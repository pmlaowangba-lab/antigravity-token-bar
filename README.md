# Antigravity Token Bar

为 **Antigravity** 桌面端打造的轻量级顶栏实时会话指标与 API 折算成本看板。

**零侵入安全架构**：不修改 `Antigravity.app` 安装包（不注入 `app.asar`）、不探测内部调试端口、零第三方 npm 依赖，纯读取本地会话日志并挂载于 macOS 窗口标题栏与系统菜单栏。

## 核心能力

1. **顶部标题栏四合一实时胶囊条**
   - **上下文占用环**（`◔ 34%`）：实时读取当前会话未缓存输入 + 缓存读取占比
   - **输出速度**（`⚡ 26.8 tok/s`）：自动计算最近一次模型输出吞吐速度与总耗时
   - **累计 Token**（`📊 152.8M`）：实时汇总已记录的输入、缓存读取与输出总量
   - **API 折算金额**（`💰 $41.85 · 总$41.85`）：按主流模型分段官方 API 单价折算今日与累计花费，右键一键切换 `USD / CNY`

2. **单一聚合展开大看板**
   - **多窗口会话切换与防串台锁定**：面板顶部内置会话切换器，支持自动跟随最新对话（自动过滤系统重启广播）或一键锁定任意指定聊天窗口
   - **实时会话双卡并排**：`⭐ 核心用量速览`（对齐客户端 `512K` 自动压缩水位线、距压缩余量与单会话累计输入/缓存/输出对照）与 `⚡ 最新生成速度与耗时`（基于工具 `Created At` 剔除命令执行等待的精确端到端速度与本步输出）
   - **API 折算汇总金额卡**：展示今日汇总、本月汇总、累计总金额与**缓存命中净省金额**，支持「**仅算新账（自安装起算 · 无历史回溯）**」与「**全量历史 52 周回溯**」一键切换
   - **四周期 Token 统计 + 52 周活动热力图**：按天查看全年 Token 活跃度、单日费用拆分及多模型账单构成

3. **原生 macOS 贴顶悬浮体验**
   - 自动跟随 Antigravity 主窗口标题栏位置，切换全屏/桌面自动隐藏或跟随
   - 采用 `.floating` 窗口层级，绝不遮挡微信或 macOS 右上角系统通知横幅
   - 支持按住左侧 `⋮⋮` 手柄自由微调标题栏偏移并自动记忆位置

## 环境要求

- **Node.js** `>= 20.0.0`
- **macOS** `13.0+`（含 Xcode Command Line Tools `swiftc`，用于编译原生顶栏悬浮窗；仅使用网页看板则跨平台通用）

## 快速开始

### 方式一：启动 macOS 顶部标题栏悬浮条 + 菜单栏看板（推荐）

```bash
git clone https://github.com/pmlaowangba-lab/antigravity-token-bar.git
cd antigravity-token-bar
npm run macos:start
```

启动后：
- Antigravity 窗口右上角（`打开 IDE` 左侧）将自动贴顶展示实时指标条；
- macOS 顶部系统菜单栏将同步显示 `🪙 $今日金额 · 累计Token` 快捷入口；
- 点击顶栏任一指标即可展开完整聚合看板。

### 方式二：仅启动本地网页看板服务

```bash
npm start
```

浏览器访问 `http://127.0.0.1:19825/` 即可查看完整实时看板。

### 方式三：Antigravity 页内看板（船板 `user/` 改装层）

不启动 macOS 悬浮条时，可将看板嵌入客户端内嵌浏览器：

1. 启动 `npm start`（或 `node src/server.js`）。
2. 将 [`integrations/chuanban-page-ledger-board/`](integrations/chuanban-page-ledger-board/) 下的 `custom.js`、`custom.css` 复制到 `~/.gemini/antigravity/theme-patch/user/`。
3. 详见该目录 [README](integrations/chuanban-page-ledger-board/README.md)。

## 运行测试

```bash
npm test
```

## 目录结构

```text
antigravity-token-bar/
├── src/
│   ├── pricing-engine.js   # 模型分段费率表、缓存净省计算、无回溯聚合与 52 周日历矩阵
│   ├── log-scanner.js      # 本地会话 transcript.jsonl 增量解析与速度耗时采样
│   ├── server.js           # 纯 Node 内置模块 HTTP 服务 (127.0.0.1:19825)
│   └── web/                # 原生无依赖前端看板 (index.html / styles.css / app.js)
├── macos/
│   ├── TokenBarApp.swift   # macOS 原生 NSPanel + WKWebView 顶栏贴顶宿主
│   └── Info.plist          # 应用包配置
├── scripts/
│   ├── build-macos-app.sh  # 本地一键编译签名脚本
│   └── start-macos-bar.sh  # 一键编译并拉起顶栏悬浮窗
├── integrations/
│   └── chuanban-page-ledger-board/  # 船板 theme-patch user 层页内看板（custom.js / custom.css）
└── test/
    └── token-bar.test.js   # 计费精度、日志解析与安全合规单元测试
```

## License

MIT © 2026 pmlaowangba
