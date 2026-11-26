import assert from 'node:assert/strict';
import test from 'node:test';

import { costOf, dayKey, formatMoney, formatTokens, isPeak, priceForModel } from '../src/pricing.js';

const ZONE = 'Asia/Shanghai';
const PEAK = Date.parse('2026-11-16T10:00:00+08:00'); // Monday 10:00
const OFF = Date.parse('2026-11-16T12:30:00+08:00'); // Monday lunch
const WEEKEND = Date.parse('2026-11-14T10:00:00+08:00'); // Saturday
const HOLIDAY = Date.parse('2026-10-01T10:00:00+08:00'); // National Day

const peak = {
  enabled: true,
  timeZone: ZONE,
  offPeakMultiplier: 0.5,
  windows: [
    { days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
    { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' },
  ],
  holidays: ['2026-10-01'],
};

test('dayKey uses the billing zone', () => {
  assert.equal(dayKey(PEAK, ZONE), '2026-11-16');
  assert.equal(dayKey(Date.parse('2026-11-15T23:30:00+08:00'), ZONE), '2026-11-15');
  assert.equal(dayKey(Date.parse('2026-11-15T23:30:00+00:00'), ZONE), '2026-11-16');
});

test('peak windows are weekdays 09-12 and 14-18, weekends and holidays off-peak', () => {
  assert.equal(isPeak(PEAK, peak), true);
  assert.equal(isPeak(OFF, peak), false);
  assert.equal(isPeak(WEEKEND, peak), false);
  assert.equal(isPeak(HOLIDAY, peak), false);
  assert.equal(isPeak(PEAK, { ...peak, enabled: false }), false);
});

const pricing = {
  prices: {},
  defaultPrice: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1, priced: false },
  peak,
};

test('known model prices are peak in the window and half off-peak', () => {
  const onPeak = priceForModel({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, pricing, PEAK);
  const offPeak = priceForModel({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, pricing, OFF);

  assert.equal(onPeak.tier, 'peak');
  assert.equal(onPeak.input, 1.25);
  assert.equal(onPeak.output, 3.75);
  assert.equal(offPeak.tier, 'off-peak');
  assert.equal(offPeak.input, 0.625);
  assert.equal(offPeak.output, 1.875);
  assert.equal(onPeak.priced, true);
});

test('price overrides win over the built-in table, keyed by model or provider/model', () => {
  const custom = {
    ...pricing,
    prices: {
      'deepseek-v4-pro': { input: 9, output: 10, cacheRead: 1, cacheWrite: 2 },
      'other/foo': { input: 3, output: 4 },
    },
  };
  const pro = priceForModel({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, custom, OFF);
  assert.equal(pro.input, 4.5);
  assert.equal(pro.source, 'override');

  const foo = priceForModel({ provider: 'other', model: 'foo' }, custom, PEAK);
  assert.equal(foo.input, 3);
  assert.equal(foo.output, 4);
});

test('a partial override keeps the built-in cache rates', () => {
  const custom = {
    ...pricing,
    prices: { 'deepseek-v4-pro': { input: 2, output: 3 } },
  };
  const pro = priceForModel({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, custom, PEAK);
  assert.equal(pro.input, 2);
  assert.equal(pro.output, 3);
  assert.equal(pro.cacheRead, 0.042, 'cached input must not fall back to the overridden input rate');
  assert.equal(pro.cacheWrite, 1.25);

  // A model with no built-in entry still gets the documented fallback: the
  // cache buckets use the override's input rate.
  const foo = priceForModel({ provider: 'other', model: 'foo' }, { ...custom, prices: { foo: { input: 3, output: 4 } } }, PEAK);
  assert.equal(foo.cacheRead, 3);
  assert.equal(foo.cacheWrite, 3);
});

test('unknown models are unpriced and contribute zero', () => {
  const price = priceForModel({ provider: 'custom', model: 'mystery' }, pricing, PEAK);
  assert.equal(price.priced, false);
  assert.equal(costOf({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, price), 0);
});

test('cost prices each disjoint bucket exactly once', () => {
  const price = priceForModel({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, pricing, PEAK);
  const cost = costOf(
    { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
    price,
  );
  assert.equal(Number(cost.toFixed(6)), Number((1.25 + 3.75 + 0.042 + 1.25).toFixed(6)));
});

test('formatting helpers', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1_500), '1.5k');
  assert.equal(formatTokens(2_000_000), '2.00M');
  assert.equal(formatMoney(1, { code: 'CNY', rate: 7.2, decimals: 2 }), '7.20 CNY');
});
