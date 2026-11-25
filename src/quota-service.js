'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const DAILY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
const PROD_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const ENDPOINTS = [DAILY_ENDPOINT, PROD_ENDPOINT];
const CACHE_TTL_MS = 5_000;
const TOKEN_REFRESH_BUFFER_MS = 60_000;

function formatResetIn(resetTimeIso, nowMs = Date.now()) {
  if (!resetTimeIso) return '';
  const targetMs = Date.parse(resetTimeIso);
  if (!Number.isFinite(targetMs)) return '';
  const diffSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  if (diffSec <= 0) return '即将重置';
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  if (days > 0) return `${days}天${hours}时`;
  if (hours > 0) return `${hours}时${mins}分`;
  return `${Math.max(1, mins)}分`;
}

function quotaTone(remainingPercent) {
  if (remainingPercent == null || !Number.isFinite(remainingPercent)) return 'muted';
  if (remainingPercent <= 15) return 'danger';
  if (remainingPercent <= 35) return 'warn';
  return 'good';
}

function clampPct(fraction) {
  const n = Number(fraction);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 100)));
}

function discoverDefaultTokenPaths(home = os.homedir()) {
  const candidates = [];
  const t3Root = path.join(home, '.t3', 'userdata', 'providers', 'antigravity');
  try {
    if (fs.existsSync(t3Root)) {
      for (const ent of fs.readdirSync(t3Root, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const p = path.join(t3Root, ent.name, 'antigravity-acp', 'acp_token.json');
        if (fs.existsSync(p)) candidates.push(p);
      }
    }
  } catch {
    // 忽略目录访问异常
  }
  const geminiAcp = path.join(home, '.gemini', 'antigravity-acp', 'acp_token.json');
  if (fs.existsSync(geminiAcp)) {
    candidates.push(geminiAcp);
  }
  return candidates;
}

function readTokenFile(tokenPath) {
  const raw = fs.readFileSync(tokenPath, 'utf8');
  const data = JSON.parse(raw);
  if (!data || !data.client_id || !data.client_secret || !data.refresh_token) {
    throw new Error('acp_token.json 缺少 OAuth 字段');
  }
  return {
    clientId: String(data.client_id),
    clientSecret: String(data.client_secret),
    refreshToken: String(data.refresh_token),
    projectId: data.project_id ? String(data.project_id) : ''
  };
}

function buildQuotaPayload(summaryJson, modelsJson, nowMs = Date.now()) {
  const groups = [];
  const seenGroupIds = new Set();

  if (summaryJson && typeof summaryJson === 'object') {
    const rawGroups = Array.isArray(summaryJson.groups) && summaryJson.groups.length > 0
      ? summaryJson.groups
      : (Array.isArray(summaryJson.buckets) ? [{ displayName: '', buckets: summaryJson.buckets }] : []);

    for (const grp of rawGroups) {
      for (const b of (grp.buckets || [])) {
        if (b.disabled) continue;
        const pct = clampPct(b.remainingFraction);
        if (pct == null) continue;
        const id = String(b.bucketId || `${grp.displayName || 'group'}-${b.window || 'quota'}`);
        if (seenGroupIds.has(id)) continue;
        seenGroupIds.add(id);

        const isGemini = id.startsWith('gemini-') || /gemini/i.test(grp.displayName || '');
        const isWeekly = b.window === 'weekly';
        const is5h = b.window === '5h';
        const windowLabel = isWeekly ? '周限额' : is5h ? '5小时' : (b.displayName || '额度');
        const family = isGemini
          ? (grp.displayName || 'Gemini')
          : id.startsWith('3p-')
            ? 'Claude & GPT'
            : (grp.displayName || id);

        groups.push({
          id,
          family,
          isGemini,
          window: b.window || 'other',
          windowLabel,
          label: `${family} · ${windowLabel}`,
          remainingPercent: pct,
          resetTime: b.resetTime || null,
          resetInText: formatResetIn(b.resetTime, nowMs),
          tone: quotaTone(pct)
        });
      }
    }
  }

  const geminiModels = [];
  const otherModels = [];
  const rawModels = modelsJson && typeof modelsJson === 'object' ? (modelsJson.models || {}) : {};

  for (const [modelId, m] of Object.entries(rawModels)) {
    if (!m || typeof m !== 'object') continue;
    if (modelId.startsWith('tab_')) continue;
    const q = m.quotaInfo || m.weeklyQuotaInfo;
    if (!q) continue;
    const pct = clampPct(q.remainingFraction);
    if (pct == null) continue;

    const isGemini = m.modelProvider === 'MODEL_PROVIDER_GOOGLE' || /^gemini-/i.test(modelId);
    const item = {
      id: modelId,
      name: m.displayName || modelId,
      remainingPercent: pct,
      resetTime: q.resetTime || null,
      resetInText: formatResetIn(q.resetTime, nowMs),
      tone: quotaTone(pct)
    };
    if (isGemini) geminiModels.push(item);
    else otherModels.push(item);
  }

  geminiModels.sort((a, b) => a.remainingPercent - b.remainingPercent || a.name.localeCompare(b.name));

  // 若 summary 中尚未返回 Gemini 组，则由 fetchAvailableModels 中的 Gemini 模型聚合生成
  const hasGeminiGroup = groups.some(g => g.isGemini);
  if (!hasGeminiGroup && geminiModels.length > 0) {
    const worst = geminiModels[0];
    groups.unshift({
      id: 'gemini-models-quota',
      family: 'Gemini',
      isGemini: true,
      window: 'quota',
      windowLabel: '可用额度',
      label: 'Gemini · 可用额度',
      remainingPercent: worst.remainingPercent,
      resetTime: worst.resetTime,
      resetInText: worst.resetInText,
      tone: quotaTone(worst.remainingPercent)
    });
  }

  const geminiGroups = groups.filter(g => g.isGemini);
  let geminiSummary = null;
  if (geminiGroups.length > 0) {
    const lowest = [...geminiGroups].sort((a, b) => a.remainingPercent - b.remainingPercent)[0];
    geminiSummary = {
      remainingPercent: lowest.remainingPercent,
      resetTime: lowest.resetTime,
      resetInText: lowest.resetInText,
      tone: lowest.tone,
      label: lowest.label,
      modelsCount: geminiModels.length
    };
  }

  // 把 Gemini 分组排在最前
  groups.sort((a, b) => (b.isGemini ? 1 : 0) - (a.isGemini ? 1 : 0));

  return {
    ok: groups.length > 0 || geminiModels.length > 0,
    updatedAt: new Date(nowMs).toISOString(),
    gemini: geminiSummary,
    groups,
    geminiModels: geminiModels.slice(0, 8),
    error: groups.length === 0 && geminiModels.length === 0 ? '未获取到有效额度数据' : null
  };
}

function readCockpitQuotaPayload(home = os.homedir(), nowMs = Date.now()) {
  if (!DatabaseSync) return null;
  const dbPath = path.join(home, '.antigravity_cockpit', 'platform-quota-history-v1.sqlite');
  if (!fs.existsSync(dbPath)) return null;
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const latestAcc = db.prepare(
      "SELECT account_id, MAX(observed_at) AS ts FROM quota_observations WHERE platform='antigravity' GROUP BY account_id ORDER BY ts DESC LIMIT 1"
    ).get();
    if (!latestAcc || !latestAcc.account_id) return null;
    const observedMs = Number(latestAcc.ts) || 0;
    // 若超过 6 小时无更新，视为过期并回退 OAuth 查询
    if (observedMs > 0 && (nowMs - observedMs) > 6 * 3600 * 1000) return null;

    const rows = db.prepare(`
      SELECT q.metric, q.label, q.remaining, q.reset_at, q.observed_at
      FROM quota_observations q
      INNER JOIN (
        SELECT metric, MAX(observed_at) AS max_ts
        FROM quota_observations
        WHERE platform='antigravity' AND account_id=?
        GROUP BY metric
      ) m ON q.metric = m.metric AND q.observed_at = m.max_ts
      WHERE q.platform='antigravity' AND q.account_id=?
      ORDER BY q.metric
    `).all(latestAcc.account_id, latestAcc.account_id);

    if (!Array.isArray(rows) || rows.length === 0) return null;

    const bucketDefs = {
      'gemini-5h': { family: 'Gemini', isGemini: true, window: '5h', windowLabel: '5小时' },
      'gemini-weekly': { family: 'Gemini', isGemini: true, window: 'weekly', windowLabel: '周限额' },
      '3p-5h': { family: 'Claude & GPT', isGemini: false, window: '5h', windowLabel: '5小时' },
      '3p-weekly': { family: 'Claude & GPT', isGemini: false, window: 'weekly', windowLabel: '周限额' }
    };

    const groups = [];
    const geminiModels = [];

    for (const r of rows) {
      const metric = String(r.metric || '');
      const pct = Math.max(0, Math.min(100, Math.round(Number(r.remaining))));
      if (!Number.isFinite(pct)) continue;
      const resetIso = Number(r.reset_at) > 0 ? new Date(Number(r.reset_at)).toISOString() : null;
      const resetInText = formatResetIn(resetIso, nowMs);
      const tone = quotaTone(pct);

      if (bucketDefs[metric]) {
        const def = bucketDefs[metric];
        groups.push({
          id: metric,
          family: def.family,
          isGemini: def.isGemini,
          window: def.window,
          windowLabel: def.windowLabel,
          label: `${def.family} · ${def.windowLabel}`,
          remainingPercent: pct,
          resetTime: resetIso,
          resetInText,
          tone
        });
      } else if (/^gemini-/i.test(metric)) {
        geminiModels.push({
          id: metric,
          name: String(r.label || metric),
          remainingPercent: pct,
          resetTime: resetIso,
          resetInText,
          tone
        });
      }
    }

    if (groups.length === 0) return null;

    geminiModels.sort((a, b) => a.remainingPercent - b.remainingPercent || a.name.localeCompare(b.name));
    const order = ['gemini-5h', 'gemini-weekly', '3p-5h', '3p-weekly'];
    groups.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

    const geminiGroups = groups.filter(g => g.isGemini);
    let geminiSummary = null;
    if (geminiGroups.length > 0) {
      const lowest = [...geminiGroups].sort((a, b) => a.remainingPercent - b.remainingPercent)[0];
      geminiSummary = {
        remainingPercent: lowest.remainingPercent,
        resetTime: lowest.resetTime,
        resetInText: lowest.resetInText,
        tone: lowest.tone,
        label: lowest.label,
        modelsCount: geminiModels.length
      };
    }

    return {
      ok: true,
      source: 'cockpit-sqlite',
      updatedAt: new Date(observedMs || nowMs).toISOString(),
      gemini: geminiSummary,
      groups,
      geminiModels: geminiModels.slice(0, 8),
      error: null
    };
  } catch {
    return null;
  } finally {
    try { db && db.close(); } catch {}
  }
}

