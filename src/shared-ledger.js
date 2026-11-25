'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEMA_VERSION = 1;

function sanitizeMachineId(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || (process.platform === 'win32' ? 'windows' : 'macos');
}

function sanitizeLabel(raw, fallback) {
  const text = String(raw || '').trim();
  if (!text) return fallback;
  // 去掉可能混入的路径分隔符，确保导出账本不含本机路径
  const base = text.split(/[\\/]/).filter(Boolean).pop() || text;
  return base.slice(0, 64);
}

/**
 * 动态定位本机 Obsidian Vault 下的 `04-素材工具/token-ledger`，避免硬编码用户路径。
 * 目录约定：{vaultParent}/laowang-local/code/antigravity-token-bar → 向上 3 级即 vaultParent。
 */
function detectVaultAndMachine(repoRoot) {
  const root = repoRoot || path.resolve(__dirname, '..');
  const candidateParents = [path.resolve(root, '..', '..', '..')];
  if (!repoRoot) {
    const home = os.homedir();
    for (const extra of [path.join(home, 'Public'), home]) {
      if (!candidateParents.includes(extra)) candidateParents.push(extra);
    }
  }
  let matchedVault = '';
  let detectedMachine = '';

  for (const vaultParent of candidateParents) {
    if (matchedVault) break;
    try {
      const entries = fs.readdirSync(vaultParent, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name === 'laowang-local') continue;
        const candidate = path.join(vaultParent, ent.name);
        const hasTools = fs.existsSync(path.join(candidate, '04-素材工具'));
        const hasProfiles = fs.existsSync(path.join(candidate, 'machine-profiles.json'));
        if (hasTools && (hasProfiles || fs.existsSync(path.join(candidate, 'AGENTS.md')))) {
          matchedVault = candidate;
          if (hasProfiles) {
            try {
              const prof = JSON.parse(fs.readFileSync(path.join(candidate, 'machine-profiles.json'), 'utf8'));
              const profiles = (prof && prof.profiles) || {};
              for (const [key, item] of Object.entries(profiles)) {
                if (!item || typeof item !== 'object') continue;
                if (item.obsidianVaultName === ent.name || path.resolve(item.vaultPath || '') === path.resolve(candidate)) {
                  detectedMachine = key;
                  break;
                }
              }
            } catch {
              // 忽略 profile 解析失败
            }
          }
          break;
        }
      }
    } catch {
      // 忽略目录扫描异常
    }
  }

  const envDir = process.env.ATB_SHARED_LEDGER_DIR ? path.resolve(process.env.ATB_SHARED_LEDGER_DIR) : '';
  const ledgerDir = envDir || (matchedVault ? path.join(matchedVault, '04-素材工具', 'token-ledger') : '');
  const machineId = sanitizeMachineId(
    process.env.ATB_MACHINE_ID ||
      detectedMachine ||
      (process.platform === 'win32' ? 'windows' : os.hostname())
  );

  return { ledgerDir, machineId, vaultDir: matchedVault };
}

function rowKey(r) {
  return `${r.date}|${r.convId}|${r.model}|${r.workspace}|${r.category}`;
}

/**
 * 将事件数组聚合成按月份分片的脱敏行列表（按 date|convId|model|workspace|category 合并）。
 */
function compactEventsByMonth(events) {
  const byMonth = new Map();
  for (const ev of events || []) {
    if (!ev || typeof ev.date !== 'string' || ev.date.length < 7) continue;
    const month = ev.date.slice(0, 7);
    let bucket = byMonth.get(month);
    if (!bucket) {
      bucket = new Map();
      byMonth.set(month, bucket);
    }
    const cleanRow = {
      date: ev.date,
      convId: String(ev.convId || '').trim(),
      model: sanitizeLabel(ev.model, 'unknown'),
      workspace: sanitizeLabel(ev.workspace, '未标明'),
      category: sanitizeLabel(ev.category, '主对话')
    };
    const key = rowKey(cleanRow);
    let agg = bucket.get(key);
    if (!agg) {
      agg = {
        ...cleanRow,
        input: 0,
        thinking: 0,
        output: 0,
        cacheRead: 0,
        responses: 0,
        estimatedResponses: 0
      };
      bucket.set(key, agg);
    }
    if (ev.estimated) {
      agg.estimatedResponses += Math.max(1, Number(ev.estimatedResponses) || 1);
    } else {
      agg.input += Math.max(0, Number(ev.input) || 0);
      agg.thinking += Math.max(0, Number(ev.thinking) || 0);
      agg.output += Math.max(0, Number(ev.output) || 0);
      agg.cacheRead += Math.max(0, Number(ev.cacheRead) || 0);
      agg.responses += Math.max(1, Number(ev.responses) || 1);
    }
  }

  const result = new Map();
  for (const [month, map] of byMonth.entries()) {
    const rows = [...map.values()].sort((a, b) => (rowKey(a) < rowKey(b) ? -1 : 1));
    result.set(month, rows);
  }
  return result;
}

function stableRowsSignature(rows) {
  return JSON.stringify(rows);
}

/**
 * 将本机 usageIndex 导出为 machines/<machineId>/<YYYY-MM>.json。
 * 幂等：仅当月度 rows 实际变化时才写盘，不无谓触发 Git 脏状态。
 */
