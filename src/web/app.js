(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const isOverlay = params.get('mode') === 'overlay';
  document.body.classList.add(isOverlay ? 'is-overlay' : 'is-standalone');

  const banner = document.getElementById('tb-standalone-banner');
  if (banner && !isOverlay) banner.hidden = false;

  const state = {
    boardOpen: !isOverlay,
    onlyFresh: localStorage.getItem('atb_only_fresh') !== '0',
    currency: localStorage.getItem('atb_ccy') === 'CNY' ? 'CNY' : 'USD',
    theme: localStorage.getItem('atb_theme') || 'auto',
    pinnedConvId: localStorage.getItem('atb_pinned_conv') || '',
    activityTab: 'heat',
    snapshot: null
  };

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
  }
  applyTheme();

  function fmtTokens(n) {
    const v = Math.max(0, Number(n) || 0);
    if (v === 512_000 || v === 524_288) return '512K';
    if (v === 1_048_576) return '1024K';
    if (v >= 1_000_000_000) return `${(v / 1e9).toFixed(2)}B`;
    if (v >= 1_000_000) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 100_000) return `${Math.round(v / 1e3)}K`;
    if (v >= 1_000) return `${(v / 1e3).toFixed(1)}K`;
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

  function postNative(handler, payload) {
    try {
      window.webkit?.messageHandlers?.[handler]?.postMessage?.(payload);
    } catch {
      // 浏览器环境下无原生桥接，静默跳过
    }
  }

  function syncBoardOpen(open) {
    state.boardOpen = Boolean(open);
    const board = document.getElementById('tb-board');
    if (board) board.hidden = !state.boardOpen;
    for (const id of ['tb-btn-ctx', 'tb-btn-quota', 'tb-btn-speed', 'tb-btn-cache', 'tb-btn-tokens', 'tb-btn-cost']) {
      document.getElementById(id)?.setAttribute('aria-expanded', String(state.boardOpen));
    }
    postNative('agPanelState', { open: state.boardOpen });
  }

  function reportStripWidth() {
    if (!isOverlay) return;
    const strip = document.getElementById('tb-strip');
    if (!strip) return;
    const w = strip.getBoundingClientRect().width;
    if (w > 80) postNative('agBarWidth', { width: w });
  }

  function renderRing(percent, tone) {
    const circle = document.getElementById('tb-ring-progress');
    if (!circle) return;
    const circumference = 2 * Math.PI * 6.5;
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    const dash = (clamped / 100) * circumference;
    circle.setAttribute('stroke-dasharray', `${dash.toFixed(2)} ${circumference.toFixed(2)}`);
    circle.setAttribute('data-tone', tone || 'good');
  }

  function renderHeatmap(heat) {
    const monthsEl = document.getElementById('tb-heat-months');
    const gridEl = document.getElementById('tb-heat-grid');
    const hoverInfo = document.getElementById('tb-heat-hover-info');
    if (!monthsEl || !gridEl || !heat?.weeks) return;

    monthsEl.innerHTML = '';
    gridEl.innerHTML = '';

    for (const w of heat.weeks) {
      const mSpan = document.createElement('span');
      mSpan.textContent = w.monthLabel || '';
      monthsEl.appendChild(mSpan);

      const col = document.createElement('div');
      col.className = 'tb-heat-col';
      for (const d of w.days) {
        const cell = document.createElement('div');
        cell.className = 'tb-heat-cell' + (d.isFuture ? ' is-future' : '');
        cell.setAttribute('data-lvl', String(d.level || 0));
        if (!d.isFuture && hoverInfo) {
          cell.addEventListener('mouseenter', () => {
            hoverInfo.textContent = `${d.date}：${fmtTokens(d.totalTokens)} Tokens（输入 ${fmtTokens(d.inputTokens)} / 缓存 ${fmtTokens(d.cacheTokens)} / 输出 ${fmtTokens(d.outputTokens)}）· 约 $${d.costUSD.toFixed(2)} (¥${d.costCNY.toFixed(2)})`;
          });
        }
        col.appendChild(cell);
      }
      gridEl.appendChild(col);
    }
  }

  function renderModelsList(models, fx) {
    const listEl = document.getElementById('tb-models-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!Array.isArray(models) || models.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tb-model-row';
      empty.textContent = '当前筛选范围内暂无模型调用记录';
      listEl.appendChild(empty);
      return;
    }
    for (const m of models) {
      const row = document.createElement('div');
      row.className = 'tb-model-row';
      const left = document.createElement('span');
      left.className = 'tb-model-name';
      left.textContent = `${m.label}（${m.steps} 次调用）`;
      const right = document.createElement('span');
      right.className = 'tb-model-stats';
      right.textContent = `${fmtTokens(m.totalTokens)} · $${m.totalUSD.toFixed(2)} (≈ ¥${(m.totalUSD * fx).toFixed(2)})`;
      row.append(left, right);
      listEl.appendChild(row);
    }
  }

  function renderQuota(quota) {
    const stripBtn = document.getElementById('tb-btn-quota');
    const stripVal = document.getElementById('tb-strip-quota');
    const badge = document.getElementById('tb-quota-badge');
    const grid = document.getElementById('tb-quota-grid');
    if (!stripBtn || !stripVal || !badge || !grid) return;

    if (!quota || quota.loading) {
      stripVal.textContent = 'G …';
      stripBtn.setAttribute('data-tone', 'muted');
      stripBtn.title = '正在读取 Gemini 官方限额…';
      badge.textContent = '读取中';
      badge.setAttribute('data-tone', 'muted');
      return;
    }

    const g = quota.gemini;
    if (g && g.remainingPercent != null) {
      stripVal.textContent = `G ${g.remainingPercent}%`;
      stripBtn.setAttribute('data-tone', g.tone || 'good');
      const groupLines = (quota.groups || []).map(item =>
        `${item.label}：剩余 ${item.remainingPercent}%${item.resetInText ? `（${item.resetInText}后重置）` : ''}`
      );
      stripBtn.title = groupLines.length ? groupLines.join('\n') : `Gemini 剩余限额 ${g.remainingPercent}%`;
      badge.textContent = g.resetInText ? `余 ${g.remainingPercent}% · ${g.resetInText}后重置` : `余 ${g.remainingPercent}%`;
      badge.setAttribute('data-tone', g.tone || 'good');
    } else {
      stripVal.textContent = 'G --%';
      stripBtn.setAttribute('data-tone', 'muted');
      stripBtn.title = quota.error || '暂未获取到 Gemini 限额';
      badge.textContent = quota.error ? '暂不可用' : '无数据';
      badge.setAttribute('data-tone', 'muted');
    }

    grid.innerHTML = '';
    const groups = Array.isArray(quota.groups) ? quota.groups : [];
    if (groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tb-quota-empty';
      empty.textContent = quota.error || '未检测到可用限额分组，请确认本机已用 Google 登录 Antigravity。';
      grid.appendChild(empty);
      return;
    }

    for (const item of groups) {
      const box = document.createElement('div');
      box.className = 'tb-quota-item';
      const head = document.createElement('div');
      head.className = 'tb-quota-item-head';
      const nameEl = document.createElement('span');
      nameEl.className = 'tb-quota-name';
      nameEl.textContent = item.label;
      const pctEl = document.createElement('span');
      pctEl.className = 'tb-quota-pct';
      pctEl.setAttribute('data-tone', item.tone || 'good');
      pctEl.textContent = `${item.remainingPercent}%`;
      head.append(nameEl, pctEl);

      const track = document.createElement('div');
      track.className = 'tb-quota-bar-track';
      const fill = document.createElement('div');
      fill.className = 'tb-quota-bar-fill';
      fill.setAttribute('data-tone', item.tone || 'good');
      fill.style.width = `${Math.max(0, Math.min(100, item.remainingPercent))}%`;
      track.appendChild(fill);

      const meta = document.createElement('div');
      meta.className = 'tb-quota-meta';
      meta.textContent = item.resetInText ? `重置倒计时：${item.resetInText}` : '实时共享额度池';

      box.append(head, track, meta);
      grid.appendChild(box);
    }
  }

  function render() {
    const snap = state.snapshot;
    if (!snap) return;

    const fx = snap.fxCny || 7.2;
    const ledger = state.onlyFresh ? snap.freshLedger : snap.fullLedger;
    const heat = state.onlyFresh ? snap.freshHeatmap : snap.fullHeatmap;
    const sess = snap.activeSession;
    const mainCcy = state.currency;
    const altCcy = mainCcy === 'USD' ? 'CNY' : 'USD';

    // 1. 顶部指标条
    renderRing(sess.usedPercent, sess.healthTone);
    const srcPrefix = sess.sourceTag ? `[${sess.sourceTag}] ` : '';
    document.getElementById('tb-strip-ctx').textContent = `${Math.round(sess.usedPercent)}%`;
    document.getElementById('tb-btn-ctx').title = `${srcPrefix}${sess.title || '当前会话'}\n上下文窗口：已用 ${fmtTokens(sess.contextUsed)} / 上限 ${fmtTokens(sess.contextLimit)} (${sess.usedPercent}%)`;
    renderQuota(snap.quota);

    document.getElementById('tb-strip-speed').textContent = sess.speed.tokensPerSec != null ? `${sess.speed.tokensPerSec} tok/s` : '-- tok/s';
    document.getElementById('tb-btn-speed').title = sess.speed.note;

    const sessCacheRate = sess.sessionTotals?.cacheHitRate ?? 0;
    const globalCacheRate = ledger.allTime.cacheHitRate ?? 0;
    document.getElementById('tb-strip-cache').textContent = `缓 ${sessCacheRate.toFixed(1)}%`;
    document.getElementById('tb-btn-cache').title = `当前会话累计缓存命中率：${sessCacheRate.toFixed(1)}%（本步 ${sess.stepCacheHitRate ?? 0}%）\n全局已记录总缓存命中率：${globalCacheRate.toFixed(1)}%`;

    document.getElementById('tb-strip-tokens').textContent = fmtTokens(ledger.allTime.totalTokens);
    const todayText = fmtMoney(ledger.today.cost.totalUSD, fx, mainCcy);
    const totalText = fmtMoney(ledger.allTime.cost.totalUSD, fx, mainCcy);
    document.getElementById('tb-strip-cost').textContent = `${todayText} · 总${totalText}`;

    // 2. 顶部模型标签与会话切换器
    document.getElementById('tb-active-model-chip').textContent = sess.modelLabel;
    const sel = document.getElementById('tb-session-select');
    if (sel && Array.isArray(snap.recentSessions)) {
      const prevVal = state.pinnedConvId || '';
      sel.innerHTML = '';
      const autoOpt = document.createElement('option');
      autoOpt.value = '';
      autoOpt.textContent = `🎯 自动跟随最新 (${sess.title || '当前'})`;
      sel.appendChild(autoOpt);
      for (const item of snap.recentSessions) {
        const opt = document.createElement('option');
        opt.value = item.conversationId;
        const tag = item.sourceTag ? `[${item.sourceTag}] ` : '';
        opt.textContent = `📌 ${tag}${item.title} (${fmtTokens(item.contextUsed)} · ${item.usedPercent}%)`;
        sel.appendChild(opt);
      }
      sel.value = Array.from(sel.options).some(o => o.value === prevVal) ? prevVal : '';
    }

    // 3. 第一行：核心用量速览 + 最新生成速度与耗时
    const ctxBadge = document.getElementById('tb-ctx-badge');
    ctxBadge.textContent = sess.healthLabel;
    ctxBadge.setAttribute('data-tone', sess.healthTone);
    const ctxBar = document.getElementById('tb-ctx-bar');
    ctxBar.style.width = `${sess.usedPercent}%`;
    ctxBar.setAttribute('data-tone', sess.healthTone);

    const roundedUsedPct = Math.round(sess.usedPercent);
    document.getElementById('tb-ctx-used').textContent = `${fmtTokens(sess.contextUsed)} (${roundedUsedPct}%)`;
    document.getElementById('tb-ctx-limit').textContent = fmtTokens(sess.contextLimit);
    document.getElementById('tb-ctx-rem').textContent = `${fmtTokens(sess.remainingTokens)} (${100 - roundedUsedPct}%)`;
    const st = sess.sessionTotals || { turns: 0, calls: 0, inputTokens: 0, cacheTokens: 0, cacheHitRate: 0, outputTokens: 0, totalUSD: 0 };
    const ctxCacheEl = document.getElementById('tb-ctx-cache-rate');
    if (ctxCacheEl) {
      ctxCacheEl.textContent = `${st.cacheHitRate.toFixed(1)}%`;
    }
    const cumLine = document.getElementById('tb-ctx-session-totals');
    if (cumLine) {
      cumLine.textContent = `单会话累计 (${st.turns} 轮 / ${st.calls} 次调用)：新增 ${fmtTokens(st.inputTokens)} + 缓存 ${fmtTokens(st.cacheTokens)} (${st.cacheHitRate}%) · 输出 ${fmtTokens(st.outputTokens)} · ≈ ${fmtMoney(st.totalUSD, fx, mainCcy)}`;
    }
    document.getElementById('tb-ctx-note').textContent = sess.healthNote;

    const spdBadge = document.getElementById('tb-spd-badge');
    spdBadge.textContent = sess.speed.badgeLabel;
    spdBadge.setAttribute('data-tone', sess.speed.tone);
    document.getElementById('tb-spd-rate').textContent = sess.speed.tokensPerSec != null ? `${sess.speed.tokensPerSec} tok/s` : '—';
    document.getElementById('tb-spd-dur').textContent = sess.speed.durationSec != null ? `${sess.speed.durationSec}s` : '—';
    document.getElementById('tb-spd-ttft').textContent = sess.speed.ttftSec != null ? `${sess.speed.ttftSec}s` : '—';
    document.getElementById('tb-spd-out').textContent = sess.speed.outputTokens > 0 ? `${sess.speed.outputTokens.toLocaleString()} tok` : '—';
    document.getElementById('tb-spd-note').textContent = sess.speed.note;

    // 4. 第二行：API 折算汇总金额
    const sinceBadge = document.getElementById('tb-since-badge');
    const scopeBtn = document.getElementById('tb-btn-scope-toggle');
    const ccyBtn = document.getElementById('tb-btn-ccy-toggle');

    if (state.onlyFresh) {
      sinceBadge.textContent = `自安装起算 (${snap.sinceLocalLabel}) · 无回溯`;
      sinceBadge.setAttribute('data-tone', 'good');
      scopeBtn.textContent = '仅算新账 ✓';
      scopeBtn.classList.add('is-active');
    } else {
      sinceBadge.textContent = '全量历史 52 周回溯';
      sinceBadge.setAttribute('data-tone', 'muted');
      scopeBtn.textContent = '全量历史 ✓';
      scopeBtn.classList.remove('is-active');
    }
    ccyBtn.textContent = mainCcy === 'CNY' ? '¥ CNY 主显' : '$ USD 主显';

    document.getElementById('tb-cost-today-main').textContent = fmtMoney(ledger.today.cost.totalUSD, fx, mainCcy);
    document.getElementById('tb-cost-today-sub').textContent = `≈ ${fmtMoney(ledger.today.cost.totalUSD, fx, altCcy)}`;

    document.getElementById('tb-cost-month-main').textContent = fmtMoney(ledger.month.cost.totalUSD, fx, mainCcy);
    document.getElementById('tb-cost-month-sub').textContent = `≈ ${fmtMoney(ledger.month.cost.totalUSD, fx, altCcy)} · 日均 ${fmtMoney(ledger.month.cost.dailyAvgUSD, fx, mainCcy)}`;

    document.getElementById('tb-cost-total-main').textContent = fmtMoney(ledger.allTime.cost.totalUSD, fx, mainCcy);
    document.getElementById('tb-cost-total-sub').textContent = `≈ ${fmtMoney(ledger.allTime.cost.totalUSD, fx, altCcy)} · ${ledger.allTime.activeDays} 天活跃`;

    document.getElementById('tb-cost-saved-main').textContent = fmtMoney(ledger.allTime.cost.savedUSD, fx, mainCcy);
    document.getElementById('tb-cost-saved-sub').textContent = `命中率 ${ledger.allTime.cacheHitRate}% · 省 ${fmtMoney(ledger.allTime.cost.savedUSD, fx, altCcy)}`;

    document.getElementById('tb-cost-breakdown').textContent =
      `今日费用拆分：未缓存输入 ${fmtMoney(ledger.today.cost.inputUSD, fx, mainCcy)} · 缓存读取 ${fmtMoney(ledger.today.cost.cacheUSD, fx, mainCcy)} · 输出 ${fmtMoney(ledger.today.cost.outputUSD, fx, mainCcy)}`;

    // 5. 第三行：4 周期 Token 卡片（含各周期缓存命中率与缓存量）
    document.getElementById('tb-tok-total-val').textContent = fmtTokens(ledger.allTime.totalTokens);
    document.getElementById('tb-tok-total-cache').textContent = `缓存命中率 ${ledger.allTime.cacheHitRate.toFixed(1)}% · 缓存 ${fmtTokens(ledger.allTime.cacheTokens)}`;
    document.getElementById('tb-tok-total-meta').textContent = `${ledger.allTime.totalTokens.toLocaleString()} Tokens`;
    document.getElementById('tb-tok-total-cost').textContent = `≈ $${ledger.allTime.cost.totalUSD.toFixed(2)} (¥${ledger.allTime.cost.totalCNY.toFixed(2)})`;

    document.getElementById('tb-tok-today-val').textContent = fmtTokens(ledger.today.totalTokens);
    document.getElementById('tb-tok-today-cache').textContent = `缓存命中率 ${ledger.today.cacheHitRate.toFixed(1)}% · 缓存 ${fmtTokens(ledger.today.cacheTokens)}`;
    document.getElementById('tb-tok-today-meta').textContent = `${ledger.today.sessionsCount} 会话实时累加`;
    document.getElementById('tb-tok-today-cost').textContent = `≈ $${ledger.today.cost.totalUSD.toFixed(2)} (¥${ledger.today.cost.totalCNY.toFixed(2)})`;

    const monthAvgTok = ledger.month.activeDays > 0 ? ledger.month.totalTokens / ledger.month.activeDays : 0;
    document.getElementById('tb-tok-month-val').textContent = fmtTokens(ledger.month.totalTokens);
    document.getElementById('tb-tok-month-cache').textContent = `缓存命中率 ${ledger.month.cacheHitRate.toFixed(1)}% · 缓存 ${fmtTokens(ledger.month.cacheTokens)}`;
    document.getElementById('tb-tok-month-meta').textContent = `日均约 ${fmtTokens(monthAvgTok)}`;
    document.getElementById('tb-tok-month-cost').textContent = `≈ $${ledger.month.cost.totalUSD.toFixed(2)} (¥${ledger.month.cost.totalCNY.toFixed(2)})`;

    document.getElementById('tb-tok-year-val').textContent = fmtTokens(ledger.year.totalTokens);
    document.getElementById('tb-tok-year-cache').textContent = `缓存命中率 ${ledger.year.cacheHitRate.toFixed(1)}% · 缓存 ${fmtTokens(ledger.year.cacheTokens)}`;
    document.getElementById('tb-tok-year-meta').textContent = `${ledger.year.activeDays} 天活动记录`;
    document.getElementById('tb-tok-year-cost').textContent = `≈ $${ledger.year.cost.totalUSD.toFixed(2)} (¥${ledger.year.cost.totalCNY.toFixed(2)})`;

    // 6. 第四行：热力图与模型列表
    document.getElementById('tb-first-date').textContent = `首次使用：${ledger.firstActiveDate}`;
    renderHeatmap(heat);
    renderModelsList(ledger.byModel, fx);

    reportStripWidth();
  }

  async function refreshSnapshot() {
    try {
      const qs = state.pinnedConvId ? `?convId=${encodeURIComponent(state.pinnedConvId)}` : '';
      const res = await fetch(`/api/snapshot${qs}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.ok) {
        state.snapshot = data;
        render();
      }
    } catch {
      // 瞬时重连期间保留上一拍展示
    }
  }

  document.getElementById('tb-session-select')?.addEventListener('change', e => {
    state.pinnedConvId = e.target.value || '';
    localStorage.setItem('atb_pinned_conv', state.pinnedConvId);
    void refreshSnapshot();
  });

  // 事件绑定：顶栏按钮全部统一开关同一个大看板（不再拆出杂乱小弹窗）
  for (const id of ['tb-btn-ctx', 'tb-btn-quota', 'tb-btn-speed', 'tb-btn-cache', 'tb-btn-tokens', 'tb-btn-cost']) {
    document.getElementById(id)?.addEventListener('click', () => {
      syncBoardOpen(!state.boardOpen);
    });
  }

  document.getElementById('tb-btn-quota-refresh')?.addEventListener('click', async () => {
    const btn = document.getElementById('tb-btn-quota-refresh');
    if (btn) btn.textContent = '刷新中…';
    try {
      const res = await fetch('/api/quota?force=1', { cache: 'no-store' });
      if (res.ok) {
        const q = await res.json();
        if (state.snapshot) {
          state.snapshot.quota = q;
          render();
        }
      }
    } finally {
      if (btn) btn.textContent = '刷新限额';
    }
  });

  document.getElementById('tb-btn-cost')?.addEventListener('contextmenu', e => {
    e.preventDefault();
    state.currency = state.currency === 'USD' ? 'CNY' : 'USD';
    localStorage.setItem('atb_ccy', state.currency);
    render();
  });

  document.getElementById('tb-btn-close')?.addEventListener('click', () => syncBoardOpen(false));

  document.getElementById('tb-btn-theme')?.addEventListener('click', () => {
    const seq = ['auto', 'light', 'dark'];
    state.theme = seq[(seq.indexOf(state.theme) + 1) % seq.length];
    localStorage.setItem('atb_theme', state.theme);
    applyTheme();
  });

  document.getElementById('tb-btn-scope-toggle')?.addEventListener('click', () => {
    state.onlyFresh = !state.onlyFresh;
    localStorage.setItem('atb_only_fresh', state.onlyFresh ? '1' : '0');
    render();
  });

  document.getElementById('tb-btn-ccy-toggle')?.addEventListener('click', () => {
    state.currency = state.currency === 'USD' ? 'CNY' : 'USD';
    localStorage.setItem('atb_ccy', state.currency);
    render();
  });

  document.getElementById('tb-btn-reset-since')?.addEventListener('click', async () => {
    const res = await fetch('/api/reset-baseline', { method: 'POST' });
    if (res.ok) {
      const json = await res.json();
      if (json?.snapshot) {
        state.onlyFresh = true;
        localStorage.setItem('atb_only_fresh', '1');
        state.snapshot = json.snapshot;
        render();
      }
    }
  });

  document.getElementById('tb-tab-heat')?.addEventListener('click', () => {
    document.getElementById('tb-pane-heat').hidden = false;
    document.getElementById('tb-pane-models').hidden = true;
    document.getElementById('tb-tab-heat').classList.add('is-active');
    document.getElementById('tb-tab-models').classList.remove('is-active');
  });

  document.getElementById('tb-tab-models')?.addEventListener('click', () => {
    document.getElementById('tb-pane-heat').hidden = true;
    document.getElementById('tb-pane-models').hidden = false;
    document.getElementById('tb-tab-models').classList.add('is-active');
    document.getElementById('tb-tab-heat').classList.remove('is-active');
  });

  // 标题栏微调拖拽桥接
  const grip = document.getElementById('tb-drag-grip');
  if (grip && isOverlay) {
    let dragging = false;
    let sx = 0;
    let sy = 0;
    grip.addEventListener('mousedown', e => {
      dragging = true;
      sx = e.screenX;
      sy = e.screenY;
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      postNative('agDrag', { dx: e.screenX - sx, dy: e.screenY - sy, ended: false });
    });
    window.addEventListener('mouseup', e => {
      if (!dragging) return;
      dragging = false;
      postNative('agDrag', { dx: e.screenX - sx, dy: e.screenY - sy, ended: true });
    });
  }

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOverlay && state.boardOpen) {
      syncBoardOpen(false);
    }
  });

  const stripEl = document.getElementById('tb-strip');
  if (stripEl && typeof ResizeObserver === 'function') {
    new ResizeObserver(() => reportStripWidth()).observe(stripEl);
  }

  window.__ATBControl = {
    closeBoard: () => syncBoardOpen(false),
    toggleBoard: () => syncBoardOpen(!state.boardOpen)
  };

  syncBoardOpen(state.boardOpen);
  void refreshSnapshot();
  setInterval(refreshSnapshot, 3500);
})();
