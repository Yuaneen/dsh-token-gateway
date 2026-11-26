/**
 * dsh-token-gateway — the Web client half: a usage chip that sits inline in the
 * composer's dock row and expands into a usage popover.
 *
 * This file is the browser artifact itself, not a source that needs building:
 * the harness loads client bundles as a lazy CJS factory
 * (`window.__ModuleLoader__.load({ id, factory })`), and React comes from the
 * module table. Keeping it hand-written is what lets the package stay
 * dependency-free and build-free; `scripts/verify-pack.mjs` asserts the shape.
 *
 * `conversation.composer.dock` is an ordered list slot: the host registers its
 * own activity and usage pills there (`order: 0`, `1`), so registering at
 * `order: 2` puts this chip on the same line, in the same type, without a
 * floating box that would cover content or swallow clicks. The popover is
 * `position: fixed` and anchored to the measured chip rect, because that row
 * may clip overflow.
 *
 * The chip is a *view*: every number comes from the host ledger over
 * `GET {basePath}/v1/stats`, the same authority that meters and blocks calls.
 * Nothing is re-derived from conversation snapshots, so subagent, title and
 * compaction traffic is included and the figures survive a page reload.
 */

window.__ModuleLoader__.load({
  id: 'dsh-token-gateway',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-token-gateway';
    /** Fixed host route the panel reads before it knows `basePath`. */
    const BOOTSTRAP_PATH = '/_dsh-token-gateway/config';
    const DEFAULT_BASE_PATH = '/token-gateway';
    const POLL_MS = 5_000;
    const STYLE_ID = 'dsh-token-gateway/style';
    const SCOPES = ['session', 'daily', 'monthly'];

    const zh = {
      'pill.open': '打开 token 用量面板',
      'pill.peak': '峰',
      'pill.off': '谷',
      'card.title': 'Token 用量',
      'card.close': '关闭',
      'card.hero': '当前生效限额',
      'card.caps': '上限',
      'card.unit': '计量单位',
      'scope.session': '会话',
      'scope.daily': '今日',
      'scope.monthly': '本月',
      'card.composition': 'token 构成（今日）',
      'card.cached': '缓存命中',
      'card.fresh': '未命中输入',
      'card.output': '输出',
      'card.hitRate': '命中率',
      'card.spend': '花费',
      'card.session': '会话',
      'card.today': '今日',
      'card.month': '本月',
      'card.cumulative': '累计',
      'card.series': '最近 24 小时',
      'card.byModel': '按模型',
      'card.loading': '读取中…',
      'card.offline': '控制面不可用',
      'card.tokenRequired': '需要访问令牌',
      'card.tokenTitle': '访问令牌',
      'card.tokenHint': '控制面要求 token。粘贴 profile 里的 gateway.token 后读取用量。',
      'card.tokenPlaceholder': 'Bearer token',
      'card.tokenSave': '保存',
      'card.tokenClear': '清除',
      'card.tokenInvalid': 'token 无效，请重试',
      'card.tokenNote': '只保存在此浏览器。',
      'card.none': '还没有计量到调用',
      'card.noCap': '未设限额',
      'tone.ok': '正常',
      'tone.warn': '接近上限',
      'tone.over': '已超限',
    };

    const en = {
      'pill.open': 'Open the token usage panel',
      'pill.peak': 'peak',
      'pill.off': 'off',
      'card.title': 'Token usage',
      'card.close': 'Close',
      'card.hero': 'Binding cap',
      'card.caps': 'Caps',
      'card.unit': 'Unit',
      'scope.session': 'session',
      'scope.daily': 'today',
      'scope.monthly': 'month',
      'card.composition': 'Token mix (today)',
      'card.cached': 'cache hit',
      'card.fresh': 'uncached in',
      'card.output': 'output',
      'card.hitRate': 'hit rate',
      'card.spend': 'Spend',
      'card.session': 'Session',
      'card.today': 'Today',
      'card.month': 'Month',
      'card.cumulative': 'Total',
      'card.series': 'Last 24 hours',
      'card.byModel': 'By model',
      'card.loading': 'Loading…',
      'card.offline': 'Control plane unavailable',
      'card.tokenRequired': 'Token required',
      'card.tokenTitle': 'Access token',
      'card.tokenHint': 'The control plane requires a token. Paste gateway.token to read usage.',
      'card.tokenPlaceholder': 'Bearer token',
      'card.tokenSave': 'Save',
      'card.tokenClear': 'Clear',
      'card.tokenInvalid': 'Invalid token, try again',
      'card.tokenNote': 'Stored in this browser only.',
      'card.none': 'no metered calls yet',
      'card.noCap': 'no cap',
      'tone.ok': 'normal',
      'tone.warn': 'near cap',
      'tone.over': 'over cap',
    };

    /** The host locale service is optional; fall back to the browser language. */
    function fallbackT(key) {
      const language = String((typeof navigator === 'object' && navigator?.language) || 'en').toLowerCase();
      const dict = language.startsWith('zh') ? zh : en;
      return dict[key] ?? key;
    }

    /* ------------------------------------------------------------ formatting */

    function formatTokens(count) {
      const value = Math.max(0, Math.round(Number(count) || 0));
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
      if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
      return String(value);
    }

    function formatMoney(usd, currency) {
      const rate = Number(currency?.rate ?? 1);
      const decimals = Number.isInteger(currency?.decimals) ? currency.decimals : 3;
      const value = (Number(usd) || 0) * rate;
      const shown = value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toFixed(decimals);
      return `${shown} ${currency?.code ?? 'USD'}`;
    }

    function formatPercent(ratio) {
      if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
      return `${Math.round(ratio * 100)}%`;
    }

    function toneOf(ratio, warnRatio) {
      if (!Number.isFinite(ratio)) return 'ok';
      if (ratio >= 1) return 'over';
      return ratio >= (warnRatio ?? 0.8) ? 'warn' : 'ok';
    }

    /** One scope's binding cap: whichever dimension (USD or tokens) is worse. */
    function scopeBinding(data, scope) {
      const usd = data?.ratios?.[scope];
      const token = data?.tokenRatios?.[scope];
      const entries = [];
      if (usd !== undefined && usd.cap !== null) {
        entries.push({ metric: 'usd', spent: usd.spent ?? 0, cap: usd.cap, ratio: usd.ratio ?? 0 });
      }
      if (token !== undefined && token.cap !== null) {
        entries.push({ metric: 'tokens', spent: token.totalTokens ?? 0, cap: token.cap, ratio: token.ratio ?? 0 });
      }
      const best = entries.sort((a, b) => b.ratio - a.ratio)[0];
      return best === undefined ? null : { scope, ...best };
    }

    /** The worst scope, used by the capsule and the hero ring. */
    function globalBinding(data) {
      return SCOPES
        .map((scope) => scopeBinding(data, scope))
        .filter((entry) => entry !== null)
        .sort((a, b) => b.ratio - a.ratio)[0] ?? null;
    }

    /** Tokens without a trailing `.0`, so the dock row stays on one line. */
    function compactTokens(count) {
      const value = Math.max(0, Number(count) || 0);
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
      if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
      return String(Math.round(value));
    }

    function bindingValues(binding, currency) {
      if (binding === null) return { spend: '—', limit: '—', unit: '' };
      return binding.metric === 'tokens'
        ? { spend: compactTokens(binding.spent), limit: `${compactTokens(binding.cap)} tok`, unit: '' }
        : { spend: formatMoney(binding.spent, currency), limit: formatMoney(binding.cap, currency), unit: '' };
    }

    /* ---------------------------------------------------------- display unit */

    /**
     * The chip tracks one dimension at a time: tokens or money. The choice is a
     * per-browser preference (localStorage), because it is a reading habit, not
     * a deployment fact — the caps themselves stay in the host config.
     */
    const UNIT_KEY = 'dsh-token-gateway:unit';

    function readUnit() {
      try {
        const value = typeof localStorage === 'object' && localStorage !== null ? localStorage.getItem(UNIT_KEY) : null;
        return value === 'tokens' || value === 'usd' ? value : null;
      } catch {
        return null;
      }
    }

    function writeUnit(value) {
      try {
        if (typeof localStorage === 'object' && localStorage !== null) localStorage.setItem(UNIT_KEY, value);
      } catch {
        /* private mode: the toggle still applies to this page */
      }
    }

    /**
     * The control-plane bearer token. It is never shipped in the page: the
     * reader pastes it once and it stays in this browser's localStorage.
     */
    const TOKEN_KEY = 'dsh-token-gateway:token';

    function readToken() {
      try {
        const value = typeof localStorage === 'object' && localStorage !== null ? localStorage.getItem(TOKEN_KEY) : null;
        return typeof value === 'string' ? value : '';
      } catch {
        return '';
      }
    }

    function writeToken(value) {
      try {
        if (typeof localStorage !== 'object' || localStorage === null) return;
        if (value === '') localStorage.removeItem(TOKEN_KEY);
        else localStorage.setItem(TOKEN_KEY, value);
      } catch {
        /* private mode: the token still works for this page */
      }
    }

    /** Every scope entry of one unit that actually has a cap. */
    function entriesOf(data, unit) {
      const out = [];
      for (const scope of SCOPES) {
        const source = unit === 'tokens' ? data?.tokenRatios?.[scope] : data?.ratios?.[scope];
        const cap = source?.cap;
        if (cap === null || cap === undefined) continue;
        out.push({
          scope,
          metric: unit,
          spent: unit === 'tokens' ? (source.totalTokens ?? 0) : (source.spent ?? 0),
          cap,
          ratio: source.ratio ?? 0,
        });
      }
      return out;
    }

    /**
     * Worst scope in the requested unit. When that unit has no caps configured at
     * all we fall back to the other one rather than showing an empty chip.
     */
    function bindingFor(data, unit) {
      const own = entriesOf(data, unit).sort((a, b) => b.ratio - a.ratio)[0];
      return own ?? globalBinding(data);
    }

    /** Peak/off-peak is a host pricing concept; recompute it for the badge only. */
    function isPeakNow() {
      const now = new Date();
      const weekday = now.getDay() === 0 ? 7 : now.getDay();
      if (weekday > 5) return false;
      const minutes = now.getHours() * 60 + now.getMinutes();
      return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
    }

    /* -------------------------------------------------------------- fetching */

    /**
     * The panel must discover the configured mount point before it can call the
     * control plane, and learn whether a bearer token is required. The host
     * serves this on a fixed path so changing `gateway.basePath` cannot strand
     * the panel; the payload contains neither spend nor credentials.
     */
    async function readConfig() {
      const response = await fetch(BOOTSTRAP_PATH, { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const data = body?.data ?? {};
      return {
        basePath: typeof data.basePath === 'string' && data.basePath.startsWith('/') ? data.basePath : DEFAULT_BASE_PATH,
        auth: data.auth === 'bearer' ? 'bearer' : 'none',
      };
    }

    function useStats(sessionId, token) {
      const [state, setState] = React.useState({ data: null, error: null, needsToken: false, invalid: false });
      const aliveRef = React.useRef(true);
      const configRef = React.useRef(null);
      const sessionRef = React.useRef(sessionId);
      const tokenRef = React.useRef(token);
      sessionRef.current = sessionId;
      tokenRef.current = token;

      const apply = (next) => {
        if (aliveRef.current) setState(next);
      };

      const load = async (overrideToken) => {
        const activeToken = overrideToken === undefined ? tokenRef.current : overrideToken;
        try {
          let config = configRef.current;
          if (config === null) {
            config = await readConfig();
            configRef.current = config;
          }
          if (config.auth === 'bearer' && activeToken === '') {
            apply({ data: null, error: null, needsToken: true, invalid: false });
            return;
          }
          const session = sessionRef.current;
          const suffix = typeof session === 'string' && session !== ''
            ? `?hours=24&session=${encodeURIComponent(session)}`
            : '?hours=24';
          const headers = { accept: 'application/json' };
          if (config.auth === 'bearer') headers.authorization = `Bearer ${activeToken}`;
          const response = await fetch(`${config.basePath}/v1/stats${suffix}`, { headers, cache: 'no-store' });
          if (response.status === 401) {
            if (config.auth === 'bearer') {
              apply({ data: null, error: null, needsToken: true, invalid: activeToken !== '' });
            } else {
              // Without a configured token the control plane is loopback-only;
              // asking for a token here would suggest one could help.
              apply({ data: null, error: 'unauthorized', needsToken: false, invalid: false });
            }
            return;
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          apply({ data: body.data, error: null, needsToken: false, invalid: false });
        } catch (error) {
          // Keep the last good snapshot on screen; surface the failure instead
          // of blanking the capsule.
          if (!aliveRef.current) return;
          setState((previous) => ({
            data: previous.data,
            error: String(error?.message ?? error),
            needsToken: false,
            invalid: false,
          }));
        }
      };

      React.useEffect(() => {
        aliveRef.current = true;
        load();
        const timer = setInterval(load, POLL_MS);
        const onVisibility = () => {
          if (document.visibilityState === 'visible') load();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
          aliveRef.current = false;
          clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisibility);
        };
      }, []);

      return { ...state, refresh: (next) => load(next) };
    }

    /* ------------------------------------------------------------ components */

    function Ring({ ratio, tone, size, stroke }) {
      return h('span', {
        className: 'tg-ring',
        'data-tone': tone,
        'data-size': size ?? 'sm',
        style: { '--tg-ratio': String(Math.min(1, Math.max(0, Number(ratio) || 0))), '--tg-stroke': `${stroke ?? 3}px` },
      });
    }

    /** Stacked composition bar: cache-hit / uncached in / out, as one shape. */
    function Composition({ daily, t }) {
      const cached = daily.cacheReadTokens ?? 0;
      const fresh = daily.inputTokens ?? 0;
      const out = daily.outputTokens ?? 0;
      const total = cached + fresh + out;
      const segments = [
        { key: 'cached', label: t('card.cached'), value: cached, tone: 'cache' },
        { key: 'fresh', label: t('card.fresh'), value: fresh, tone: 'fresh' },
        { key: 'output', label: t('card.output'), value: out, tone: 'output' },
      ];
      const hit = cached + fresh === 0 ? null : cached / (cached + fresh);

      return h(
        'div',
        { className: 'tg-composition' },
        h(
          'div',
          { className: 'tg-stack', role: 'img', 'aria-label': t('card.composition') },
          total === 0
            ? h('span', { className: 'tg-stack-empty' })
            : segments.map((segment) =>
              h('span', {
                key: segment.key,
                className: 'tg-stack-seg',
                'data-tone': segment.tone,
                // Percent widths, not flex-grow: grow factors in the millions
                // round to sub-pixel widths and the bar collapses.
                style: { width: `${(segment.value / total) * 100}%` },
                title: `${segment.label} · ${formatTokens(segment.value)}`,
              }),
            ),
        ),
        h(
          'div',
          { className: 'tg-legend' },
          segments.map((segment) =>
            h(
              'span',
              { className: 'tg-legend-item', key: segment.key },
              h('span', { className: 'tg-dot', 'data-tone': segment.tone }),
              h('span', { className: 'tg-legend-label' }, segment.label),
              h('span', { className: 'tg-legend-value' }, formatTokens(segment.value)),
            ),
          ),
        ),
        h('div', { className: 'tg-hitrate' }, `${t('card.hitRate')} ${formatPercent(hit)}`),
      );
    }

    function Sparkline({ points }) {
      const values = (points ?? []).map((point) => point.totalTokens ?? 0);
      if (values.length === 0) return null;
      const max = Math.max(...values, 1);
      return h(
        'div',
        { className: 'tg-spark', role: 'img' },
        values.map((value, index) =>
          h('span', {
            key: index,
            className: 'tg-spark-bar',
            'data-empty': value === 0 ? 'true' : undefined,
            style: { height: `${Math.max(3, (value / max) * 100)}%` },
            title: `${points[index].key} · ${formatTokens(value)} tok`,
          }),
        ),
      );
    }

    function Popover({ t, data, peak, onClose, unit, onUnit }) {
      const binding = bindingFor(data, unit);
      const tone = toneOf(binding?.ratio, data.warnRatio);
      const values = bindingValues(binding, data.currency);
      const daily = data.tokenTotals?.daily ?? {};
      const models = (data.models ?? []).slice(0, 3);

      // The other dimension stays visible: a token cap can be the real gate while
      // the reader is watching money, and the reverse.
      const otherUnit = unit === 'tokens' ? 'usd' : 'tokens';
      const otherBinding = entriesOf(data, otherUnit).sort((a, b) => b.ratio - a.ratio)[0] ?? null;
      const otherValues = otherBinding === null ? null : bindingValues(otherBinding, data.currency);

      const unitButton = (value, label) => h(
        'button',
        {
          type: 'button',
          className: 'tg-unit-btn',
          'data-active': unit === value ? 'true' : undefined,
          'aria-pressed': unit === value,
          onClick: () => onUnit(value),
        },
        label,
      );

      return h(
        'div',
        { className: 'tg-card', role: 'dialog', 'aria-label': t('card.title'), 'data-tone': tone, 'data-menu-material': '' },
        h(
          'header',
          { className: 'tg-head' },
          h('span', { className: 'tg-title' }, t('card.title')),
          h('span', { className: 'tg-band', 'data-peak': peak ? 'true' : undefined }, peak ? t('pill.peak') : t('pill.off')),
          h('div', { className: 'tg-units', role: 'group', 'aria-label': t('card.unit') }, unitButton('tokens', 'tok'), unitButton('usd', data.currency?.code ?? 'USD')),
          h(
            'button',
            { type: 'button', className: 'tg-icon-btn', 'aria-label': t('card.close'), title: t('card.close'), onClick: onClose },
            '✕',
          ),
        ),

        h(
          'section',
          { className: 'tg-hero', 'data-tone': tone },
          h(Ring, { ratio: binding?.ratio ?? 0, tone, size: 'lg', stroke: 4 }),
          h(
            'div',
            { className: 'tg-hero-body' },
            h('div', { className: 'tg-hero-label' }, `${t('card.hero')} · ${t(`card.${binding?.scope === 'daily' ? 'today' : binding?.scope === 'monthly' ? 'month' : 'session'}`)}`),
            h(
              'div',
              { className: 'tg-hero-value' },
              values.spend,
              h('span', { className: 'tg-hero-sep' }, ' / '),
              h('span', { className: 'tg-hero-cap' }, values.limit),
            ),
            h('div', { className: 'tg-hero-note' }, `${formatPercent(binding?.ratio)} · ${t(`tone.${tone}`)}`),
            otherValues === null
              ? null
              : h('div', { className: 'tg-hero-alt' }, `${otherValues.spend} / ${otherValues.limit} · ${formatPercent(otherBinding.ratio)}`),
          ),
        ),

        h('div', { className: 'tg-rule' }),
        h('div', { className: 'tg-section' }, t('card.caps')),
        SCOPES.map((scope) => {
          const entry = entriesOf(data, unit).find((item) => item.scope === scope) ?? null;
          const scopeValues = entry === null ? null : bindingValues(entry, data.currency);
          return h(
            'div',
            { className: 'tg-cap', key: scope },
            h('span', { className: 'tg-cap-label' }, t(`scope.${scope}`)),
            h('span', { className: 'tg-cap-value' }, scopeValues === null ? t('card.noCap') : `${scopeValues.spend} / ${scopeValues.limit}`),
            h('span', { className: 'tg-cap-ratio', 'data-tone': toneOf(entry?.ratio, data.warnRatio) }, formatPercent(entry?.ratio)),
          );
        }),

        h('div', { className: 'tg-rule' }),
        h('div', { className: 'tg-section' }, t('card.composition')),
        h(Composition, { daily, t }),

        h('div', { className: 'tg-rule' }),
        h(
          'div',
          { className: 'tg-grid' },
          [
            ['card.session', formatMoney(data.totals?.session, data.currency)],
            ['card.today', formatMoney(data.totals?.daily, data.currency)],
            ['card.month', formatMoney(data.totals?.monthly, data.currency)],
            ['card.cumulative', formatMoney(data.allTime?.spentUsd, data.currency)],
          ].map(([label, value]) =>
            h('div', { className: 'tg-cell', key: label }, h('div', { className: 'tg-cell-label' }, t(label)), h('div', { className: 'tg-cell-value' }, value)),
          ),
        ),

        h('div', { className: 'tg-rule' }),
        h('div', { className: 'tg-section' }, t('card.series')),
        h(Sparkline, { points: data.series }),

        models.length === 0
          ? null
          : h(
            'div',
            { className: 'tg-models' },
            h('div', { className: 'tg-section' }, t('card.byModel')),
            models.map((entry) =>
              h(
                'div',
                { className: 'tg-model', key: `${entry.provider}/${entry.model}` },
                h('span', { className: 'tg-model-name' }, entry.model),
                h('span', { className: 'tg-model-value' }, `${formatTokens(entry.tokens ?? entry.totalTokens)} · ${formatMoney(entry.spentUsd, data.currency)}`),
              ),
            ),
          ),

        h('div', { className: 'tg-foot' }, data.sessionId ?? ''),
      );
    }

    /**
     * The token gate is what the chip opens when the control plane is protected
     * but this browser has no stored token. The token never comes from the host
     * page: the reader pastes the same value as `gateway.token`.
     */
    function TokenGate({ t, value, invalid, hasToken, onChange, onSave, onClear, onClose }) {
      const submit = () => {
        const next = value.trim();
        if (next !== '') onSave(next);
      };

      return h(
        'div',
        {
          className: 'tg-card tg-token-card',
          role: 'dialog',
          'aria-label': t('card.tokenTitle'),
          'data-tone': 'ok',
          'data-menu-material': '',
        },
        h(
          'header',
          { className: 'tg-head' },
          h('span', { className: 'tg-title' }, t('card.tokenTitle')),
          h(
            'button',
            { type: 'button', className: 'tg-icon-btn', 'aria-label': t('card.close'), title: t('card.close'), onClick: onClose },
            '✕',
          ),
        ),
        h('p', { className: 'tg-token-hint' }, t('card.tokenHint')),
        h('input', {
          className: 'tg-token-input',
          type: 'password',
          value,
          placeholder: t('card.tokenPlaceholder'),
          'aria-label': t('card.tokenPlaceholder'),
          autoComplete: 'off',
          spellCheck: false,
          'aria-invalid': invalid ? 'true' : undefined,
          onChange: (event) => onChange(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') submit();
          },
        }),
        invalid ? h('div', { className: 'tg-token-error', role: 'alert' }, t('card.tokenInvalid')) : null,
        h(
          'div',
          { className: 'tg-token-actions' },
          h(
            'button',
            { type: 'button', className: 'tg-token-save', disabled: value.trim() === '', onClick: submit },
            t('card.tokenSave'),
          ),
          hasToken
            ? h('button', { type: 'button', className: 'tg-token-clear', onClick: onClear }, t('card.tokenClear'))
            : null,
        ),
        h('div', { className: 'tg-token-note' }, t('card.tokenNote')),
      );
    }

    /**
     * The dock chip. `conversation.composer.dock` is the row under the composer
     * where the host itself renders its activity and usage pills, so joining it
     * with a higher `order` puts this chip inline with them: same line, same
     * type, no floating box over the page.
     */
    function DockChip(props) {
      const t = typeof props?.t === 'function' ? props.t : fallbackT;
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined;
      // The slot supplies the Session identity; reading the server's
      // `lastSessionId` fallback would paint another Session after a switch.
      const [token, setToken] = React.useState(() => readToken());
      const { data, error, needsToken, invalid, refresh } = useStats(sessionId, token);
      const [open, setOpen] = React.useState(false);
      const [tokenDraft, setTokenDraft] = React.useState('');
      // Money by default: it is the unit a bill arrives in. The toggle below
      // remembers whatever the reader picks.
      const [unit, setUnit] = React.useState(() => readUnit() ?? 'usd');
      const chooseUnit = (value) => {
        setUnit(value);
        writeUnit(value);
      };
      const chooseToken = (value) => {
        setToken(value);
        writeToken(value);
        void refresh(value);
      };
      const clearToken = () => {
        setToken('');
        setTokenDraft('');
        writeToken('');
        void refresh('');
      };
      const [anchor, setAnchor] = React.useState(null);
      const chipRef = React.useRef(null);
      const rootRef = React.useRef(null);
      const openRef = React.useRef(false);
      openRef.current = open;

      /**
       * Whether a pointer landed inside this widget. The popover portals to the
       * document body (the docked composer is the containing block for fixed
       * descendants), so containment must accept either the chip's dock wrapper
       * or the portaled card.
       */
      const insideOf = (target) => {
        if (target !== null && target !== undefined && typeof target.closest === 'function') {
          return target.closest('.tg-dock, .tg-card') !== null;
        }
        const node = rootRef.current;
        return node !== null && node !== undefined && typeof node.contains === 'function' && node.contains(target);
      };

      // Escape and click-outside dismiss the popover; it never traps focus.
      // One listener pair for the widget's lifetime, gated on the live `open`
      // value, instead of re-registering on every toggle.
      React.useEffect(() => {
        const onKey = (event) => {
          if (openRef.current && event.key === 'Escape') setOpen(false);
        };
        const onPointer = (event) => {
          if (openRef.current && !insideOf(event.target)) setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onPointer);
        return () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('pointerdown', onPointer);
        };
      }, []);

      const binding = data === null ? null : bindingFor(data, unit);
      const tone = toneOf(binding?.ratio, data?.warnRatio);
      const values = binding === null || data === null ? null : bindingValues(binding, data.currency);

      /**
       * Anchor the popover to the chip. The docked composer is the containing
       * block for `position: fixed` descendants (it carries `will-change:
       * transform`), so the card portals to `document.body` and is positioned
       * from the measured viewport rect instead of the dock's flow.
       */
      const toggle = () => {
        const node = chipRef.current;
        const viewportWidth = typeof window === 'object' && typeof window.innerWidth === 'number' ? window.innerWidth : 0;
        const viewportHeight = typeof window === 'object' && typeof window.innerHeight === 'number' ? window.innerHeight : 0;
        if (node !== null && node !== undefined && typeof node.getBoundingClientRect === 'function' && viewportWidth > 0) {
          const rect = node.getBoundingClientRect();
          setAnchor({
            right: Math.max(8, viewportWidth - rect.right),
            bottom: Math.max(8, viewportHeight - rect.top + 8),
          });
        }
        setOpen((value) => !value);
      };

      /** Portal the card to the document body; fall back to inline if unavailable. */
      const withPortal = (content) => {
        const body = typeof document === 'object' && document !== null ? document.body : undefined;
        const style = { right: `${anchor?.right ?? 16}px`, bottom: `${anchor?.bottom ?? 72}px` };
        return body === undefined
          ? h('div', { className: 'tg-pop', style }, content)
          : createPortal(h('div', { className: 'tg-pop', style }, content), body);
      };

      const label = data === null
        ? (needsToken ? t('card.tokenRequired') : error === null ? t('card.loading') : t('card.offline'))
        : values === null
          ? t('card.noCap')
          : `${values.spend} / ${values.limit}`;

      return h(
        'div',
        { className: 'tg-dock', 'data-tone': tone, ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            className: 'tg-chip',
            ref: chipRef,
            title: needsToken ? t('card.tokenRequired') : data === null ? t('pill.open') : `${t('pill.open')} · ${data.sessionId}`,
            'aria-expanded': open,
            'aria-label': needsToken ? t('card.tokenRequired') : t('pill.open'),
            onClick: toggle,
          },
          h('span', { className: 'tg-chip-dot' }),
          h('span', { className: 'tg-chip-text' }, label),
          binding === null ? null : h('span', { className: 'tg-chip-pct' }, formatPercent(binding.ratio)),
        ),
        open && (data !== null || needsToken)
          ? withPortal(
            data !== null
              ? h(Popover, { t, data, peak: isPeakNow(), onClose: () => setOpen(false), unit, onUnit: chooseUnit })
              : h(TokenGate, {
                t,
                value: tokenDraft,
                invalid,
                hasToken: token !== '',
                onChange: setTokenDraft,
                onSave: chooseToken,
                onClear: clearToken,
                onClose: () => setOpen(false),
              }),
          )
          : null,
      );
    }

    /* ------------------------------------------------------------------ css */

    /**
     * Craft notes — every technique here has a plain fallback so the bar still
     * renders in an engine that lacks it:
     *   - `@property --tg-ratio` makes the ring gauge animatable; the conic
     *     gradient reads it, so a new reading glides instead of jumping.
     *   - `color-mix(in oklab, ...)` derives the whole palette from `--tg-tone`,
     *     so one tone switch recolours ring, pill tint and shadows together.
     *   - `light-dark()` follows the document's own `color-scheme`, which the
     *     theme presenter sets on `html`; no hard-coded dark-on-light.
     *   - the wrapper is `pointer-events: none`; only the pill and the popover
     *     opt back in, so the corner never eats clicks.
     */
    const CSS = `
@property --tg-ratio { syntax: "<number>"; inherits: false; initial-value: 0; }

/*
 * Every colour, radius, shadow and font comes from the host design system
 * ("--dsw-*", projected onto <body> by the theme presenter) with a plain
 * fallback, so the panel looks native in both schemes and still renders if a
 * token is absent. "var(--token, fallback)" also keeps older engines working:
 * a missing token falls back instead of invalidating the declaration.
 */
/* The dock chip inherits the row's type rather than imposing its own box, so it
   lines up with the host's activity/usage pills without changing the row height. */
.tg-dock {
  position: relative;
  display: inline-flex; align-items: center;
  pointer-events: auto;
  font-family: inherit;
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  line-height: inherit;
  color: var(--dsw-alias-label-tertiary, rgba(24, 24, 27, 0.45));
}

/*
 * The popover portals to <body>, outside the dock's subtree, so the design
 * tokens live on both roots. Only custom properties are shared; .tg-dock keeps
 * its inline-flex layout and .tg-card keeps its own box.
 */
.tg-dock, .tg-card {
  --tg-tone: var(--dsw-alias-state-success-primary, #16a34a);
  --tg-cat-cache: var(--dsw-static-green-500, #059669);
  --tg-cat-fresh: var(--dsw-static-blue-500, #2563eb);
  --tg-cat-output: var(--dsw-static-violet-600, #7c3aed);

  --tg-surface: var(--dsw-menu-surface-fill, rgba(255, 255, 255, 0.94));
  --tg-blur: var(--dsw-menu-backdrop-filter, blur(20px) saturate(160%));
  --tg-border: var(--dsw-elevation-stroke-color, rgba(24, 24, 27, 0.1));
  --tg-track: var(--dsw-alias-border-l2, rgba(24, 24, 27, 0.12));
  --tg-muted: var(--dsw-alias-label-tertiary, rgba(24, 24, 27, 0.45));
  --tg-hairline: var(--dsh-hairline-width, 1px);
  --tg-radius-card: var(--dsw-radius-lg, 16px);
  --tg-radius-cell: var(--dsw-radius-sm, 6px);
  --tg-card-shadow: var(--dsw-shadow-lv3, 0 12px 24px -12px rgba(0, 0, 0, 0.22), 0 32px 64px -24px rgba(0, 0, 0, 0.28));
  --tg-hover: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  --tg-focus: var(--dsw-focus-ring-color, #2563eb);
  --tg-focus-width: var(--dsw-focus-ring-width, 2px);
}
.tg-dock[data-tone="warn"], .tg-card[data-tone="warn"] { --tg-tone: var(--dsw-alias-state-warn-primary, #d97706); }
.tg-dock[data-tone="over"], .tg-card[data-tone="over"] { --tg-tone: var(--dsw-alias-state-error-primary, #dc2626); }

.tg-chip {
  display: inline-flex; align-items: center; gap: 5px;
  margin: 0 0 0 4px; padding: 1px 6px;
  border: 0; border-radius: var(--tg-radius-cell);
  background: transparent; color: inherit;
  font: inherit; line-height: inherit;
  font-variant-numeric: tabular-nums; white-space: nowrap;
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}
.tg-chip:hover { background: var(--tg-hover); color: var(--dsw-alias-label-secondary, rgba(24, 24, 27, 0.7)); }
.tg-chip:focus-visible { outline: var(--tg-focus-width) solid var(--tg-focus); outline-offset: 1px; }
.tg-chip-dot {
  width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: var(--tg-tone);
  box-shadow: 0 0 0 2px color-mix(in oklab, var(--tg-tone) 22%, transparent);
}
.tg-dock[data-tone="ok"] .tg-chip-dot { box-shadow: none; }
.tg-chip-text { font-weight: 500; }
.tg-chip-pct { opacity: 0.65; }

.tg-pop { position: fixed; z-index: 70; }

/* Hero ring: a conic gauge driven by the registered --tg-ratio custom property,
   so a new reading animates instead of jumping. The inner disc masks the centre
   with the card surface, leaving a stroke of --tg-stroke. */
.tg-ring {
  flex: none;
  display: inline-block;
  width: 40px; height: 40px;
  border-radius: 50%;
  background:
    radial-gradient(
      closest-side,
      var(--tg-surface) calc(100% - var(--tg-stroke, 3px)),
      transparent calc(100% - var(--tg-stroke, 3px) + 0.5px)
    ),
    conic-gradient(var(--tg-tone) calc(var(--tg-ratio, 0) * 1turn), var(--tg-track) 0);
  transition: --tg-ratio 400ms cubic-bezier(0.22, 1, 0.36, 1);
}
.tg-ring[data-size="lg"] { width: 44px; height: 44px; }

/* -------------------------------------------------------------- popover --- */
.tg-card {
  pointer-events: auto;
  width: min(320px, calc(100vw - 28px));
  max-height: min(72vh, 640px); overflow-y: auto; overscroll-behavior: contain;
  scrollbar-width: thin;
  padding: 12px 14px 10px;
  border: var(--tg-hairline) solid var(--tg-border);
  border-radius: var(--tg-radius-card);
  background: var(--tg-surface);
  -webkit-backdrop-filter: var(--tg-blur);
  backdrop-filter: var(--tg-blur);
  box-shadow: var(--tg-card-shadow);
  color: var(--dsw-alias-label-primary, #18181b);
  font-family: inherit;
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  transform-origin: 100% 100%;
  transition: opacity 170ms ease, transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
@starting-style {
  .tg-card { opacity: 0; transform: translateY(8px) scale(0.98); }
}

.tg-card::-webkit-scrollbar { width: 8px; }
.tg-card::-webkit-scrollbar-track { background: transparent; }
.tg-card::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: var(--dsw-alias-scrollbar-bg-l1, rgba(24, 24, 27, 0.18));
}
.tg-card::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l1, rgba(24, 24, 27, 0.3)); }

/* --------------------------------------------------------------- header --- */
.tg-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.tg-title {
  font-size: var(--dsw-font-xs-strong-13-font-size, 13px);
  font-weight: var(--dsw-font-xs-strong-13-font-weight, 600);
  letter-spacing: -0.01em;
}
.tg-band {
  font-size: var(--dsw-font-xxxs-11-font-size, 11px); line-height: 1; padding: 2px 5px;
  border-radius: var(--tg-radius-cell);
  background: var(--dsw-alias-bg-layer-2, rgba(24, 24, 27, 0.06));
  color: var(--tg-muted);
}
.tg-band[data-peak="true"] {
  background: color-mix(in oklab, var(--dsw-alias-state-warn-primary, #ea580c) 18%, transparent);
  color: var(--dsw-alias-state-warn-primary, #c2410c);
}
.tg-icon-btn {
  margin-left: 4px; display: grid; place-items: center;
  width: 22px; height: 22px; padding: 0;
  border: 0; border-radius: var(--tg-radius-cell); cursor: pointer;
  background: transparent; color: inherit; font-size: 10px; opacity: 0.45;
  transition: opacity 140ms ease, background-color 140ms ease;
}
.tg-icon-btn:hover { opacity: 0.9; background: var(--tg-hover); }
.tg-icon-btn:focus-visible { outline: var(--tg-focus-width) solid var(--tg-focus); outline-offset: 1px; }

/* ----------------------------------------------------------------- hero --- */
.tg-hero { display: flex; align-items: center; gap: 14px; }
.tg-hero-body { min-width: 0; }
.tg-hero-label {
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  letter-spacing: 0.04em;
  color: var(--tg-muted);
}
.tg-hero-value {
  font-size: var(--dsw-font-s-strong-14-font-size, 14px);
  font-weight: var(--dsw-font-s-strong-14-font-weight, 600);
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  margin-top: 1px;
}
.tg-hero-sep { opacity: 0.3; font-weight: 400; }
.tg-hero-cap { opacity: 0.5; font-weight: 500; }
.tg-hero-note { margin-top: 2px; font-size: var(--dsw-font-xxxs-11-font-size, 11px); font-variant-numeric: tabular-nums; color: var(--tg-tone); }
.tg-hero-alt { margin-top: 3px; font-size: var(--dsw-font-xxxs-11-font-size, 11px); font-variant-numeric: tabular-nums; color: var(--tg-muted); }

/* Token / money switch: a two-option segmented control in the card header. */
.tg-units {
  display: inline-flex; align-items: center; gap: 1px;
  margin-left: auto; padding: 2px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, rgba(24, 24, 27, 0.06));
}
.tg-unit-btn {
  padding: 1px 7px; border: 0; border-radius: 999px;
  background: transparent; color: var(--tg-muted);
  font: inherit; font-size: var(--dsw-font-xxxs-11-font-size, 11px); line-height: 1.6;
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}
.tg-unit-btn:hover { color: var(--dsw-alias-label-secondary, rgba(24, 24, 27, 0.7)); }
.tg-unit-btn[data-active="true"] {
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #18181b);
  box-shadow: var(--dsw-shadow-lv1, 0 1px 2px rgba(0, 0, 0, 0.1));
}
.tg-unit-btn:focus-visible { outline: var(--tg-focus-width) solid var(--tg-focus); outline-offset: 1px; }

/* One row per budget scope, in the currently selected unit. */
.tg-cap { display: flex; align-items: baseline; gap: 8px; padding: 1.5px 0; font-variant-numeric: tabular-nums; }
.tg-cap-label { flex: none; width: 2.6em; font-size: var(--dsw-font-xxxs-11-font-size, 11px); color: var(--tg-muted); }
.tg-cap-value { margin-left: auto; white-space: nowrap; }
.tg-cap-ratio { flex: none; width: 40px; text-align: right; color: var(--tg-muted); }
.tg-cap-ratio[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary, #b45309); }
.tg-cap-ratio[data-tone="over"] { color: var(--dsw-alias-state-error-primary, #b91c1c); font-weight: 600; }

.tg-rule { height: var(--tg-hairline); margin: 12px 0 10px; background: var(--tg-border); }
.tg-section {
  margin: 0 0 7px;
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--tg-muted);
}

/* ---------------------------------------------------------- composition --- */
.tg-stack {
  display: flex; gap: 2px; height: 8px;
  border-radius: 999px; overflow: hidden;
  background: var(--tg-track);
}
.tg-stack-empty { flex: 1; }
.tg-stack-seg { flex: none; min-width: 3px; border-radius: 2px; transition: width 400ms cubic-bezier(0.22, 1, 0.36, 1); }
.tg-stack-seg[data-tone="cache"] { background: var(--tg-cat-cache); }
.tg-stack-seg[data-tone="fresh"] { background: var(--tg-cat-fresh); }
.tg-stack-seg[data-tone="output"] { background: var(--tg-cat-output); }
.tg-legend { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 7px; }
.tg-legend-item { display: inline-flex; align-items: center; gap: 4px; font-size: var(--dsw-font-xxs-12-font-size, 12px); }
.tg-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.tg-dot[data-tone="cache"] { background: var(--tg-cat-cache); }
.tg-dot[data-tone="fresh"] { background: var(--tg-cat-fresh); }
.tg-dot[data-tone="output"] { background: var(--tg-cat-output); }
.tg-legend-label { color: var(--tg-muted); }
.tg-legend-value { font-variant-numeric: tabular-nums; font-weight: 600; }
.tg-hitrate { margin-top: 5px; font-size: var(--dsw-font-xxxs-11-font-size, 11px); font-variant-numeric: tabular-nums; color: var(--tg-muted); }

/* ----------------------------------------------------------------- grid --- */
.tg-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.tg-cell-label { font-size: var(--dsw-font-xxxs-11-font-size, 11px); color: var(--tg-muted); }
.tg-cell-value {
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

/* ------------------------------------------------------------ sparkline --- */
.tg-spark { display: flex; align-items: flex-end; gap: 2px; height: 32px; margin-bottom: 2px; }
.tg-spark-bar {
  flex: 1 1 0; min-height: 2px;
  border-radius: 1.5px 1.5px 1px 1px;
  background: linear-gradient(180deg, color-mix(in oklab, var(--tg-tone) 82%, #fff), var(--tg-tone));
}
.tg-spark-bar[data-empty="true"] { background: var(--tg-track); }

/* --------------------------------------------------------------- models --- */
.tg-models { margin-top: 14px; }
.tg-model { display: flex; align-items: baseline; gap: 8px; padding: 1.5px 0; font-size: var(--dsw-font-xxs-12-font-size, 12px); }
.tg-model-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, rgba(24, 24, 27, 0.7)); }
.tg-model-value { margin-left: auto; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tg-foot {
  margin-top: 10px; padding-top: 8px;
  border-top: var(--tg-hairline) solid var(--tg-border);
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  color: var(--tg-muted);
  word-break: break-all;
}

/* ----------------------------------------------------------- token gate --- */
.tg-token-card { width: min(300px, calc(100vw - 28px)); }
.tg-token-hint {
  margin: 0 0 10px;
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  line-height: 1.5;
  color: var(--tg-muted);
}
.tg-token-input {
  box-sizing: border-box; width: 100%;
  padding: 7px 9px;
  border: var(--tg-hairline) solid var(--tg-border);
  border-radius: var(--tg-radius-cell);
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #18181b);
  font: inherit;
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
}
.tg-token-input:focus-visible { outline: var(--tg-focus-width) solid var(--tg-focus); outline-offset: 1px; }
.tg-token-error {
  margin-top: 7px;
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  color: var(--dsw-alias-state-error-primary, #dc2626);
}
.tg-token-actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.tg-token-save, .tg-token-clear {
  border: 0; border-radius: var(--tg-radius-cell);
  padding: 5px 10px; font: inherit;
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  cursor: pointer;
}
.tg-token-save {
  background: var(--dsw-alias-label-primary, #18181b);
  color: var(--dsw-alias-bg-layer-1, #fff);
}
.tg-token-save:disabled { opacity: 0.4; cursor: default; }
.tg-token-clear { padding-inline: 4px; background: transparent; color: var(--tg-muted); }
.tg-token-clear:hover { color: var(--dsw-alias-label-primary, #18181b); }
.tg-token-save:focus-visible, .tg-token-clear:focus-visible {
  outline: var(--tg-focus-width) solid var(--tg-focus); outline-offset: 1px;
}
.tg-token-note { margin-top: 9px; font-size: var(--dsw-font-xxxs-11-font-size, 11px); color: var(--tg-muted); }

@media (max-width: 380px) { .tg-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (prefers-reduced-motion: reduce) {
  .tg-chip, .tg-stack-seg { transition: none; }
  .tg-card { transition: none; }
  .tg-card { opacity: 1; transform: none; }
  .tg-ring { transition: none; }
}
`;

    /* ----------------------------------------------------------------- apply */

    function injectStyles() {
      if (typeof document === 'undefined') return () => {};
      const existing = document.getElementById(STYLE_ID);
      if (existing !== null) return () => {};
      const tag = document.createElement('style');
      tag.id = STYLE_ID;
      tag.dataset.plugin = NS;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
      };
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(injectStyles, 'dsh-token-gateway: styles');

        // Register the dictionaries when the locale service is present; the
        // component still falls back to the browser language if it is not.
        let localeReady = false;
        if (typeof ctx.get === 'function') {
          const locale = ctx.get('locale');
          if (locale !== undefined && typeof locale.register === 'function') {
            ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-token-gateway: dictionaries');
            localeReady = true;
          }
        }

        // `conversation.composer.dock` is the row under the composer where the
        // host renders its own activity and usage pills. A higher `order` lands
        // this chip inline with them — same line, same type — instead of a
        // floating box over the page.
        ctx.effect(
          () => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
            name: 'conversation.composer.dock',
            id: NS,
            order: 2,
            ...(localeReady ? { locale: NS } : {}),
          }, DockChip)),
          'dsh-token-gateway: dock chip',
        );
      },
    };
  },
});
