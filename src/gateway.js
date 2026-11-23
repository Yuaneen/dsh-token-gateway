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
 *   web host (read-only by default, loopback-gated when no token is set).
 */

import { costOf, formatMoney, formatTokens, priceForModel } from './pricing.js';
import { SCOPES, budgetRatios, evaluateBudget } from './policy.js';
import { blockedStream, meteredStream } from './stream.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']);

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
      budgets: config.budgets,
      warnRatio: config.warnRatio,
      overLimit: config.overLimit,
      degradeAt: config.degradeAt,
      degradation: config.degradation,
      model: typeof options?.model === 'string' ? options.model : '',
      overrides: ledger.getOverrides(sessionId),
    });
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

  /** Track a fallback session id for auxiliary calls without `options.sessionId`. */
  function onSessionEvent(session) {
    if (session?.id !== undefined) state.lastSessionId = String(session.id);
  }

  /**
   * Status snapshot for the command, HTTP API and tests.
   * @param {string} [sessionId]
   * @param {number} [at]
   */
  function snapshot(sessionId = state.lastSessionId ?? '__global__', at = now()) {
    const totals = ledger.totals(sessionId, at);
    const decision = evaluateBudget({
      totals,
      budgets: config.budgets,
      warnRatio: config.warnRatio,
      overLimit: config.overLimit,
      degradeAt: config.degradeAt,
      degradation: config.degradation,
      model: '',
      overrides: ledger.getOverrides(sessionId),
    });
    return {
      generatedAt: new Date(at).toISOString(),
      sessionId,
      currency: config.currency,
      budgets: config.budgets,
      warnRatio: config.warnRatio,
      overLimit: config.overLimit,
      totals,
      ratios: budgetRatios(totals, config.budgets),
      overrides: ledger.getOverrides(sessionId),
      // Scope-level policy, not model-specific: with overLimit=degrade the
      // actual outcome depends on whether the current model has a mapping.
      action: decision.over && config.overLimit === 'degrade' ? 'degrade' : decision.action,
      over: decision.over,
      scope: decision.scope,
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
            sessionId: id,
            generatedAt: new Date(at).toISOString(),
            totals: ledger.totals(id, at),
            models: ledger.modelBreakdown(),
          },
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
        ledger.setOverride(scope, spent, id);
        persist?.markDirty();
        sendJson(res, 200, { ok: true, scope, sessionId: id, spent, note: 'block lifted until spending grows past this watermark' });
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
      ledger.setOverride(scope, spent, sessionId);
      persist?.markDirty();
      return {
        kind: 'success',
        text: `Token Gateway: lifted the ${scope} block at ${formatMoney(spent, config.currency)}. It re-blocks after further spending.`,
      };
    }

    if (sub === 'help') {
      return { kind: 'success', text: 'Token Gateway commands: /gateway [status] | usage | unblock <session|daily|monthly> | help' };
    }

    return { kind: 'error', text: `unknown subcommand "${sub}". Try /gateway help.` };
  }

  return { onLlmStream, onSessionEvent, snapshot, handleHttp, handleCommand };
}

function line(label, scope, snapshot) {
  const entry = snapshot.ratios[scope];
  const spent = formatMoney(entry.spent, snapshot.currency);
  if (entry.cap === null) return `${label.padEnd(8)} ${spent}  (no cap)`;
  const ratio = entry.ratio === null ? 0 : entry.ratio;
  return `${label.padEnd(8)} ${spent} / ${formatMoney(entry.cap, snapshot.currency)}  (${Math.round(ratio * 100)}%)`;
}

/** Human-readable `/gateway` status. */
export function formatStatus(snapshot) {
  return [
    `Token Gateway · policy ${snapshot.overLimit} · action ${snapshot.action}`,
    line('session', 'session', snapshot),
    line('today', 'daily', snapshot),
    line('month', 'monthly', snapshot),
    `warn at ${Math.round(snapshot.warnRatio * 100)}% · ${snapshot.reason}`,
  ].join('\n');
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
  return [header, rows.length === 0 ? '  (no metered calls yet)' : 'by model:', ...rows].join('\n');
}
