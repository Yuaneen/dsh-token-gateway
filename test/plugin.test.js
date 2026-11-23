import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../src/index.js';

function mockResponse() {
  const out = { status: 0, headers: {}, body: '' };
  return {
    out,
    writeHead(status, headers) {
      out.status = status;
      out.headers = { ...out.headers, ...headers };
    },
    end(body) {
      out.body = String(body ?? '');
    },
  };
}

function mockRequest({ method = 'GET', url = '/', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  return { method, url, headers, socket: { remoteAddress } };
}

function createHost() {
  const listeners = new Map();
  const commands = [];
  const routes = [];
  const disposers = [];
  const lines = [];

  const ctx = {
    logger: () => ({ info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]) }),
    llm: { stream: () => (async function* () {})() },
    on(name, handler, options) {
      listeners.set(name, { handler, options });
    },
    get(name) {
      if (name === 'commands') {
        return {
          register(definition) {
            commands.push(definition);
            return () => {};
          },
        };
      }
      if (name === 'webServer') {
        return {
          register(route) {
            routes.push(route);
            return () => {};
          },
        };
      }
      return undefined;
    },
    effect(fn) {
      disposers.push(fn());
    },
  };

  return { ctx, listeners, commands, routes, disposers, lines };
}

test('apply wires llm/stream, commands and the control API', async () => {
  const host = createHost();
  await apply(host.ctx, {
    persistence: { enabled: false },
    budgets: { session: 1, daily: 5, monthly: 20 },
  });

  assert.equal(host.listeners.has('llm/stream'), true);
  assert.equal(host.listeners.has('session/event'), true);
  assert.equal(host.listeners.get('llm/stream').options.prepend, true);

  assert.equal(host.commands.length, 1);
  assert.equal(host.commands[0].name, 'gateway');

  assert.equal(host.routes.length, 1);
  assert.equal(host.routes[0].kind, 'prefix');
  assert.equal(host.routes[0].path, '/token-gateway');
});

test('the /gateway command reports status and can unblock', async () => {
  const host = createHost();
  await apply(host.ctx, { persistence: { enabled: false } });

  const command = host.commands[0];
  const invocation = { rawInput: '', agent: { session: { id: 's1' } } };
  const status = await command.handler(invocation);
  assert.equal(status.kind, 'success');
  assert.match(status.text, /Token Gateway/);

  const unblock = await command.handler({ rawInput: 'unblock session', agent: { session: { id: 's1' } } });
  assert.equal(unblock.kind, 'success');
  assert.match(unblock.text, /lifted the session block/);

  const bad = await command.handler({ rawInput: 'unblock everything', agent: { session: { id: 's1' } } });
  assert.equal(bad.kind, 'error');
});

test('HTTP status is loopback-readable and JSON-shaped', async () => {
  const host = createHost();
  await apply(host.ctx, { persistence: { enabled: false } });

  const route = host.routes[0];
  const res = mockResponse();
  await route.handler(mockRequest({ url: '/token-gateway/v1/status', headers: { host: '127.0.0.1:3080' } }), res);

  assert.equal(res.out.status, 200);
  const body = JSON.parse(res.out.body);
  assert.equal(body.ok, true);
  assert.equal(body.data.budgets.session, 2);
  assert.equal(body.data.action, 'allow');
});

test('a configured token is required for every control request', async () => {
  const host = createHost();
  await apply(host.ctx, { persistence: { enabled: false }, gateway: { token: 's3cret' } });

  const route = host.routes[0];
  const denied = mockResponse();
  await route.handler(mockRequest({ url: '/token-gateway/v1/status' }), denied);
  assert.equal(denied.out.status, 401);

  const allowed = mockResponse();
  await route.handler(
    mockRequest({ url: '/token-gateway/v1/status', headers: { authorization: 'Bearer s3cret' } }),
    allowed,
  );
  assert.equal(allowed.out.status, 200);
});

test('the control API can lift a block over HTTP', async () => {
  const host = createHost();
  await apply(host.ctx, { persistence: { enabled: false }, budgets: { session: 0.000001 } });

  const route = host.routes[0];
  const res = mockResponse();
  await route.handler(
    {
      method: 'POST',
      url: '/token-gateway/v1/unblock',
      headers: { 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ scope: 'session', sessionId: 's1' }));
      },
    },
    res,
  );

  assert.equal(res.out.status, 200);
  assert.equal(JSON.parse(res.out.body).scope, 'session');
});

test('waits for bundle services that are absent at apply time', async () => {
  const host = createHost();
  const injected = [];
  host.ctx.get = () => undefined;
  host.ctx.inject = (deps) => {
    injected.push(...deps);
  };

  await apply(host.ctx, { persistence: { enabled: false } });
  assert.deepEqual(injected.sort(), ['commands', 'webServer']);
});

test('dispose flushes and removes host effects', async () => {
  const host = createHost();
  await apply(host.ctx, { persistence: { enabled: false } });
  assert.equal(host.disposers.length, 2); // command + control API
  for (const dispose of host.disposers) dispose();
});
