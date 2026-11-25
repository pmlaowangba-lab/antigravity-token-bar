/**
 * 页内 API 折算金额 · 缓存净省 · 聚合看板（user 改装层）
 * 实时会话指标与底部 #ag-live-metrics-pill 同源（window.__ag_last_metrics / ctx.metrics）
 * 账本汇总走本机 127.0.0.1:19825（antigravity-token-bar API，非悬浮窗进程）
 */
(function agLedgerPageBoard() {
  if (typeof window.__agLedgerCleanup === 'function') {
    try { window.__agLedgerCleanup(); } catch (e) {}
  }
  document.querySelectorAll('#ag-ledger-dock, #ag-ledger-board, #ag-ledger-backdrop').forEach((el) => {
    el.classList.add('ag-ledger-stale');
    el.remove();
  });

  const API_BASE = 'http://127.0.0.1:19825';
  const LS_CCY = 'ag_ledger_ccy';
  const LS_FRESH = 'ag_ledger_only_fresh';
  const LS_PIN = 'ag_ledger_pinned_conv';
  const LS_PIN_LEGACY = 'ag_ledger_pinned_conv';
  const LS_OPEN = 'ag_ledger_board_open';

  /** 避免 pointerdown 打开后同一击的 click 落在遮罩上立刻关掉面板 */
  let suppressBackdropCloseUntil = 0;

  const state = {
    boardOpen: localStorage.getItem(LS_OPEN) === '1',
    onlyFresh: localStorage.getItem(LS_FRESH) !== '0',
    currency: localStorage.getItem(LS_CCY) === 'CNY' ? 'CNY' : 'USD',
    pinnedConvId: (() => {
      try {
        const tabPin = sessionStorage.getItem(LS_PIN) || '';
        if (tabPin) return tabPin;
      } catch (e) {}
      try {
        localStorage.removeItem(LS_PIN_LEGACY);
      } catch (e) {}
      return '';
    })(),
    activityTab: 'heat',
    activityScope: 'all',
    filters: { range: 'today', grain: 'day', category: '', model: '', workspace: '', machine: '' },
    snapshot: null,
    apiOk: false,
    topCostToday: '',
    topCostTotal: ''
  };

  const CASCADE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function takeCascadeId(value) {
    const id = String(value || '').trim().toLowerCase();
    return CASCADE_UUID_RE.test(id) ? id : '';
  }

  /** 当前标签页正在交互的对话 ID：焦点胶囊 > URL/侧栏；无明确 ID 时才用本标签页锁定 */
  function resolveCurrentConvId() {
    const live = takeCascadeId(readFocusedPillPayload()?.cascadeId) || takeCascadeId(extractCascadeId());
    const pinned = takeCascadeId(state.pinnedConvId);
    if (pinned) return pinned;
    return live || '';
  }

  function focusedConvId() {
    return takeCascadeId(readFocusedPillPayload()?.cascadeId) || takeCascadeId(extractCascadeId());
  }

  function snapshotConvId(snap) {
    if (!snap) return '';
    return takeCascadeId(snap.selectedConvId || snap.activeSession?.conversationId);
  }

  /** 账本「路」口径：有焦点时必须与 snapshot 请求的 convId 一致 */
  function sessionAlignedWithFocus(snap) {
    const focus = focusedConvId();
    const selected = snapshotConvId(snap);
    if (!focus) return Boolean(selected);
    if (!selected) return false;
    return focus === selected;
  }

  function readTabPin() {
    try {
      return sessionStorage.getItem(LS_PIN) || '';
    } catch (e) {
      return '';
    }
  }

  function writeTabPin(convId) {
    try {
      const id = String(convId || '').trim();
      if (id) sessionStorage.setItem(LS_PIN, id);
      else sessionStorage.removeItem(LS_PIN);
    } catch (e) {}
    try {
      localStorage.removeItem(LS_PIN_LEGACY);
    } catch (e) {}
  }

  /** 与补丁内核同一套会话识别：新窗口的 id 可能在 query、watched 或侧栏，不只在 /c/ 路径里 */
  function extractCascadeId() {
    try {
      const watched = takeCascadeId(window.__ag_watched_cascade_id);
      if (watched) return watched;
      const sp = new URLSearchParams(window.location.search || '');
      const focused = takeCascadeId(sp.get('focused'));
      if (focused) return focused;
      const fromQuery = takeCascadeId(sp.get('cascadeId'));
      if (fromQuery) return fromQuery;
      let path = String(window.location.pathname || '');
      try {
        path = decodeURIComponent(path);
      } catch (e) {}
      const m = path.match(/\/c\/([^/?#]+)/i);
      if (m) {
        const first = takeCascadeId(String(m[1]).split(/\+|%2b/i)[0]);
        if (first) return first;
      }
      const selected = document.querySelector(
        '[data-testid="conversation-row-sidebar"][data-selected="true"], [data-testid=conversation-row-sidebar][data-selected=true]'
      );
      if (selected) {
        const fromRow = takeCascadeId(selected.getAttribute('data-cascade-id'));
        if (fromRow) return fromRow;
      }
      const pill = document.getElementById('ag-live-metrics-pill');
      if (pill) {
        const fromPill = takeCascadeId(
          pill.getAttribute('data-ag-cascade-id') || pill.getAttribute('data-ag-rendered-cid')
        );
        if (fromPill) return fromPill;
      }
    } catch (e) {}
    return '';
  }

  function fmtTokens(n) {
    const v = Math.max(0, Number(n) || 0);
    if (v === 512000 || v === 524288) return '512K';
    if (v === 1048576) return '1024K';
    if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e5) return `${Math.round(v / 1e3)}K`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return String(Math.round(v));
  }

  /** 满 1 亿用「亿」（两位）；千万以下到一万用「万」。102150900 → 1.02亿，46259000 → 4625.90万 */
  /** 超过一千万用亿（两位）。精确合计旁仍保留完整 token 数。 */
  function fmtWan(n, digits) {
    const v = Math.max(0, Number(n) || 0);
    if (v >= 100000000) return `${(v / 100000000).toFixed(2)}亿`;
    if (v >= 10000) {
      const d = digits != null ? digits : 1;
      return `${(v / 10000).toFixed(d)}万`;
    }
    return Math.round(v).toLocaleString('en-US');
  }

  function fmtExact(n) {
    return Math.round(Math.max(0, Number(n) || 0)).toLocaleString('en-US');
  }

  function fmtMoney(usd, fx, ccy) {
    const u = Math.max(0, Number(usd) || 0);
    const rate = Number(fx) > 0 ? Number(fx) : 7.2;
    if (ccy === 'CNY') {
      const y = u * rate;
      return `¥${y >= 100 ? y.toFixed(1) : y.toFixed(2)}`;
    }
    return `$${u >= 100 ? u.toFixed(1) : u.toFixed(2)}`;
  }

  function parseTooltipRows(tooltipHtml) {
    const map = Object.create(null);
    if (!tooltipHtml) return map;
    const wrap = document.createElement('div');
    wrap.innerHTML = tooltipHtml;
    wrap.querySelectorAll('.ag-tt-row').forEach((row) => {
      const lbl = row.querySelector('.ag-tt-lbl')?.textContent?.trim();
      const val = row.querySelector('.ag-tt-val')?.textContent?.trim();
      if (lbl) map[lbl] = val || '';
    });
    return map;
  }

  function numFromText(s) {
    if (!s) return null;
    const m = String(s).replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)/);
    return m ? Number(m[1]) : null;
  }

  /** 从补丁内核推送的 metrics 载荷解析，与底部胶囊 tooltip 同源 */
  function parseLiveMetrics(metrics) {
    if (!metrics || !metrics.hasData) return null;
    const rows = parseTooltipRows(metrics.tooltipHtml || '');
    const inlineText = (() => {
      const el = document.createElement('span');
      el.innerHTML = metrics.inlineHtml || '';
      return el.textContent || '';
    })();

    const tpsM = inlineText.match(/([0-9]+)\s*tok\/s/i);
    const holdM = inlineText.match(/(?:TTFT|Hold)\s+([0-9.]+)s/i);
    const ctxM = inlineText.match(/Ctx\s+([^/]+)\/([^\s(]+)\s*\((\d+)%\)/i);
    const outM = inlineText.match(/Out\s+([^\s·]+)/i);

    const speedRow = rows['生成速度'] || '';
    const e2eM = speedRow.match(/端到端[^0-9]*([0-9.]+)\s*tok\/s/);
    const streamM = speedRow.match(/流式\s+([0-9.]+)\s*tok\/s/);

    const durRow = rows['响应耗时'] || '';
    const ttftM = durRow.match(/TTFT\s+([0-9.]+)s|等待\s+([0-9.]+)s/);
    const totalDurM = durRow.match(/总计\s+([0-9.]+)s/);

    const ctxRow = rows['当前上下文'] || '';
    const ctxCacheM = ctxRow.match(/\(([0-9.]+)%\)/);

    const waterRow = rows['压缩水位线'] || '';
    const waterPctM = waterRow.match(/\((\d+)%\)/);
    const waterUsedM = waterRow.match(/^([^/]+)\//);

    const inputRow = rows['累计输入量'] || '';
    const sessCacheM = inputRow.match(/命中率\s+([0-9.]+)%/);

    const outRow = rows['累计输出量'] || rows['本步输出量'] || '';
    const outTokM = outRow.match(/(?:总计|本步)\s*([\d,.KMB]+)|^([\d,.KMB]+)/i);

    const usedPct = waterPctM
      ? Number(waterPctM[1])
      : ctxM
        ? Number(ctxM[3])
        : 0;
    let healthTone = 'good';
    let healthLabel = '正常';
    if (usedPct >= 88) {
      healthTone = 'danger';
      healthLabel = '临近压缩';
    } else if (usedPct >= 72) {
      healthTone = 'warn';
      healthLabel = '偏高';
    }

    const tps = tpsM ? Number(tpsM[1]) : e2eM ? Number(e2eM[1]) : null;
    let speedTone = 'good';
    let speedBadge = '流畅';
    if (tps == null) {
      speedTone = 'muted';
      speedBadge = '待生成';
    } else if (tps >= 75) speedBadge = '极速';
    else if (tps >= 32) speedBadge = '流畅';
    else if (tps >= 14) {
      speedBadge = '良好';
      speedTone = 'warn';
    } else {
      speedBadge = '偏慢';
      speedTone = 'danger';
    }

    return {
      source: 'patch-metrics',
      usedPercent: usedPct,
      contextUsedLabel: waterUsedM ? waterUsedM[1].trim() : ctxM ? ctxM[1].trim() : '—',
      contextLimitLabel: ctxM ? ctxM[2].trim() : '512K',
      stepCacheRate: ctxCacheM ? Number(ctxCacheM[1]) : 0,
      sessionCacheRate: sessCacheM ? Number(sessCacheM[1]) : 0,
      healthTone,
      healthLabel,
      speed: {
        tokensPerSec: tps,
        ttftSec: ttftM ? Number(ttftM[1] || ttftM[2]) : holdM ? Number(holdM[1]) : null,
        durationSec: totalDurM ? Number(totalDurM[1]) : null,
        streamTps: streamM ? Number(streamM[1]) : null,
        e2eTps: e2eM ? Number(e2eM[1]) : tps,
        badgeLabel: speedBadge,
        tone: speedTone,
        note: speedRow || '等待模型输出…',
        outLabel: outM ? outM[1] : outTokM ? (outTokM[1] || outTokM[2]) : '—'
      },
      rows
    };
  }

  let boardEl, backdropEl, dockEl, dockMetricsEl, dockCostEl, dockSessionEl, dockQuotaEl;
  let lastRequestedConv = '';
  let quotaService = null;
  let quotaState = { at: 0, groups: null, error: '' };
  let quotaSig = '';
  const refs = {};

  const DOCK_TOP_PX = 10;
  const DOCK_BAND_PX = 56;
  /** macOS 红绿灯在左侧，避让页内按钮后再向右贴一些 */
  const DOCK_NUDGE_RIGHT_PX = 28;
  /** Windows 最小化/最大化/关闭是系统按钮，不在 DOM 里，固定让出宽度 */
  const WIN_CAPTION_RESERVE_PX = 176;

  function nativeCaptionReserve() {
    try {
      const hint = `${navigator.platform || ''} ${navigator.userAgent || ''}`;
      if (/Windows|Win32|Win64/i.test(hint)) return WIN_CAPTION_RESERVE_PX;
    } catch (e) {}
    return 0;
  }

  function measureTopRightChromeInset() {
    let insetRight = 16;
    const band = DOCK_BAND_PX;
    const vw = window.innerWidth;
    const skipRoot = dockEl;
    const nodes = document.querySelectorAll(
      'header button, header a, [data-testid*="header"] button, [data-testid*="toolbar"] button, [class*="titlebar"] button'
    );
    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue;
      if (skipRoot && (el === skipRoot || el.closest('#ag-ledger-dock, #ag-ledger-board, #ag-ledger-backdrop'))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.top < -4 || r.bottom > band) continue;
      if (r.left < vw * 0.52) continue;
      const need = vw - r.left + 10;
      if (need > insetRight) insetRight = need;
    }
    return Math.min(Math.max(insetRight, 12), vw * 0.42);
  }

  function applyDockGeometry() {
    if (!dockEl) return;
    dockEl.style.setProperty('--ag-ledger-dock-top', `${DOCK_TOP_PX}px`);
  }

  function buildDockCostHtml(todayText, totalText) {
    if (!todayText && !totalText) {
      return '<span class="ag-dock-cost-main">—</span>';
    }
    const main = esc(todayText || totalText || '—');
    return `<span class="ag-dock-cost-main">${main}</span>`;
  }

  function buildDockMetricsHtml(metrics, live) {
    let tps = live?.speed?.tokensPerSec ?? null;
    if (tps == null && metrics?.inlineHtml) {
      const probe = document.createElement('span');
      probe.innerHTML = metrics.inlineHtml;
      const tpsM = (probe.textContent || '').match(/([0-9]+(?:\.[0-9]+)?)\s*tok\/s/i);
      if (tpsM) tps = Math.round(Number(tpsM[1]));
    }
    const tpsTone = tps == null ? 'muted' : (live?.speed?.tone || 'good');
    let used = live && live.contextUsedLabel && live.contextUsedLabel !== '—' ? live.contextUsedLabel : '';
    let pct = Number.isFinite(live?.usedPercent) ? live.usedPercent : null;
    if (!used && metrics?.inlineHtml) {
      const ctxProbe = document.createElement('span');
      ctxProbe.innerHTML = metrics.inlineHtml;
      const ctxM = (ctxProbe.textContent || '').match(/Ctx\s+([^/]+)\/([^\s(]+)\s*\((\d+)%\)/i);
      if (ctxM) {
        used = ctxM[1].trim();
        pct = Number(ctxM[3]);
      }
    }
    const ctxPct = pct == null ? 0 : Math.max(0, Math.min(100, Math.round(pct)));
    const ctxTone = ctxPct >= 88 ? 'danger' : ctxPct >= 72 ? 'warn' : 'good';
    const ctxHtml = used
      ? `<span class="ag-dock-vsep" aria-hidden="true"></span>` +
        `<span class="ag-dock-ctx">` +
        `<span class="ag-dock-ctx-num" data-tone="${ctxTone}">${esc(used)}·${ctxPct}%</span>` +
        `</span>`
      : '';
    return (
      `<span class="ag-dock-speed">` +
      `<span class="ag-dock-dot" data-tone="${esc(tpsTone)}"></span>` +
      `<span class="ag-dock-val">${tps != null ? esc(String(tps)) : '—'}</span>` +
      `<span class="ag-dock-muted">t/s</span>` +
      `</span>` +
      ctxHtml
    );
  }

  function sessionCostText() {
    const snap = state.snapshot;
    const sess = snap?.activeSession;
    if (!sess || !sessionAlignedWithFocus(snap)) return '路—';
    const usd = sess.sessionTotals?.todayUSD;
    if (usd == null) return '路—';
    if (Number(usd) === 0) return '路¥0';
    return `路${fmtMoney(usd, snap.fxCny || 7.2, state.currency)}`;
  }

  function hideCoreMetricsTooltip() {
    const tt = document.getElementById('ag-live-metrics-tooltip');
    if (!tt) return;
    tt.removeAttribute('data-visible');
    tt.style.setProperty('display', 'none', 'important');
  }

  function applyBoardAnchor() {
    if (!boardEl || !dockEl) return;
    const top = dockEl.style.getPropertyValue('--ag-ledger-dock-top') || '10px';
    const right = dockEl.style.getPropertyValue('--ag-ledger-dock-right') || '8px';
    boardEl.style.setProperty('--ag-ledger-dock-top', top);
    boardEl.style.setProperty('--ag-ledger-dock-right', right);
  }

  function syncBoardDom() {
    const open = Boolean(state.boardOpen);
    backdropEl?.setAttribute('data-open', open ? '1' : '0');
    boardEl?.setAttribute('data-open', open ? '1' : '0');
    dockEl?.setAttribute('data-board-open', open ? '1' : '0');
    document.documentElement.classList.toggle('ag-ledger-panel-open', open);
    if (open) {
      applyBoardAnchor();
      hideCoreMetricsTooltip();
      if (document.body && backdropEl && boardEl) {
        if (!backdropEl.isConnected) document.body.appendChild(backdropEl);
        if (!boardEl.isConnected) document.body.appendChild(boardEl);
      }
    }
  }

  function ensureShell() {
    if (!backdropEl) {
      backdropEl = document.createElement('div');
      backdropEl.id = 'ag-ledger-backdrop';
      backdropEl.addEventListener('click', (e) => {
        if (performance.now() < suppressBackdropCloseUntil) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        setBoardOpen(false);
      });
      document.body.appendChild(backdropEl);
    }
    if (!boardEl) {
      boardEl = document.createElement('div');
      boardEl.id = 'ag-ledger-board';
      boardEl.setAttribute('role', 'dialog');
      boardEl.setAttribute('aria-modal', 'true');
      boardEl.setAttribute('aria-label', 'API 折算与 Token 账本看板');
      boardEl.innerHTML = `
        <div class="ag-ledger-hdr">
          <div class="ag-ledger-title-wrap">
            <span class="ag-ledger-live-dot" aria-hidden="true"></span>
            <div class="ag-ledger-title">本机用量与折算控制台</div>
            <span id="ag-ledger-conn-chip" class="ag-ledger-status-chip">连接中…</span>
          </div>
          <div class="ag-ledger-actions">
            <button type="button" id="ag-ledger-btn-pin" class="ag-ledger-pill">自动跟随会话</button>
            <button type="button" id="ag-ledger-ccy" class="ag-ledger-pill">$ USD 主显</button>
            <button type="button" id="ag-ledger-btn-refresh" class="ag-ledger-pill">刷新</button>
            <button type="button" id="ag-ledger-btn-close" class="ag-ledger-pill">收起 ×</button>
          </div>
        </div>
        <div class="ag-ledger-fit">
          <section id="ag-ledger-quota" class="ag-ledger-grid-2"></section>
          <div id="ag-ledger-offline" class="ag-ledger-offline" hidden></div>
          <section id="ag-ledger-session-pair" class="ag-ledger-grid-2"></section>
          <section class="ag-ledger-card" id="ag-ledger-today"></section>
          <section class="ag-ledger-period-grid" id="ag-ledger-period"></section>
          <section class="ag-ledger-card" id="ag-ledger-activity"></section>
        </div>
      `;
      document.body.appendChild(boardEl);

      refs.connChip = boardEl.querySelector('#ag-ledger-conn-chip');
      refs.pinBtn = boardEl.querySelector('#ag-ledger-btn-pin');
      refs.ccyBtn = boardEl.querySelector('#ag-ledger-ccy');
      refs.quota = boardEl.querySelector('#ag-ledger-quota');
      refs.offline = boardEl.querySelector('#ag-ledger-offline');
      refs.sessionPair = boardEl.querySelector('#ag-ledger-session-pair');
      refs.costSection = boardEl.querySelector('#ag-ledger-cost-section');
      refs.period = boardEl.querySelector('#ag-ledger-period');
      refs.today = boardEl.querySelector('#ag-ledger-today');
      refs.activity = boardEl.querySelector('#ag-ledger-activity');

      boardEl.querySelector('#ag-ledger-btn-close').addEventListener('click', () => setBoardOpen(false));
      boardEl.addEventListener('mouseover', (ev) => {
        const cell = ev.target instanceof Element ? ev.target.closest('.ag-ledger-heat-cell') : null;
        if (!cell) return;
        const tip = boardEl.querySelector('#ag-ledger-heat-tip');
        const info = cell.getAttribute('title') || '';
        if (tip && info) tip.textContent = info;
      });
      boardEl.addEventListener('mouseout', (ev) => {
        const cell = ev.target instanceof Element ? ev.target.closest('.ag-ledger-heat-cell') : null;
        if (!cell) return;
        const tip = boardEl.querySelector('#ag-ledger-heat-tip');
        if (tip) tip.textContent = '鼠标移到格子可查看当日明细';
      });
      boardEl.addEventListener('change', (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLElement)) return;
        if (t.id === 'ag-ledger-filter-category') state.filters.category = t.value;
        else if (t.id === 'ag-ledger-filter-model') state.filters.model = t.value;
        else if (t.id === 'ag-ledger-filter-workspace') state.filters.workspace = t.value;
        else if (t.id === 'ag-ledger-filter-machine') state.filters.machine = t.value;
        else return;
        void refreshSnapshot();
      });
      boardEl.addEventListener('click', (ev) => {
        const origin = ev.target instanceof Element ? ev.target : ev.target?.parentElement || null;
        if (!origin) return;
        const filterBtn = origin.closest('[data-filter]');
        if (filterBtn && boardEl.contains(filterBtn)) {
          const filterKey = filterBtn.getAttribute('data-filter');
          if (filterKey === 'range' || filterKey === 'grain') {
            state.filters[filterKey] = filterBtn.getAttribute('data-value') || '';
            void refreshSnapshot();
          }
          return;
        }
        const t = origin instanceof HTMLElement ? origin : origin.closest('button');
        if (!(t instanceof HTMLElement)) return;
        const id = t.id;
        if (id === 'ag-ledger-btn-pin') {
          if (state.pinnedConvId) {
            state.pinnedConvId = '';
            writeTabPin('');
          } else {
            const curCid = resolveCurrentConvId();
            if (curCid) {
              state.pinnedConvId = curCid;
              writeTabPin(curCid);
            }
          }
          renderAll();
          void refreshSnapshot();
        } else if (id === 'ag-ledger-btn-refresh') {
          t.textContent = '刷新中';
          void Promise.all([refreshSnapshot(true), refreshQuota(true)]).finally(() => {
            if (t.isConnected) t.textContent = '刷新';
          });
        } else if (id === 'ag-ledger-ccy') {
          state.currency = state.currency === 'USD' ? 'CNY' : 'USD';
          localStorage.setItem(LS_CCY, state.currency);
          renderAll();
        } else if (id === 'ag-ledger-tab-heat') {
          state.activityTab = 'heat';
          renderAll();
        } else if (id === 'ag-ledger-tab-models') {
          state.activityTab = 'models';
          renderAll();
        } else if (id === 'ag-ledger-scope-current' || id === 'ag-ledger-scope-all') {
          state.activityScope = id === 'ag-ledger-scope-current' ? 'current' : 'all';
          renderAll();
        }
      }, true);
    }
    if (!dockEl) {
      dockEl = document.createElement('div');
      dockEl.id = 'ag-ledger-dock';
      dockEl.setAttribute('role', 'button');
      dockEl.setAttribute('tabindex', '0');
      dockEl.setAttribute('aria-label', '会话指标与 API 折算，点击查看完整账本看板');
      dockEl.title = '点击任意位置打开完整账本看板 · 右键切换 USD/CNY';
      const topRow = document.createElement('div');
      topRow.className = 'ag-dock-top';
      dockMetricsEl = document.createElement('span');
      dockMetricsEl.id = 'ag-ledger-dock-metrics';
      dockCostEl = document.createElement('span');
      dockCostEl.id = 'ag-ledger-dock-cost';
      dockCostEl.innerHTML = buildDockCostHtml(state.topCostToday, state.topCostTotal);
      dockSessionEl = document.createElement('span');
      dockSessionEl.id = 'ag-ledger-dock-session';
      dockSessionEl.textContent = '路—';
      dockQuotaEl = document.createElement('span');
      dockQuotaEl.id = 'ag-ledger-dock-quota';
      dockQuotaEl.innerHTML = '<span class="ag-dock-qgroup"><span class="ag-dock-muted">额度…</span></span>';
      const sep1 = document.createElement('span');
      sep1.className = 'ag-dock-vsep';
      sep1.setAttribute('aria-hidden', 'true');
      const sep2 = document.createElement('span');
      sep2.className = 'ag-dock-vsep';
      sep2.setAttribute('aria-hidden', 'true');
      topRow.append(dockMetricsEl, sep1, dockCostEl, dockSessionEl, sep2, dockQuotaEl);
      dockEl.append(topRow);
      document.body.appendChild(dockEl);

      const toggleBoardFromDock = (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        }
        hideCoreMetricsTooltip();
        ensureShell();
        if (state.boardOpen) {
          setBoardOpen(false);
          return;
        }
        suppressBackdropCloseUntil = performance.now() + 480;
        setBoardOpen(true);
        renderAll();
        void refreshSnapshot();
        void refreshQuota(true);
      };
      dockEl.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        toggleBoardFromDock(e);
      }, true);
      dockEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, true);
      dockEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') toggleBoardFromDock(e);
      });
      dockEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        state.currency = state.currency === 'USD' ? 'CNY' : 'USD';
        localStorage.setItem(LS_CCY, state.currency);
        renderAll();
      });
    }
    if (boardEl && !boardEl.__agLedgerStopBubble) {
      boardEl.__agLedgerStopBubble = true;
      boardEl.addEventListener('pointerdown', (e) => e.stopPropagation(), true);
      boardEl.addEventListener('click', (e) => e.stopPropagation(), true);
    }
  }

  function setBoardOpen(open) {
    state.boardOpen = Boolean(open);
    localStorage.setItem(LS_OPEN, state.boardOpen ? '1' : '0');
    syncBoardDom();
  }

  const INPUT_BOX_ID = 'antigravity.agentSidePanelInputBox';
  let lastFocusedBox = null;

  function allInputBoxes() {
    return Array.from(document.querySelectorAll('[id="' + INPUT_BOX_ID + '"]'));
  }

  function boxFromNode(node) {
    if (!node || typeof node.closest !== 'function') return null;
    const boxes = allInputBoxes();
    for (const box of boxes) {
      if (box === node || box.contains(node)) return box;
    }
    const pane = node.closest(
      '[data-pane-id], [data-testid="conversation-view"], [data-testid="side-question-tab-content"], [data-media-drop-scope="subpane"]'
    );
    if (!pane) return null;
    for (const box of boxes) {
      if (pane.contains(box)) return box;
    }
    return null;
  }

  /** 船板口径：当前正在用的那路输入框，而不是窗口主会话 */
  function activeInputBox() {
    const boxes = allInputBoxes();
    if (boxes.length === 0) return null;
    const fromActive = boxFromNode(document.activeElement);
    if (fromActive) {
      lastFocusedBox = fromActive;
      return fromActive;
    }
    const focusedPanes = boxes.filter((box) => !(box.closest && box.closest('[data-pane-unfocused]')));
    if (focusedPanes.length === 1) {
      lastFocusedBox = focusedPanes[0];
      return focusedPanes[0];
    }
    if (lastFocusedBox && lastFocusedBox.isConnected && boxes.includes(lastFocusedBox)) return lastFocusedBox;
    return focusedPanes[0] || boxes[0];
  }

  function readPillElement(pill) {
    if (!pill || pill.style.display === 'none') return null;
    const textEl = pill.querySelector('[data-ag-metrics-text="1"], .ag-live-metrics-text, #ag-live-metrics-text');
    const inlineHtml = textEl ? textEl.innerHTML : '';
    const text = ((textEl ? textEl.textContent : pill.textContent) || '').trim();
    if (!text || !inlineHtml) return null;
    return {
      hasData: true,
      inlineHtml,
      cascadeId: String(pill.getAttribute('data-ag-rendered-cid') || pill.getAttribute('data-ag-cascade-id') || '').trim(),
      tooltipHtml: ''
    };
  }

  function readFocusedPillPayload() {
    const box = activeInputBox();
    if (box) {
      const pill = box.querySelector('[data-ag-metrics-pill="1"], .ag-live-metrics-pill, #ag-live-metrics-pill');
      return readPillElement(pill);
    }
    return readPillElement(document.getElementById('ag-live-metrics-pill'));
  }

  function findQuotaService() {
    if (quotaService) return quotaService;
    const root = document.getElementById('root');
    if (!root) return null;
    const key = Object.keys(root).find((k) => k.indexOf('__reactContainer') === 0);
    if (!key || !root[key]) return null;
    const seen = new Set();
    const consider = (obj, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 6 || quotaService) return;
      if (typeof obj.retrieveUserQuotaSummary === 'function') {
        quotaService = obj;
        return;
      }
      try {
        if (obj.cloudCodeService) consider(obj.cloudCodeService, depth + 1);
      } catch (e) {}
      try {
        if (obj.core && obj.core !== obj) consider(obj.core, depth + 1);
      } catch (e) {}
      try {
        if (obj.value && obj.value !== obj) consider(obj.value, depth + 1);
      } catch (e) {}
    };
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 8000 || seen.has(node) || quotaService) return;
      seen.add(node);
      try { consider(node.memoizedProps, 0); } catch (e) {}
      try { consider(node.memoizedState, 0); } catch (e) {}
      walk(node.child, depth + 1);
      walk(node.sibling, depth + 1);
    };
    walk(root[key], 0);
    return quotaService;
  }

  function quotaPct(bucket) {
    const raw = bucket && bucket.remaining && bucket.remaining.case === 'remainingFraction'
      ? bucket.remaining.value
      : null;
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n * 100)));
  }

  function quotaRemainText(resetTime) {
    const sec = Number(resetTime && resetTime.seconds != null ? resetTime.seconds : NaN);
    if (!Number.isFinite(sec)) return '';
    const ms = sec * 1000 - Date.now();
    if (ms <= 60000) return '即将重置';
    const mins = Math.floor(ms / 60000);
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (days > 0) return hours > 0 ? `${days}天${hours}小时` : `${days}天`;
    if (hours > 0) return m > 0 ? `${hours}小时${m}分` : `${hours}小时`;
    return `${m}分`;
  }

  function quotaRemainShort(resetTime) {
    const sec = Number(resetTime && resetTime.seconds != null ? resetTime.seconds : NaN);
    if (!Number.isFinite(sec)) return '';
    const ms = sec * 1000 - Date.now();
    if (ms <= 60000) return '<1m';
    const mins = Math.floor(ms / 60000);
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
    if (hours > 0) return m > 0 ? `${hours}h${m}m` : `${hours}h`;
    return `${m}m`;
  }

  function pickQuotaBucket(group, kind) {
    const buckets = (group && group.buckets) || [];
    for (const bucket of buckets) {
      const windowName = String(bucket.window || '').trim().toLowerCase();
      if (kind === 'day' && windowName === 'daily') return bucket;
      if (kind === 'week' && windowName === 'weekly') return bucket;
      if (kind === 'h5' && (windowName === '5h' || windowName === '5-hour' || windowName === 'five-hour')) return bucket;
    }
    return null;
  }

  function shortQuotaName(name, compact) {
    const text = String(name || '');
    if (/gemini/i.test(text)) return compact ? 'Gem' : 'Gemini';
    if (/claude|gpt/i.test(text)) return 'Claude/GPT';
    return text.replace(/\s*models?$/i, '') || '额度';
  }

  function asQuotaPercent(n) {
    if (n == null || !Number.isFinite(n)) return null;
    if (n > 0 && n <= 1) return Math.round(n * 100);
    return Math.round(n);
  }

  function quotaStatus(pct) {
    const percent = asQuotaPercent(pct);
    if (percent == null) return { tone: 'muted', label: '—' };
    if (percent < 10) return { tone: 'danger', label: '紧张' };
    if (percent < 25) return { tone: 'warn', label: '偏低' };
    return { tone: 'good', label: '正常' };
  }

  function quotaColorTone(pct) {
    const percent = asQuotaPercent(pct);
    if (percent == null) return 'muted';
    if (percent < 40) return 'danger';
    if (percent < 70) return 'warn';
    return 'good';
  }

  function quotaBarHtml(pct) {
    const tone = quotaColorTone(pct);
    const width = pct == null ? 0 : pct;
    return `<div class="ag-ledger-progress"><div data-tone="${tone}" style="width:${width}%"></div></div>`;
  }

  function quotaPctText(bucket) {
    const pct = quotaPct(bucket);
    return pct == null ? '—' : `${pct}%`;
  }

  function quotaCard(group) {
    const h5 = pickQuotaBucket(group, 'h5');
    const week = pickQuotaBucket(group, 'week');
    const day = pickQuotaBucket(group, 'day');
    const h5Pct = quotaPct(h5);
    const weekPct = quotaPct(week);
    const dayPct = quotaPct(day);
    const tight = [h5Pct, weekPct].filter((n) => n != null);
    const status = quotaStatus(tight.length ? Math.min.apply(null, tight) : null);
    const h5Time = quotaRemainShort(h5 && h5.resetTime) || '—';
    const weekTime = quotaRemainShort(week && week.resetTime) || '—';
    const rowHtml = (label, pct, timeText) =>
      `<div class="ag-ledger-qbar-row">` +
      `<span class="ag-ledger-qbar-lbl">${label}</span>` +
      `${quotaBarHtml(pct)}` +
      `<b class="ag-ledger-qbar-pct" data-tone="${quotaColorTone(pct)}">${pct == null ? '—' : `${pct}%`}</b>` +
      `<span class="ag-ledger-qbar-time">${timeText && timeText !== '—' ? `${esc(timeText)}后重置` : (pct === 100 ? '满额' : '—')}</span>` +
      `</div>`;
    const rows = [];
    if (day) rows.push(rowHtml('日额度', dayPct, quotaRemainShort(day.resetTime) || '—'));
    if (h5) rows.push(rowHtml('5小时', h5Pct, h5Time));
    if (week) rows.push(rowHtml('周额度', weekPct, weekTime));
    if (!rows.length) rows.push(rowHtml('额度', null, '—'));
    return `<div class="ag-ledger-card">
      <div class="ag-ledger-card-head">
        <span>${esc(shortQuotaName(group.displayName))} 额度</span>
        <span class="ag-ledger-badge" data-tone="${status.tone}">${status.label}</span>
      </div>
      <div class="ag-ledger-qbar-list">${rows.join('')}</div>
    </div>`;
  }

  function quotaDockGroupHtml(group) {
    const items = [];
    const day = pickQuotaBucket(group, 'day');
    const h5 = pickQuotaBucket(group, 'h5');
    const week = pickQuotaBucket(group, 'week');
    const pcts = [];
    const pushItem = (label, bucket) => {
      if (!bucket) return;
      const pct = quotaPct(bucket);
      if (pct != null) pcts.push(pct);
      const tone = quotaColorTone(pct);
      const remain = label === '日' ? '' : quotaRemainShort(bucket.resetTime);
      items.push(
        `<span class="ag-dock-muted">${esc(label)}</span>` +
        `<span class="ag-dock-qval" data-tone="${esc(tone)}">${pct == null ? '—' : `${pct}%`}</span>` +
        (remain ? `<span class="ag-dock-qtime">${esc(remain)}</span>` : '')
      );
    };
    pushItem('日', day);
    pushItem('5h', h5);
    pushItem('周', week);

    const minPct = pcts.length ? Math.min.apply(null, pcts) : null;
    const groupTone = quotaStatus(minPct).tone;
    const dotHtml =
      groupTone === 'danger' || groupTone === 'warn'
        ? `<span class="ag-dock-dot" data-tone="${esc(groupTone)}"></span>`
        : '';
    const joined = items.join('<span class="ag-dock-muted">·</span>');
    return (
      `<span class="ag-dock-qgroup">` +
      `<span class="ag-dock-qname">${esc(shortQuotaName(group.displayName, true))}</span>` +
      `<span class="ag-dock-qbadge" data-tone="${esc(groupTone)}">${dotHtml}${joined || '<span class="ag-dock-muted">—</span>'}</span>` +
      `</span>`
    );
  }

  function renderQuota() {
    const groups = quotaState.groups || [];
    const dockGroups = groups.filter((g) => !/claude|gpt/i.test(String((g && g.displayName) || '')));
    const dockHtml = dockGroups.length
      ? `<span class="ag-dock-qrow">${dockGroups.map(quotaDockGroupHtml).join('')}</span>`
      : `<span class="ag-dock-qgroup"><span class="ag-dock-muted">${esc(quotaState.error || '5h — · 周 —')}</span></span>`;
    const boardHtml = groups.length
      ? groups.map(quotaCard).join('')
      : `<div class="ag-ledger-card"><div class="ag-ledger-card-head"><span>额度剩余</span><span class="ag-ledger-badge" data-tone="muted">—</span></div><div class="ag-ledger-foot">${esc(quotaState.error || '额度读取中')}</div></div>`;
    const sig = `${dockHtml}\n${boardHtml}`;
    if (sig === quotaSig) return;
    quotaSig = sig;
    if (dockQuotaEl && dockQuotaEl.innerHTML !== dockHtml) dockQuotaEl.innerHTML = dockHtml;
    if (refs.quota && refs.quota.innerHTML !== boardHtml) refs.quota.innerHTML = boardHtml;
  }

  async function refreshQuota(force) {
    const now = Date.now();
    if (!force && quotaState.groups && quotaState.at && now - quotaState.at < 4000) return;
    const svc = findQuotaService();
    if (!svc) {
      renderQuota();
      return;
    }
    try {
      const raw = await svc.retrieveUserQuotaSummary(true);
      const groups = (raw && raw.response && raw.response.groups) || [];
      quotaState = { at: Date.now(), groups, error: groups.length ? '' : '暂无额度信息' };
    } catch (e) {
      quotaService = null;
      if (!quotaState.groups) quotaState = { at: Date.now(), groups: null, error: '额度读取失败' };
    }
    renderQuota();
  }

  function syncDock(metrics, live) {
    if (cancelled) return;
    renderQuota();
    if (!dockEl || !dockMetricsEl || !dockCostEl) return;
    applyDockGeometry();
    const focused = readFocusedPillPayload();
    const focusedCid = String(focused?.cascadeId || '').trim().toLowerCase();
    const metricsCid = String(metrics?.cascadeId || '').trim().toLowerCase();
    const source =
      focused &&
      metrics &&
      metrics.hasData &&
      metrics.inlineHtml &&
      metricsCid &&
      focusedCid &&
      metricsCid === focusedCid
        ? metrics
        : focused;
    const onChat =
      (location.pathname || '').indexOf('/c/') !== -1 || !!document.querySelector('[id="antigravity.agentSidePanelInputBox"]');
    const costHtml = buildDockCostHtml(state.topCostToday, state.topCostTotal);
    const sessionText = sessionCostText();
    const convNow = resolveCurrentConvId();
    if (convNow && convNow !== lastRequestedConv) {
      lastRequestedConv = convNow;
      void refreshSnapshot();
    }
    if (dockSessionEl && dockSessionEl.textContent !== sessionText) dockSessionEl.textContent = sessionText;
    if (!source || !source.inlineHtml) {
      if (!onChat) {
        dockEl.style.display = 'none';
        hideCoreMetricsTooltip();
        return;
      }
      if (document.body) document.body.appendChild(dockEl);
      const fallbackMetricsHtml = buildDockMetricsHtml(null, live);
      if (dockMetricsEl.innerHTML !== fallbackMetricsHtml) dockMetricsEl.innerHTML = fallbackMetricsHtml;
      if (dockCostEl.innerHTML !== costHtml) dockCostEl.innerHTML = costHtml;
      dockEl.style.display = 'inline-flex';
      return;
    }
    live = live || parseLiveMetrics(source);
    if (document.body) document.body.appendChild(dockEl);
    document.getElementById('ag-ledger-dock-hint')?.remove();
    const metricsHtml = buildDockMetricsHtml(source, live);
    if (dockMetricsEl.innerHTML !== metricsHtml) dockMetricsEl.innerHTML = metricsHtml;
    if (dockCostEl.innerHTML !== costHtml) dockCostEl.innerHTML = costHtml;
    dockEl.style.display = 'inline-flex';
  }

  function renderSessionCards(live, snap) {
    if (!refs.sessionPair) return;
    const aligned = sessionAlignedWithFocus(snap);
    const sess = aligned ? snap?.activeSession : null;
    const fx = snap?.fxCny || 7.2;
    const usedPct = live ? live.usedPercent : sess?.usedPercent || 0;
    const tone = live ? live.healthTone : sess?.healthTone || 'muted';
    const badge = live ? live.healthLabel : sess?.healthLabel || '—';
    const liveSpd = live?.speed || {};
    const sessSpd = sess?.speed || {};
    const spd = {
      ...sessSpd,
      ...Object.fromEntries(Object.entries(liveSpd).filter(([, v]) => v != null && v !== '' && v !== '等待模型输出…'))
    };

    const sessionMoney = sess?.sessionTotals
      ? fmtMoney(sess.sessionTotals.totalUSD, fx, state.currency)
      : '—';
    const todayMoney =
      !sess || sess.sessionTotals?.todayUSD == null
        ? '—'
        : fmtMoney(sess.sessionTotals.todayUSD, fx, state.currency);
    const usedLabel = live?.contextUsedLabel || fmtTokens(sess?.contextUsed || 0);
    const limitLabel = live?.contextLimitLabel || fmtTokens(sess?.contextLimit || 512000);
    const remLabel = sess ? fmtTokens(sess.remainingTokens) : '—';
    const hitRate = ((live?.sessionCacheRate > 0 ? live.sessionCacheRate : null) ?? sess?.sessionTotals?.cacheHitRate ?? 0).toFixed(1);
    const barTone = tone === 'good' ? 'info' : tone;
    const todaySessMoney =
      sess?.sessionTotals?.todayUSD != null
        ? fmtMoney(sess.sessionTotals.todayUSD, fx, state.currency)
        : '—';
    const cumLine = !aligned
      ? '正在对齐当前窗口会话…（切换对话后会自动刷新本路今日，与顶栏「路」同源）'
      : sess?.sessionTotals
        ? `本路今日 ${todaySessMoney} · 精确账本 ${sess.sessionTotals.calls} 次响应 · 全程累计 ≈ ${sessionMoney}（${fmtTokens(sess.sessionTotals.inputTokens)} 入 + ${fmtTokens(sess.sessionTotals.cacheTokens)} 缓存 · 出 ${fmtTokens(sess.sessionTotals.outputTokens)}）`
        : sess
          ? '当前对话尚无账本记录，费用从首条模型回复后开始累计。'
          : '账本服务未连接，仅展示补丁实时指标。';

    refs.sessionPair.innerHTML = `
      <div class="ag-ledger-card">
        <div class="ag-ledger-card-head">
          <span>核心用量速览（512K 压缩水位线）</span>
          <span class="ag-ledger-head-side">
            <span class="ag-ledger-session-amt">本路今日 ${esc(todayMoney)}</span>
            <span class="ag-ledger-badge" data-tone="${esc(tone)}">${esc(badge)}</span>
          </span>
        </div>
        <div class="ag-ledger-progress"><div data-tone="${esc(barTone)}" style="width:${Math.min(100, usedPct)}%"></div></div>
        <div class="ag-ledger-mini-grid">
          <div><div class="ag-ledger-mini-lbl">当前已用</div><div class="ag-ledger-mini-val">${esc(usedLabel)} (${Math.round(usedPct)}%)</div></div>
          <div><div class="ag-ledger-mini-lbl">压缩水位线</div><div class="ag-ledger-mini-val">${esc(limitLabel)}</div></div>
          <div><div class="ag-ledger-mini-lbl">距压缩余量</div><div class="ag-ledger-mini-val">${esc(remLabel)}</div></div>
          <div><div class="ag-ledger-mini-lbl">缓存命中率</div><div class="ag-ledger-mini-val">${hitRate}%</div></div>
        </div>
        <div class="ag-ledger-foot">${esc(cumLine)}</div>
      </div>
      <div class="ag-ledger-card">
        <div class="ag-ledger-card-head">
          <span>最新生成速度与耗时</span>
          <span class="ag-ledger-badge" data-tone="${esc(spd.tone || 'muted')}">${esc(spd.badgeLabel || '—')}</span>
        </div>
        <div class="ag-ledger-mini-grid">
          <div><div class="ag-ledger-mini-lbl">输出速度</div><div class="ag-ledger-mini-val">${spd.tokensPerSec != null ? `${spd.tokensPerSec} tok/s` : '—'}</div></div>
          <div><div class="ag-ledger-mini-lbl">生成耗时</div><div class="ag-ledger-mini-val">${spd.durationSec != null ? `${spd.durationSec}s` : '—'}</div></div>
          <div><div class="ag-ledger-mini-lbl">首字延迟</div><div class="ag-ledger-mini-val">${spd.ttftSec != null ? `${spd.ttftSec}s` : '—'}</div></div>
          <div><div class="ag-ledger-mini-lbl">本次输出</div><div class="ag-ledger-mini-val">${esc(spd.outLabel || (spd.outputTokens ? `${spd.outputTokens} tok` : '—'))}</div></div>
        </div>
        <div class="ag-ledger-foot">${esc(spd.note || '—')}</div>
      </div>
    `;
  }

  function renderHeatmap(heat, fx) {
    if (!heat?.weeks) return '<div class="ag-ledger-foot">暂无热力图数据</div>';
    let html = '<div class="ag-ledger-heat-months">';
    for (const w of heat.weeks) {
      html += `<span>${w.monthLabel || ''}</span>`;
    }
    html += '</div><div class="ag-ledger-heat-grid">';
    for (const w of heat.weeks) {
      html += '<div class="ag-ledger-heat-col">';
      for (const d of w.days) {
        const cls = d.isFuture ? ' is-future' : '';
        const title = d.isFuture
          ? ''
          : `${d.date}：${fmtTokens(d.totalTokens)} tok · $${Number(d.costUSD || 0).toFixed(2)}`;
        html += `<div class="ag-ledger-heat-cell${cls}" data-lvl="${d.level || 0}" title="${title}"></div>`;
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderModels(models, fx) {
    if (!Array.isArray(models) || models.length === 0) {
      return '<div class="ag-ledger-model-row">当前筛选范围内暂无模型调用记录</div>';
    }
    const sum = models.reduce((n, m) => n + (m.totalTokens || 0), 0) || 1;
    const head = `<div class="ag-ledger-model-head"><span>模型</span><span>轮次</span><span>输入</span><span>输出含思考</span><span>缓存</span><span>合计</span><span>占比</span></div>`;
    const rows = models
      .map((m) => {
        const share = ((m.totalTokens || 0) / sum) * 100;
        const width = Math.max(0, Math.min(100, share));
        return `<div class="ag-ledger-model-row">
          <span class="ag-ledger-model-name" title="${esc(m.label)}">${esc(m.label)}</span>
          <span>${m.steps}</span>
          <span>${fmtTokens(m.inputTokens)}</span>
          <span>${fmtTokens(m.outputTokens)}</span>
          <span>${fmtTokens(m.cacheTokens)}</span>
          <span>${fmtTokens(m.totalTokens)}</span>
          <span class="ag-ledger-share">
            <span class="ag-ledger-share-track"><i style="width:${width.toFixed(1)}%"></i></span>
            <b>${share.toFixed(1)}%</b>
          </span>
        </div>`;
      })
      .join('');
    return head + rows;
  }

  function esc(s) {
    return String(s || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  function todaySource(snap) {
    const scopeCurrent = state.activityScope === 'current';
    if (scopeCurrent && snap.selectedConvId && snap.activePreciseView) return snap.activePreciseView;
    if (snap.preciseView) return snap.preciseView;
    const precise = snap.preciseToday;
    if (precise && (precise.totalTokens > 0 || precise.responses > 0)) return precise;
    const bucket = snap.fullLedger && snap.fullLedger.today;
    if (!bucket) return null;
    return {
      totalTokens: bucket.totalTokens || 0,
      inputTokens: bucket.inputTokens || 0,
      thinkingTokens: 0,
      outputTokens: bucket.outputTokens || 0,
      cacheReadTokens: bucket.cacheTokens || 0,
      cacheWriteTokens: 0,
      sessions: bucket.sessionsCount || 0,
      responses: bucket.steps || 0,
      coveragePct: 0,
      dailyAvgTokens: bucket.totalTokens || 0,
      series: [],
      bundledOutput: true
    };
  }

  function filterButtons(key, items) {
    return items
      .map(
        ([value, label]) =>
          `<button type="button" data-filter="${key}" data-value="${value}" class="${state.filters[key] === value ? 'is-active' : ''}">${label}</button>`
      )
      .join('');
  }

  function filterSelect(id, values, current, allLabel) {
    const opts = [`<option value="">${allLabel}</option>`];
    for (const value of values || []) {
      opts.push(`<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(value)}</option>`);
    }
    return `<select id="${id}">${opts.join('')}</select>`;
  }

  function renderTodayPanel(snap) {
    const day = todaySource(snap);
    if (!day) return '<div class="ag-ledger-foot">当前筛选下还没有 Token 记录</div>';
    const total = day.totalTokens || 0;
    const pct = (part) => (total > 0 ? ((part / total) * 100).toFixed(part / total < 0.01 ? 2 : 1) : '0.0');
    const promptTokens = (day.inputTokens || 0) + (day.cacheReadTokens || 0);
    const hitRate = promptTokens > 0 ? ((day.cacheReadTokens || 0) / promptTokens) * 100 : 0;
    const outputLabel = day.bundledOutput ? '输出含思考' : '输出 Tokens';
    const options = snap.preciseOptions || {};
    const scopeCurrent = state.activityScope === 'current' && Boolean(snap.selectedConvId);
    const rangeLabel = { today: '今日', '7d': '近7日', month: '本月', year: '年度', all: '累计' }[state.filters.range] || '今日';
    const scopeNote = scopeCurrent ? ' · 本路对话' : '';
    const fx = snap.fxCny || 7.2;
    const mainCcy = state.currency;
    const altCcy = mainCcy === 'USD' ? 'CNY' : 'USD';
    const cost = day.cost || {};
    const money = (usd) => (usd == null || Number.isNaN(Number(usd)) ? '—' : fmtMoney(usd, fx, mainCcy));
    const pctNum = (part) => (total > 0 ? Math.max(0, Math.min(100, (part / total) * 100)) : 0);
    const inW = pctNum(day.inputTokens || 0);
    const thinkW = pctNum(day.thinkingTokens || 0);
    const outW = pctNum(day.outputTokens || 0);
    const cacheW = pctNum(day.cacheReadTokens || 0);
    const segs = [];
    if (inW > 0) segs.push(`<span class="ag-ledger-stack-seg" data-k="in" style="flex:${inW.toFixed(2)} 0 0"></span>`);
    if (thinkW > 0) segs.push(`<span class="ag-ledger-stack-seg" data-k="think" style="flex:${Math.max(thinkW, 0.35).toFixed(2)} 0 0"></span>`);
    if (outW > 0) segs.push(`<span class="ag-ledger-stack-seg" data-k="out" style="flex:${Math.max(outW, 0.35).toFixed(2)} 0 0"></span>`);
    if (cacheW > 0) segs.push(`<span class="ag-ledger-stack-seg" data-k="cache" style="flex:${cacheW.toFixed(2)} 0 0"></span>`);

    return `
      <div class="ag-ledger-filters">
        <div class="ag-ledger-seg">${filterButtons('range', [['today', '今日'], ['7d', '近7日'], ['month', '本月'], ['year', '年度'], ['all', '累计']])}</div>
        <div class="ag-ledger-filter-selects">
          ${Array.isArray(options.machines) && options.machines.length > 0 ? filterSelect('ag-ledger-filter-machine', options.machines, state.filters.machine, '全部机器') : ''}
          ${filterSelect('ag-ledger-filter-category', options.categories, state.filters.category, '全部会话')}
          ${filterSelect('ag-ledger-filter-model', options.models, state.filters.model, '全部模型')}
          ${filterSelect('ag-ledger-filter-workspace', options.workspaces, state.filters.workspace, '全部工作区')}
        </div>
      </div>
      <div class="ag-ledger-cost-grid">
        <div class="ag-ledger-kpi"><div class="ag-ledger-cost-lbl">${rangeLabel}折算金额${scopeNote}</div><div class="ag-ledger-cost-val">${money(cost.totalUSD)}</div><div class="ag-ledger-cost-sub">≈ ${money(cost.totalUSD).startsWith('—') ? '—' : fmtMoney(cost.totalUSD, fx, altCcy)}</div></div>
        <div class="ag-ledger-kpi"><div class="ag-ledger-cost-lbl">输入</div><div class="ag-ledger-cost-val">${money(cost.inputUSD)}</div><div class="ag-ledger-cost-sub">${fmtWan(day.inputTokens, 1)}</div></div>
        <div class="ag-ledger-kpi"><div class="ag-ledger-cost-lbl">输出</div><div class="ag-ledger-cost-val">${money(cost.outputUSD)}</div><div class="ag-ledger-cost-sub">含思考 ${fmtWan((day.thinkingTokens || 0) + (day.outputTokens || 0), 1)}</div></div>
        <div class="ag-ledger-kpi" data-tone="good"><div class="ag-ledger-cost-lbl">缓存净省</div><div class="ag-ledger-cost-val">${money(cost.savedUSD)}</div><div class="ag-ledger-cost-sub">缓存费用 ${money(cost.cacheUSD)} · 日均 ${money(cost.dailyAvgUSD)}</div></div>
      </div>
      <div class="ag-ledger-today-top">
        <div class="ag-ledger-today-v-row">
          <span class="ag-ledger-today-k">精确合计 Tokens</span>
          <div class="ag-ledger-today-v">${fmtWan(total)}</div>
          <div class="ag-ledger-today-exact">${fmtExact(total)} tokens</div>
        </div>
        <div class="ag-ledger-today-side">
          <div><span>会话数</span><b>${day.sessions || 0}</b></div>
          <div><span>响应轮次</span><b>${day.responses || 0}</b></div>
          <div><span>精确覆盖率</span><b>${Number(day.coveragePct || 0).toFixed(1)}%</b></div>
          <div><span>活跃日均</span><b>${fmtWan(day.dailyAvgTokens || total)}</b></div>
        </div>
      </div>
      <div class="ag-ledger-stack-bar">${segs.join('')}</div>
      <div class="ag-ledger-today-metrics">
        <div class="ag-ledger-today-metric" data-k="in"><div class="ag-ledger-metric-head"><span class="ag-ledger-swatch" data-k="in"></span>输入</div><b>${fmtWan(day.inputTokens, 1)}</b><small>${pct(day.inputTokens)}% · ${fmtExact(day.inputTokens)}</small></div>
        <div class="ag-ledger-today-metric" data-k="think"><div class="ag-ledger-metric-head"><span class="ag-ledger-swatch" data-k="think"></span>思考</div><b>${fmtWan(day.thinkingTokens, 1)}</b><small>${pct(day.thinkingTokens)}% · ${fmtExact(day.thinkingTokens)}</small></div>
        <div class="ag-ledger-today-metric" data-k="out"><div class="ag-ledger-metric-head"><span class="ag-ledger-swatch" data-k="out"></span>${outputLabel.replace(' Tokens', '')}</div><b>${fmtWan(day.outputTokens, 1)}</b><small>${pct(day.outputTokens)}% · ${fmtExact(day.outputTokens)}</small></div>
        <div class="ag-ledger-today-metric" data-k="cache"><div class="ag-ledger-metric-head"><span class="ag-ledger-swatch" data-k="cache"></span>缓存读取</div><b>${fmtWan(day.cacheReadTokens, 1)}</b><small>${pct(day.cacheReadTokens)}% · W ${fmtWan(day.cacheWriteTokens || 0, 1)}</small></div>
        <div class="ag-ledger-today-metric" data-k="hit"><div class="ag-ledger-metric-head"><span class="ag-ledger-swatch" data-k="hit"></span>缓存命中率</div><b>${hitRate.toFixed(1)}%</b><small>读取 ÷ (输入+读取)</small></div>
      </div>`;
  }

  function renderLedgerSections(snap, live) {
    if (!snap) {
      if (refs.today) refs.today.innerHTML = '<div class="ag-ledger-foot">账本 API 未就绪（请保持 node src/server.js 运行于 127.0.0.1:19825）</div>';
      refs.period.innerHTML = '';
      refs.activity.innerHTML = '';
      return;
    }
    const fx = snap.fxCny || 7.2;
    const ledger = snap.fullLedger;
    const preciseLedger = snap.preciseLedger;
    const heat = snap.fullHeatmap;
    const mainCcy = state.currency;

    const topTodayUSD = preciseLedger?.today?.cost?.totalUSD ?? ledger?.today?.cost?.totalUSD ?? 0;
    const topAllUSD = preciseLedger?.allTime?.cost?.totalUSD ?? ledger?.allTime?.cost?.totalUSD ?? 0;
    state.topCostToday = fmtMoney(topTodayUSD, fx, mainCcy);
    state.topCostTotal = fmtMoney(topAllUSD, fx, mainCcy);

    if (refs.ccyBtn) {
      refs.ccyBtn.textContent = mainCcy === 'CNY' ? '¥ CNY 主显' : '$ USD 主显';
    }
    if (refs.connChip) {
      refs.connChip.textContent = state.apiOk ? '127.0.0.1:19825 已连接' : '本地账本离线';
    }
    if (refs.pinBtn) {
      const pinned = Boolean(state.pinnedConvId);
      refs.pinBtn.textContent = pinned ? '已锁定本路' : '自动跟随会话';
      refs.pinBtn.classList.toggle('is-active', pinned);
    }

    if (refs.today) refs.today.innerHTML = renderTodayPanel(snap);
    const scopeCurrentLed = state.activityScope === 'current' && snap.selectedConvId && snap.activePreciseLedger;
    refs.period.innerHTML = ['allTime', 'month', 'year']
      .map((key, i) => {
        const labels = ['累计', '本月', '年度'];
        const activeRaw = scopeCurrentLed && snap.activePreciseLedger[key];
        const raw =
          activeRaw ||
          (state.activityScope === 'current' && snap.activeLedger && snap.activeLedger[key]) ||
          (preciseLedger && preciseLedger[key]) ||
          (snap.fullLedger && snap.fullLedger[key]);
        const bucket = {
          totalTokens: raw.totalTokens || 0,
          inputTokens: raw.inputTokens || 0,
          thinkingTokens: raw.thinkingTokens || 0,
          outputTokens: raw.outputTokens || 0,
          cacheTokens: raw.cacheReadTokens != null ? raw.cacheReadTokens : raw.cacheTokens || 0,
          sessionsCount: raw.sessions != null ? raw.sessions : raw.sessionsCount || 0,
          steps: raw.responses != null ? raw.responses : raw.steps || 0
        };
        const total = bucket.totalTokens || 0;
        const pct = (part) => (total > 0 ? ((part / total) * 100).toFixed(1) : '0.0');
        const split = raw.thinkingTokens != null;
        return `
          <div class="ag-ledger-card">
            <div class="ag-ledger-card-head"><span>${labels[i]}精确合计</span><span class="ag-ledger-badge">${bucket.sessionsCount} 会话 · ${bucket.steps} 轮</span></div>
            <div class="ag-ledger-period-val-row">
              <div class="ag-ledger-period-val">${fmtWan(total)}</div>
              <span class="ag-ledger-period-exact">${fmtExact(total)}</span>
            </div>
            <div class="ag-ledger-period-lines">
              <div>输入 ${fmtWan(bucket.inputTokens, 1)} (${pct(bucket.inputTokens)}%) · ${split ? `思考 ${fmtWan(bucket.thinkingTokens, 1)} · 输出 ${fmtWan(bucket.outputTokens, 1)}` : `输出含思考 ${fmtWan(bucket.outputTokens, 1)}`}</div>
              <div>缓存 ${fmtWan(bucket.cacheTokens, 1)}</div>
            </div>
          </div>`;
      })
      .join('');

    const showModels = state.activityTab === 'models';
    const scopeCurrent = state.activityScope === 'current';
    const viewLedger = scopeCurrent && snap.activeLedger ? snap.activeLedger : ledger;
    const scopeSeg = showModels
      ? `<div class="ag-ledger-seg">
            <button type="button" id="ag-ledger-scope-current" class="${scopeCurrent ? 'is-active' : ''}">当前对话</button>
            <button type="button" id="ag-ledger-scope-all" class="${scopeCurrent ? '' : 'is-active'}">全部对话</button>
          </div>`
      : '';
    refs.activity.innerHTML = `
      <div class="ag-ledger-card-head">
        <span>Token 活动 · 首次 ${ledger.firstActiveDate}${showModels ? '' : '<span id="ag-ledger-heat-tip" class="ag-ledger-heat-tip">鼠标移到格子可查看当日明细</span>'}</span>
        <div class="ag-ledger-head-actions">
          ${scopeSeg}
          <div class="ag-ledger-seg">
            <button type="button" id="ag-ledger-tab-heat" class="${showModels ? '' : 'is-active'}">52 周热力图</button>
            <button type="button" id="ag-ledger-tab-models" class="${showModels ? 'is-active' : ''}">模型费用构成</button>
          </div>
        </div>
      </div>
      <div id="ag-ledger-pane-heat" class="ag-ledger-heat-wrap"${showModels ? ' hidden' : ''}>${renderHeatmap(heat, fx)}</div>
      <div id="ag-ledger-pane-models"${showModels ? '' : ' hidden'}>${renderModels(viewLedger.byModel, fx)}</div>
    `;

  }

  function fitBoard() {
    if (!boardEl || !state.boardOpen) return;
    const fit = boardEl.querySelector('.ag-ledger-fit');
    if (!fit) return;
    fit.style.zoom = '1';
    const styles = getComputedStyle(boardEl);
    const pad = (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0);
    const gap = parseFloat(styles.rowGap || styles.gap) || 0;
    const header = boardEl.querySelector('.ag-ledger-hdr');
    const headerH = header ? header.offsetHeight : 0;
    const maxH = parseFloat(styles.maxHeight) || window.innerHeight - 80;
    const avail = maxH - pad - headerH - gap;
    const need = fit.scrollHeight;
    if (avail < 80 || need <= avail) return;
    const scale = Math.max(0.75, Math.min(1, avail / need));
    fit.style.zoom = String(scale);
  }

  function renderAll() {
    ensureShell();
    const metrics = window.__ag_last_metrics || null;
    const live = parseLiveMetrics(metrics);
    if (refs.connChip) {
      refs.connChip.textContent = state.apiOk ? '127.0.0.1:19825 已连接' : '本地账本离线';
    }
    if (refs.ccyBtn) {
      refs.ccyBtn.textContent = state.currency === 'CNY' ? '¥ CNY 主显' : '$ USD 主显';
    }
    if (refs.pinBtn) {
      const pinned = Boolean(state.pinnedConvId);
      refs.pinBtn.textContent = pinned ? '已锁定本路' : '自动跟随会话';
      refs.pinBtn.classList.toggle('is-active', pinned);
    }
    if (refs.offline) {
      if (!state.apiOk) {
        refs.offline.hidden = false;
        refs.offline.textContent =
          '账本 API 未连接：请在后台运行 node antigravity-token-bar/src/server.js（127.0.0.1:19825）。上方停靠条的会话指标仍与补丁内核推送同源。';
      } else {
        refs.offline.hidden = true;
      }
    }
    renderSessionCards(live, state.snapshot);
    renderLedgerSections(state.snapshot, live);
    syncDock(metrics, live);
    syncBoardDom();
    fitBoard();
  }

  async function refreshSnapshot(fresh) {
    const convId = resolveCurrentConvId();
    const params = new URLSearchParams();
    if (convId) params.set('convId', convId);
    const filters = state.filters || {};
    params.set('range', filters.range || 'today');
    params.set('grain', filters.grain || 'day');
    if (filters.category) params.set('category', filters.category);
    if (filters.model) params.set('model', filters.model);
    if (filters.workspace) params.set('workspace', filters.workspace);
    if (filters.machine) params.set('machine', filters.machine);
    if (fresh) params.set('fresh', '1');
    const qs = `?${params.toString()}`;
    const keepBoardOpen = state.boardOpen;
    try {
      const res = await fetch(`${API_BASE}/api/snapshot${qs}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      if (data && data.ok) {
        state.snapshot = data;
        state.apiOk = true;
      }
    } catch (e) {
      state.apiOk = false;
    }
    if (keepBoardOpen) state.boardOpen = true;
    renderAll();
  }

  const tick = () => {
    try {
      if (typeof window.__ag_ensure_metrics_pill_fn === 'function') {
        window.__ag_ensure_metrics_pill_fn(false);
      }
    } catch (e) {}
    const metrics = window.__ag_last_metrics || null;
    syncDock(metrics, parseLiveMetrics(metrics));
    if (state.boardOpen) hideCoreMetricsTooltip();
  };

  let cancelled = false;
  let bootStarted = false;
  let intervalId = 0;
  let fastId = 0;
  let quotaId = 0;
  let resizeRaf = 0;
  const unlisten = [];

  function listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    unlisten.push(() => target.removeEventListener(type, fn, opts));
  }

  function cleanupLedger() {
    if (cancelled) return;
    cancelled = true;
    clearInterval(intervalId);
    clearInterval(fastId);
    clearInterval(quotaId);
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = 0;
    while (unlisten.length) {
      try { unlisten.pop()(); } catch (e) {}
    }
    document.querySelectorAll('#ag-ledger-dock, #ag-ledger-board, #ag-ledger-backdrop').forEach((el) => {
      el.classList.add('ag-ledger-stale');
      el.remove();
    });
    boardEl = null;
    backdropEl = null;
    dockEl = null;
    dockQuotaEl = null;
  }

  window.__agLedgerCleanup = cleanupLedger;
  if (typeof ctx !== 'undefined' && ctx.onCleanup) ctx.onCleanup(cleanupLedger);

  /** 新窗口的补丁脚本在 document-start 执行，此时还没有 body，必须等 DOM 再挂停靠条 */
  function bootLedger() {
    if (cancelled || bootStarted) return;
    if (!document.body) {
      listen(document, 'DOMContentLoaded', bootLedger, { once: true });
      return;
    }
    bootStarted = true;
    document.querySelectorAll('#ag-ledger-board, #ag-ledger-backdrop, #ag-ledger-dock').forEach((el) => el.remove());
    boardEl = null;
    backdropEl = null;
    dockEl = null;
    ensureShell();
    setBoardOpen(state.boardOpen);

    intervalId = setInterval(() => {
      void refreshSnapshot();
    }, 2000);
    fastId = setInterval(tick, 800);
    quotaId = setInterval(() => { void refreshQuota(false); }, 5000);
    void refreshQuota(false);

    listen(window, 'keydown', (e) => {
      if (e.key === 'Escape' && state.boardOpen) setBoardOpen(false);
    });
    listen(document, 'focusin', (e) => {
      const box = boxFromNode(e.target);
      if (!box) return;
      lastFocusedBox = box;
      tick();
    }, true);
    listen(window, 'resize', () => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        if (cancelled) return;
        const metrics = window.__ag_last_metrics || null;
        syncDock(metrics, parseLiveMetrics(metrics));
        fitBoard();
      });
    });

    void refreshSnapshot();
    tick();
  }

  bootLedger();
})();