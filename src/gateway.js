/**
 * The gateway core: admission, metering, control surfaces.
 *
 * This module deliberately knows nothing about cordis. `index.js` wires these
 * functions to `ctx.on('llm/stream')`, `ctx.get('commands')` and
 * `ctx.get('webServer')`; tests drive them with a fake host.
 *
 * Data plane
 *   Every DSH model call (main loop, subagent, title, compaction) crosses the
 *   `llm/stream` waterfall. That is the one choke point where a pre-flight
 *   budget check and post-flight usage meter can see *all* traffic.
 *
 * Control plane
 *   `/gateway` command (in-session) + `GET/POST {basePath}/v1/*` on the DSH
 *   web host, with a fixed-path client bootstrap. Reads are loopback-gated
 *   when no token is set; the only write is the idempotent `unblock`.
 */

import { costOf, formatMoney, formatTokens, priceForModel } from './pricing.js';
import { SCOPES, budgetRatios, evaluateBudget, formatTokenCount, tokenRatios } from './policy.js';
import { blockedStream, meteredStream } from './stream.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']);

/**
 * Fixed path the client bundle reads before it knows `basePath`.
 * Kept outside `gateway.basePath` so changing the mount point cannot strand the
 * panel: the payload is only the mount point and whether a token is required.
 */
export const BOOTSTRAP_PATH = '/_dsh-token-gateway/config';

