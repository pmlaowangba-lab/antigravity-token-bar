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
    assert.equal(snap.activeSession.contextLimit, 512_000, 'Carbon 压缩水位线应对齐精确十进制 512,000 (512k)');
    assert.equal(Math.round(snap.activeSession.usedPercent), 70);
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

test('4. 默认优先锁定用户最近提问窗口（防后台 Agent 抢焦点导致 31% vs 59% 不一致）、512k 水位线精确到 59%/212k，且全界面展示缓存命中率', async () => {
  const { startTokenBarServer } = require('../src/server');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atb-align-'));
  const brainDir = path.join(tmpDir, 'brain');

  const convUserActiveId = '11111111-aaaa-4111-8111-111111111111';
  const convBgAgentId = '22222222-bbbb-4222-8222-222222222222';
  const convUserDir = path.join(brainDir, convUserActiveId, '.system_generated', 'logs');
  const convBgDir = path.join(brainDir, convBgAgentId, '.system_generated', 'logs');
  fs.mkdirSync(convUserDir, { recursive: true });
  fs.mkdirSync(convBgDir, { recursive: true });

  // 会话 1：用户刚刚在 12:10:00 亲自发消息的当前窗口（300,046 / 512,000 = 58.6% -> 59%，余 211,954 ≈ 212k）
  fs.writeFileSync(
    path.join(convUserDir, 'transcript.jsonl'),
    [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-11-18T12:10:00.000Z',
        content: '<USER_REQUEST>\n当前正在看的窗口\n</USER_REQUEST><USER_SETTINGS_CHANGE>Model Selection to Gemini 4 Carbon (Medium).</USER_SETTINGS_CHANGE>'
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-18T12:10:01.000Z',
        input_tokens: 60_046,
        cache_read_tokens: 240_000,
        output_tokens: 800
      }),
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        created_at: '2026-11-18T12:10:36.000Z',
        content: 'Created At: 2026-11-18T20:10:11+08:00\nCompleted At: 2026-11-18T20:10:36+08:00\nok'
      }),
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-18T12:10:37.000Z',
        input_tokens: 60_046,
        cache_read_tokens: 240_000,
        output_tokens: 981
      })
    ].join('\n') + '\n'
  );

  // 会话 2：用户早在 12:00:00 提问、但后台 Agent 在 12:11:13 自动跑工具的后台会话（160,000 / 512,000 = 31.3%）
  fs.writeFileSync(
    path.join(convBgDir, 'transcript.jsonl'),
    [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-11-18T12:00:00.000Z',
        content: '<USER_REQUEST>十多分钟前丢在后台的任务</USER_REQUEST>'
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-18T12:11:13.000Z',
        input_tokens: 10_000,
        cache_read_tokens: 150_000,
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
    // 不传 convId 时，必须自动对齐用户最近亲自发消息的会话 1（59%），绝不被后台自动跑步骤的会话 2（31%）抢焦点！
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/snapshot`);
    assert.equal(res.status, 200);
    const snap = await res.json();

    assert.equal(snap.activeSession.conversationId, convUserActiveId, '默认应锁定用户最近发消息的活跃窗口');
    assert.equal(snap.activeSession.contextUsed, 300_046);
    assert.equal(snap.activeSession.contextLimit, 512_000);
    assert.equal(Math.round(snap.activeSession.usedPercent), 59, '顶栏四舍五入百分比必须为 59%');
    assert.equal(Math.round(snap.activeSession.remainingTokens / 1000), 212, '距压缩余量必须为 212k');
    assert.equal(snap.activeSession.sessionTotals.cacheHitRate, 80, '单会话缓存命中率计算准确');

    // 验证 HTML 顶栏、核心用量速览与四张周期卡片均包含缓存命中率节点
    const html = await (await fetch(`http://127.0.0.1:${srv.port}/`)).text();
    assert.match(html, /id="tb-btn-cache"/, '顶栏缺少缓存命中率胶囊 #tb-btn-cache');
    assert.match(html, /id="tb-ctx-cache-rate"/, '核心用量速览缺少缓存命中率格 #tb-ctx-cache-rate');
    assert.match(html, /id="tb-tok-today-cache"/, '今日 Token 卡片缺少缓存命中率节点 #tb-tok-today-cache');
    assert.match(html, /id="tb-tok-total-cache"/, '累计 Token 卡片缺少缓存命中率节点 #tb-tok-total-cache');
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

test('5. 船板页内停靠条（方案 A · 单行精简微条）：去硬棕框与钱袋 Emoji、单行不换行、去除 Ctx 进度条与 Claude 额度', () => {
  const dir = path.resolve(__dirname, '../integrations/chuanban-page-ledger-board');
  const css = fs.readFileSync(path.join(dir, 'custom.css'), 'utf8');
  const js = fs.readFileSync(path.join(dir, 'custom.js'), 'utf8');

  // JS 语法合法
  assert.doesNotThrow(() => new Function(js), 'custom.js 存在语法错误');

  // CSS：方案 A 明暗主题变量与去扁平粗黑覆盖
  assert.match(css, /--ag-dock-bg:/, 'custom.css 应定义方案 A 停靠条背景变量 --ag-dock-bg');
  assert.match(css, /--ag-dock-track:/, 'custom.css 应定义方案 A 进度条底槽变量 --ag-dock-track');
  assert.doesNotMatch(css, /border:\s*1\.5px\s+solid\s+#9f4a2c/i, '应移除旧版硬棕边框');
  assert.doesNotMatch(css, /#ag-ledger-dock\s*\*\s*\{[^}]*color:\s*#111111\s*!important/i, '应移除全黑强制覆盖以建立视觉层级');
  assert.match(css, /\.ag-dock-top\b/, '缺少单行容器 .ag-dock-top');
  assert.match(css, /#ag-ledger-dock\s*\{[^}]*flex-direction:\s*row/i, '停靠条应为单行横向布局');
  assert.match(css, /\.ag-dock-qgroup\b/, '缺少配额独立分组 .ag-dock-qgroup');

  // JS：停靠条去钱袋 Emoji、去 Ctx 进度条、过滤 Claude/GPT 额度、时间精简
  assert.doesNotMatch(js, /topCostLabel:\s*['"]💰/, '停靠条初始费用文案不应再使用钱袋 Emoji');
  assert.doesNotMatch(js, /state\.topCostLabel\s*=\s*`💰/, '停靠条费用文案不应再拼接钱袋 Emoji');
  assert.doesNotMatch(js, /ag-dock-ctx-track/, '停靠条应已删除 Ctx 进度条');
  assert.match(js, /ag-dock-speed/, '停靠条指标区应渲染结构化速度节点');
  assert.match(js, /ag-dock-qgroup/, '停靠条配额区应按模型组渲染独立分组节点');
  assert.match(js, /dockGroups\s*=\s*groups\.filter/, '停靠条应过滤掉 Claude/GPT 额度');
  assert.match(js, /\$\{days\}d\$\{hours\}h/, '停靠条重置时间应使用精简 d/h/m 格式');
  assert.match(js, /data-tone=/, '停靠条配额与上下文应输出语义 data-tone');
});

test('6. 页内看板小弹窗（套件 3 · 暖金陶土工作室）：胶囊单行不换行、全功能交互、原始 5 层顺序与暖陶色系', () => {
  const dir = path.resolve(__dirname, '../integrations/chuanban-page-ledger-board');
  const css = fs.readFileSync(path.join(dir, 'custom.css'), 'utf8');
  const js = fs.readFileSync(path.join(dir, 'custom.js'), 'utf8');

  assert.doesNotThrow(() => new Function(js), 'custom.js 存在语法错误');

  // 顶部胶囊单行不换行 + 暖陶色系与 Hero 横幅变量
  assert.match(css, /\.ag-dock-top\s*\{[^}]*flex-wrap:\s*nowrap/i, '顶部胶囊行必须禁止换行');
  assert.match(css, /#ag-ledger-dock-quota\s*\{[^}]*flex-wrap:\s*nowrap/i, '顶部胶囊配额区必须禁止换行');
  assert.match(css, /--ag-ledger-hero-bg:/, '缺少套件 3 暖金陶土费用 Hero 渐变变量 --ag-ledger-hero-bg');
  assert.match(css, /#ag-ledger-board\s*\{[^}]*width:\s*min\(840px/i, '看板应为 840px 级紧凑小弹窗');
  assert.match(css, /#ag-ledger-board\s*\{[^}]*overflow:\s*hidden/i, '小弹窗不应出现上下滚动条');
  assert.doesNotMatch(css, /#ag-ledger-board\s*\{[^}]*bottom:\s*16px/i, '不应再铺满全屏高度');

  // 保持原始 5 层顺序 + 完整字段 + 交互控件（锁会话 / 热力图悬浮提示 / 模型构成条件显示切换）
  const idxQuota = js.indexOf('id="ag-ledger-quota"');
  const idxSession = js.indexOf('id="ag-ledger-session-pair"');
  const idxToday = js.indexOf('id="ag-ledger-today"');
  const idxPeriod = js.indexOf('id="ag-ledger-period"');
  const idxActivity = js.indexOf('id="ag-ledger-activity"');
  assert.ok(idxQuota > 0 && idxQuota < idxSession && idxSession < idxToday && idxToday < idxPeriod && idxPeriod < idxActivity, '模块顺序必须严格保持：额度 → 会话/速度 → 今日折算 → 周期汇总 → 热力图');
  assert.match(js, /5小时剩余[\s\S]*周额度剩余[\s\S]*5小时重置[\s\S]*周额度重置/, '额度卡 4 个字段必须完整保留');
  assert.match(js, /缓存命中率/, '今日指标必须保留缓存命中率字段');
  assert.match(js, /ag-ledger-btn-pin/, '顶栏应提供自动跟随/锁定本路会话交互按钮');
  assert.match(js, /ag-ledger-heat-tip/, '热力图应支持悬浮显示当日明细');
  assert.match(css, /#ag-ledger-dock\s*\{[^}]*left:\s*50%/i, '顶部胶囊应居中显示避免遮挡右侧按钮');
  assert.doesNotMatch(js, /ag-dock-ccy-btn|ag-dock-toggle-btn/, '顶部胶囊不应渲染右侧 CNY 和展开按钮');
  assert.match(css, /\.ag-ledger-stack-bar\b/, '缺少 Token 堆叠占比条样式 .ag-ledger-stack-bar');
  assert.doesNotMatch(js, /⭐|⚡|💰/, '看板内应彻底移除 ⭐ / ⚡ / 💰 Emoji');
});
