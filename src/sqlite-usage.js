'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pricing = require('./pricing-engine');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

function parseProto(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let i = 0;
  const out = new Map();
  while (i < u8.length) {
    let tag = 0;
    let shift = 0;
    while (i < u8.length) {
      const b = u8[i++];
      tag |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 28) return out;
    }
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn <= 0 || fn > 10000) break;
    if (wt === 0) {
      let val = 0;
      let s = 0;
      while (i < u8.length) {
        const b = u8[i++];
        val += (b & 0x7f) * Math.pow(2, s);
        if (!(b & 0x80)) break;
        s += 7;
        if (s > 56) break;
      }
      out.set(fn, val);
    } else if (wt === 2) {
      let len = 0;
      let s = 0;
      while (i < u8.length) {
        const b = u8[i++];
        len |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      if (len < 0 || i + len > u8.length) break;
      out.set(fn, u8.subarray(i, i + len));
      i += len;
    } else if (wt === 1) {
      if (i + 8 > u8.length) break;
      i += 8;
    } else if (wt === 5) {
      if (i + 4 > u8.length) break;
      i += 4;
    } else {
      break;
    }
  }
  return out;
}

function readUsage(data) {
  const top = parseProto(data);
  const chatRaw = top.get(1);
  if (!(chatRaw instanceof Uint8Array)) return null;
  const chat = parseProto(chatRaw);
  const usageRaw = chat.get(4);
  if (!(usageRaw instanceof Uint8Array)) return null;
  const usage = parseProto(usageRaw);
  return {
    input: usage.get(2) || 0,
    output: usage.get(3) || 0,
    cacheRead: usage.get(5) || 0,
    thinking: usage.get(9) || 0,
    response: usage.get(10) || 0
  };
}

function responseStepTimes(db) {
  // gen_metadata.idx 和 steps.idx 不是同一套编号，不能按 idx 对齐。
  // 模型回复是 step_type = 15，和 gen_metadata 按出现顺序一一对应。
  const times = [];
  for (const step of db.prepare('SELECT metadata FROM steps WHERE step_type = 15 ORDER BY idx ASC').all()) {
    times.push(readStepCreatedSec(step.metadata));
  }
  return times;
}

function readStepCreatedSec(metadata) {
  if (!metadata) return 0;
  const top = parseProto(metadata);
  const raw = top.get(1);
  if (!(raw instanceof Uint8Array)) return 0;
  const sec = parseProto(raw).get(1) || 0;
  if (sec > 1.6e9 && sec < 2.1e9) return sec;
  return 0;
}

function localDateFromSec(sec) {
  const d = new Date(sec * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function emptyDay() {
  return {
    inputTokens: 0,
    thinkingTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sessions: new Set(),
    responses: 0,
    estimatedResponses: 0,
    estimatedTokens: 0
  };
}

function finalizeDay(day, date) {
  const input = day.inputTokens;
  const thinking = day.thinkingTokens;
  const output = day.outputTokens;
  const cache = day.cacheReadTokens;
  const total = input + thinking + output + cache;
  const precise = day.responses;
  const estimated = day.estimatedResponses;
  const denom = precise + estimated;
  const activeDays = total > 0 ? 1 : 0;
  return {
    date,
    totalTokens: total,
    inputTokens: input,
    thinkingTokens: thinking,
    outputTokens: output,
    cacheReadTokens: cache,
    cacheWriteTokens: day.cacheWriteTokens,
    sessions: day.sessions.size,
    responses: precise,
    estimatedResponses: estimated,
    estimatedTokens: day.estimatedTokens,
    coveragePct: denom > 0 ? Number(((precise / denom) * 100).toFixed(1)) : 0,
    dailyAvgTokens: activeDays > 0 ? total : 0
  };
}

/**
 * 只读 conversations/*.db 的 gen_metadata，按本地日汇总。
 * 输出不含思考：usage 字段 10；思考是字段 9。
 */
function scanConversationUsage(conversationsDir, todayDate) {
  if (!DatabaseSync || !conversationsDir || !fs.existsSync(conversationsDir)) return null;
  const today = emptyDay();
  let files = [];
  try {
    files = fs.readdirSync(conversationsDir);
  } catch {
    return null;
  }
  let scanned = 0;
  for (const name of files) {
    if (!name.endsWith('.db')) continue;
    const convId = name.slice(0, -3);
    const dbPath = path.join(conversationsDir, name);
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1500 });
      const times = responseStepTimes(db);
      const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
      let touchedToday = false;
      const count = Math.min(times.length, rows.length);
      for (let i = 0; i < count; i++) {
        const row = rows[i];
        const sec = times[i] || 0;
        if (!sec || localDateFromSec(sec) !== todayDate) continue;
        const usage = readUsage(row.data);
        if (!usage) continue;
        const thinking = usage.thinking || 0;
        const response = usage.response || Math.max(0, usage.output - thinking);
        const sum = usage.input + thinking + response + usage.cacheRead;
        if (sum <= 0) {
          today.estimatedResponses += 1;
          continue;
        }
        today.inputTokens += usage.input;
        today.thinkingTokens += thinking;
        today.outputTokens += response;
        today.cacheReadTokens += usage.cacheRead;
        today.responses += 1;
        touchedToday = true;
      }
      if (touchedToday) today.sessions.add(convId);
      scanned += 1;
    } catch {
      // 被占用或不是本机会话库时跳过
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }
  const result = finalizeDay(today, todayDate);
  result.scannedFiles = scanned;
  return result;
}

