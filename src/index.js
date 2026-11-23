/**
 * dsh-token-gateway — Token Gateway + budget governance for DeepSeek Harness.
 *
 * Wires the pure gateway core to the host:
 *   - `llm/stream` waterfall  -> admission + metering for every model call
 *   - `session/event`         -> fallback session attribution
 *   - `commands`              -> `/gateway` status / usage / unblock
 *   - `webServer`             -> read-only control API under `gateway.basePath`
 *
 * The plugin has no runtime dependencies; every tunable is validated in
 * config.js and fails loudly at load time.
 */

import { resolveConfig } from './config.js';
import { createGateway } from './gateway.js';
import { Ledger } from './ledger.js';
import { createStore } from './store.js';

export const name = 'token-gateway';

/** The gateway is meaningless without the LLM seam. */
export const inject = ['llm'];

function registerCommand(scope, runtime, gateway) {
  scope.effect(
    () =>
      runtime.register({
        name: 'gateway',
        description: 'Token Gateway: spend, budgets, and block/unblock controls',
        input: { hint: 'status | usage | unblock <session|daily|monthly>' },
        handler: (invocation) => gateway.handleCommand(invocation),
      }),
    'token-gateway: /gateway command',
  );
}

function registerRoute(scope, server, gateway, config) {
  scope.effect(
    () =>
      server.register({
        kind: 'prefix',
        path: config.gateway.basePath,
        handler: (req, res) => gateway.handleHttp(req, res),
      }),
    'token-gateway: control API',
  );
}

export async function apply(ctx, input) {
  const config = resolveConfig(input);
  const logger = ctx.logger('token-gateway');
  const ledger = new Ledger({ timeZone: config.pricing.peak.timeZone });

  const store = config.persistence.enabled
    ? createStore({ file: config.persistence.file, flushMs: config.persistence.flushMs, ledger, logger })
    : null;
  store?.load();

  const gateway = createGateway({
    config,
    ledger,
    llm: ctx.llm,
    logger,
    persist: store ?? undefined,
  });

  // Fallback attribution for auxiliary calls (title, compaction) that omit sessionId.
  ctx.on('session/event', (session) => gateway.onSessionEvent(session));

  // Prepend: the gate must see the request before retry/compaction wrappers,
  // and the meter must see the usage chunk on the way back.
  ctx.on('llm/stream', (options, next) => gateway.onLlmStream(options, next), { prepend: true });

  // Commands and the web host mount as bundle services; do not depend on the
  // order this overlay row happens to load in. `ctx.inject` retries once the
  // service exists, while a present service registers immediately.
  const commands = ctx.get('commands');
  if (commands !== undefined) {
    registerCommand(ctx, commands, gateway);
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (scope) => {
      const runtime = scope.get('commands');
      if (runtime !== undefined) registerCommand(scope, runtime, gateway);
    });
  }

  if (config.gateway.http) {
    const webServer = ctx.get('webServer');
    if (webServer !== undefined) {
      registerRoute(ctx, webServer, gateway, config);
    } else if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scope) => {
        const server = scope.get('webServer');
        if (server !== undefined) registerRoute(scope, server, gateway, config);
      });
    }
  }

  if (store !== null) {
    ctx.effect(() => () => store.dispose(), 'token-gateway: persistence');
  }

  logger.info(
    `gateway ready: session=${config.budgets.session} daily=${config.budgets.daily} monthly=${config.budgets.monthly} USD, overLimit=${config.overLimit}`,
  );
}
