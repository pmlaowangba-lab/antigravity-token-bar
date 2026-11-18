'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pricing = require('./pricing-engine');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_CHANGE_REGEX = /Model Selection`?\s+(?:from\s+[^`]+?\s+)?to\s+`?([^.`<\n]+)`?/i;
const USER_REQUEST_REGEX = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i;
const TOOL_CREATED_AT_REGEX = /^Created At:\s*([^\r\n]+)/m;

function extractTimestampMs(row, fallbackMs) {
  const raw = row?.created_at || row?.timestamp || row?.metadata?.createdAt;
  if (raw) {
    const t = Date.parse(raw);
    if (!Number.isNaN(t) && t > 0) return t;
  }
  return fallbackMs;
}

function extractToolStartMs(nextEntry) {
  if (!nextEntry || !nextEntry.obj) return null;
  const content = nextEntry.obj.content;
  if (typeof content === 'string') {
    const m = content.match(TOOL_CREATED_AT_REGEX);
    if (m && m[1]) {
      const parsed = Date.parse(m[1].trim());
      if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    }
  }
  return nextEntry.tsMs;
}

function parseDurationSeconds(val) {
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) return val;
  if (typeof val === 'string') {
    const m = val.trim().match(/^([0-9]+(?:\.[0-9]+)?)s?$/i);
    if (m) return Number(m[1]);
  }
  return null;
}

function cleanUserTitle(raw) {
  const oneLine = String(raw || '')
    .replace(/\[Attachment:[^\]]*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!oneLine) return '';
  return oneLine.length > 26 ? `${oneLine.slice(0, 26)}…` : oneLine;
}

function ensureBaselineState(stateFilePath, legacyPluginStatePath) {
  try {
    if (fs.existsSync(stateFilePath)) {
      const parsed = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
      if (parsed && typeof parsed.sinceIso === 'string' && !Number.isNaN(Date.parse(parsed.sinceIso))) {
        return parsed;
      }
    }
    if (legacyPluginStatePath && fs.existsSync(legacyPluginStatePath)) {
      const legacy = JSON.parse(fs.readFileSync(legacyPluginStatePath, 'utf8'));
      const legacyIso = legacy?.sinceIso || legacy?.sinceUtc || legacy?.since_utc;
      if (typeof legacyIso === 'string' && !Number.isNaN(Date.parse(legacyIso))) {
        const next = { sinceIso: legacyIso, fxCny: legacy.fxCny || pricing.DEFAULT_FX_CNY };
        fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
        fs.writeFileSync(stateFilePath, JSON.stringify(next, null, 2));
        return next;
      }
    }
  } catch {
    // 忽略损坏配置，自动重建
  }
  const fresh = { sinceIso: new Date().toISOString(), fxCny: pricing.DEFAULT_FX_CNY };
  try {
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify(fresh, null, 2));
  } catch {
    // 只读环境降级为内存态
  }
  return fresh;
}