function isLoopback(address) {
  if (typeof address !== 'string') return false;
  if (LOOPBACK.has(address)) return true;
  return address.startsWith('127.') || address.startsWith('::ffff:127.');
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * @param {object} options
 * @param {object} options.config resolved config
 * @param {import('./ledger.js').Ledger} options.ledger
 * @param {{stream: Function}} [options.llm] DSH LLM service (needed only for degrade)
 * @param {{info: Function, warn: Function}} [options.logger]
 * @param {() => number} [options.now]
 * @param {{markDirty: Function}} [options.persist]
 */
export function createGateway({ config, ledger, llm, logger, now = () => Date.now(), persist }) {
  const state = {
    /** Fallback attribution for calls that do not carry a sessionId. */
    lastSessionId: null,
    /** scope -> last warning timestamp */
    warnedAt: new Map(),
  };
  /** Requests we already re-dispatched for degradation: skip admission, still meter. */
  const rewritten = new WeakSet();
  /** Models we already warned about as unpriced (avoid log spam). */
  const unpriced = new Set();

  const log = {
    info: logger?.info?.bind(logger) ?? (() => {}),
    warn: logger?.warn?.bind(logger) ?? (() => {}),
  };

  function sessionIdOf(options) {
    if (options?.sessionId !== undefined && options.sessionId !== null) return String(options.sessionId);
    return state.lastSessionId ?? '__global__';
  }

  function decide(options, sessionId, at) {
    return evaluateBudget({
      totals: ledger.totals(sessionId, at),
      tokenTotals: ledger.tokenTotals(sessionId, at),
      budgets: config.budgets,
      tokenBudgets: config.tokenBudgets,
      warnRatio: config.warnRatio,
      overLimit: config.overLimit,
      degradeAt: config.degradeAt,
      degradation: config.degradation,
      model: typeof options?.model === 'string' ? options.model : '',
      overrides: ledger.getOverrides(sessionId, at),
      tokenOverrides: ledger.getTokenOverrides(sessionId, at),
    });
  }

  /** Cache-hit rate of the prompt side: cached input over all input. */
  function cacheStats(summary) {
    const cached = summary?.cacheReadTokens ?? 0;
    const fresh = summary?.inputTokens ?? 0;
    const promptTokens = cached + fresh;
    return { promptTokens, cacheHitRate: promptTokens === 0 ? null : cached / promptTokens };
  }

  function recordUsage(options, usage, sessionId, at) {
    const provider = typeof options?.provider === 'string' ? options.provider : 'unknown';
    const model = typeof options?.model === 'string' ? options.model : 'unknown';
    const price = priceForModel({ provider, model }, config.pricing, at);
    const costUsd = costOf(usage, price);
    if (!price.priced && !unpriced.has(model)) {
      unpriced.add(model);
      log.warn(`unpriced model "${provider}/${model}": usage is metered at 0 USD; add pricing.prices["${model}"]`);
    }
    ledger.record({ sessionId, provider, model, usage, costUsd, at });
    persist?.markDirty();
    log.info(
      `metered ${provider}/${model} (${price.tier}): ${formatTokens(
        (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      )} tokens, ${formatMoney(costUsd, config.currency)}`,
    );
  }

  function warnOnce(decision, at) {
    const key = decision.scope ?? 'global';
    const last = state.warnedAt.get(key) ?? 0;
    if (at - last < config.alertCooldownMs) return;
    state.warnedAt.set(key, at);
    log.warn(`budget warning: ${decision.reason}`);
  }

  /**
   * `llm/stream` waterfall listener.
   * @param {object} options GenerateOptions
   * @param {() => AsyncIterable<object>} next
   * @returns {AsyncIterable<object>}
   */
  function onLlmStream(options, next) {
    const at = now();
    const sessionId = sessionIdOf(options);

    // A degraded request re-enters the waterfall. It was admitted once
    // already; only meter it (and never block it again, or we would loop).
    if (rewritten.has(options)) {
      return meteredStream(next(), (usage) => recordUsage(options, usage, sessionId, at));
    }

    const decision = decide(options, sessionId, at);

    if (decision.action === 'block') {
      log.warn(`blocked ${options.provider}/${options.model}: ${decision.reason}`);
      return blockedStream(
        `Token Gateway blocked this request: ${decision.reason}. Lift it with "/gateway unblock ${decision.scope}".`,
      );
    }

    if (decision.action === 'degrade' && decision.targetModel) {
      if (llm === undefined || typeof llm.stream !== 'function') {
        return blockedStream(`Token Gateway: degrade requested but no LLM service is available (${decision.reason}).`);
      }
      const copy = { ...options, model: decision.targetModel };
      rewritten.add(copy);
      log.warn(`degrading ${options.provider}/${options.model} -> ${decision.targetModel}: ${decision.reason}`);
      return llm.stream(copy);
    }

    if (decision.action === 'warn') warnOnce(decision, at);

    return meteredStream(next(), (usage) => recordUsage(options, usage, sessionId, at));
  }

  /**
   * Track a fallback session id for auxiliary calls without `options.sessionId`.
   *
   * Only the main session may claim it: a subagent session (delegation depth > 0)
   * runs its own calls and would otherwise steal the attribution for titles and
   * compaction, making the panel show a subagent's tiny totals as "this session".
   */
  function onSessionEvent(session) {
    if (session?.id === undefined) return;
    const id = String(session.id);
    const header = session.header ?? {};
    const depth = header.delegationDepth;
    const delegated = header.origin === 'subagent' || (typeof depth === 'number' && depth > 0);
    if (delegated) {
      if (header.parentSession !== undefined) ledger.setSessionRoot(id, header.parentSession);
      return;
    }
    state.lastSessionId = id;
  }

  /**
   * Status snapshot for the command, HTTP API and tests.
   * @param {string} [sessionId]
   * @param {number} [at]
   */
  function snapshot(sessionId = state.lastSessionId ?? '__global__', at = now()) {
    const totals = ledger.totals(sessionId, at);
    const tokenTotals = ledger.tokenTotals(sessionId, at);
    const overrides = ledger.getOverrides(sessionId, at);
    const tokenOverrides = ledger.getTokenOverrides(sessionId, at);
    const decision = evaluateBudget({
      totals,
      tokenTotals,
      budgets: config.budgets,
      tokenBudgets: config.tokenBudgets,
      warnRatio: config.warnRatio,
      overLimit: config.overLimit,
      degradeAt: config.degradeAt,
      degradation: config.degradation,
      model: '',
      overrides,
      tokenOverrides,
    });
    return {
      generatedAt: new Date(at).toISOString(),
      sessionId: ledger.rootOf(sessionId),
      currency: config.currency,
      budgets: config.budgets,
      tokenBudgets: config.tokenBudgets,
      warnRatio: config.warnRatio,
      overLimit: config.overLimit,
      totals,
      tokenTotals,
      allTime: ledger.allTime(),
      cache: cacheStats(tokenTotals.daily),
      ratios: budgetRatios(totals, config.budgets),
      tokenRatios: tokenRatios(tokenTotals, config.tokenBudgets),
      overrides,
      tokenOverrides,
      // Scope-level policy, not model-specific: with overLimit=degrade the
      // actual outcome depends on whether the current model has a mapping.
      action: decision.over && config.overLimit === 'degrade' ? 'degrade' : decision.action,
      over: decision.over,
      scope: decision.scope,
      metric: decision.metric,
      reason: decision.reason,
      models: ledger.modelBreakdown(),
    };
  }

  function authorized(req) {
    if (config.gateway.token.length > 0) {
      return req.headers.authorization === `Bearer ${config.gateway.token}`;
    }
    // No token configured: read-only access from loopback only.
    return isLoopback(req.socket?.remoteAddress);
  }

  /**
   * Public client bootstrap: the panel must learn `basePath` before it can call
   * the control plane, and whether it needs an access token. This exposes no
   * spend, budget, session or credential data.
   */
  function handleBootstrap(req, res) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      data: {
        basePath: config.gateway.basePath,
        auth: config.gateway.token.length > 0 ? 'bearer' : 'none',
      },
    });
  }

  /** Raw HTTP handler registered at `basePath`. */
  async function handleHttp(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = url.pathname.slice(config.gateway.basePath.length) || '/';

      if (!authorized(req)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      if (req.method === 'GET' && (route === '/' || route === '/v1/status')) {
        const sessionId = url.searchParams.get('session') ?? undefined;
        sendJson(res, 200, { ok: true, data: snapshot(sessionId ?? undefined) });
        return;
      }

      if (req.method === 'GET' && route === '/v1/usage') {
        const sessionId = url.searchParams.get('session') ?? undefined;
        const at = now();
        const id = sessionId ?? state.lastSessionId ?? '__global__';
        sendJson(res, 200, {
          ok: true,
          data: {
            sessionId: ledger.rootOf(id),
            generatedAt: new Date(at).toISOString(),
            totals: ledger.totals(id, at),
            tokenTotals: ledger.tokenTotals(id, at),
            models: ledger.modelBreakdown(),
          },
        });
        return;
      }

      // Token-first view for the panel: status + hourly series in one reply, so
      // a single poll paints the whole card.
      if (req.method === 'GET' && route === '/v1/stats') {
        const sessionId = url.searchParams.get('session') ?? undefined;
        const at = now();
        const hours = Number.parseInt(url.searchParams.get('hours') ?? '24', 10);
        sendJson(res, 200, {
          ok: true,
          data: { ...snapshot(sessionId ?? undefined, at), series: ledger.series({ at, hours: Number.isFinite(hours) ? hours : 24 }) },
        });
        return;
      }

      if (req.method === 'GET' && route === '/v1/series') {
        const hours = Number.parseInt(url.searchParams.get('hours') ?? '24', 10);
        const at = now();
        sendJson(res, 200, {
          ok: true,
          data: { generatedAt: new Date(at).toISOString(), hours, points: ledger.series({ at, hours: Number.isFinite(hours) ? hours : 24 }) },
        });
        return;
      }

      if (req.method === 'POST' && route === '/v1/unblock') {
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          sendJson(res, 400, { error: `invalid request body: ${error instanceof Error ? error.message : String(error)}` });
          return;
        }
        const scope = body.scope;
        if (!SCOPES.includes(scope)) {
          sendJson(res, 400, { error: `scope must be one of ${SCOPES.join(', ')}` });
          return;
        }
        const at = now();
        const id = typeof body.sessionId === 'string' ? body.sessionId : state.lastSessionId ?? '__global__';
        const spent = ledger.spentFor(scope, id, at);
        const tokens = ledger.tokenTotals(id, at)[scope]?.totalTokens ?? 0;
        ledger.setOverride(scope, spent, id, at);
        ledger.setTokenOverride(scope, tokens, id, at);
        persist?.markDirty();
        sendJson(res, 200, {
          ok: true,
          scope,
          sessionId: id,
          spent,
          tokens,
          note: 'block lifted until spending grows past this watermark',
        });
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** `/gateway` command handler (CommandResult shape). */
  function handleCommand(invocation) {
    const sessionId = invocation?.agent?.session?.id !== undefined ? String(invocation.agent.session.id) : '__global__';
    const words = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean);
    const sub = words[0] ?? 'status';
    const at = now();

    if (sub === 'status' || sub === '') {
      return { kind: 'success', text: formatStatus(snapshot(sessionId, at)) };
    }

    if (sub === 'usage') {
      return { kind: 'success', text: formatUsage(snapshot(sessionId, at)) };
    }

    if (sub === 'unblock') {
      const scope = words[1];
      if (!SCOPES.includes(scope)) {
        return { kind: 'error', text: `usage: /gateway unblock <${SCOPES.join('|')}>` };
      }
      const spent = ledger.spentFor(scope, sessionId, at);
      const tokens = ledger.tokenTotals(sessionId, at)[scope]?.totalTokens ?? 0;
      ledger.setOverride(scope, spent, sessionId, at);
      ledger.setTokenOverride(scope, tokens, sessionId, at);
      persist?.markDirty();
      return {
        kind: 'success',
        text: `Token Gateway: lifted the ${scope} block at ${formatMoney(spent, config.currency)} / ${formatTokenCount(tokens)} tokens. It re-blocks after further spending.`,
      };
    }

    if (sub === 'help') {
      return { kind: 'success', text: 'Token Gateway commands: /gateway [status] | usage | unblock <session|daily|monthly> | help' };
    }

    return { kind: 'error', text: `unknown subcommand "${sub}". Try /gateway help.` };
  }

  return { onLlmStream, onSessionEvent, snapshot, handleHttp, handleBootstrap, handleCommand };
}

