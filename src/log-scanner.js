'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pricing = require('./pricing-engine');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_CHANGE_REGEX = /Model Selection`?\s+(?:from\s+[^`]+?\s+)?to\s+`?([^.`<\n]+)`?/i;

function extractTimestampMs(row, fallbackMs) {
  const raw = row?.created_at || row?.timestamp || row?.metadata?.createdAt;
  if (raw) {
    const t = Date.parse(raw);
    if (!Number.isNaN(t) && t > 0) return t;
  }
  return fallbackMs;
}

function parseDurationSeconds(val) {
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) return val;
  if (typeof val === 'string') {
    const m = val.trim().match(/^([0-9]+(?:\.[0-9]+)?)s?$/i);
    if (m) return Number(m[1]);
  }
  return null;
}

function ensureBaselineState(stateFilePath, legacyPluginStatePath) {
  try {
    if (fs.existsSync(stateFilePath)) {
      const parsed = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
      if (parsed && typeof parsed.sinceIso === 'string' && !Number.isNaN(Date.parse(parsed.sinceIso))) {
        return parsed;
      }
    }
    // 若本机此前已记录起算基线，平滑继承不丢账
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

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof obj.content === 'string' && obj.content.includes('Model Selection')) {
      const m = obj.content.match(MODEL_CHANGE_REGEX);
      if (m && m[1]) activeModelName = m[1].trim();
    }
    const directModel = obj.model || obj.model_name || obj.metadata?.model;
    if (typeof directModel === 'string' && directModel.trim()) {
      activeModelName = directModel.trim();
    }
    rawEntries.push({
      obj,
      tsMs: extractTimestampMs(obj, mtimeMs),
      modelAtStep: activeModelName
    });
  }

  const plannerSteps = [];
  for (let i = 0; i < rawEntries.length; i++) {
    const { obj, tsMs, modelAtStep } = rawEntries[i];
    const inTok = Math.max(0, Number(obj.input_tokens ?? obj.usage?.inputTokens ?? 0) || 0);
    const caTok = Math.max(0, Number(obj.cache_read_tokens ?? obj.usage?.cacheReadTokens ?? 0) || 0);
    const outTok = Math.max(0, Number(obj.output_tokens ?? obj.usage?.outputTokens ?? 0) || 0);
    const isPlanner = obj.type === 'PLANNER_RESPONSE' || (inTok + caTok + outTok > 0);
    if (!isPlanner || (inTok + caTok + outTok <= 0)) continue;

    // 精确耗时计算：优先取显式字段，其次取下一步事件时间戳与当前步开始时间差值
    const explicitStreamSec = parseDurationSeconds(obj.streaming_duration ?? obj.streamingDuration);
    const explicitTtftSec = parseDurationSeconds(obj.time_to_first_token ?? obj.timeToFirstToken);
    let durationSec = explicitStreamSec != null ? explicitStreamSec + (explicitTtftSec || 0) : null;

    if (durationSec == null && i + 1 < rawEntries.length && rawEntries[i + 1].obj?.type !== 'USER_INPUT') {
      const deltaSec = (rawEntries[i + 1].tsMs - tsMs) / 1000;
      if (deltaSec >= 0.4 && deltaSec <= 240) {
        durationSec = Number(deltaSec.toFixed(1));
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
    plannerSteps.push({
      convId,
      tsMs,
      dateStr: pricing.formatLocalDate(new Date(tsMs)),
      modelKey: spec.key,
      modelLabel: spec.displayLabel,
      contextLimit: spec.contextLimit,
      inputTokens: inTok,
      cacheTokens: caTok,
      outputTokens: outTok,
      durationSec: durationSec != null ? Number(durationSec.toFixed(1)) : null,
      ttftSec: explicitTtftSec != null ? Number(explicitTtftSec.toFixed(1)) : null,
      tokensPerSec
    });
  }

  return {
    convId,
    mtimeMs,
    latestModel: activeModelName,
    steps: plannerSteps
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
      modelLabel: parsedConv?.latestModel || 'Gemini 4 Carbon',
      contextUsed: 0,
      contextLimit: 1_048_576,
      remainingTokens: 1_048_576,
      usedPercent: 0,
      remainingPercent: 100,
      healthTone: 'good',
      healthLabel: '空闲',
      healthNote: '等待当前会话产生首次模型请求…',
      speed: {
        tokensPerSec: null,
        durationSec: null,
        ttftSec: null,
        outputTokens: 0,
        tone: 'muted',
        badgeLabel: '待生成',
        note: '等待首次模型输出后自动计算生成速度与耗时…'
      }
    };
  }

  const last = parsedConv.steps[parsedConv.steps.length - 1];
  const lastWithSpeed = [...parsedConv.steps].reverse().find(s => s.tokensPerSec != null) || last;

  const contextUsed = last.inputTokens + last.cacheTokens;
  const contextLimit = last.contextLimit || 1_048_576;
  const remainingTokens = Math.max(0, contextLimit - contextUsed);
  const usedPercent = Number(Math.min(100, (contextUsed / contextLimit) * 100).toFixed(1));
  const remainingPercent = Number(Math.max(0, 100 - usedPercent).toFixed(1));

  let healthTone = 'good';
  let healthLabel = '正常';
  let healthNote = `✓ 当前用量健康 (${usedPercent}%)，剩余空间充足，可顺畅继续对话。`;
  if (usedPercent >= 88) {
    healthTone = 'danger';
    healthLabel = '告急';
    healthNote = `⚠ 上下文已占用 ${usedPercent}%，建议尽快使用 /compact 压缩或新开会话。`;
  } else if (usedPercent >= 72) {
    healthTone = 'warn';
    healthLabel = '偏高';
    healthNote = `提示：上下文已使用 ${usedPercent}%，长任务建议适时收敛历史上下文。`;
  }

  let speedObj;
  if (lastWithSpeed && lastWithSpeed.tokensPerSec != null) {
    const tps = lastWithSpeed.tokensPerSec;
    let tone = 'good';
    let badgeLabel = '流畅';
    let descWord = '输出流畅';
    if (tps >= 75) {
      tone = 'good';
      badgeLabel = '极速';
      descWord = '高速生成';
    } else if (tps >= 32) {
      tone = 'good';
      badgeLabel = '流畅';
      descWord = '输出流畅';
    } else if (tps >= 14) {
      tone = 'warn';
      badgeLabel = '良好';
      descWord = '输出平稳';
    } else {
      tone = 'danger';
      badgeLabel = '偏慢';
      descWord = '响应偏慢';
    }
    const durText = lastWithSpeed.durationSec != null ? `总耗时 ${lastWithSpeed.durationSec}s ` : '';
    speedObj = {
      tokensPerSec: tps,
      durationSec: lastWithSpeed.durationSec,
      ttftSec: lastWithSpeed.ttftSec,
      outputTokens: lastWithSpeed.outputTokens,
      tone,
      badgeLabel,
      note: `✓ ${descWord} (${tps} tok/s)，${durText}内生成 ${lastWithSpeed.outputTokens.toLocaleString()} tokens（${lastWithSpeed.modelLabel}）。`
    };
  } else {
    speedObj = {
      tokensPerSec: null,
      durationSec: last.durationSec,
      ttftSec: last.ttftSec,
      outputTokens: last.outputTokens,
      tone: 'muted',
      badgeLabel: '已记录',
      note: `最近一次输出 ${last.outputTokens.toLocaleString()} tokens（${last.modelLabel}），等待下一拍耗时采样。`
    };
  }

  return {
    conversationId: parsedConv.convId,
    modelLabel: last.modelLabel,
    contextUsed,
    contextLimit,
    remainingTokens,
    usedPercent,
    remainingPercent,
    healthTone,
    healthLabel,
    healthNote,
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
    return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  function getSnapshot() {
    const files = listConversationTranscripts();
    const sinceMs = Date.parse(state.sinceIso) || 0;
    const fxCny = Number(state.fxCny) > 0 ? Number(state.fxCny) : pricing.DEFAULT_FX_CNY;

    const fullBuckets = {};
    const freshBuckets = {};
    let mostRecentParsed = null;

    for (let idx = 0; idx < files.length; idx++) {
      const f = files[idx];
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
      if (idx === 0) mostRecentParsed = parsed;

      for (const step of parsed.steps) {
        addStepIntoBuckets(fullBuckets, step);
        if (step.tsMs >= sinceMs) {
          addStepIntoBuckets(freshBuckets, step);
        }
      }
    }

    const todayDate = pricing.formatLocalDate(new Date());
    const sinceLocalStr = pricing.formatLocalDate(new Date(sinceMs || Date.now()));

    return {
      ok: true,
      scannedAt: new Date().toISOString(),
      sinceIso: state.sinceIso,
      sinceLocalLabel: new Date(sinceMs || Date.now()).toLocaleString('zh-CN', { hour12: false }),
      fxCny,
      activeSession: buildActiveSessionView(mostRecentParsed),
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
