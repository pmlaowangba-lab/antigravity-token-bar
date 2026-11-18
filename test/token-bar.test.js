'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('1. pricing-engine 准确计算单次调用成本、缓存命中净省金额，并支持按日无历史回溯聚合与 52 周日历热力图生成', () => {
  const pricing = require('../src/pricing-engine');

  // 单次调用计费：200k 未缓存输入 + 800k 缓存读取 + 10k 输出
  const single = pricing.calcStepCost(
    { inputTokens: 200_000, cacheReadTokens: 800_000, outputTokens: 10_000 },
    'Gemini 4 Carbon (Medium)'
  );
  assert.ok(single.totalUSD > 0);
  assert.ok(single.savedUSD > single.cacheUSD, '缓存命中净省金额应显著高于缓存读取费');

  // 多日账本聚合（验证全量模式 vs 无回溯模式）
  const buckets = {
    '2026-11-16': {
      input: 1_000_000,
      cache: 3_000_000,
      output: 100_000,
      steps: 12,
      sessions: new Set(['s1']),
      models: {
        'gemini-4-carbon': { label: 'Gemini 4 Carbon', input: 1_000_000, cache: 3_000_000, output: 100_000, steps: 12 }
      }
    },
    '2026-11-18': {
      input: 500_000,
      cache: 2_000_000,
      output: 50_000,
      steps: 6,
      sessions: new Set(['s2', 's3']),
      models: {
        'gemini-4-carbon': { label: 'Gemini 4 Carbon', input: 500_000, cache: 2_000_000, output: 50_000, steps: 6 }
      }
    }
  };

  const fullSummary = pricing.summarizeBuckets(buckets, { todayDate: '2026-11-18' });
  const freshSummary = pricing.summarizeBuckets(buckets, { todayDate: '2026-11-18', minDate: '2026-11-18' });

  assert.equal(fullSummary.allTime.totalTokens, 6_650_000);
  assert.equal(freshSummary.allTime.totalTokens, 2_550_000);
  assert.equal(freshSummary.today.sessionsCount, 2);
  assert.ok(fullSummary.allTime.cost.totalUSD > freshSummary.allTime.cost.totalUSD);
  assert.ok(freshSummary.today.cost.totalCNY > freshSummary.today.cost.totalUSD * 6);

  const heat = pricing.buildHeatmapGrid(buckets, { endDate: '2026-11-18', weeks: 52 });
  assert.equal(heat.weeks.length, 52);
  assert.equal(heat.weeks[51].days.length, 7);
});

