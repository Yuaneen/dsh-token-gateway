/**
 * Pricing, peak/off-peak windows, and money formatting.
 *
 * The built-in table is a *snapshot* of DeepSeek's published peak rates in USD
 * per 1M tokens (same baseline used by dsh-budget). It is intentionally a
 * starting point: verify against the vendor pricing page and override through
 * `pricing.prices`. Off-peak applies `pricing.peak.offPeakMultiplier` (0.5 by
 * default, matching DeepSeek's half-price window).
 */

/** USD per 1M tokens, peak rates. */
export const BUILTIN_PRICES = Object.freeze({
  'deepseek-chat': { input: 0.27, cacheRead: 0.027, cacheWrite: 0.27, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, cacheRead: 0.055, cacheWrite: 0.55, output: 2.19 },
  'deepseek-flash': { input: 0.28, cacheRead: 0.0056, cacheWrite: 0.28, output: 1.12 },
  'deepseek-v4-flash': { input: 0.28, cacheRead: 0.0056, cacheWrite: 0.28, output: 1.12 },
  'deepseek-v4-flash-vision-exp': { input: 0.28, cacheRead: 0.0056, cacheWrite: 0.28, output: 1.12 },
  'deepseek-v4-pro': { input: 1.25, cacheRead: 0.042, cacheWrite: 1.25, output: 3.75 },
});

const WEEKDAY = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatterCache = new Map();

function formatter(timeZone, options) {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let found = formatterCache.get(key);
  if (found === undefined) {
    found = new Intl.DateTimeFormat('en-US', { timeZone, ...options });
    formatterCache.set(key, found);
  }
  return found;
}

function partsOf(at, timeZone, options) {
  const out = {};
  for (const part of formatter(timeZone, options).formatToParts(new Date(at))) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return out;
}

/**
 * Billing day in the configured zone, YYYY-MM-DD.
 * @param {number} at epoch milliseconds
 * @param {string} timeZone IANA zone
 */
export function dayKey(at, timeZone) {
  const parts = partsOf(at, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Billing month in the configured zone, YYYY-MM. */
export function monthKey(at, timeZone) {
  return dayKey(at, timeZone).slice(0, 7);
}

/**
 * Billing hour in the configured zone, YYYY-MM-DDTHH.
 * Sorts lexicographically inside one zone, which is what the series needs.
 * @param {number} at epoch milliseconds
 * @param {string} timeZone IANA zone
 */
export function hourKey(at, timeZone) {
  const parts = partsOf(at, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
}

function minuteOfDay(text) {
  const [hour, minute] = text.split(':').map(Number);
  return hour * 60 + minute;
}

/**
 * Whether `at` falls inside a configured peak window.
 * Weekends and holidays are off-peak even when a window matches the weekday.
 * @param {number} at epoch milliseconds
 * @param {object} peak pricing.peak config
 */
export function isPeak(at, peak) {
  if (!peak.enabled) return false;
  const zone = peak.timeZone;
  const day = dayKey(at, zone);
  if (peak.holidays.includes(day)) return false;

  const parts = partsOf(at, zone, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const weekday = WEEKDAY[parts.weekday];
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);

  return peak.windows.some((window) => {
    if (!window.days.includes(weekday)) return false;
    return minutes >= minuteOfDay(window.start) && minutes < minuteOfDay(window.end);
  });
}

function pickTable(pricing, provider, model) {
  const overrides = pricing.prices;
  // An override merges over the built-in entry of the same model, so a table
  // that only restates input/output keeps the published cache rates instead of
  // silently falling back to the (much higher) input rate for cached tokens.
  const builtin = Object.prototype.hasOwnProperty.call(BUILTIN_PRICES, model) ? BUILTIN_PRICES[model] : undefined;
  const keys = [`${provider}/${model}`, model];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      return { ...(builtin ?? {}), ...overrides[key], source: 'override' };
    }
  }
  if (builtin !== undefined) {
    return { ...builtin, source: 'builtin' };
  }
  return { ...pricing.defaultPrice, source: 'default' };
}

/**
 * Resolve one request's effective rates (USD per 1M tokens), already scaled by
 * the peak/off-peak tier.
 * @param {{provider: string, model: string}} route
 * @param {object} pricing resolved pricing config
 * @param {number} at epoch milliseconds
 */
export function priceForModel({ provider, model }, pricing, at) {
  const base = pickTable(pricing, provider, model);
  const peak = isPeak(at, pricing.peak);
  const multiplier = peak ? 1 : pricing.peak.offPeakMultiplier;
  const priced = base.source !== 'default' || base.priced === true;
  return {
    input: base.input * multiplier,
    output: base.output * multiplier,
    cacheRead: (base.cacheRead ?? base.input) * multiplier,
    cacheWrite: (base.cacheWrite ?? base.input) * multiplier,
    tier: peak ? 'peak' : 'off-peak',
    source: base.source,
    priced,
  };
}

/**
 * Cost of one usage record in USD. Cache buckets are disjoint from `inputTokens`
 * (DSH's TokenUsage contract), so each bucket is priced exactly once.
 * @param {object} usage DSH TokenUsage
 * @param {object} price result of priceForModel
 */
export function costOf(usage, price) {
  if (!price.priced) return 0;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  return (
    (input * price.input + output * price.output + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite) /
    1_000_000
  );
}

/** Compact token count: 1.2k / 3.4M. */
export function formatTokens(tokens) {
  const value = Math.max(0, Math.round(tokens));
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** Convert USD to the display currency. */
export function formatMoney(usd, currency) {
  const value = usd * currency.rate;
  return `${value.toFixed(currency.decimals)} ${currency.code}`;
}
