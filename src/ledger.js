/**
 * In-memory spend ledger with a serializable snapshot.
 *
 * Buckets:
 *   - per session  -> the session budget scope
 *   - per day      -> the daily scope (billing day in the configured zone)
 *   - per month    -> the monthly scope
 *   - per model    -> cost attribution / `usage` output
 *
 * The ledger is deliberately dependency-free and synchronous; persistence is a
 * separate concern (see store.js) so tests can exercise accounting directly.
 */

import { dayKey, hourKey, monthKey } from './pricing.js';

const ZERO = Object.freeze({
  spentUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  calls: 0,
});

/** Hour buckets kept for the rolling series (8 days covers every day/week view). */
const HOUR_RETENTION = 8 * 24;

function emptyBucket() {
  return { ...ZERO };
}

function addUsage(bucket, usage, costUsd) {
  bucket.spentUsd += costUsd;
  bucket.inputTokens += usage.inputTokens ?? 0;
  bucket.outputTokens += usage.outputTokens ?? 0;
  bucket.cacheReadTokens += usage.cacheReadTokens ?? 0;
  bucket.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  bucket.calls += 1;
}

function tokensOf(bucket) {
  return bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens;
}

/**
 * One bucket as the read side wants it: every token class kept separate, plus
 * the derived totals the panel and the token budget both need.
 * @param {object} [bucket]
 */
function summaryOf(bucket) {
  if (bucket === undefined) {
    return { spentUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, calls: 0 };
  }
  return {
    spentUsd: bucket.spentUsd,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    cacheWriteTokens: bucket.cacheWriteTokens,
    totalTokens: tokensOf(bucket),
    calls: bucket.calls,
  };
}

export class Ledger {
  /** @param {{timeZone?: string}} [options] */
  constructor({ timeZone = 'Asia/Shanghai' } = {}) {
    this.timeZone = timeZone;
    /** @type {Map<string, ReturnType<typeof emptyBucket>>} */
    this.sessions = new Map();
    /** @type {Map<string, ReturnType<typeof emptyBucket>>} */
    this.days = new Map();
    /** @type {Map<string, ReturnType<typeof emptyBucket>>} */
    this.months = new Map();
    /** @type {Map<string, ReturnType<typeof emptyBucket>>} hour keys, for the series */
    this.hours = new Map();
    /** @type {Map<string, ReturnType<typeof emptyBucket>>} */
    this.models = new Map();
    /** scope -> spend at the moment the user lifted the block */
    this.overrides = new Map();
    /** scope -> token count at the moment the user lifted the block */
    this.tokenOverrides = new Map();
    /**
     * Delegated session -> its direct parent. A session budget belongs to the
     * root conversation: subagent spend must not create an independent bucket.
     * @type {Map<string, string>}
     */
    this.sessionParents = new Map();
  }

  /**
   * Remember that a delegated session belongs to a parent conversation.
   * @param {string} sessionId
   * @param {string} parentSessionId
   */
  setSessionRoot(sessionId, parentSessionId) {
    const id = String(sessionId || '');
    const parent = String(parentSessionId || '');
    if (id === '' || parent === '' || id === parent) return;
    this.sessionParents.set(id, parent);
  }

  /**
   * Resolve a session id to the root conversation that owns its budget.
   * Unknown ids are their own root, so ordinary sessions are unaffected.
   * @param {string} sessionId
   * @returns {string}
   */
  rootOf(sessionId) {
    let current = String(sessionId || '__global__');
    const seen = new Set();
    while (this.sessionParents.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.sessionParents.get(current);
    }
    return current;
  }

  /**
   * Record one metered model call.
   * @param {{sessionId: string, provider: string, model: string, usage: object, costUsd: number, at: number}} entry
   */
  record({ sessionId, provider, model, usage, costUsd, at }) {
    const session = this.rootOf(String(sessionId || '__global__'));
    const day = dayKey(at, this.timeZone);
    const month = monthKey(at, this.timeZone);
    const hour = hourKey(at, this.timeZone);
    const modelKey = `${provider}/${model}`;

    for (const [map, key] of [
      [this.sessions, session],
      [this.days, day],
      [this.months, month],
      [this.models, modelKey],
      [this.hours, hour],
    ]) {
      const bucket = map.get(key) ?? emptyBucket();
      addUsage(bucket, usage, costUsd);
      map.set(key, bucket);
    }