function parseConversationLog(filePath, convId, mtimeMs) {
  const rawText = fs.readFileSync(filePath, 'utf8');
  const lines = rawText.split('\n');
  const rawEntries = [];
  let activeModelName = 'Gemini 4 Carbon';
  let firstTitle = '';
  let userTurns = 0;
  let lastRealActivityMs = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const isSystemMsg = obj.source === 'SYSTEM';
    const tsMs = extractTimestampMs(obj, mtimeMs);

    if (typeof obj.content === 'string') {
      if (obj.content.includes('Model Selection')) {
        const m = obj.content.match(MODEL_CHANGE_REGEX);
        if (m && m[1]) activeModelName = m[1].trim();
      }
      if (obj.type === 'USER_INPUT' && !isSystemMsg) {
        userTurns += 1;
        if (!firstTitle) {
          const reqMatch = obj.content.match(USER_REQUEST_REGEX);
          const candidate = cleanUserTitle(reqMatch ? reqMatch[1] : obj.content);
          if (candidate) firstTitle = candidate;
        }
      }
    }

    const directModel = obj.model || obj.model_name || obj.metadata?.model;
    if (typeof directModel === 'string' && directModel.trim()) {
      activeModelName = directModel.trim();
    }

    if (!isSystemMsg && (obj.type === 'PLANNER_RESPONSE' || obj.type === 'USER_INPUT')) {
      if (tsMs > lastRealActivityMs) lastRealActivityMs = tsMs;
    }

    rawEntries.push({
      obj,
      tsMs,
      isSystemMsg,
      modelAtStep: activeModelName
    });
  }

  const plannerSteps = [];
  let sumInput = 0;
  let sumCache = 0;
  let sumOutput = 0;
  let sumUSD = 0;

  for (let i = 0; i < rawEntries.length; i++) {
    const { obj, tsMs, modelAtStep } = rawEntries[i];
    const inTok = Math.max(0, Number(obj.input_tokens ?? obj.usage?.inputTokens ?? 0) || 0);
    const caTok = Math.max(0, Number(obj.cache_read_tokens ?? obj.usage?.cacheReadTokens ?? 0) || 0);
    const outTok = Math.max(0, Number(obj.output_tokens ?? obj.usage?.outputTokens ?? 0) || 0);
    const isPlanner = obj.type === 'PLANNER_RESPONSE' || (inTok + caTok + outTok > 0);
    if (!isPlanner || (inTok + caTok + outTok <= 0)) continue;

    // 精确耗时计算：
    // 1) 若日志存在显式流式耗时字段则直接使用；
    // 2) 否则读取紧邻下一步非 SYSTEM、非人工提问事件，并优先取工具 Created At（剔除长命令自身执行耗时）
    const explicitStreamSec = parseDurationSeconds(obj.streaming_duration ?? obj.streamingDuration);
    const explicitTtftSec = parseDurationSeconds(obj.time_to_first_token ?? obj.timeToFirstToken);
    let durationSec = explicitStreamSec != null ? explicitStreamSec + (explicitTtftSec || 0) : null;

    const nextEntry = i + 1 < rawEntries.length ? rawEntries[i + 1] : null;
    if (
      durationSec == null
      && nextEntry
      && !nextEntry.isSystemMsg
      && nextEntry.obj?.type !== 'USER_INPUT'
    ) {
      const endMs = extractToolStartMs(nextEntry);
      if (endMs != null) {
        const deltaSec = (endMs - tsMs) / 1000;
        if (deltaSec >= 0.4 && deltaSec <= 240) {
          durationSec = Number(deltaSec.toFixed(1));
        }
      }
    }

    let tokensPerSec = null;
    if (outTok > 0 && durationSec != null && durationSec >= 0.4) {
      const rate = outTok / durationSec;
      if (rate >= 1 && rate <= 600) {
        tokensPerSec = Number(rate.toFixed(1));
      }
    }

    const spec = pricing.resolveModelSpec(modelAtStep);
    const stepCost = pricing.calcStepCost(
      { inputTokens: inTok, cacheReadTokens: caTok, outputTokens: outTok },
      modelAtStep
    );
    sumInput += inTok;
    sumCache += caTok;
    sumOutput += outTok;
    sumUSD += stepCost.totalUSD;

    plannerSteps.push({
      convId,
      tsMs,
      dateStr: pricing.formatLocalDate(new Date(tsMs)),
      modelKey: spec.key,
      modelLabel: spec.displayLabel,
      contextLimit: spec.contextLimit,
      physicalLimit: spec.physicalLimit || spec.contextLimit,
      inputTokens: inTok,
      cacheTokens: caTok,
      outputTokens: outTok,
      durationSec: durationSec != null ? Number(durationSec.toFixed(1)) : null,
      ttftSec: explicitTtftSec != null ? Number(explicitTtftSec.toFixed(1)) : null,
      tokensPerSec
    });
  }

  const promptSum = sumInput + sumCache;
  return {
    convId,
    title: firstTitle || `会话 ${convId.slice(0, 8)}`,
    mtimeMs,
    lastRealActivityMs: lastRealActivityMs || mtimeMs,
    latestModel: activeModelName,
    steps: plannerSteps,
    sessionTotals: {
      turns: userTurns,
      calls: plannerSteps.length,
      inputTokens: sumInput,
      cacheTokens: sumCache,
      cacheHitRate: promptSum > 0 ? Number(((sumCache / promptSum) * 100).toFixed(1)) : 0,
      outputTokens: sumOutput,
      totalUSD: Math.round(sumUSD * 10000) / 10000
    }
  };
}

function addStepIntoBuckets(bucketsMap, step) {
  let day = bucketsMap[step.dateStr];
  if (!day) {
    day = {
      input: 0,
      cache: 0,
      output: 0,
      steps: 0,
      sessions: new Set(),
      models: {}
    };
    bucketsMap[step.dateStr] = day;
  }
  day.input += step.inputTokens;
  day.cache += step.cacheTokens;
  day.output += step.outputTokens;
  day.steps += 1;
  day.sessions.add(step.convId);

  let m = day.models[step.modelKey];
  if (!m) {
    m = { label: step.modelLabel, input: 0, cache: 0, output: 0, steps: 0 };
    day.models[step.modelKey] = m;
  }
  m.input += step.inputTokens;
  m.cache += step.cacheTokens;
  m.output += step.outputTokens;
  m.steps += 1;
}

