import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * The browser half is a plain artifact, not a module: nothing imports it, so a
 * typo would only ever surface in the user's page. These tests execute it the
 * way the harness does — through `window.__ModuleLoader__.load` — against a
 * minimal React runtime, then drive `apply()` and mount the capsule.
 */

const SOURCE = readFileSync(new URL('../src/client/panel.js', import.meta.url), 'utf8');

/* ------------------------------------------------------------ react shim --- */

/** Hook harness for the current mount; React hooks read through it. */
let current = null;

const createElement = (type, props, ...children) => ({ type, props: { ...props, children } });

const reactShim = {
  createElement,
  useState(initial) {
    const index = current.index++;
    // Bind the setter to this mount, not to whatever render happens to be
    // current when a handler runs after the initial render.
    const harness = current;
    if (!(index in harness.cells)) harness.cells[index] = typeof initial === 'function' ? initial() : initial;
    const set = (next) => {
      const value = typeof next === 'function' ? next(harness.cells[index]) : next;
      if (value !== harness.cells[index]) {
        harness.cells[index] = value;
        harness.dirty = true;
      }
    };
    return [harness.cells[index], set];
  },
  useEffect(effect) {
    current.index += 1;
    current.pendingEffects.push(effect);
  },
  useRef(initial) {
    const index = current.index++;
    if (!(index in current.refs)) current.refs[index] = { current: initial };
    return current.refs[index];
  },
  useCallback(fn) {
    current.index += 1;
    return fn;
  },
  useMemo(fn) {
    current.index += 1;
    return fn();
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    current.index += 1;
    return getSnapshot();
  },
};

/**
 * Mount a component: render, run its mount effects once, let promise work
 * settle, then re-render while state changed. `rerender()` replays a render
 * without re-running effects, which is what a click handler triggers.
 */
async function mount(component, props) {
  const harness = { cells: {}, refs: {}, index: 0, pendingEffects: [], dirty: false, mounted: false };
  const cleanups = [];

  const draw = () => {
    harness.index = 0;
    current = harness;
    const tree = component(props);
    const effects = harness.pendingEffects;
    harness.pendingEffects = [];
    return { tree, effects };
  };

  let { tree, effects } = draw();
  for (const effect of effects) {
    const cleanup = effect();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  }
  harness.mounted = true;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));
    if (!harness.dirty) break;
    harness.dirty = false;
    ({ tree } = draw());
    harness.pendingEffects = [];
  }
  current = null;

  return {
    tree,
    rerender() {
      harness.dirty = false;
      ({ tree } = draw());
      harness.pendingEffects = [];
      return tree;
    },
    unmount() {
      for (const cleanup of cleanups) cleanup();
    },
  };
}

/* ---------------------------------------------------------------- helpers --- */

/**
 * React would execute function components while rendering; the shim keeps them
 * as element types, so walkers expand them on the way down. Every component in
 * the card below `Capsule` is a pure function, which keeps this honest.
 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object' || Array.isArray(node)) return node;
  if (typeof node.type === 'function') return expand(node.type(node.props ?? {}));
  return node;
}

function textOf(node, out = []) {
  node = expand(node);
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) textOf(item, out);
    return out;
  }
  if (typeof node === 'object' && node.props !== undefined) textOf(node.props.children, out);
  return out;
}

function findAll(node, predicate, out = []) {
  node = expand(node);
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  findAll(node.props?.children, predicate, out);
  return out;
}

const findOne = (node, predicate) => findAll(node, predicate)[0];

function loadBundle() {
  const captured = [];
  const portals = [];
  const reactDomShim = {
    createPortal(node, container) {
      portals.push({ node, container });
      return node;
    },
  };
  /** Document listeners the widget registers, keyed by event type. */
  const listeners = {};
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          captured.push(definition);
        },
      },
    },
    document: {
      visibilityState: 'visible',
      body: {},
      head: { appendChild() {} },
      getElementById: () => null,
      createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
      addEventListener(type, fn) {
        (listeners[type] ??= []).push(fn);
      },
      removeEventListener(type, fn) {
        const list = listeners[type];
        const at = list === undefined ? -1 : list.indexOf(fn);
        if (at !== -1) list.splice(at, 1);
      },
    },
    navigator: { language: 'zh-CN' },
    fetch: async (url) => {
      if (String(url) === '/_dsh-token-gateway/config') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { basePath: '/token-gateway', auth: 'none' } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: null }) };
    },
    encodeURIComponent,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    Date,
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    Intl,
    console,
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: 'src/client/panel.js' });
  assert.equal(captured.length, 1, 'the bundle must register exactly one factory');

  const [definition] = captured;
  const module = definition.factory((id) => {
    if (id === 'react') return reactShim;
    if (id === 'react-dom') return reactDomShim;
    throw new Error(`unexpected module-table request: ${id}`);
  });
  return { definition, module, sandbox, listeners, portals };
}