test('2. log-scanner 解析本地 transcript.jsonl：提取当前会话上下文占比、生成速度与精确耗时秒数，并区分安装前后新旧账本', () => {
  const { createLogScanner } = require('../src/log-scanner');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atb-scan-'));
  const brainDir = path.join(tmpDir, 'brain');
  const stateFile = path.join(tmpDir, 'state.json');

  try {
    const convA = path.join(brainDir, 'aaaaaaaa-1111-4111-8111-111111111111', '.system_generated', 'logs');
    fs.mkdirSync(convA, { recursive: true });

    // 写入安装前一步 + 安装后一步 + 工具返回时间戳（用于精确计算生成耗时）
    fs.writeFileSync(
      path.join(convA, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          created_at: '2026-11-17T10:00:00.000Z',
          content: '<USER_REQUEST>old</USER_REQUEST><USER_SETTINGS_CHANGE>Model Selection to Gemini 4 Carbon (Medium).</USER_SETTINGS_CHANGE>'
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-17T10:00:05.000Z',
          input_tokens: 100_000,
          cache_read_tokens: 300_000,
          output_tokens: 1_000
        }),
        JSON.stringify({
          step_index: 2,
          type: 'USER_INPUT',
          created_at: '2026-11-18T06:10:00.000Z',
          content: '<USER_REQUEST>new</USER_REQUEST>'
        }),
        JSON.stringify({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-18T06:10:01.000Z',
          input_tokens: 60_000,
          cache_read_tokens: 300_000,
          output_tokens: 900
        }),
        JSON.stringify({
          step_index: 4,
          type: 'TOOL_RESPONSE',
          created_at: '2026-11-18T06:10:19.000Z',
          content: 'done'
        })
      ].join('\n') + '\n'
    );

    fs.writeFileSync(stateFile, JSON.stringify({ sinceIso: '2026-11-18T05:00:00.000Z' }));

    const scanner = createLogScanner({ brainRootDir: brainDir, stateFilePath: stateFile });
    const snap = scanner.getSnapshot();

    assert.equal(snap.activeSession.contextUsed, 360_000);
    assert.equal(snap.activeSession.contextLimit, 524_288, 'Carbon 默认预算上限应对齐 512K (524,288) 自动压缩水位线');
    assert.ok(snap.activeSession.usedPercent > 68 && snap.activeSession.usedPercent < 69);
    assert.equal(snap.activeSession.speed.durationSec, 18);
    assert.equal(snap.activeSession.speed.tokensPerSec, 50);
    assert.equal(snap.activeSession.speed.outputTokens, 900);

    // 新账仅含 2026-11-18 安装后的 360,900 tokens，全量历史含全部 761,900 tokens
    assert.equal(snap.freshLedger.allTime.totalTokens, 360_900);
    assert.equal(snap.fullLedger.allTime.totalTokens, 761_900);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('4. 多窗口会话锁定、工具 Created At 精确测速（剔除工具执行与 SYSTEM 重启噪声）及单会话累计统计精确对齐', async () => {
  const { startTokenBarServer } = require('../src/server');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atb-align-'));
  const brainDir = path.join(tmpDir, 'brain');

  const convLongId = '11111111-aaaa-4111-8111-111111111111';
  const convOtherId = '22222222-bbbb-4222-8222-222222222222';
  const convLongDir = path.join(brainDir, convLongId, '.system_generated', 'logs');
  const convOtherDir = path.join(brainDir, convOtherId, '.system_generated', 'logs');
  fs.mkdirSync(convLongDir, { recursive: true });
  fs.mkdirSync(convOtherDir, { recursive: true });

  // 会话 1（目标长会话）：468,111 上下文；第 1 步模型耗时 10s（工具本身额外跑了 25s，不应计入模型吐字耗时）；末尾带一条隔了 180s 的 SYSTEM 重启消息
  fs.writeFileSync(
    path.join(convLongDir, 'transcript.jsonl'),
    [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-11-18T12:00:00.000Z',
        content: '<USER_REQUEST>\n写Skill实战教学五层拆解\n</USER_REQUEST><USER_SETTINGS_CHANGE>Model Selection to Gemini 4 Carbon (Medium).</USER_SETTINGS_CHANGE>'
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-18T12:00:01.000Z',
        input_tokens: 2_778,
        cache_read_tokens: 465_333,
        output_tokens: 800
      }),
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        // 工具跑完是 12:00:36（含 25s 命令执行），但工具 Created At 是 12:00:11（模型实际只花了 10.0s 生成！）
        created_at: '2026-11-18T12:00:36.000Z',
        content: 'Created At: 2026-11-18T20:00:11+08:00\nCompleted At: 2026-11-18T20:00:36+08:00\nok'
      }),
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-18T12:00:37.000Z',
        input_tokens: 2_778,
        cache_read_tokens: 465_333,
        output_tokens: 881
      }),
      JSON.stringify({
        step_index: 4,
        source: 'SYSTEM',
        type: 'USER_INPUT',
        created_at: '2026-11-18T12:03:37.000Z',
        content: '[Notice] All your subagents and background tasks have been stopped due to server restart.'
      })
    ].join('\n') + '\n'
  );

  // 会话 2（稍晚修改的短会话 184.4K）
  fs.writeFileSync(
    path.join(convOtherDir, 'transcript.jsonl'),
    [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-11-18T12:05:00.000Z',
        content: '<USER_REQUEST>另一个后台窗口任务</USER_REQUEST>'
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-18T12:05:02.000Z',
        input_tokens: 4_400,
        cache_read_tokens: 180_000,
        output_tokens: 300
      })
    ].join('\n') + '\n'
  );

  const srv = await startTokenBarServer({
    port: 0,
    brainRootDir: brainDir,
    stateFilePath: path.join(tmpDir, 'state.json')
  });

  try {
    // 锁定查询会话 1（不串台到会话 2）
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/snapshot?convId=${convLongId}`);
    assert.equal(res.status, 200);
    const snap = await res.json();

    assert.equal(snap.activeSession.conversationId, convLongId);
    assert.equal(snap.activeSession.contextUsed, 468_111);
    assert.equal(snap.activeSession.contextLimit, 524_288);
    assert.ok(Math.abs(snap.activeSession.usedPercent - 89.3) < 0.2);

    // 验证工具 Created At 精确测速：800 tok / 10.0s = 80 tok/s，且绝不被末尾 180s SYSTEM 重启消息污染成 4.9 tok/s
    assert.equal(snap.activeSession.speed.tokensPerSec, 80);
    assert.equal(snap.activeSession.speed.durationSec, 10);
    // 最新一步纯文字回复输出量为 881
    assert.equal(snap.activeSession.speed.latestOutputTokens, 881);

    // 验证单会话累计对照数据
    assert.ok(snap.activeSession.sessionTotals, '缺少单会话累计 sessionTotals');
    assert.equal(snap.activeSession.sessionTotals.turns, 1);
    assert.equal(snap.activeSession.sessionTotals.calls, 2);
    assert.equal(snap.activeSession.sessionTotals.inputTokens, 5_556);
    assert.equal(snap.activeSession.sessionTotals.cacheTokens, 930_666);
    assert.equal(snap.activeSession.sessionTotals.outputTokens, 1_681);

    // 验证 recentSessions 列表返回可读标题
    assert.equal(snap.recentSessions.length, 2);
    const longMeta = snap.recentSessions.find(s => s.conversationId === convLongId);
    assert.match(longMeta.title, /写Skill实战教学五层拆解/);
  } finally {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('3. HTTP 服务与纯手写前端 UI 正常响应：单一大面板集成核心用量速览+生成速度+API汇总金额+热力图，且全仓零第三方署名/品牌残留', async () => {
  const { startTokenBarServer } = require('../src/server');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atb-http-'));
  const brainDir = path.join(tmpDir, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });

  const srv = await startTokenBarServer({
    port: 0,
    brainRootDir: brainDir,
    stateFilePath: path.join(tmpDir, 'state.json')
  });

  try {
    const resOverlay = await fetch(`http://127.0.0.1:${srv.port}/?mode=overlay`);
    assert.equal(resOverlay.status, 200);
    const html = await resOverlay.text();
    assert.match(html, /id="tb-strip"/, '缺少顶栏指标条 #tb-strip');
    assert.match(html, /id="tb-board"/, '缺少统一展开大面板 #tb-board');
    assert.match(html, /核心用量速览/, '大面板缺少核心用量速览卡片');
    assert.match(html, /最新生成速度与耗时/, '大面板缺少最新生成速度与耗时卡片');
    assert.match(html, /API 折算汇总金额/, '大面板缺少 API 折算汇总金额卡片');

    const resSnap = await fetch(`http://127.0.0.1:${srv.port}/api/snapshot`);
    assert.equal(resSnap.status, 200);
    const json = await resSnap.json();
    assert.equal(json.ok, true);
    assert.ok(json.freshLedger && json.fullLedger);

    // 全仓署名与外链纯净度校验：仅允许 pmlaowangba 自有署名与仓库链接，禁止任何外部署名、本地用户路径或硬编码密钥
    const repoRoot = path.resolve(__dirname, '..');
    const walk = dir => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === 'build') continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (/\.(js|html|css|swift|md|json|sh|plist)$/i.test(ent.name)) {
          const text = fs.readFileSync(full, 'utf8');
          const ghMatches = text.match(/github\.com\/([a-zA-Z0-9_.-]+)/gi) || [];
          for (const m of ghMatches) {
            assert.match(m, /^github\.com\/pmlaowangba-lab$/i, `发现非自有 GitHub 链接 (${m}): ${full}`);
          }
          if (ent.name !== 'token-bar.test.js') {
            assert.doesNotMatch(text, /\/Users\/[a-zA-Z0-9_-]+/, `发现硬编码本地用户路径: ${full}`);
          }
        }
      }
    };
    walk(repoRoot);
  } finally {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
