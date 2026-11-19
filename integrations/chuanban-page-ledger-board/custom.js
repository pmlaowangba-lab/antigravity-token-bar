/**
 * 页内 API 折算金额 · 缓存净省 · 聚合看板（user 改装层）
 * 实时会话指标与底部 #ag-live-metrics-pill 同源（window.__ag_last_metrics / ctx.metrics）
 * 账本汇总走本机 127.0.0.1:19825（antigravity-token-bar API，非悬浮窗进程）
 */
(function agLedgerPageBoard() {
  const API_BASE = 'http://127.0.0.1:19825';
  const LS_CCY = 'ag_ledger_ccy';
  const LS_FRESH = 'ag_ledger_only_fresh';
  const LS_PIN = 'ag_ledger_pinned_conv';
  const LS_OPEN = 'ag_ledger_board_open';

  /** 避免 pointerdown 打开后同一击的 click 落在遮罩上立刻关掉面板 */
  let suppressBackdropCloseUntil = 0;

  const state = {
    boardOpen: localStorage.getItem(LS_OPEN) === '1',
    onlyFresh: localStorage.getItem(LS_FRESH) !== '0',
    currency: localStorage.getItem(LS_CCY) === 'CNY' ? 'CNY' : 'USD',
    pinnedConvId: localStorage.getItem(LS_PIN) || '',
    activityTab: 'heat',
    snapshot: null,
    apiOk: false,
    topCostLabel: '💰 —'
  };

  function extractCascadeId() {
    try {
      const m = window.location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
      if (m) return m[1];
    } catch (e) {}
    return '';
  }

  function fmtTokens(n) {
    const v = Math.max(0, Number(n) || 0);
    if (v === 512000 || v === 524288) return '512K';
    if (v === 1048576) return '1024K';
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e5) return `${Math.round(v / 1e3)}K`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return String(Math.round(v));
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
      healthNote: `✓ 当前上下文占用 ${usedPct}%（与底部指标胶囊同源实时推送）。`,
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

  let boardEl, backdropEl, dockEl, dockMetricsEl, dockCostEl;
  const refs = {};

  const DOCK_TOP_PX = 10;
  const DOCK_BAND_PX = 56;
  /** 在避让标题栏按钮后，再向右贴一些（减小 right 偏移） */
  const DOCK_NUDGE_RIGHT_PX = 28;

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
    const rightPx = Math.max(8, measureTopRightChromeInset() - DOCK_NUDGE_RIGHT_PX);
    dockEl.style.setProperty('--ag-ledger-dock-right', `${Math.round(rightPx)}px`);
    dockEl.style.setProperty('--ag-ledger-dock-top', `${DOCK_TOP_PX}px`);
  }

  function buildDockMetricsHtml(metrics, live) {
    if (!metrics?.inlineHtml && !live) return '';
    let tps = live?.speed?.tokensPerSec ?? null;
    let pct = live?.usedPercent ?? 0;
    let ctxUsed = live?.contextUsedLabel || '';
    let ctxLimit = live?.contextLimitLabel || '512k';
    if (metrics?.inlineHtml) {
      const probe = document.createElement('span');
      probe.innerHTML = metrics.inlineHtml;
      const txt = probe.textContent || '';
      const tpsM = txt.match(/([0-9]+)\s*tok\/s/i);
      const ctxM = txt.match(/Ctx\s+([^/]+)\/([^\s(]+)\s*\((\d+)%\)/i);
      if (tps == null && tpsM) tps = Number(tpsM[1]);
      if (ctxM) {
        if (!ctxUsed) ctxUsed = ctxM[1].trim();
        ctxLimit = ctxM[2].trim();
        if (!live?.usedPercent) pct = Number(ctxM[3]);
      }
    }
    const ctxClass = pct >= 90 ? 'ag-ctx-crit' : pct >= 75 ? 'ag-ctx-warn' : 'ag-ctx-ok';
    const tpsTxt = tps != null ? `${tps} tok/s` : '— tok/s';
    const ctxInner = ctxUsed
      ? `Ctx ${ctxUsed}/${ctxLimit} <span class="${ctxClass}">(${Math.round(pct)}%)</span>`
      : `Ctx <span class="${ctxClass}">(${Math.round(pct)}%)</span>`;
    return `<span>${tpsTxt}</span><span class="ag-sep">·</span><span>${ctxInner}</span>`;
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
        document.body.appendChild(backdropEl);
        document.body.appendChild(boardEl);
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
          <div class="ag-ledger-title">本机已记录用量 · 页内看板</div>
          <div class="ag-ledger-actions">
            <button type="button" id="ag-ledger-btn-reset" class="ag-ledger-pill">重置新账起点</button>
            <button type="button" id="ag-ledger-btn-close" class="ag-ledger-pill">收起 ×</button>
          </div>
        </div>
        <div id="ag-ledger-offline" class="ag-ledger-offline" hidden></div>
        <section class="ag-ledger-grid-2" id="ag-ledger-session-pair"></section>
        <section class="ag-ledger-card" id="ag-ledger-cost-section"></section>
        <section class="ag-ledger-period-grid" id="ag-ledger-period"></section>
        <section class="ag-ledger-card" id="ag-ledger-activity"></section>
      `;
      document.body.appendChild(boardEl);

      refs.offline = boardEl.querySelector('#ag-ledger-offline');
      refs.sessionPair = boardEl.querySelector('#ag-ledger-session-pair');
      refs.costSection = boardEl.querySelector('#ag-ledger-cost-section');
      refs.period = boardEl.querySelector('#ag-ledger-period');
      refs.activity = boardEl.querySelector('#ag-ledger-activity');

      boardEl.querySelector('#ag-ledger-btn-close').addEventListener('click', () => setBoardOpen(false));
      boardEl.querySelector('#ag-ledger-btn-reset').addEventListener('click', async () => {
        try {
          const res = await fetch(`${API_BASE}/api/reset-baseline`, { method: 'POST' });
          if (res.ok) {
            const json = await res.json();
            state.onlyFresh = true;
            localStorage.setItem(LS_FRESH, '1');
            state.snapshot = json.snapshot || null;
            renderAll();
          }
        } catch (e) {}
      });
      boardEl.addEventListener('click', (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLElement)) return;
        const id = t.id;
        if (id === 'ag-ledger-scope') {
          state.onlyFresh = !state.onlyFresh;
          localStorage.setItem(LS_FRESH, state.onlyFresh ? '1' : '0');
          renderAll();
        } else if (id === 'ag-ledger-ccy') {
          state.currency = state.currency === 'USD' ? 'CNY' : 'USD';
          localStorage.setItem(LS_CCY, state.currency);
          renderAll();
        } else if (id === 'ag-ledger-tab-heat') {
          refs.activity.querySelector('#ag-ledger-pane-heat').hidden = false;
          refs.activity.querySelector('#ag-ledger-pane-models').hidden = true;
        } else if (id === 'ag-ledger-tab-models') {
          refs.activity.querySelector('#ag-ledger-pane-heat').hidden = true;
          refs.activity.querySelector('#ag-ledger-pane-models').hidden = false;
        }
      });
    }
    if (!dockEl) {
      dockEl = document.createElement('div');
      dockEl.id = 'ag-ledger-dock';
      dockEl.setAttribute('role', 'button');
      dockEl.setAttribute('tabindex', '0');
      dockEl.setAttribute('aria-label', '会话指标与 API 折算，点击查看完整账本看板');
      dockEl.title = '点击任意位置打开完整账本看板 · 右键切换 USD/CNY';
      dockMetricsEl = document.createElement('span');
      dockMetricsEl.id = 'ag-ledger-dock-metrics';
      const vsep = document.createElement('span');
      vsep.id = 'ag-ledger-dock-vsep';
      vsep.setAttribute('aria-hidden', 'true');
      dockCostEl = document.createElement('span');
      dockCostEl.id = 'ag-ledger-dock-cost';
      dockEl.append(dockMetricsEl, vsep, dockCostEl);
      document.body.appendChild(dockEl);

      const openBoardFromDock = (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        }
        hideCoreMetricsTooltip();
        ensureShell();
        suppressBackdropCloseUntil = performance.now() + 480;
        setBoardOpen(true);
        renderAll();
        void refreshSnapshot();
      };
      dockEl.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        openBoardFromDock(e);
      }, true);
      dockEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, true);
      dockEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') openBoardFromDock(e);
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

  function syncDock(metrics, costLabel, live) {
    if (!dockEl || !dockMetricsEl || !dockCostEl) return;
    applyDockGeometry();
    const cid = extractCascadeId();
    const visible =
      Boolean(cid) && metrics && metrics.hasData && metrics.cascadeId === cid && metrics.inlineHtml;
    if (!visible) {
      dockEl.style.display = 'none';
      hideCoreMetricsTooltip();
      return;
    }
    if (document.body) document.body.appendChild(dockEl);
    document.getElementById('ag-ledger-dock-hint')?.remove();
    const metricsHtml = buildDockMetricsHtml(metrics, live);
    if (dockMetricsEl.innerHTML !== metricsHtml) dockMetricsEl.innerHTML = metricsHtml;
    const costText = costLabel || '💰 —';
    if (dockCostEl.textContent !== costText) dockCostEl.textContent = costText;
    dockEl.style.display = 'inline-flex';
  }

  function renderSessionCards(live, snap) {
    if (!refs.sessionPair) return;
    const sess = snap?.activeSession;
    const fx = snap?.fxCny || 7.2;
    const usedPct = live ? live.usedPercent : sess?.usedPercent || 0;
    const tone = live ? live.healthTone : sess?.healthTone || 'muted';
    const badge = live ? live.healthLabel : sess?.healthLabel || '—';
    const spd = live?.speed || sess?.speed || {};

    const cumLine = sess?.sessionTotals
      ? `单会话累计 (${sess.sessionTotals.turns} 轮 / ${sess.sessionTotals.calls} 次调用)：新增 ${fmtTokens(sess.sessionTotals.inputTokens)} + 缓存 ${fmtTokens(sess.sessionTotals.cacheTokens)} (${sess.sessionTotals.cacheHitRate}%) · 输出 ${fmtTokens(sess.sessionTotals.outputTokens)} · ≈ ${fmtMoney(sess.sessionTotals.totalUSD, fx, state.currency)}`
      : '账本服务未连接，仅展示补丁实时指标。';

    refs.sessionPair.innerHTML = `
      <div class="ag-ledger-card">
        <div class="ag-ledger-card-head">
          <span>⭐ 核心用量速览（512K 压缩水位线）</span>
          <span class="ag-ledger-pill" data-tone="${tone}">${badge}</span>
        </div>
        <div class="ag-ledger-progress"><div data-tone="${tone}" style="width:${Math.min(100, usedPct)}%"></div></div>
        <div class="ag-ledger-mini-grid">
          <div><div class="ag-ledger-mini-lbl">当前已用</div><div class="ag-ledger-mini-val">${live?.contextUsedLabel || fmtTokens(sess?.contextUsed || 0)} (${Math.round(usedPct)}%)</div></div>
          <div><div class="ag-ledger-mini-lbl">压缩水位线</div><div class="ag-ledger-mini-val">${live?.contextLimitLabel || fmtTokens(sess?.contextLimit || 512000)}</div></div>
          <div><div class="ag-ledger-mini-lbl">距压缩余量</div><div class="ag-ledger-mini-val">${sess ? fmtTokens(sess.remainingTokens) : '—'}</div></div>
          <div><div class="ag-ledger-mini-lbl">缓存命中率</div><div class="ag-ledger-mini-val">${(live?.sessionCacheRate ?? sess?.sessionTotals?.cacheHitRate ?? 0).toFixed(1)}%</div></div>
        </div>
        <div class="ag-ledger-foot">${cumLine}</div>
        <div class="ag-ledger-foot">${live?.healthNote || sess?.healthNote || ''}</div>
      </div>
      <div class="ag-ledger-card">
        <div class="ag-ledger-card-head">
          <span>⚡ 最新生成速度与耗时</span>
          <span class="ag-ledger-pill" data-tone="${spd.tone || 'muted'}">${spd.badgeLabel || '—'}</span>
        </div>
        <div class="ag-ledger-mini-grid">
          <div><div class="ag-ledger-mini-lbl">输出速度</div><div class="ag-ledger-mini-val">${spd.tokensPerSec != null ? `${spd.tokensPerSec} tok/s` : '—'}</div></div>
          <div><div class="ag-ledger-mini-lbl">生成耗时</div><div class="ag-ledger-mini-val">${spd.durationSec != null ? `${spd.durationSec}s` : '—'}</div></div>
          <div><div class="ag-ledger-mini-lbl">首字延迟</div><div class="ag-ledger-mini-val">${spd.ttftSec != null ? `${spd.ttftSec}s` : '—'}</div></div>
          <div><div class="ag-ledger-mini-lbl">本次输出</div><div class="ag-ledger-mini-val">${spd.outLabel || (spd.outputTokens ? `${spd.outputTokens} tok` : '—')}</div></div>
        </div>
        <div class="ag-ledger-foot">${spd.note || '—'}</div>
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
    return models
      .map(
        (m) =>
          `<div class="ag-ledger-model-row"><span>${m.label}（${m.steps} 次）</span><span>${fmtTokens(m.totalTokens)} · $${m.totalUSD.toFixed(2)} (≈ ¥${(m.totalUSD * fx).toFixed(2)})</span></div>`
      )
      .join('');
  }

  function renderLedgerSections(snap, live) {
    if (!snap) {
      refs.costSection.innerHTML = '<div class="ag-ledger-foot">账本 API 未就绪（请保持 node src/server.js 运行于 127.0.0.1:19825）</div>';
      refs.period.innerHTML = '';
      refs.activity.innerHTML = '';
      return;
    }
    const fx = snap.fxCny || 7.2;
    const ledger = state.onlyFresh ? snap.freshLedger : snap.fullLedger;
    const heat = state.onlyFresh ? snap.freshHeatmap : snap.fullHeatmap;
    const mainCcy = state.currency;
    const altCcy = mainCcy === 'USD' ? 'CNY' : 'USD';

    const todayText = fmtMoney(ledger.today.cost.totalUSD, fx, mainCcy);
    const totalText = fmtMoney(ledger.allTime.cost.totalUSD, fx, mainCcy);
    state.topCostLabel = `💰 ${todayText} · 总${totalText}`;

    const scopeLabel = state.onlyFresh
      ? `自安装起算 (${snap.sinceLocalLabel}) · 无回溯`
      : '全量历史 52 周回溯';
    const scopeTone = state.onlyFresh ? 'good' : 'muted';

    refs.costSection.innerHTML = `
      <div class="ag-ledger-card-head">
        <div>💰 API 折算汇总金额 <span class="ag-ledger-pill" data-tone="${scopeTone}">${scopeLabel}</span></div>
        <div class="ag-ledger-seg">
          <button type="button" id="ag-ledger-scope" class="${state.onlyFresh ? 'is-active' : ''}">${state.onlyFresh ? '仅算新账 ✓' : '仅算新账'}</button>
          <button type="button" id="ag-ledger-ccy" class="is-active">${mainCcy === 'CNY' ? '¥ CNY 主显' : '$ USD 主显'}</button>
        </div>
      </div>
      <div class="ag-ledger-cost-grid">
        <div><div class="ag-ledger-cost-lbl">今日汇总</div><div class="ag-ledger-cost-val">${fmtMoney(ledger.today.cost.totalUSD, fx, mainCcy)}</div><div class="ag-ledger-cost-sub">≈ ${fmtMoney(ledger.today.cost.totalUSD, fx, altCcy)}</div></div>
        <div><div class="ag-ledger-cost-lbl">本月汇总</div><div class="ag-ledger-cost-val">${fmtMoney(ledger.month.cost.totalUSD, fx, mainCcy)}</div><div class="ag-ledger-cost-sub">日均 ${fmtMoney(ledger.month.cost.dailyAvgUSD, fx, mainCcy)}</div></div>
        <div><div class="ag-ledger-cost-lbl">累计总金额</div><div class="ag-ledger-cost-val">${fmtMoney(ledger.allTime.cost.totalUSD, fx, mainCcy)}</div><div class="ag-ledger-cost-sub">${ledger.allTime.activeDays} 天活跃</div></div>
        <div><div class="ag-ledger-cost-lbl">缓存命中净省</div><div class="ag-ledger-cost-val">${fmtMoney(ledger.allTime.cost.savedUSD, fx, mainCcy)}</div><div class="ag-ledger-cost-sub">命中率 ${ledger.allTime.cacheHitRate}% · 省 ${fmtMoney(ledger.allTime.cost.savedUSD, fx, altCcy)}</div></div>
      </div>
      <div class="ag-ledger-foot">今日拆分：输入 ${fmtMoney(ledger.today.cost.inputUSD, fx, mainCcy)} · 缓存 ${fmtMoney(ledger.today.cost.cacheUSD, fx, mainCcy)} · 输出 ${fmtMoney(ledger.today.cost.outputUSD, fx, mainCcy)}</div>
    `;

    refs.period.innerHTML = ['allTime', 'today', 'month', 'year']
      .map((key, i) => {
        const labels = ['累计', '今日', '本月', '年度'];
        const bucket = ledger[key];
        return `
          <div class="ag-ledger-card">
            <div class="ag-ledger-card-head"><span>${labels[i]} Token</span><span class="ag-ledger-pill">${labels[i]}</span></div>
            <div class="ag-ledger-period-val">${fmtTokens(bucket.totalTokens)}</div>
            <div class="ag-ledger-foot">缓存命中率 ${bucket.cacheHitRate.toFixed(1)}% · 缓存 ${fmtTokens(bucket.cacheTokens)}</div>
            <div class="ag-ledger-foot">≈ ${fmtMoney(bucket.cost.totalUSD, fx, mainCcy)}</div>
          </div>`;
      })
      .join('');

    refs.activity.innerHTML = `
      <div class="ag-ledger-card-head">
        <span>Token 活动 · 首次 ${ledger.firstActiveDate}</span>
        <div class="ag-ledger-seg">
          <button type="button" id="ag-ledger-tab-heat" class="is-active">52 周热力图</button>
          <button type="button" id="ag-ledger-tab-models">模型费用构成</button>
        </div>
      </div>
      <div id="ag-ledger-pane-heat">${renderHeatmap(heat, fx)}</div>
      <div id="ag-ledger-pane-models" hidden>${renderModels(ledger.byModel, fx)}</div>
    `;

  }

  function renderAll() {
    ensureShell();
    const metrics = window.__ag_last_metrics || null;
    const live = parseLiveMetrics(metrics);
    syncDock(metrics, state.topCostLabel, live);
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
    syncBoardDom();
  }

  async function refreshSnapshot() {
    const convId = state.pinnedConvId || extractCascadeId();
    const qs = convId ? `?convId=${encodeURIComponent(convId)}` : '';
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
    syncDock(metrics, state.topCostLabel, parseLiveMetrics(metrics));
    if (state.boardOpen) hideCoreMetricsTooltip();
  };

  ensureShell();
  setBoardOpen(state.boardOpen);

  const pollMs = 3500;
  const intervalId = setInterval(() => {
    void refreshSnapshot();
  }, pollMs);

  const fastId = setInterval(tick, 800);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.boardOpen) setBoardOpen(false);
  });

  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      const metrics = window.__ag_last_metrics || null;
      syncDock(metrics, state.topCostLabel, parseLiveMetrics(metrics));
    });
  });

  if (typeof ctx !== 'undefined' && ctx.onCleanup) {
    ctx.onCleanup(() => {
      clearInterval(intervalId);
      clearInterval(fastId);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      boardEl?.remove();
      backdropEl?.remove();
      dockEl?.remove();
    });
  }

  void refreshSnapshot();
  tick();
})();