function exportLocalUsageToShared(localIndex, options = {}) {
  const ledgerDir = options.ledgerDir;
  const machineId = sanitizeMachineId(options.machineId);
  if (!ledgerDir || !localIndex || !Array.isArray(localIndex.events)) {
    return { ok: false, writtenFiles: [], machineId };
  }

  const machineDir = path.join(ledgerDir, 'machines', machineId);
  fs.mkdirSync(machineDir, { recursive: true });

  const byMonth = compactEventsByMonth(localIndex.events);
  const writtenFiles = [];

  for (const [month, rows] of byMonth.entries()) {
    const filePath = path.join(machineDir, `${month}.json`);
    const nextSig = stableRowsSignature(rows);
    let unchanged = false;
    if (fs.existsSync(filePath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (existing && Array.isArray(existing.rows) && stableRowsSignature(existing.rows) === nextSig) {
          unchanged = true;
        }
      } catch {
        unchanged = false;
      }
    }
    if (unchanged) continue;

    const payload = {
      version: SCHEMA_VERSION,
      machine: machineId,
      month,
      updatedAt: new Date().toISOString(),
      rows
    };
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, filePath);
    writtenFiles.push(filePath);
  }

  return { ok: true, writtenFiles, machineId, months: [...byMonth.keys()].sort() };
}

function rowTokenTotal(r) {
  return (Number(r.input) || 0) + (Number(r.thinking) || 0) + (Number(r.output) || 0) + (Number(r.cacheRead) || 0);
}

/**
 * 合并本机实时 localIndex 与共享目录中其他机器的月度 JSON 分片。
 * 按 date|convId|model|workspace|category 去重（保留 token 总量更大的记录），避免同一会话跨机同步后重复计费。
 */
function loadMergedUsageIndex(localIndex, options = {}) {
  const ledgerDir = options.ledgerDir;
  const localMachine = sanitizeMachineId(options.machineId);
  const dedup = new Map();
  const machineSet = new Set();

  // 1. 先载入本机实时聚合行（始终作为本机真相源）
  if (localIndex && Array.isArray(localIndex.events) && localIndex.events.length > 0) {
    machineSet.add(localMachine);
    const localMonths = compactEventsByMonth(localIndex.events);
    for (const rows of localMonths.values()) {
      for (const r of rows) {
        const key = rowKey(r);
        dedup.set(key, { ...r, machine: localMachine });
      }
    }
  }

  // 2. 扫描共享目录下所有机器分片（跳过本机，避免陈旧文件覆盖本机实时值）
  const machinesRoot = ledgerDir ? path.join(ledgerDir, 'machines') : '';
  if (machinesRoot && fs.existsSync(machinesRoot)) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(machinesRoot, { withFileTypes: true });
    } catch {
      dirs = [];
    }
    for (const ent of dirs) {
      if (!ent.isDirectory()) continue;
      const mId = sanitizeMachineId(ent.name);
      if (mId === localMachine && localIndex && Array.isArray(localIndex.events) && localIndex.events.length > 0) {
        continue;
      }
      const mDir = path.join(machinesRoot, ent.name);
      let files = [];
      try {
        files = fs.readdirSync(mDir).filter((n) => /^\d{4}-\d{2}\.json$/.test(n)).sort();
      } catch {
        continue;
      }
      for (const fname of files) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(mDir, fname), 'utf8'));
          if (!parsed || !Array.isArray(parsed.rows)) continue;
          if (parsed.rows.length > 0) machineSet.add(mId);
          for (const raw of parsed.rows) {
            if (!raw || !raw.date) continue;
            const r = {
              date: String(raw.date),
              convId: String(raw.convId || ''),
              model: sanitizeLabel(raw.model, 'unknown'),
              workspace: sanitizeLabel(raw.workspace, '未标明'),
              category: sanitizeLabel(raw.category, '主对话'),
              input: Math.max(0, Number(raw.input) || 0),
              thinking: Math.max(0, Number(raw.thinking) || 0),
              output: Math.max(0, Number(raw.output) || 0),
              cacheRead: Math.max(0, Number(raw.cacheRead) || 0),
              responses: Math.max(0, Number(raw.responses) || 0),
              estimatedResponses: Math.max(0, Number(raw.estimatedResponses) || 0),
              machine: mId
            };
            const key = rowKey(r);
            const prev = dedup.get(key);
            if (!prev || rowTokenTotal(r) > rowTokenTotal(prev)) {
              dedup.set(key, r);
            }
          }
        } catch {
          // 跳过损坏分片，不影响其余机器
        }
      }
    }
  }

  const events = [];
  const modelSet = new Set();
  const workspaceSet = new Set();
  const categorySet = new Set();

  for (const r of dedup.values()) {
    modelSet.add(r.model);
    workspaceSet.add(r.workspace);
    categorySet.add(r.category);
    if (r.responses > 0 || rowTokenTotal(r) > 0) {
      events.push({
        date: r.date,
        convId: r.convId,
        model: r.model,
        workspace: r.workspace,
        category: r.category,
        machine: r.machine,
        input: r.input,
        thinking: r.thinking,
        output: r.output,
        cacheRead: r.cacheRead,
        responses: Math.max(1, r.responses || 1),
        estimated: false
      });
    }
    if (r.estimatedResponses > 0) {
      events.push({
        date: r.date,
        convId: r.convId,
        model: r.model,
        workspace: r.workspace,
        category: r.category,
        machine: r.machine,
        input: 0,
        thinking: 0,
        output: 0,
        cacheRead: 0,
        estimatedResponses: r.estimatedResponses,
        estimated: true
      });
    }
  }

  return {
    events,
    scannedFiles: localIndex?.scannedFiles || 0,
    models: [...modelSet].sort(),
    workspaces: [...workspaceSet].sort(),
    categories: [...categorySet].sort(),
    machines: [...machineSet].sort(),
    localMachine,
    sharedDir: ledgerDir || ''
  };
}

module.exports = {
  SCHEMA_VERSION,
  detectVaultAndMachine,
  compactEventsByMonth,
  exportLocalUsageToShared,
  loadMergedUsageIndex
};
