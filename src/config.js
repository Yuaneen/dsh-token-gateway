/**
 * Configuration defaults and validation for dsh-token-gateway.
 *
 * The plugin deliberately has no runtime dependencies: DSH loads it with the
 * plain object below, and this module fails loud on any invalid value instead
 * of silently falling back to a default that would weaken a budget.
 *
 * Money is accounted in USD internally (matching most provider price tables);
 * `currency` only converts for display.
 */

const DEFAULT_CONFIG = Object.freeze({
  /** Display currency; accounting stays in USD. */
  currency: { code: 'CNY', rate: 7.2, decimals: 3 },

  /** Budget caps in USD per scope; null or omitted = unlimited. */
  budgets: { session: 2, daily: 10, monthly: 100 },

  /** Fraction of a cap that raises the first warning. */
  warnRatio: 0.8,

  /** alert | block | degrade */
  overLimit: 'block',

  /** Model id -> cheaper model id of the SAME provider. */
  degradation: {},

  /** warn | hard: when to start degrading (only for overLimit=degrade). */
  degradeAt: 'warn',

  pricing: {
    /** Per-model price overrides: USD per 1M tokens. */
    prices: {},
    /** Fallback for models absent from both tables. priced=false contributes 0. */
    defaultPrice: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1, priced: false },
    peak: {
      enabled: true,
      timeZone: 'Asia/Shanghai',
      /** Off-peak multiplier applied to the built-in (peak) table. */
      offPeakMultiplier: 0.5,
      /** Beijing working-hour peak windows. */
      windows: [
        { days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
        { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' },
      ],
      /** YYYY-MM-DD dates billed as off-peak all day. */
      holidays: [],
    },
  },

  gateway: {
    /** Expose the read-only control API on the DSH web host. */
    http: true,
    /** Mount point; must be an absolute path without a trailing slash. */
    basePath: '/token-gateway',
    /** Bearer token for the control API; empty = loopback/MVP mode. */
    token: '',
  },

  persistence: {
    enabled: true,
    /** $DSH_HOME and ~ are expanded at load time. */
    file: '$DSH_HOME/token-gateway/ledger.json',
    flushMs: 500,
  },

  /** Minimum gap between two warnings for the same scope. */
  alertCooldownMs: 60_000,
});

const OVER_LIMIT = new Set(['alert', 'block', 'degrade']);
const DEGRADE_AT = new Set(['warn', 'hard']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = clone(item);
    return out;
  }
  return value;
}

/** Deep-merge user input over defaults. Arrays and null replace, they never merge. */
function merge(base, patch) {
  if (patch === undefined) return clone(base);
  if (!isPlainObject(base) || !isPlainObject(patch)) return clone(patch);
  const out = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in out ? merge(out[key], value) : clone(value);
  }
  return out;
}

function assertNumber(value, label, { min = 0, max = Number.POSITIVE_INFINITY, allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined)) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`dsh-token-gateway: ${label} must be a finite number in [${min}, ${max}]${allowNull ? ' or null' : ''}, got ${JSON.stringify(value)}`);
  }
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`dsh-token-gateway: ${label} must be a non-empty string`);
  }
}

function validateWindow(window, index) {
  if (!isPlainObject(window)) throw new TypeError(`dsh-token-gateway: pricing.peak.windows[${index}] must be an object`);
  if (!Array.isArray(window.days) || window.days.length === 0 || window.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw new TypeError(`dsh-token-gateway: pricing.peak.windows[${index}].days must be a non-empty array of 1..7`);
  }
  for (const key of ['start', 'end']) {
    if (typeof window[key] !== 'string' || !/^\d{2}:\d{2}$/.test(window[key])) {
      throw new TypeError(`dsh-token-gateway: pricing.peak.windows[${index}].${key} must be HH:MM`);
    }
  }
  if (toMinutes(window.start) >= toMinutes(window.end)) {
    throw new TypeError(`dsh-token-gateway: pricing.peak.windows[${index}] start must precede end`);
  }
}

function toMinutes(text) {
  const [hour, minute] = text.split(':').map(Number);
  return hour * 60 + minute;
}

function validatePrice(entry, label) {
  if (!isPlainObject(entry)) throw new TypeError(`dsh-token-gateway: ${label} must be an object`);
  for (const key of ['input', 'output']) {
    if (typeof entry[key] !== 'number' || !Number.isFinite(entry[key]) || entry[key] < 0) {
      throw new TypeError(`dsh-token-gateway: ${label}.${key} must be a non-negative number`);
    }
  }
  for (const key of ['cacheRead', 'cacheWrite']) {
    if (entry[key] !== undefined) {
      if (typeof entry[key] !== 'number' || !Number.isFinite(entry[key]) || entry[key] < 0) {
        throw new TypeError(`dsh-token-gateway: ${label}.${key} must be a non-negative number`);
      }
    }
  }
}