function line(label, scope, snapshot) {
  const entry = snapshot.ratios[scope];
  const spent = formatMoney(entry.spent, snapshot.currency);
  if (entry.cap === null) return `${label.padEnd(11)} ${spent}  (no cap)`;
  const ratio = entry.ratio === null ? 0 : entry.ratio;
  return `${label.padEnd(11)} ${spent} / ${formatMoney(entry.cap, snapshot.currency)}  (${Math.round(ratio * 100)}%)`;
}

/** One token line per scope, only where a token cap is configured. */
function tokenLine(label, scope, snapshot) {
  const cap = snapshot.tokenBudgets?.[scope];
  if (cap === null || cap === undefined) return null;
  const summary = snapshot.tokenRatios?.[scope] ?? { totalTokens: 0, ratio: 0 };
  return `${`${label} tok`.padEnd(11)} ${formatTokenCount(summary.totalTokens)} / ${formatTokenCount(cap)} tokens  (${Math.round((summary.ratio ?? 0) * 100)}%)`;
}

/** Human-readable `/gateway` status. */
export function formatStatus(snapshot) {
  const lines = [`Token Gateway · policy ${snapshot.overLimit} · action ${snapshot.action}`];
  for (const [label, scope] of [['session', 'session'], ['today', 'daily'], ['month', 'monthly']]) {
    lines.push(line(label, scope, snapshot));
    const tokens = tokenLine(label, scope, snapshot);
    if (tokens !== null) lines.push(tokens);
  }
  const cache = snapshot.cache;
  if (cache?.cacheHitRate !== null && cache?.cacheHitRate !== undefined) {
    lines.push(`cache hit ${Math.round(cache.cacheHitRate * 100)}% of ${formatTokenCount(cache.promptTokens)} prompt tokens today`);
  }
  lines.push(`warn at ${Math.round(snapshot.warnRatio * 100)}% · ${snapshot.reason}`);
  return lines.join('\n');
}

/** Human-readable `/gateway usage`. */
export function formatUsage(snapshot) {
  const rows = snapshot.models.slice(0, 10).map((entry) => {
    return `  ${`${entry.provider}/${entry.model}`.padEnd(38)} ${formatMoney(entry.spentUsd, snapshot.currency).padStart(12)}  ${formatTokens(
      entry.tokens,
    ).padStart(7)} tok  ${String(entry.calls).padStart(4)} calls`;
  });
  const header = `Token Gateway usage · session ${formatMoney(snapshot.totals.session, snapshot.currency)} · today ${formatMoney(
    snapshot.totals.daily,
    snapshot.currency,
  )} · month ${formatMoney(snapshot.totals.monthly, snapshot.currency)}`;
  const daily = snapshot.tokenTotals?.daily;
  const split = daily === undefined
    ? null
    : `tokens today: ${formatTokens(daily.totalTokens)} · cache hit ${formatTokens(daily.cacheReadTokens)} · fresh in ${formatTokens(
      daily.inputTokens,
    )} · out ${formatTokens(daily.outputTokens)}`;
  return [header, split, rows.length === 0 ? '  (no metered calls yet)' : 'by model:', ...rows].filter(Boolean).join('\n');
}
