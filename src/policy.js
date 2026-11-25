/**
 * Budget policy: turn spend totals + caps into one admission decision.
 *
 * The engine is pure so the same decision can be exercised by tests, the
 * `/gateway` command, and the HTTP control plane without a live DSH host.
 *
 * Decision order:
 *   1. an over-cap scope (unless the user lifted it for the current spend) wins;
 *   2. otherwise the highest ratio crossing `warnRatio` warns;
 *   3. `overLimit: 'degrade'` turns either stage into a model downgrade when a
 *      mapping exists, and falls back to block (hard stage) when it does not.
 */

export const SCOPES = ['session', 'daily', 'monthly'];

/** Budget dimensions. A cap exists per (scope, metric); the worst one decides. */
export const METRICS = ['usd', 'tokens'];

function ratioOf(spent, cap) {
  if (cap === null || cap === undefined) return null;
  if (cap <= 0) return Number.POSITIVE_INFINITY;
  return spent / cap;
}

/** Compact token count for human-facing reasons. */
export function formatTokenCount(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/**
 * One candidate per (scope, metric) that actually has a cap.
 * USD and tokens are separate dimensions: a call is admitted only when every
 * capped dimension is satisfied, which is why the caller takes the maximum.
 */
function candidates({ totals, tokenTotals, budgets, tokenBudgets }) {
  const out = [];
  for (const scope of SCOPES) {
    const cap = budgets?.[scope] ?? null;
    if (cap !== null) {
      const spent = totals?.[scope] ?? 0;
      out.push({ scope, metric: 'usd', cap, spent, ratio: ratioOf(spent, cap) });
    }
    const tokenCap = tokenBudgets?.[scope] ?? null;
    if (tokenCap !== null) {
      const spent = tokenTotals?.[scope]?.totalTokens ?? 0;
      out.push({ scope, metric: 'tokens', cap: tokenCap, spent, ratio: ratioOf(spent, tokenCap) });
    }
  }
  return out;
}

function describe(entry) {
  return entry.metric === 'tokens'
    ? `${formatTokenCount(entry.spent)} / ${formatTokenCount(entry.cap)} tokens`
    : `${entry.spent.toFixed(4)} / ${entry.cap} USD`;
}

/**
 * @param {object} input
 * @param {{session: number, daily: number, monthly: number}} input.totals spend in USD
 * @param {{session: object, daily: object, monthly: object}} [input.tokenTotals] per-scope token summaries
 * @param {{session?: number|null, daily?: number|null, monthly?: number|null}} input.budgets USD caps
 * @param {{session?: number|null, daily?: number|null, monthly?: number|null}} [input.tokenBudgets] token caps
 * @param {number} input.warnRatio
 * @param {'alert'|'block'|'degrade'} input.overLimit
 * @param {'warn'|'hard'} [input.degradeAt]
 * @param {Record<string, string>} [input.degradation]
 * @param {string} [input.model]
 * @param {Record<string, number>} [input.overrides] scope -> USD at unblock time
 * @param {Record<string, number>} [input.tokenOverrides] scope -> tokens at unblock time
 */
export function evaluateBudget({
  totals,
  tokenTotals,
  budgets,
  tokenBudgets,
  warnRatio,
  overLimit,
  degradeAt = 'hard',
  degradation = {},
  model = '',
  overrides = {},
  tokenOverrides = {},
}) {
  const entries = candidates({ totals, tokenTotals, budgets, tokenBudgets });

  const target = degradation[model];
  const canDegrade = typeof target === 'string' && target.length > 0 && target !== model;
  const highest = entries.reduce((best, entry) => (best === null || entry.ratio > best.ratio ? entry : best), null);

  if (highest === null) {
    return allow('no budget caps configured');
  }

  const overridden = (entry) => {
    const watermarks = entry.metric === 'tokens' ? tokenOverrides : overrides;
    const watermark = watermarks?.[entry.scope];
    return typeof watermark === 'number' && entry.spent <= watermark + 1e-9;
  };

  const over = entries
    .filter((entry) => entry.ratio >= 1 && !overridden(entry))
    .sort((a, b) => b.ratio - a.ratio)[0];

  if (over !== undefined) {
    const reason = `${over.scope} ${over.metric === 'tokens' ? 'token budget' : 'budget'} exceeded (${describe(over)})`;
    const base = { over: true, scope: over.scope, metric: over.metric, ratio: over.ratio, cap: over.cap, spent: over.spent };
    if (overLimit === 'alert') {
      return { action: 'warn', ...base, targetModel: null, reason: `${reason}; alert only` };
    }
    if (overLimit === 'degrade' && canDegrade) {
      return { action: 'degrade', ...base, targetModel: target, reason: `${reason}; degrading ${model} -> ${target}` };
    }
    return { action: 'block', ...base, targetModel: null, reason };
  }

  if (highest.ratio >= warnRatio) {
    const base = { over: false, scope: highest.scope, metric: highest.metric, ratio: highest.ratio, cap: highest.cap, spent: highest.spent };
    if (overLimit === 'degrade' && degradeAt === 'warn' && canDegrade) {
      return { action: 'degrade', ...base, targetModel: target, reason: `${highest.scope} budget at ${Math.round(highest.ratio * 100)}%; degrading ${model} -> ${target}` };
    }
    return { action: 'warn', ...base, targetModel: null, reason: `${highest.scope} ${highest.metric === 'tokens' ? 'token ' : ''}budget at ${Math.round(highest.ratio * 100)}%` };
  }

  return allow(`highest ${highest.scope} ${highest.metric === 'tokens' ? 'token ' : ''}budget at ${Math.round(highest.ratio * 100)}%`, highest);
}

function allow(reason, highest = null) {
  return {
    action: 'allow',
    over: false,
    scope: highest?.scope ?? null,
    metric: highest?.metric ?? 'usd',
    ratio: highest?.ratio ?? 0,
    cap: highest?.cap ?? null,
    spent: highest?.spent ?? 0,
    targetModel: null,
    reason,
  };
}

/**
 * Ratios for the status surfaces (no policy applied).
 * @param {{session: number, daily: number, monthly: number}} totals
 * @param {object} budgets
 */
export function budgetRatios(totals, budgets) {
  const out = {};
  for (const scope of SCOPES) {
    const cap = budgets[scope] ?? null;
    out[scope] = { spent: totals[scope] ?? 0, cap, ratio: ratioOf(totals[scope] ?? 0, cap) };
  }
  return out;
}

/**
 * Token ratios for the status surfaces. Each entry also carries the full
 * breakdown so the panel can render cached vs uncached vs output without a
 * second request.
 * @param {{session: object, daily: object, monthly: object}} tokenTotals
 * @param {object} [tokenBudgets]
 */
export function tokenRatios(tokenTotals, tokenBudgets = {}) {
  const out = {};
  for (const scope of SCOPES) {
    const summary = tokenTotals?.[scope] ?? { totalTokens: 0 };
    const spent = summary.totalTokens ?? 0;
    const cap = tokenBudgets?.[scope] ?? null;
    out[scope] = { ...summary, cap, ratio: ratioOf(spent, cap) };
  }
  return out;
}