/**
 * Resolve raw plugin configuration into a validated, plain object.
 * @param {object} [input]
 * @returns {object}
 */
export function resolveConfig(input = {}) {
  if (input !== undefined && !isPlainObject(input)) {
    throw new TypeError('dsh-token-gateway: config must be an object');
  }
  const config = merge(DEFAULT_CONFIG, input);

  for (const section of ['budgets', 'currency', 'pricing', 'gateway', 'persistence']) {
    if (!isPlainObject(config[section])) {
      throw new TypeError(`dsh-token-gateway: ${section} must be an object`);
    }
  }
  if (!isPlainObject(config.pricing.peak)) {
    throw new TypeError('dsh-token-gateway: pricing.peak must be an object');
  }

  for (const scope of ['session', 'daily', 'monthly']) {
    assertNumber(config.budgets[scope], `budgets.${scope}`, { allowNull: true });
    if (config.budgets[scope] === 0) {
      throw new TypeError(`dsh-token-gateway: budgets.${scope} must be positive or null (0 is not a cap)`);
    }
  }

  assertNumber(config.warnRatio, 'warnRatio', { max: 1 });
  if (!OVER_LIMIT.has(config.overLimit)) {
    throw new TypeError(`dsh-token-gateway: overLimit must be one of ${[...OVER_LIMIT].join(', ')}`);
  }
  if (!DEGRADE_AT.has(config.degradeAt)) {
    throw new TypeError(`dsh-token-gateway: degradeAt must be warn or hard`);
  }

  if (!isPlainObject(config.degradation)) {
    throw new TypeError('dsh-token-gateway: degradation must be an object mapping model id to a cheaper model id');
  }
  for (const [from, to] of Object.entries(config.degradation)) {
    assertString(from, 'degradation key');
    assertString(to, `degradation["${from}"]`);
  }

  assertString(config.currency.code, 'currency.code');
  assertNumber(config.currency.rate, 'currency.rate', { min: Number.EPSILON });
  assertNumber(config.currency.decimals, 'currency.decimals', { max: 6 });
  if (!Number.isInteger(config.currency.decimals)) {
    throw new TypeError('dsh-token-gateway: currency.decimals must be an integer');
  }

  if (!isPlainObject(config.pricing.prices)) {
    throw new TypeError('dsh-token-gateway: pricing.prices must be an object');
  }
  for (const [model, entry] of Object.entries(config.pricing.prices)) {
    validatePrice(entry, `pricing.prices["${model}"]`);
  }
  validatePrice(config.pricing.defaultPrice, 'pricing.defaultPrice');

  const peak = config.pricing.peak;
  if (!Array.isArray(peak.windows) || peak.windows.length === 0) {
    throw new TypeError('dsh-token-gateway: pricing.peak.windows must be a non-empty array');
  }
  peak.windows.forEach(validateWindow);
  assertNumber(peak.offPeakMultiplier, 'pricing.peak.offPeakMultiplier');
  if (!Array.isArray(peak.holidays) || peak.holidays.some((day) => typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day))) {
    throw new TypeError('dsh-token-gateway: pricing.peak.holidays must be an array of YYYY-MM-DD');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: peak.timeZone }).format(0);
  } catch {
    throw new TypeError(`dsh-token-gateway: pricing.peak.timeZone is not a valid IANA zone: ${peak.timeZone}`);
  }

  if (typeof config.gateway.http !== 'boolean') {
    throw new TypeError('dsh-token-gateway: gateway.http must be a boolean');
  }
  assertString(config.gateway.basePath, 'gateway.basePath');
  if (!config.gateway.basePath.startsWith('/') || config.gateway.basePath.endsWith('/')) {
    throw new TypeError('dsh-token-gateway: gateway.basePath must start with "/" and not end with "/"');
  }
  if (typeof config.gateway.token !== 'string') {
    throw new TypeError('dsh-token-gateway: gateway.token must be a string');
  }

  assertString(config.persistence.file, 'persistence.file');
  assertNumber(config.persistence.flushMs, 'persistence.flushMs', { min: 0 });
  assertNumber(config.alertCooldownMs, 'alertCooldownMs');

  return config;
}

export { DEFAULT_CONFIG, toMinutes };