function buildActiveSessionView(parsedConv) {
  if (!parsedConv || parsedConv.steps.length === 0) {
    return {
      conversationId: parsedConv?.convId || null,
      title: parsedConv?.title || '暂无活跃会话',
      modelLabel: parsedConv?.latestModel || 'Gemini 4 Carbon',
      contextUsed: 0,
      contextLimit: 524_288,
      physicalLimit: 1_048_576,
      remainingTokens: 524_288,
      usedPercent: 0,
      remainingPercent: 100,
      healthTone: 'good',
      healthLabel: '空闲',
      healthNote: '等待当前会话产生首次模型请求…',
      sessionTotals: {
        turns: 0,
        calls: 0,
        inputTokens: 0,
        cacheTokens: 0,
        cacheHitRate: 0,
        outputTokens: 0,
        totalUSD: 0
      },
      speed: {
        tokensPerSec: null,
        durationSec: null,
        ttftSec: null,
        outputTokens: 0,
        latestOutputTokens: 0,
        tone: 'muted',
        badgeLabel: '待生成',
        note: '等待首次模型输出后自动计算生成速度与耗时…'
      }
    };
  }

  const last = parsedConv.steps[parsedConv.steps.length - 1];
  const lastWithSpeed = [...parsedConv.steps].reverse().find(s => s.tokensPerSec != null) || null;

  const contextUsed = last.inputTokens + last.cacheTokens;
  const contextLimit = last.contextLimit || 524_288;
  const physicalLimit = last.physicalLimit || contextLimit;
  const remainingTokens = Math.max(0, contextLimit - contextUsed);
  const usedPercent = Number(Math.min(100, (contextUsed / contextLimit) * 100).toFixed(1));
  const remainingPercent = Number(Math.max(0, 100 - usedPercent).toFixed(1));

  let healthTone = 'good';
  let healthLabel = '正常';
  let healthNote = `✓ 距 512K 自动压缩水位线余 ${(remainingTokens / 1000).toFixed(1)}K (${remainingPercent}%)，可顺畅继续对话。`;
  if (usedPercent >= 88) {
    healthTone = 'danger';
    healthLabel = '临近压缩';
    healthNote = `⚠ 已达压缩水位线 ${usedPercent}%（距触发自动摘要仅余 ${(remainingTokens / 1000).toFixed(1)}K），建议主动 /compact 或新开会话。`;
  } else if (usedPercent >= 72) {
    healthTone = 'warn';
    healthLabel = '偏高';
    healthNote = `提示：已达压缩水位线 ${usedPercent}%（余 ${(remainingTokens / 1000).toFixed(1)}K），长任务注意适时收敛上下文。`;
  }

  let speedObj;
  if (lastWithSpeed && lastWithSpeed.tokensPerSec != null) {
    const tps = lastWithSpeed.tokensPerSec;
    let tone = 'good';
    let badgeLabel = '流畅';
    let descWord = '端到端流畅';
    if (tps >= 75) {
      tone = 'good';
      badgeLabel = '极速';
      descWord = '端到端高速';
    } else if (tps >= 32) {
      tone = 'good';
      badgeLabel = '流畅';
      descWord = '端到端流畅';
    } else if (tps >= 14) {
      tone = 'warn';
      badgeLabel = '良好';
      descWord = '端到端平稳';
    } else {
      tone = 'danger';
      badgeLabel = '偏慢';
      descWord = '端到端偏慢';
    }
    const isLatestStepMeasured = lastWithSpeed === last;
    const durText = lastWithSpeed.durationSec != null ? `耗时 ${lastWithSpeed.durationSec}s ` : '';
    const tailSuffix = isLatestStepMeasured
      ? `内生成 ${lastWithSpeed.outputTokens.toLocaleString()} tok`
      : `测得 · 最新回复 ${last.outputTokens.toLocaleString()} tok`;
    speedObj = {
      tokensPerSec: tps,
      durationSec: lastWithSpeed.durationSec,
      ttftSec: lastWithSpeed.ttftSec,
      outputTokens: last.outputTokens,
      latestOutputTokens: last.outputTokens,
      tone,
      badgeLabel,
      note: `✓ ${descWord} (${tps} tok/s，含首字等待)，${durText}${tailSuffix}（${last.modelLabel}）。`
    };
  } else {
    speedObj = {
      tokensPerSec: null,
      durationSec: last.durationSec,
      ttftSec: last.ttftSec,
      outputTokens: last.outputTokens,
      latestOutputTokens: last.outputTokens,
      tone: 'muted',
      badgeLabel: '已记录',
      note: `本步输出 ${last.outputTokens.toLocaleString()} tok（${last.modelLabel}），磁盘日志未含单步流式时间戳。`
    };
  }

  return {
    conversationId: parsedConv.convId,
    title: parsedConv.title,
    modelLabel: last.modelLabel,
    contextUsed,
    contextLimit,
    physicalLimit,
    remainingTokens,
    usedPercent,
    remainingPercent,
    healthTone,
    healthLabel,
    healthNote,
    sessionTotals: parsedConv.sessionTotals,
    speed: speedObj
  };
}

