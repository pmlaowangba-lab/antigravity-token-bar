# 船板 user 层 · 页内账本看板

将 Token Bar 聚合看板嵌入 Antigravity 客户端（无独立 `AntigravityTokenBar.app` 悬浮窗）。

## 安装

1. 已安装船板 Antigravity 主题补丁（运行其目录下 `node install.mjs install`，见补丁包内 `SKILL.md`）。
2. 用本目录的 `custom.js`、`custom.css` **覆盖或合并**到：

   `~/.gemini/antigravity/theme-patch/user/`

3. 启动账本 API（页内 `fetch` 需要 CORS，见主仓 `src/server.js`）：

   ```bash
   node src/server.js
   ```

4. 保存后约 2.5 秒热重载；右上角停靠条点击打开大看板，遮罩或 `Esc` 关闭。

## 行为摘要

- 右上 `#ag-ledger-dock`：`tok/s · Ctx | 💰`；左键开大面板，右键 USD/CNY。
- 数据：实时指标与补丁内核 `#ag-live-metrics-pill` 同源；汇总走 `GET /api/snapshot`。
- 不启用内核 hover tooltip；点击后短时忽略遮罩误触关闭。