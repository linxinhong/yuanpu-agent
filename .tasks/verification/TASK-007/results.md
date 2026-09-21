# TASK-007 验证结果

- 基线 revision：`5deefc8caafc6148e11ffa6d7f59091cf9d879f7` 加本卡未提交实现
- 环境：macOS 26.5.2 arm64；Node 24.15.0；pnpm 11.22.0
- 真实界面：Electron 43.7.3，通过 CDP 9333 操作；renderer 为本地 Vite，Runtime 为真实独立进程
- catalog：本地 `@yuanpu-agent/catalog-server`，制品为真实 PyInstaller onedir tar.gz
- 用户数据：隔离的临时 `YUANPU_HOME`；仅复制现有模型配置用于真实对话，证据不包含密钥
- 检索：当前 host 未提供 zvec-grep，使用 scoped `rg`；未创建或重建索引

| 场景 | 操作与观察 | 结果 |
| --- | --- | --- |
| S7-SEARCH | 技能页从 catalog 搜索 Python 示例能力，显示发布者、版本、权限；安装前出现信任确认 | PASS |
| S7-INSTALL | 从 catalog 下载、验签、解包并健康检查 0.1.0，立即激活；renderer 刷新后仍显示已安装 | PASS |
| S7-ALLOW | 真实 LongCat 对话请求 `yuanpu_approved_echo`；点击“允许一次”后仅执行一次并返回 `TASK007-ALLOW` | PASS |
| S7-DENY | 新审批点击拒绝，回到对话并显示拒绝结果，能力未执行 | PASS |
| S7-REFRESH | 审批待定时刷新 renderer，Runtime 持久记录恢复相同审批卡 | PASS |
| S7-UPDATE-FAIL | 0.2.0 使用另一测试签名；Runtime 拒绝，0.1.0 保持活动，界面显示当前版本与重试 | PASS |
| S7-ROLLBACK | 加载匹配测试信任根后升级到 0.2.0；已安装页显示历史版本，点击后回滚至 0.1.0 | PASS |
| S7-DEDUP | 安装/回滚/审批进行时相关按钮禁用；审批后端的一次消费及重放拒绝由 runtime 测试覆盖 | PASS |
| S7-CONFLICT | UI 检测已启用 `pi-mcp-adapter` 后要求明确选择；取消不变更，选择 Yuanpu 仅停用旧 adapter；配置保留由 runtime 回归测试覆盖 | PASS |
| IPC-TRUST | Electron 所有 invoke handler 校验发送 webContents 与主 frame，preload 只暴露窄方法 | PASS（静态检查 + typecheck） |

证据：`.tasks/ui/task-007-skill-ui/images/`。其中信任、安装、审批、刷新、失败恢复和回滚均来自真实 Electron，不是浏览器 mock。

## 命令

- `PATH=/Users/linxinhong/.nvm/versions/node/v24.15.0/bin:$PATH pnpm check` — PASS
- `YUANPU_CAPABILITY_VERSION=0.2.0 pnpm build:python-artifact` — PASS
- PyInstaller 制品 `--version` 健康检查 — PASS；入口先处理版本参数，不再加载完整 MCP 栈
- `agent-browser --session task007-yuanpu --cdp 9333 ...` — PASS，完成上述真实桌面旅程

## 边界

本卡只证明 macOS arm64 的界面与真实后端链路。Linux/Windows、系统签名提示、正式发布密钥和三平台离线制品证据仍为 `UNVERIFIED`，由 TASK-008 汇总；不得据此宣称生产发布就绪。