function latin1(buf) {
  return Buffer.from(buf).toString('latin1');
}

function readModel(buf) {
  const m = latin1(buf).match(/model_enum[\s\S]{0,16}(MODEL_[A-Z0-9_]+)/);
  return m ? m[1] : '未标明';
}

function readCategory(buf, convId) {
  const text = latin1(buf);
  const root = text.match(/root_cascade_id[\s\S]{0,16}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (root && root[1].toLowerCase() !== String(convId).toLowerCase()) return '子代理';
  return '主会话';
}

function workspaceLabel(raw) {
  if (!raw) return '未标明';
  let list = [];
  try {
    list = JSON.parse(raw);
  } catch {
    list = [String(raw)];
  }
  const first = Array.isArray(list) ? list[0] : '';
  if (!first) return '未标明';
  let decoded = String(first);
  try {
    decoded = decodeURIComponent(decoded.replace(/^file:\/\//, ''));
  } catch {
    decoded = decoded.replace(/^file:\/\//, '');
  }
  decoded = decoded.replace(/^\/+/, '').replace(/\\/g, '/');
  const parts = decoded.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || '未标明';
}

function loadWorkspaces(conversationsDir) {
  const map = new Map();
  if (!DatabaseSync) return map;
  const dbPath = path.join(path.dirname(conversationsDir), 'conversation_summaries.db');
  if (!fs.existsSync(dbPath)) return map;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1500 });
    const rows = db.prepare('SELECT conversation_id, workspace_uris FROM conversation_summaries').all();
    for (const row of rows) map.set(row.conversation_id, workspaceLabel(row.workspace_uris));
  } catch {
    // 摘要库打不开时工作区筛选项为空
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
  return map;
}

function dirSignature(conversationsDir) {
  const names = fs.readdirSync(conversationsDir).filter((name) => name.endsWith('.db'));
  let max = 0;
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(conversationsDir, name));
      if (st.mtimeMs > max) max = st.mtimeMs;
    } catch {
      // ignore
    }
  }
  return `${names.length}:${Math.round(max)}`;
}

const indexCache = new Map();

function loadUsageIndex(conversationsDir, options = {}) {
  if (!DatabaseSync || !conversationsDir || !fs.existsSync(conversationsDir)) return null;
  const sig = dirSignature(conversationsDir);
  const cached = indexCache.get(conversationsDir);
  if (!options.fresh && cached && cached.sig === sig) return cached.index;

  const workspaces = loadWorkspaces(conversationsDir);
  const events = [];
  const modelSet = new Set();
  const workspaceSet = new Set();
  const categorySet = new Set();
  let scanned = 0;
  for (const name of fs.readdirSync(conversationsDir)) {
    if (!name.endsWith('.db')) continue;
    const convId = name.slice(0, -3);
    const dbPath = path.join(conversationsDir, name);
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1500 });
      const times = responseStepTimes(db);
      const workspace = workspaces.get(convId) || '未标明';
      const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
      const count = Math.min(times.length, rows.length);
      for (let i = 0; i < count; i++) {
        const row = rows[i];
        const sec = times[i] || 0;
        if (!sec) continue;
        const usage = readUsage(row.data);
        if (!usage) continue;
        const thinking = usage.thinking || 0;
        const response = usage.response || Math.max(0, usage.output - thinking);
        const model = readModel(row.data);
        const category = readCategory(row.data, convId);
        const sum = usage.input + thinking + response + usage.cacheRead;
        modelSet.add(model);
        workspaceSet.add(workspace);
        categorySet.add(category);
        events.push({
          date: localDateFromSec(sec),
          convId,
          model,
          workspace,
          category,
          input: usage.input,
          thinking,
          output: response,
          cacheRead: usage.cacheRead,
          estimated: sum <= 0
        });
      }
      scanned += 1;
    } catch {
      // 跳过打不开的库
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }
  const index = {
    events,
    scannedFiles: scanned,
    models: [...modelSet].sort(),
    workspaces: [...workspaceSet].sort(),
    categories: [...categorySet].sort()
  };
  indexCache.set(conversationsDir, { sig, index });
  return index;
}