function createQuotaService(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const home = options.homeDir || os.homedir();
  const disabled = Boolean(options.disabled);
  const cacheTtlMs = Number(options.cacheTtlMs) > 0 ? Number(options.cacheTtlMs) : CACHE_TTL_MS;

  let tokenCache = null; // { tokenPath, accessToken, expiresAtMs }
  let quotaCache = null; // { fetchedAtMs, cockpitMtimeMs, data }
  let inflight = null;

  function getCockpitDbMtimeMs() {
    const dbPath = path.join(home, '.antigravity_cockpit', 'platform-quota-history-v1.sqlite');
    let maxMtime = 0;
    for (const p of [dbPath, `${dbPath}-wal`]) {
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
      } catch {}
    }
    return maxMtime;
  }

  function resolveTokenPath() {
    if (Array.isArray(options.tokenPaths)) {
      return options.tokenPaths.find(p => p && fs.existsSync(p)) || null;
    }
    const list = discoverDefaultTokenPaths(home);
    return list[0] || null;
  }

  async function getAccessToken(tokenPath, tok) {
    const nowMs = Date.now();
    if (tokenCache && tokenCache.tokenPath === tokenPath && tokenCache.expiresAtMs > nowMs + TOKEN_REFRESH_BUFFER_MS) {
      return tokenCache.accessToken;
    }
    const body = new URLSearchParams({
      client_id: tok.clientId,
      client_secret: tok.clientSecret,
      refresh_token: tok.refreshToken,
      grant_type: 'refresh_token'
    });
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      throw new Error(`OAuth 刷新失败 (${res.status})`);
    }
    const json = await res.json();
    if (!json || !json.access_token) {
      throw new Error('OAuth 未返回 access_token');
    }
    const expiresInSec = Number(json.expires_in) || 3600;
    tokenCache = {
      tokenPath,
      accessToken: json.access_token,
      expiresAtMs: nowMs + expiresInSec * 1000
    };
    return json.access_token;
  }

  async function postInternal(accessToken, projectId, operation) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': `antigravity/1.5.9 ${process.platform}/${process.arch}`
    };
    const payload = JSON.stringify(projectId ? { project: projectId } : {});
    for (const ep of ENDPOINTS) {
      try {
        const res = await fetchImpl(`${ep}/v1internal:${operation}`, {
          method: 'POST',
          headers,
          body: payload,
          signal: AbortSignal.timeout(8000)
        });
        if (res.ok) {
          return await res.json();
        }
      } catch {
        // 尝试下一个端点
      }
    }
    return null;
  }

  async function refresh(force = false) {
    if (disabled || typeof fetchImpl !== 'function') {
      return {
        ok: false,
        updatedAt: new Date().toISOString(),
        gemini: null,
        groups: [],
        geminiModels: [],
        error: '限额查询已禁用'
      };
    }
    const nowMs = Date.now();
    const cockpitMtimeMs = !Array.isArray(options.tokenPaths) ? getCockpitDbMtimeMs() : 0;
    const cockpitChanged = cockpitMtimeMs > 0 && cockpitMtimeMs !== (quotaCache?.cockpitMtimeMs || 0);
    if (!force && !cockpitChanged && quotaCache && (nowMs - quotaCache.fetchedAtMs) < cacheTtlMs) {
      return quotaCache.data;
    }

    // 优先同步读取本机 Antigravity Cockpit 实时只读库，文件一有写入立即直出，不进入 inflight Promise
    if (!Array.isArray(options.tokenPaths)) {
      const cockpitData = readCockpitQuotaPayload(home, nowMs);
      if (cockpitData && cockpitData.ok) {
        quotaCache = { fetchedAtMs: Date.now(), cockpitMtimeMs, data: cockpitData };
        return cockpitData;
      }
    }

    if (inflight) return inflight;

    const req = (async () => {
      try {
        const tokenPath = resolveTokenPath();
        if (!tokenPath) {
          const data = {
            ok: false,
            updatedAt: new Date().toISOString(),
            gemini: null,
            groups: [],
            geminiModels: [],
            error: '未找到 acp_token.json（请先用 Google 登录 Antigravity）'
          };
          quotaCache = { fetchedAtMs: Date.now(), data };
          return data;
        }
        const tok = readTokenFile(tokenPath);
        const accessToken = await getAccessToken(tokenPath, tok);
        const [summaryJson, modelsJson] = await Promise.all([
          postInternal(accessToken, tok.projectId, 'retrieveUserQuotaSummary'),
          postInternal(accessToken, tok.projectId, 'fetchAvailableModels')
        ]);
        const data = buildQuotaPayload(summaryJson, modelsJson, Date.now());
        quotaCache = { fetchedAtMs: Date.now(), data };
        return data;
      } catch (err) {
        const data = {
          ok: false,
          updatedAt: new Date().toISOString(),
          gemini: quotaCache?.data?.gemini || null,
          groups: quotaCache?.data?.groups || [],
          geminiModels: quotaCache?.data?.geminiModels || [],
          error: err?.message || '获取限额失败'
        };
        quotaCache = { fetchedAtMs: Date.now() - cacheTtlMs + 15_000, data };
        return data;
      }
    })();
    inflight = req;
    req.finally(() => {
      if (inflight === req) inflight = null;
    });

    return req;
  }

  function getCachedOrTriggerRefresh() {
    if (disabled) return null;
    const nowMs = Date.now();
    if (!quotaCache || (nowMs - quotaCache.fetchedAtMs) >= cacheTtlMs) {
      void refresh(false);
    }
    return quotaCache ? quotaCache.data : {
      ok: false,
      loading: true,
      updatedAt: null,
      gemini: null,
      groups: [],
      geminiModels: [],
      error: null
    };
  }

  return {
    refresh,
    getCachedOrTriggerRefresh
  };
}

module.exports = {
  createQuotaService,
  buildQuotaPayload,
  formatResetIn,
  discoverDefaultTokenPaths
};
