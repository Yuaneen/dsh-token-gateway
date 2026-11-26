import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveConfig } from '../src/config.js';
import { createGateway, formatStatus, formatUsage } from '../src/gateway.js';
import { Ledger } from '../src/ledger.js';

const ZONE = 'Asia/Shanghai';
const T = Date.parse('2026-11-16T10:00:00+08:00'); // Monday peak

const usageChunk = {
  type: 'usage',
  usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
};

function upstream() {
  return (async function* () {
    yield usageChunk;
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}

function logger() {
  const lines = [];
  return { lines, info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]) };
}

function collect(iterable) {
  return (async () => {
    const chunks = [];
    for await (const chunk of iterable) chunks.push(chunk);
    return chunks;
  })();
}

function config(overrides = {}) {
  return resolveConfig({
    budgets: { session: 10, daily: 50, monthly: 500 },
    ...overrides,
  });
}

test('allows and meters a call under budget', async () => {
  const ledger = new Ledger({ timeZone: ZONE });
  const gateway = createGateway({ config: config(), ledger, now: () => T });
  const chunks = await collect(gateway.onLlmStream({ sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-v4-pro' }, upstream));

  assert.equal(chunks.at(-1).type, 'finish');
  const session = ledger.totals('s1', T).session;
  assert.equal(Number(session.toFixed(6)), Number((1.25 + 3.75).toFixed(6)));
});

test('blocks an over-budget call without touching the upstream', async () => {
  const ledger = new Ledger({ timeZone: ZONE });
  ledger.record({ sessionId: 's1', provider: 'p', model: 'm', usage: {}, costUsd: 11, at: T });
  let called = false;
  const gateway = createGateway({
    config: config({ budgets: { session: 10, daily: 50, monthly: 500 } }),
    ledger,
    now: () => T,
  });

  const chunks = await collect(
    gateway.onLlmStream({ sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-v4-pro' }, () => {
      called = true;
      return upstream();
    }),
  );

  assert.equal(called, false);
  assert.match(chunks.find((chunk) => chunk.type === 'text-delta').text, /blocked this request/i);
  assert.equal(chunks.at(-1).reason.kind, 'error');
  assert.equal(chunks.at(-1).reason.failure.code, 'BUDGET_BLOCKED');
});

test('alert policy passes through even over the cap', async () => {
  const ledger = new Ledger({ timeZone: ZONE });
  ledger.record({ sessionId: 's1', provider: 'p', model: 'm', usage: {}, costUsd: 11, at: T });
  let called = false;
  const gateway = createGateway({
    config: config({ overLimit: 'alert', budgets: { session: 10, daily: 50, monthly: 500 } }),
    ledger,
    now: () => T,
  });

  await collect(
    gateway.onLlmStream({ sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-v4-flash' }, () => {
      called = true;
      return upstream();
    }),
  );

  assert.equal(called, true);
});

test('warn policy passes the first call and meters it', async () => {
  const ledger = new Ledger({ timeZone: ZONE });
  ledger.record({ sessionId: 's1', provider: 'p', model: 'm', usage: {}, costUsd: 8.5, at: T });
  let called = false;
  const log = logger();
  const gateway = createGateway({
    config: config({ budgets: { session: 10, daily: 50, monthly: 500 } }),
    ledger,
    logger: log,
    now: () => T,
  });

  await collect(
    gateway.onLlmStream({ sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-v4-flash' }, () => {
      called = true;
      return upstream();
    }),
  );

  assert.equal(called, true);
  assert.ok(log.lines.some(([level, message]) => level === 'warn' && message.includes('budget warning')));
});

test('degrade re-dispatches to the cheaper model and meters the degraded route', async () => {
  const ledger = new Ledger({ timeZone: ZONE });
  ledger.record({ sessionId: 's1', provider: 'p', model: 'm', usage: {}, costUsd: 9, at: T });

  const seen = [];
  let gateway;
  const llm = {
    stream(options) {
      seen.push(options.model);
      return gateway.onLlmStream(options, () => upstream());
    },
  };

  gateway = createGateway({
    llm,
    ledger,
    config: config({
      overLimit: 'degrade',
      degradation: { 'deepseek-v4-pro': 'deepseek-v4-flash' },
      budgets: { session: 10, daily: 50, monthly: 500 },
    }),
    now: () => T,
  });

  const chunks = await collect(
    gateway.onLlmStream({ sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-v4-pro' }, () => {
      throw new Error('the original model should not be called');
    }),
  );

  assert.equal(chunks.at(-1).type, 'finish');
  assert.deepEqual(seen, ['deepseek-v4-flash']);
  // Flash prices, not Pro prices: 0.28 + 1.12 per 1M.
  assert.equal(Number(ledger.totals('s1', T).session.toFixed(6)), Number((9 + 0.28 + 1.12).toFixed(6)));
});

test('degrade guard prevents an admission loop', async () => {
  const ledger = new Ledger({ timeZone: ZONE });
  ledger.record({ sessionId: 's1', provider: 'p', model: 'm', usage: {}, costUsd: 11, at: T });

  let depth = 0;
  let gateway;
  const llm = {
    stream(options) {
      depth += 1;
      if (depth > 3) throw new Error('loop');
      return gateway.onLlmStream(options, () => upstream());
    },
  };

  gateway = createGateway({
    llm,
    ledger,
    config: config({
      overLimit: 'degrade',
      degradation: { 'deepseek-v4-pro': 'deepseek-v4-flash' },
      budgets: { session: 10, daily: 50, monthly: 500 },
    }),
    now: () => T,
  });

  await collect(gateway.onLlmStream({ sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-v4-pro' }, upstream));
  assert.equal(depth, 1);
});

test('snapshot and formatters expose session, day and month caps', () => {
  const ledger = new Ledger({ timeZone: ZONE });
  ledger.record({ sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-v4-flash', usage: usageChunk.usage, costUsd: 0.5, at: T });
  const gateway = createGateway({ config: config(), ledger, now: () => T });

  const status = gateway.snapshot('s1', T);
  assert.equal(status.totals.session, 0.5);
  assert.equal(status.budgets.session, 10);
  assert.match(formatStatus(status), /session/);
  assert.match(formatUsage(status), /deepseek-v4-flash/);
});

test('command unblock lifts the block until spending grows', () => {
  const ledger = new Ledger({ timeZone: ZONE });
  ledger.record({ sessionId: 's1', provider: 'p', model: 'm', usage: {}, costUsd: 11, at: T });
  const gateway = createGateway({ config: config(), ledger, now: () => T });

  const result = gateway.handleCommand({
    rawInput: 'unblock session',
    agent: { session: { id: 's1' } },
  });

  assert.equal(result.kind, 'success');
  assert.equal(ledger.overrides.get('session:s1'), 11);
});

test('a daily unblock does not lift the next day cap', async () => {
  const ledger = new Ledger({ timeZone: ZONE });
  const tomorrow = Date.parse('2026-11-17T10:00:00+08:00');
  let now = T;
  const gateway = createGateway({
    config: config({ budgets: { session: null, daily: 10, monthly: null } }),
    ledger,
    now: () => now,
  });

  ledger.record({ sessionId: 's1', provider: 'p', model: 'm', usage: {}, costUsd: 12, at: T });
  const lifted = gateway.handleCommand({ rawInput: 'unblock daily', agent: { session: { id: 's1' } } });
  assert.equal(lifted.kind, 'success');

  now = tomorrow;
  ledger.record({ sessionId: 's1', provider: 'p', model: 'm', usage: {}, costUsd: 11, at: tomorrow });
  const chunks = await collect(
    gateway.onLlmStream({ sessionId: 's1', provider: 'p', model: 'm' }, upstream),
  );

  assert.equal(chunks.at(-1).reason.failure.code, 'BUDGET_BLOCKED');
});

test('invalid config fails loudly', () => {
  assert.throws(() => resolveConfig({ budgets: { session: -1 } }), /budgets\.session/);
  assert.throws(() => resolveConfig({ overLimit: 'nope' }), /overLimit/);
  assert.throws(() => resolveConfig({ budgets: null }), /budgets must be an object/);
  assert.throws(() => resolveConfig({ gateway: null }), /gateway must be an object/);
});

test('token caps fail loudly', () => {
  assert.throws(() => resolveConfig({ tokenBudgets: { session: 0 } }), /tokenBudgets\.session/);
  assert.throws(() => resolveConfig({ tokenBudgets: { daily: 1.5 } }), /whole number of tokens/);
  assert.throws(() => resolveConfig({ tokenBudgets: null }), /tokenBudgets must be an object/);
});

/* ------------------------------------------------------------ control plane */

function mockResponse() {
  const out = { status: 0, body: '' };
  return { out, writeHead(status) { out.status = status; }, end(body) { out.body = String(body ?? ''); } };
}

function mockRequest(url, method = 'GET') {
  return { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
}

async function get(gateway, url) {
  const res = mockResponse();
  await gateway.handleHttp(mockRequest(url), res);
  return { status: res.out.status, body: JSON.parse(res.out.body) };
}

test('the stats route serves token totals, cache rate and the series', async () => {
  const ledger = new Ledger({ timeZone: ZONE });
  const gateway = createGateway({ config: config(), ledger, now: () => T });
  await collect(gateway.onLlmStream({ sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-flash' }, upstream));

  const { status, body } = await get(gateway, '/token-gateway/v1/stats?session=s1&hours=4');
  assert.equal(status, 200);
  assert.equal(body.data.sessionId, 's1');
  assert.equal(body.data.tokenTotals.session.totalTokens, 2_000_000);
  assert.equal(body.data.tokenTotals.session.outputTokens, 1_000_000);
  assert.equal(body.data.cache.cacheHitRate, 0);
  assert.equal(body.data.models[0].totalTokens, 2_000_000);
  assert.equal(body.data.series.length, 4);
  assert.equal(body.data.series.at(-1).totalTokens, 2_000_000);
  assert.equal(body.data.allTime.totalTokens, 2_000_000);
});

test('the series route answers the requested window and clamps garbage', async () => {
  const ledger = new Ledger({ timeZone: ZONE });
  const gateway = createGateway({ config: config(), ledger, now: () => T });

  const ok = await get(gateway, '/token-gateway/v1/series?hours=6');
  assert.equal(ok.body.data.points.length, 6);
  assert.equal(ok.body.data.hours, 6);

  const junk = await get(gateway, '/token-gateway/v1/series?hours=abc');
  assert.equal(junk.body.data.points.length, 24);
});

test('a token cap blocks the next call end to end', async () => {
  const ledger = new Ledger({ timeZone: ZONE });
  ledger.record({
    sessionId: 's1',
    provider: 'p',
    model: 'm',
    usage: { inputTokens: 2_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
    at: T,
  });
  const gateway = createGateway({
    config: config({
      budgets: { session: null, daily: null, monthly: null },
      tokenBudgets: { session: 1_000, daily: null, monthly: null },
    }),
    ledger,
    now: () => T,
  });

  let called = false;
  const chunks = await collect(
    gateway.onLlmStream({ sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-flash' }, () => {
      called = true;
      return upstream();
    }),
  );

  assert.equal(called, false);
  assert.equal(chunks.at(-1).reason.failure.code, 'BUDGET_BLOCKED');
  assert.match(chunks.at(-1).reason.failure.message, /token budget exceeded/);
});

test('unblock lifts the token watermark as well as the USD one', () => {
  const ledger = new Ledger({ timeZone: ZONE });
  ledger.record({
    sessionId: 's1',
    provider: 'p',
    model: 'm',
    usage: { inputTokens: 5_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 11,
    at: T,
  });
  const gateway = createGateway({ config: config(), ledger, now: () => T });

  gateway.handleCommand({ rawInput: 'unblock session', agent: { session: { id: 's1' } } });
  assert.deepEqual(ledger.getTokenOverrides('s1'), { session: 5_000 });

  const status = gateway.snapshot('s1', T);
  assert.equal(status.action, 'warn');
});

test('a subagent session cannot steal the fallback attribution', () => {
  const ledger = new Ledger({ timeZone: ZONE });
  const gateway = createGateway({ config: config(), ledger, now: () => T });

  gateway.onSessionEvent({ id: 'main', delegationDepth: 0 });
  gateway.onSessionEvent({ id: 'subagent', delegationDepth: 1 });
  assert.equal(gateway.snapshot().sessionId, 'main', 'a delegated session must not claim the default');

  // A session event without a depth field keeps the old behaviour.
  gateway.onSessionEvent({ id: 'main-2' });
  assert.equal(gateway.snapshot().sessionId, 'main-2');
});

test('the status line shows a token cap only where one is configured', () => {
  const ledger = new Ledger({ timeZone: ZONE });
  ledger.record({
    sessionId: 's1',
    provider: 'p',
    model: 'm',
    usage: { inputTokens: 400_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0.5,
    at: T,
  });
  const gateway = createGateway({
    config: config({ tokenBudgets: { session: 1_000_000, daily: null, monthly: null } }),
    ledger,
    now: () => T,
  });

  const text = formatStatus(gateway.snapshot('s1', T));
  assert.match(text, /session tok\s+500\.0k \/ 1\.00M tokens\s+\(50%\)/);
  assert.doesNotMatch(text, /today tok/);
});