function fakeClientHost() {
  const state = { slots: [], dictionaries: [], effects: 0, injected: [] };
  const ctx = {
    effect(fn) {
      state.effects += 1;
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get(name) {
      if (name === 'locale') {
        return { register: (ns, dicts) => (state.dictionaries.push({ ns, dicts }), () => {}) };
      }
      return undefined;
    },
    slots: {
      inject(name, register) {
        state.injected.push(name);
        return register();
      },
      register(options, component) {
        state.slots.push({ options, component });
        return () => {};
      },
    },
  };
  return { ctx, state };
}

/**
 * The bundle resolves `fetch` from its own realm (the vm sandbox), so the stub
 * has to replace the sandbox binding, not the host global. Bootstrap is
 * answered first; the stats call receives `payload`.
 * @returns the recorded calls, so a test can assert the Session query or auth.
 */
function withFetch(sandbox, payload, run) {
  const original = sandbox.fetch;
  const calls = [];
  sandbox.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, headers: init.headers ?? {} });
    if (target === '/_dsh-token-gateway/config') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { basePath: '/token-gateway', auth: 'none' } }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ data: payload }) };
  };
  return Promise.resolve(run(calls)).finally(() => {
    sandbox.fetch = original;
  });
}

/** Wait for the async bootstrap/stats chain to settle in the browser shim. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

const SNAPSHOT = {
  generatedAt: '2026-11-25T12:00:00.000Z',
  sessionId: 's1',
  currency: { code: 'CNY', rate: 7.2, decimals: 3 },
  budgets: { session: 2, daily: 10, monthly: 100 },
  tokenBudgets: { session: 1_000_000, daily: null, monthly: null },
  warnRatio: 0.8,
  overLimit: 'block',
  totals: { session: 0.05, daily: 0.05, monthly: 0.05 },
  tokenTotals: {
    session: { totalTokens: 500_000, cacheReadTokens: 400_000, inputTokens: 50_000, outputTokens: 50_000, calls: 3 },
    daily: { totalTokens: 500_000, cacheReadTokens: 400_000, inputTokens: 50_000, outputTokens: 50_000, calls: 3 },
    monthly: { totalTokens: 500_000, cacheReadTokens: 400_000, inputTokens: 50_000, outputTokens: 50_000, calls: 3 },
  },
  allTime: { spentUsd: 1.25, totalTokens: 9_000_000, calls: 42 },
  cache: { promptTokens: 450_000, cacheHitRate: 400_000 / 450_000 },
  ratios: {
    session: { spent: 0.05, cap: 2, ratio: 0.025 },
    daily: { spent: 0.05, cap: 10, ratio: 0.005 },
    monthly: { spent: 0.05, cap: 100, ratio: 0.0005 },
  },
  tokenRatios: {
    session: { totalTokens: 500_000, cap: 1_000_000, ratio: 0.5 },
    daily: { totalTokens: 500_000, cap: null, ratio: null },
    monthly: { totalTokens: 500_000, cap: null, ratio: null },
  },
  models: [{ provider: 'deepseek-account', model: 'deepseek-flash', spentUsd: 0.05, tokens: 500_000, calls: 3 }],
  series: [{ key: '2026-11-25T12', totalTokens: 100_000 }, { key: '2026-11-25T13', totalTokens: 400_000 }],
};

/* ------------------------------------------------------------------ tests --- */

test('the bundle registers under the package name and takes React from the table', () => {
  const { definition, module } = loadBundle();
  assert.equal(definition.id, 'dsh-token-gateway');
  assert.deepEqual([...module.inject], ['slots']);
  assert.equal(typeof module.apply, 'function');
});