function inRange(date, range, today) {
  if (!date) return false;
  if (range === 'all' || range === 'allTime') return true;
  if (range === 'year') return date.slice(0, 4) === today.slice(0, 4);
  if (range === 'month') return date.slice(0, 7) === today.slice(0, 7);
  if (range === '7d') {
    const end = new Date(`${today}T00:00:00`);
    const cur = new Date(`${date}T00:00:00`);
    const diff = (end - cur) / 86400000;
    return diff >= 0 && diff < 7;
  }
  return date === today;
}

function weekStart(date) {
  const d = new Date(`${date}T00:00:00`);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function normConvId(id) {
  return String(id || '').trim().toLowerCase();
}

function aggregateUsage(index, options = {}) {
  if (!index) return null;
  const today = options.todayDate;
  const range = options.range || 'today';
  const grain = options.grain === 'week' ? 'week' : 'day';
  const model = options.model || '';
  const workspace = options.workspace || '';
  const category = options.category || '';
  const machine = options.machine || '';
  const convId = options.convId ? normConvId(options.convId) : '';
  const sessions = new Set();
  const days = new Map();
  const fxCny = Number(options.fxCny) > 0 ? Number(options.fxCny) : pricing.DEFAULT_FX_CNY;
  let input = 0;
  let thinking = 0;
  let output = 0;
  let cacheRead = 0;
  let responses = 0;
  let estimatedResponses = 0;
  let inputUSD = 0;
  let cacheUSD = 0;
  let outputUSD = 0;
  let savedUSD = 0;
  for (const ev of index.events) {
    if (!inRange(ev.date, range, today)) continue;
    if (convId && normConvId(ev.convId) !== convId) continue;
    if (model && ev.model !== model) continue;
    if (workspace && ev.workspace !== workspace) continue;
    if (category && ev.category !== category) continue;
    if (machine && ev.machine !== machine) continue;
    if (ev.estimated) {
      estimatedResponses += Math.max(1, Number(ev.estimatedResponses) || 1);
      continue;
    }
    input += ev.input;
    thinking += ev.thinking;
    output += ev.output;
    cacheRead += ev.cacheRead;
    responses += Math.max(1, Number(ev.responses) || 1);
    const stepCost = pricing.calcStepCost(
      {
        inputTokens: ev.input,
        cacheReadTokens: ev.cacheRead,
        outputTokens: ev.thinking + ev.output
      },
      ev.model,
      fxCny
    );
    inputUSD += stepCost.inputUSD;
    cacheUSD += stepCost.cacheUSD;
    outputUSD += stepCost.outputUSD;
    savedUSD += stepCost.savedUSD;
    sessions.add(ev.convId);
    const key = grain === 'week' ? weekStart(ev.date) : ev.date;
    let bucket = days.get(key);
    if (!bucket) {
      bucket = { key, total: 0 };
      days.set(key, bucket);
    }
    bucket.total += ev.input + ev.thinking + ev.output + ev.cacheRead;
  }
  const total = input + thinking + output + cacheRead;
  const activeDays = days.size;
  const denom = responses + estimatedResponses;
  const series = [...days.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  return {
    range,
    grain,
    totalTokens: total,
    inputTokens: input,
    thinkingTokens: thinking,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    sessions: sessions.size,
    responses,
    estimatedResponses,
    estimatedTokens: 0,
    coveragePct: denom > 0 ? Number(((responses / denom) * 100).toFixed(1)) : 0,
    dailyAvgTokens: activeDays > 0 ? Math.round(total / activeDays) : 0,
    activeDays,
    series,
    scannedFiles: index.scannedFiles,
    cost: {
      inputUSD,
      cacheUSD,
      outputUSD,
      totalUSD: inputUSD + cacheUSD + outputUSD,
      savedUSD,
      totalCNY: (inputUSD + cacheUSD + outputUSD) * fxCny,
      savedCNY: savedUSD * fxCny,
      dailyAvgUSD: activeDays > 0 ? (inputUSD + cacheUSD + outputUSD) / activeDays : 0,
      fx: fxCny
    }
  };
}

function preciseBuckets(index, todayDate, options = {}) {
  const ranges = ['today', 'month', 'year', 'all'];
  const machine = options.machine || '';
  const out = {};
  for (const range of ranges) {
    out[range === 'all' ? 'allTime' : range] = aggregateUsage(index, { todayDate, range, grain: 'day', machine });
  }
  const daily = {};
  for (const ev of index.events) {
    if (ev.estimated) continue;
    if (machine && ev.machine !== machine) continue;
    let day = daily[ev.date];
    if (!day) {
      day = { input: 0, cache: 0, output: 0, steps: 0 };
      daily[ev.date] = day;
    }
    day.input += ev.input;
    day.cache += ev.cacheRead;
    day.output += ev.thinking + ev.output;
    day.steps += Math.max(1, Number(ev.responses) || 1);
  }
  return { cards: out, daily };
}

module.exports = {
  scanConversationUsage,
  loadUsageIndex,
  aggregateUsage,
  preciseBuckets,
  readUsage,
  readStepCreatedSec
};