    // Keep the day map bounded; monthly totals are cheap and stay.
    if (this.days.size > 400) {
      const oldest = [...this.days.keys()].sort()[0];
      this.days.delete(oldest);
    }
    // Hour keys sort inside one zone, so the oldest few are the ones to drop.
    if (this.hours.size > HOUR_RETENTION) {
      for (const key of [...this.hours.keys()].sort().slice(0, this.hours.size - HOUR_RETENTION)) {
        this.hours.delete(key);
      }
    }
  }

  /**
   * Current spend for one session and the current day/month.
   * @param {string} sessionId
   * @param {number} at
   * @returns {{session: number, daily: number, monthly: number}}
   */
  totals(sessionId, at) {
    return {
      session: this.sessions.get(this.rootOf(String(sessionId || '__global__')))?.spentUsd ?? 0,
      daily: this.days.get(dayKey(at, this.timeZone))?.spentUsd ?? 0,
      monthly: this.months.get(monthKey(at, this.timeZone))?.spentUsd ?? 0,
    };
  }

  /** Spend for one scope only (used by `/gateway unblock`). */
  spentFor(scope, sessionId, at) {
    return this.totals(sessionId, at)[scope] ?? 0;
  }

  /**
   * Token totals per budget scope, with every class kept separate.
   * Mirrors `totals()`: same session id, same billing day/month keys.
   * @param {string} sessionId
   * @param {number} at
   * @returns {{session: object, daily: object, monthly: object}}
   */
  tokenTotals(sessionId, at) {
    return {
      session: summaryOf(this.sessions.get(this.rootOf(String(sessionId || '__global__')))),
      daily: summaryOf(this.days.get(dayKey(at, this.timeZone))),
      monthly: summaryOf(this.months.get(monthKey(at, this.timeZone))),
    };
  }

  /** Everything ever recorded, for the "cumulative" line in the panel. */
  allTime() {
    const total = emptyBucket();
    for (const bucket of this.months.values()) {
      total.spentUsd += bucket.spentUsd;
      total.inputTokens += bucket.inputTokens;
      total.outputTokens += bucket.outputTokens;
      total.cacheReadTokens += bucket.cacheReadTokens;
      total.cacheWriteTokens += bucket.cacheWriteTokens;
      total.calls += bucket.calls;
    }
    return summaryOf(total);
  }

  /**
   * Rolling hourly series ending at `at` (oldest first).
   * Gaps are real zeros: a quiet hour is not the same as a missing one.
   * @param {{at?: number, hours?: number}} [options]
   */
  series({ at = Date.now(), hours = 24 } = {}) {
    const span = Math.max(1, Math.min(24 * 8, Math.trunc(hours)));
    const start = at - (span - 1) * 3_600_000;
    const out = [];
    for (let index = 0; index < span; index += 1) {
      const key = hourKey(start + index * 3_600_000, this.timeZone);
      out.push({ key, ...summaryOf(this.hours.get(key)) });
    }
    return out;
  }

  /**
   * Lift a hard block until spending grows past the current watermark.
   * A daily or monthly watermark belongs to that period only: the next day or
   * month starts with no watermark, so a lift never raises a later cap.
   */
  setOverride(scope, spent, sessionId = '__global__', at = Date.now()) {
    const key = this.overrideKey(scope, sessionId, at);
    this.overrides.set(key, spent);
    this.prunePeriods(this.overrides, scope, key);
  }

  /** Lift a token-cap block; `unblock` sets both watermarks for a scope. */
  setTokenOverride(scope, tokens, sessionId = '__global__', at = Date.now()) {
    const key = this.overrideKey(scope, sessionId, at);
    this.tokenOverrides.set(key, tokens);
    this.prunePeriods(this.tokenOverrides, scope, key);
  }

  /**
   * Drop watermarks from earlier billing periods of the same global scope. A
   * new daily/monthly lift is the only live one; keeping old periods would grow
   * the snapshot forever without ever being read again.
   */
  prunePeriods(map, scope, keepKey) {
    if (scope === 'session') return;
    const prefix = `${scope}:`;
    for (const key of map.keys()) {
      if (key !== keepKey && key.startsWith(prefix)) map.delete(key);
    }
  }