function createLogScanner(options = {}) {
  const home = os.homedir();
  const brainRootDir = options.brainRootDir || path.join(home, '.gemini', 'antigravity', 'brain');
  const stateFilePath = options.stateFilePath || path.join(home, '.antigravity-token-bar', 'state.json');
  const legacyStatePath = path.join(home, '.gemini', 'config', 'plugin-data', 'token-meter', 'standalone-state.json');

  let state = ensureBaselineState(stateFilePath, options.stateFilePath ? null : legacyStatePath);
  const fileCache = new Map();

  function listConversationTranscripts() {
    if (!fs.existsSync(brainRootDir)) return [];
    const results = [];
    let entries = [];
    try {
      entries = fs.readdirSync(brainRootDir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || !UUID_PATTERN.test(ent.name)) continue;
      const logPath = path.join(brainRootDir, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        const st = fs.statSync(logPath);
        if (st.isFile() && st.size > 0) {
          results.push({ convId: ent.name, logPath, mtimeMs: st.mtimeMs, size: st.size });
        }
      } catch {
        // 忽略无日志目录
      }
    }
    return results;
  }

  function getSnapshot(query = {}) {
    const files = listConversationTranscripts();
    const sinceMs = Date.parse(state.sinceIso) || 0;
    const fxCny = Number(state.fxCny) > 0 ? Number(state.fxCny) : pricing.DEFAULT_FX_CNY;

    const fullBuckets = {};
    const freshBuckets = {};
    const parsedList = [];

    for (const f of files) {
      const cached = fileCache.get(f.logPath);
      let parsed;
      if (cached && cached.mtimeMs === f.mtimeMs && cached.size === f.size) {
        parsed = cached.parsed;
      } else {
        try {
          parsed = parseConversationLog(f.logPath, f.convId, f.mtimeMs);
          fileCache.set(f.logPath, { mtimeMs: f.mtimeMs, size: f.size, parsed });
        } catch {
          continue;
        }
      }
      if (parsed.steps.length > 0) {
        parsedList.push(parsed);
      }

      for (const step of parsed.steps) {
        addStepIntoBuckets(fullBuckets, step);
        if (step.tsMs >= sinceMs) {
          addStepIntoBuckets(freshBuckets, step);
        }
      }
    }

    // 按真实模型/用户活动时间倒序排列（忽略纯 SYSTEM 广播通知导致的假 mtime 跳变）
    parsedList.sort((a, b) => b.lastRealActivityMs - a.lastRealActivityMs);

    const requestedConvId = typeof query.convId === 'string' && query.convId.trim() ? query.convId.trim() : null;
    const targetParsed = (requestedConvId && parsedList.find(p => p.convId === requestedConvId)) || parsedList[0] || null;

    const recentSessions = parsedList.slice(0, 12).map(p => {
      const last = p.steps[p.steps.length - 1];
      const used = last ? (last.inputTokens + last.cacheTokens) : 0;
      const lim = last?.contextLimit || 524_288;
      const pct = Number(Math.min(100, (used / lim) * 100).toFixed(0));
      return {
        conversationId: p.convId,
        title: p.title,
        modelLabel: last?.modelLabel || p.latestModel,
        contextUsed: used,
        contextLimit: lim,
        usedPercent: pct,
        calls: p.steps.length,
        updatedAtMs: p.lastRealActivityMs
      };
    });

    const todayDate = pricing.formatLocalDate(new Date());
    const sinceLocalStr = pricing.formatLocalDate(new Date(sinceMs || Date.now()));

    return {
      ok: true,
      scannedAt: new Date().toISOString(),
      sinceIso: state.sinceIso,
      sinceLocalLabel: new Date(sinceMs || Date.now()).toLocaleString('zh-CN', { hour12: false }),
      fxCny,
      selectedConvId: requestedConvId || null,
      recentSessions,
      activeSession: buildActiveSessionView(targetParsed),
      freshLedger: pricing.summarizeBuckets(freshBuckets, { todayDate, fxCny }),
      fullLedger: pricing.summarizeBuckets(fullBuckets, { todayDate, fxCny }),
      freshHeatmap: pricing.buildHeatmapGrid(freshBuckets, { endDate: todayDate, weeks: 52, fxCny, minDate: sinceLocalStr }),
      fullHeatmap: pricing.buildHeatmapGrid(fullBuckets, { endDate: todayDate, weeks: 52, fxCny })
    };
  }

  function resetBaselineNow() {
    state = { ...state, sinceIso: new Date().toISOString() };
    try {
      fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
      fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
    } catch {
      // 忽略写入异常
    }
    return state;
  }

  return {
    getSnapshot,
    resetBaselineNow
  };
}

module.exports = {
  createLogScanner
};