test('apply mounts the chip into the composer dock and registers dictionaries', () => {
  const { module } = loadBundle();
  const host = fakeClientHost();
  module.apply(host.ctx);

  assert.deepEqual(host.state.injected, ['conversation.composer.dock']);
  assert.equal(host.state.slots.length, 1);
  assert.equal(host.state.slots[0].options.name, 'conversation.composer.dock');
  assert.equal(host.state.slots[0].options.id, 'dsh-token-gateway');
  assert.equal(host.state.slots[0].options.locale, 'dsh-token-gateway');
  assert.equal(host.state.slots[0].component.name, 'DockChip');

  assert.equal(host.state.dictionaries.length, 1);
  const { ns, dicts } = host.state.dictionaries[0];
  assert.equal(ns, 'dsh-token-gateway');
  // Both languages must carry the same key set or one locale silently falls back.
  assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort());
});

test('apply survives a host without a locale service', () => {
  const { module } = loadBundle();
  const host = fakeClientHost();
  host.ctx.get = () => undefined;
  module.apply(host.ctx);

  assert.equal(host.state.slots.length, 1);
  assert.equal(host.state.slots[0].options.locale, undefined, 'no locale service means no locale prop');
  assert.equal(host.state.dictionaries.length, 0);
});

test('the chip polls the control plane and shows money by default', async () => {
  const { module, sandbox } = loadBundle();
  const host = fakeClientHost();
  module.apply(host.ctx);
  const DockChip = host.state.slots[0].component;

  await withFetch(sandbox, SNAPSHOT, async () => {
    const view = await mount(DockChip, {});
    const text = textOf(view.tree).join(' ');
    // Money is the default unit: 0.05 USD at rate 7.2 with 3 decimals.
    assert.match(text, /0\.360 CNY/);
    assert.doesNotMatch(text, /读取中/);
    view.unmount();
  });
});

test('the unit toggle switches the chip between money and tokens', async () => {
  const { module, sandbox } = loadBundle();
  const host = fakeClientHost();
  module.apply(host.ctx);
  const DockChip = host.state.slots[0].component;

  await withFetch(sandbox, SNAPSHOT, async () => {
    const view = await mount(DockChip, {});
    findOne(view.tree, (node) => node.props?.className === 'tg-chip').props.onClick();
    let tree = view.rerender();

    const buttons = findAll(tree, (node) => node.props?.className === 'tg-unit-btn');
    assert.equal(buttons.length, 2, 'the header must offer both units');
    const tokenButton = buttons.find((node) => textOf(node).join('').trim() === 'tok');
    assert.ok(tokenButton !== undefined, 'a tokens button must exist');

    tokenButton.props.onClick();
    tree = view.rerender();
    const text = textOf(tree).join(' ');
    assert.match(text, /500k\s+\/\s+1M tok/);
    // The other dimension stays visible in the hero.
    assert.match(text, /0\.360 CNY/);
    view.unmount();
  });
});

test('clicking the chip opens the popover with the token mix', async () => {
  const { module, sandbox, portals } = loadBundle();
  const host = fakeClientHost();
  module.apply(host.ctx);
  const DockChip = host.state.slots[0].component;

  await withFetch(sandbox, SNAPSHOT, async () => {
    const view = await mount(DockChip, {});
    const chip = findOne(view.tree, (node) => node.props?.className === 'tg-chip');
    assert.ok(chip !== undefined, 'the dock chip button must render');

    chip.props.onClick();
    const expanded = view.rerender();
    const text = textOf(expanded).join(' ');

    // The card leaves the dock's containing block: it must be portaled to the
    // document body, not rendered as a fixed child of the composer.
    assert.ok(
      portals.some((entry) => entry.container === sandbox.document.body),
      'the popover must portal to document.body',
    );
    assert.ok(
      findOne(expanded, (node) => node.props?.className === 'tg-ring') !== undefined,
      'the hero ring must render',
    );
    assert.match(text, /生效限额/);
    assert.match(text, /token 构成/);
    assert.match(text, /缓存命中/);
    assert.match(text, /400\.0k/); // cache-hit input
    assert.match(text, /50\.0k/); // output
    assert.match(text, /89%/); // hit rate 400k / 450k
    assert.match(text, /deepseek-flash/);
    assert.match(text, /累计/);
    view.unmount();
  });
});

