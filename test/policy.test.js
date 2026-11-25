import assert from 'node:assert/strict';
import test from 'node:test';

import { budgetRatios, evaluateBudget, tokenRatios } from '../src/policy.js';

const base = {
  budgets: { session: 1, daily: 10, monthly: 100 },
  warnRatio: 0.8,
  overLimit: 'block',
  degradation: { expensive: 'cheap' },
  model: 'expensive',
};

test('allows well under the warn threshold', () => {
  const decision = evaluateBudget({ ...base, totals: { session: 0.1, daily: 1, monthly: 2 }, overrides: {} });
  assert.equal(decision.action, 'allow');
  assert.equal(decision.scope, 'session');
});

test('warns at the warn ratio without blocking', () => {
  const decision = evaluateBudget({ ...base, totals: { session: 0.8, daily: 1, monthly: 2 }, overrides: {} });
  assert.equal(decision.action, 'warn');
  assert.equal(decision.scope, 'session');
  assert.equal(decision.over, false);
});

test('blocks at the cap', () => {
  const decision = evaluateBudget({ ...base, totals: { session: 1, daily: 1, monthly: 2 }, overrides: {} });
  assert.equal(decision.action, 'block');
  assert.equal(decision.over, true);
});

test('alert policy never blocks', () => {
  const decision = evaluateBudget({ ...base, overLimit: 'alert', totals: { session: 2, daily: 1, monthly: 2 }, overrides: {} });
  assert.equal(decision.action, 'warn');
  assert.equal(decision.over, true);
});

test('degrade policy maps the model at warn or hard stage', () => {
  const warn = evaluateBudget({
    ...base,
    overLimit: 'degrade',
    degradeAt: 'warn',
    totals: { session: 0.9, daily: 1, monthly: 2 },
    overrides: {},
  });
  assert.equal(warn.action, 'degrade');
  assert.equal(warn.targetModel, 'cheap');

  const hard = evaluateBudget({
    ...base,
    overLimit: 'degrade',
    degradeAt: 'hard',
    totals: { session: 0.9, daily: 1, monthly: 2 },
    overrides: {},
  });
  assert.equal(hard.action, 'warn');

  const over = evaluateBudget({
    ...base,
    overLimit: 'degrade',
    degradeAt: 'hard',
    totals: { session: 1.5, daily: 1, monthly: 2 },
    overrides: {},
  });
  assert.equal(over.action, 'degrade');
  assert.equal(over.targetModel, 'cheap');
});

test('degrade without a mapping falls back to block at the cap', () => {
  const decision = evaluateBudget({
    ...base,
    overLimit: 'degrade',
    degradation: {},
    totals: { session: 1.5, daily: 1, monthly: 2 },
    overrides: {},
  });
  assert.equal(decision.action, 'block');
});

test('unblock watermark suppresses the block until spending grows', () => {
  const lifted = evaluateBudget({
    ...base,
    totals: { session: 1.2, daily: 1, monthly: 2 },
    overrides: { session: 1.2 },
  });
  assert.equal(lifted.action, 'warn');

  const again = evaluateBudget({
    ...base,
    totals: { session: 1.3, daily: 1, monthly: 2 },
    overrides: { session: 1.2 },
  });
  assert.equal(again.action, 'block');
});

test('the highest ratio wins across scopes', () => {
  const decision = evaluateBudget({
    ...base,
    totals: { session: 0.2, daily: 9.5, monthly: 10 },
    overrides: {},
  });
  assert.equal(decision.scope, 'daily');
  assert.equal(decision.action, 'warn');
});

test('no caps means unlimited', () => {
  const decision = evaluateBudget({
    ...base,
    budgets: { session: null, daily: null, monthly: null },
    totals: { session: 999, daily: 999, monthly: 999 },
    overrides: {},
  });
  assert.equal(decision.action, 'allow');
});

test('budgetRatios reports spend, cap and ratio per scope', () => {
  const ratios = budgetRatios({ session: 0.5, daily: 5, monthly: 50 }, base.budgets);
  assert.equal(ratios.session.ratio, 0.5);
  assert.equal(ratios.daily.ratio, 0.5);
  assert.equal(ratios.monthly.cap, 100);
});

/** Token totals shaped like Ledger.tokenTotals(). */
function tokens(total) {
  return { session: { totalTokens: total }, daily: { totalTokens: total }, monthly: { totalTokens: total } };
}

const tokenBase = { ...base, tokenBudgets: { session: 1_000_000, daily: null, monthly: null } };

test('token caps block independently of USD spend', () => {
  const decision = evaluateBudget({
    ...tokenBase,
    totals: { session: 0.01, daily: 1, monthly: 2 },
    tokenTotals: tokens(1_200_000),
    overrides: {},
    tokenOverrides: {},
  });
  assert.equal(decision.action, 'block');
  assert.equal(decision.scope, 'session');
  assert.equal(decision.metric, 'tokens');
  assert.match(decision.reason, /token budget exceeded/);
});

test('the heavier dimension decides which metric is reported', () => {
  const decision = evaluateBudget({
    ...base,
    tokenBudgets: { session: 20_000_000, daily: null, monthly: null },
    totals: { session: 5, daily: 1, monthly: 2 }, // 5x the USD cap
    tokenTotals: tokens(1_000_000), // 5% of the token cap
    overrides: {},
    tokenOverrides: {},
  });
  assert.equal(decision.action, 'block');
  assert.equal(decision.metric, 'usd');
});

test('a token watermark lifts a token block until tokens grow again', () => {
  const lifted = evaluateBudget({
    ...tokenBase,
    totals: { session: 0.01, daily: 1, monthly: 2 },
    tokenTotals: tokens(1_200_000),
    overrides: {},
    tokenOverrides: { session: 1_200_000 },
  });
  assert.equal(lifted.action, 'warn');

  const again = evaluateBudget({
    ...tokenBase,
    totals: { session: 0.01, daily: 1, monthly: 2 },
    tokenTotals: tokens(1_300_000),
    overrides: {},
    tokenOverrides: { session: 1_200_000 },
  });
  assert.equal(again.action, 'block');
});

test('tokenRatios carries the class breakdown next to the cap', () => {
  const ratios = tokenRatios(
    { daily: { totalTokens: 500, cacheReadTokens: 400, inputTokens: 100, outputTokens: 0, calls: 1 } },
    { daily: 1_000 },
  );
  assert.equal(ratios.daily.ratio, 0.5);
  assert.equal(ratios.daily.cacheReadTokens, 400);
  assert.equal(ratios.session.cap, null);
});