  clearOverride(scope, sessionId = '__global__', at = Date.now()) {
    this.overrides.delete(this.overrideKey(scope, sessionId, at));
    this.tokenOverrides.delete(this.overrideKey(scope, sessionId, at));
  }

  /**
   * Session-scoped overrides are keyed by the root session; day/month by their
   * billing period. Keying by period is what makes `spent <= watermark`
   * meaningful: a watermark recorded yesterday must not lift today's cap, and a
   * delegated session must not get an independent session watermark.
   */
  overrideKey(scope, sessionId, at = Date.now()) {
    if (scope === 'session') return `session:${this.rootOf(sessionId)}`;
    const period = scope === 'daily' ? dayKey(at, this.timeZone) : monthKey(at, this.timeZone);
    return `${scope}:${period}`;
  }

  /** The override values policy.js expects, resolved for one session at `at`. */
  getOverrides(sessionId, at = Date.now()) {
    const out = {};
    for (const scope of ['session', 'daily', 'monthly']) {
      const value = this.overrides.get(this.overrideKey(scope, sessionId, at));
      if (typeof value === 'number') out[scope] = value;
    }
    return out;
  }

  /** Token watermarks for the same scopes (see `tokenTotals`). */
  getTokenOverrides(sessionId, at = Date.now()) {
    const out = {};
    for (const scope of ['session', 'daily', 'monthly']) {
      const value = this.tokenOverrides.get(this.overrideKey(scope, sessionId, at));
      if (typeof value === 'number') out[scope] = value;
    }
    return out;
  }

  /** @returns {Array<object>} per-model attribution, highest spend first */
  modelBreakdown() {
    return [...this.models.entries()]
      .map(([key, bucket]) => {
        const slash = key.indexOf('/');
        return {
          provider: slash === -1 ? '' : key.slice(0, slash),
          model: slash === -1 ? key : key.slice(slash + 1),
          ...summaryOf(bucket),
          tokens: tokensOf(bucket),
        };
      })
      .sort((a, b) => b.spentUsd - a.spentUsd);
  }

  /** Serializable state for the persistence layer. */
  serialize() {
    const dump = (map) => Object.fromEntries([...map.entries()].map(([key, value]) => [key, { ...value }]));
    return {
      version: 3,
      timeZone: this.timeZone,
      sessions: dump(this.sessions),
      days: dump(this.days),
      months: dump(this.months),
      hours: dump(this.hours),
      models: dump(this.models),
      overrides: Object.fromEntries(this.overrides),
      tokenOverrides: Object.fromEntries(this.tokenOverrides),
      sessionParents: Object.fromEntries(this.sessionParents),
    };
  }

  /** Restore a snapshot; corrupt or partial input is ignored bucket by bucket. */
  restore(state) {
    if (state === null || typeof state !== 'object') return false;
    const load = (map, source) => {
      if (source === null || typeof source !== 'object') return;
      for (const [key, value] of Object.entries(source)) {
        if (value === null || typeof value !== 'object') continue;
        const bucket = emptyBucket();
        for (const field of Object.keys(bucket)) {
          const number = value[field];
          if (typeof number === 'number' && Number.isFinite(number) && number >= 0) bucket[field] = number;
        }
        map.set(String(key), bucket);
      }
    };
    load(this.sessions, state.sessions);
    load(this.days, state.days);
    load(this.months, state.months);
    load(this.hours, state.hours);
    load(this.models, state.models);
    const loadOverrides = (map, source) => {
      if (source === null || typeof source !== 'object') return;
      for (const [key, value] of Object.entries(source)) {
        // Versions 2 and earlier stored `daily`/`monthly` without a billing
        // period. That watermark cannot be interpreted for any particular day,
        // so it is dropped instead of silently lifting a later period's cap.
        if (key === 'daily' || key === 'monthly') continue;
        if (typeof value === 'number' && Number.isFinite(value)) map.set(key, value);
      }
    };
    loadOverrides(this.overrides, state.overrides);
    // Version 1 snapshots have no token watermarks; an absent map is fine.
    loadOverrides(this.tokenOverrides, state.tokenOverrides);
    if (state.sessionParents !== null && typeof state.sessionParents === 'object') {
      for (const [session, parent] of Object.entries(state.sessionParents)) {
        this.setSessionRoot(session, parent);
      }
    }
    return true;
  }
}

export { summaryOf, tokensOf };