test('a pointerdown inside the popover must not dismiss it', async () => {
  const { module, sandbox, listeners } = loadBundle();
  const host = fakeClientHost();
  module.apply(host.ctx);
  const DockChip = host.state.slots[0].component;

  await withFetch(sandbox, SNAPSHOT, async () => {
    const view = await mount(DockChip, {});
    findOne(view.tree, (node) => node.props?.className === 'tg-chip').props.onClick();
    view.rerender();

    const fire = (target) => {
      for (const fn of listeners.pointerdown ?? []) fn({ target });
    };

    // Clicking the chip's wrapper keeps the card open.
    fire({ closest: (selector) => (selector.includes('.tg-dock') ? { tag: 'div' } : null) });
    let tree = view.rerender();
    assert.ok(
      findOne(tree, (node) => node.props?.className === 'tg-card') !== undefined,
      'the popover must survive a click on the chip wrapper',
    );

    // The portaled card is outside .tg-dock, so containment must also accept it.
    fire({ closest: (selector) => (selector.includes('.tg-card') ? { tag: 'div' } : null) });
    tree = view.rerender();
    assert.ok(
      findOne(tree, (node) => node.props?.className === 'tg-card') !== undefined,
      'the popover must survive a click on its own portaled controls',
    );

    // Clicking elsewhere still dismisses it.
    fire({ closest: () => null });
    tree = view.rerender();
    assert.equal(
      findOne(tree, (node) => node.props?.className === 'tg-card'),
      undefined,
      'a click outside must dismiss the popover',
    );

    view.unmount();
  });
});

test('an unreachable control plane degrades to a message, not a crash', async () => {
  const { module, sandbox } = loadBundle();
  const host = fakeClientHost();
  module.apply(host.ctx);
  const DockChip = host.state.slots[0].component;

  const original = sandbox.fetch;
  sandbox.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  try {
    const view = await mount(DockChip, {});
    const text = textOf(view.tree).join(' ');
    assert.match(text, /控制面不可用/);
    view.unmount();
  } finally {
    sandbox.fetch = original;
  }
});

test('the chip scopes stats to the slot Session and the discovered basePath', async () => {
  const { module, sandbox } = loadBundle();
  const host = fakeClientHost();
  module.apply(host.ctx);
  const DockChip = host.state.slots[0].component;

  await withFetch(sandbox, SNAPSHOT, async (calls) => {
    const view = await mount(DockChip, { sessionId: 'session-x' });
    assert.ok(
      calls.some((call) => call.url === '/token-gateway/v1/stats?hours=24&session=session-x'),
      'the stats request must carry the slot Session, not rely on lastSessionId',
    );
    view.unmount();
  });
});

test('a protected control plane opens a token gate and retries with the token', async () => {
  const { module, sandbox } = loadBundle();
  const host = fakeClientHost();
  module.apply(host.ctx);
  const DockChip = host.state.slots[0].component;

  const original = sandbox.fetch;
  const calls = [];
  sandbox.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, headers: init.headers ?? {} });
    if (target === '/_dsh-token-gateway/config') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { basePath: '/token-gateway', auth: 'bearer' } }),
      };
    }
    if (init.headers?.authorization === 'Bearer s3cret') {
      return { ok: true, status: 200, json: async () => ({ data: SNAPSHOT }) };
    }
    return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
  };

  try {
    const view = await mount(DockChip, { sessionId: 's1' });
    assert.match(textOf(view.tree).join(' '), /需要访问令牌/);

    findOne(view.tree, (node) => node.props?.className === 'tg-chip').props.onClick();
    let tree = view.rerender();

    const input = findOne(tree, (node) => node.props?.className === 'tg-token-input');
    assert.ok(input !== undefined, 'the gate must render a token input');
    input.props.onChange({ target: { value: 's3cret' } });
    tree = view.rerender();

    const save = findOne(tree, (node) => node.props?.className === 'tg-token-save');
    assert.equal(save.props.disabled, false, 'a non-empty token enables Save');
    save.props.onClick();
    await tick();
    await tick();

    tree = view.rerender();
    assert.match(textOf(tree).join(' '), /0\.360 CNY/);
    assert.ok(
      calls.some((call) => call.headers?.authorization === 'Bearer s3cret'),
      'the retry must carry the pasted bearer token',
    );
    view.unmount();
  } finally {
    sandbox.fetch = original;
  }
});
