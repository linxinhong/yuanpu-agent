# 工作会话文件夹树桌面业务验收（TASK-060）

## 环境与边界

- 独立验收分支 `task/task-060-work-tree-acceptance`，基线 `81b475a`（TASK-059 后）。macOS，Node 24.15.0，pnpm 11.22.0。验收者未参与 TASK-055/056/057/059 的产品实现。
- `apps/desktop/test/task-060-work-tree-app-probe.mjs` 真正启动隔离 Electron 主进程、preload、Runtime sidecar 与 Vite renderer，通过 Electron CDP 对 UI 执行操作。配置和 SQLite/Pi JSONL/工作文件都写在 `mkdtemp` 的临时 `YUANPU_HOME`，执行后删除。模型端为本地确定性 SSE fixture，不访问外网、不使用真实用户 Home。
- 证据截图在 `screenshots/`，全由虚构的 Acme、Roadmap、Priority、preview.txt 等数据产生。后台 TASK-058 的 Runtime HTTP/SQLite/Pi JSONL 故障测试作为补充，但本报告的 UI 结果来自真实 Electron，不以浏览器预览代替桌面验收。
- 本宿主没有可调用的 zvec-grep 工具；从任务卡给出的 `docs/work-conversation-tree.md`、v003 原型与 TASK-058 证据定点阅读，再用 scoped `rg` 查 UI 和 Runtime 契约；未建立或刷新持久索引。

## 场景结果

| ID | 观察 | 状态 | 证据 |
| --- | --- | --- | --- |
| A60-01 | Electron 工作树 UI 新建 `Acme/Platform/Milestones` 三层文件夹与两个会话；F2 将首会话改名 Roadmap，设置星形图标与 Priority 标签。 | pass | `tree-created-light.png`，脚本 SQLite/API 断言 |
| A60-02 | 从三层文件夹将 Roadmap 移至 Acme，原 cwd 消失，新 cwd 下 `preview.txt` 保留。SQLite 会话 cwd、Pi binding cwd 和 JSONL header 均与新路径一致。右侧文件树可打开文件并预览正文；搬迁后继续第二轮模型回复，保留第一轮历史。 | pass | `electron-moved.png`、`electron-files-open.png`、`electron-file-preview.png` |
| A60-03 | 将会话源目录放入指向根外的符号链接后，UI 移动被拒并显示错误；原 cwd 与文件未改变。 | pass | `electron-move-rejected.png`，脚本磁盘断言 |
| A60-04 | 在 Electron 工作树搜索 Roadmap、Priority 和第一轮消息，分别出现标题、标签、消息结果；归档后出现在“已归档”树，恢复后返回活动树。 | pass | `electron-message-search.png`，脚本 UI/API 断言 |
| A60-05 | 关闭并重启 Electron/Runtime，Roadmap 的目录、标题、星形图标、标签及两轮历史保留。第三轮从 UI 发送后，本地模型请求含搬迁前后历史消息；Pi JSONL 与 SQLite binding 保持同一 session。 | pass | `electron-restarted.png`，脚本模型请求和本地文件断言 |
| A60-06 | 浅色、深色、MindLink 三主题均通过设置页按钮切换，`data-yuanpu-theme` 与所选一致，返回工作页后工作树仍呈现。 | pass | `electron-theme-yuanpu-light.png`、`electron-theme-yuanpu-dark.png`、`electron-theme-mindlink.png` |
| A60-07 | 将旧版 `default` Pi 会话按现有 Runtime 单元测试的 binding 格式注入临时 Home 后重启，Runtime 在健康检查前以 `Work evidence is not bound to a local conversation.` 退出，Electron 页面无法加载。因此旧会话只读展示及历史未能进行桌面验收。 | **fail（阻塞）** | 下述可复现步骤与启动栈；TASK-064 修复中，待新 revision 复测 |
| A60-08 | 键盘 F2 重命名已覆盖；方向键导航、Escape 取消、拖拽排序、任意多层项目大规模数据、Windows/Linux、打包 SEA 均未在本轮桌面流程验证。 | unverified | 范围限制；后端相应安全/故障场景见 TASK-058 |

## A60-07 最小复现与原因

1. 使用隔离 `YUANPU_HOME` 真正启动 Electron，创建至少一个正常 Work 会话并退出。
2. 用 `SessionManager.create(workspace, join(home,'agent','sessions'), { id:'legacy-pi-session' })` 创建旧 Pi JSONL，追加一条用户消息。
3. 按 `packages/yuanpu-runtime/test/work-conversation.test.mjs` 的旧数据形状，仅向 `yp_conversation_bindings` 插入 `conversation_id='default'`、`pi_session_id='legacy-pi-session'`、`workspace_id=workspace`，没有 `yp_work_conversations` 行。
4. 重启 Electron。`TASK_060_LEGACY=1 TASK_060_RENDERER_URL=http://127.0.0.1:5179/ node apps/desktop/test/task-060-work-tree-app-probe.mjs` 在本基线稳定失败；同一脚本不设置 `TASK_060_LEGACY` 时，核心场景通过。

启动栈：`apps/runtime/dist/index.cjs:4141:64 UCn.recordToolResults` → `:5065:11291 L` → `:5065:11411 HDn`；主进程报告 `Runtime exited before becoming healthy (code=1): Work evidence is not bound to a local conversation.` 根因由主代理定位为启动时的证据补扫遍历旧 `default` binding，而 `WorkEvidenceStore.recordToolResults` 只接受连接到 `yp_work_conversations` 的新 Work 会话。TASK-064 专项修复已分派。本验收分支没有修改生产代码。

## 命令与结论

| 命令 | 结果 |
| --- | --- |
| `TASK_060_RENDERER_URL=http://127.0.0.1:5179/ node apps/desktop/test/task-060-work-tree-app-probe.mjs`（Node 24） | pass，真实 Electron/Runtime 核心流程、重启、三主题，本地 SSE 模型 5 次请求含后台标题请求 |
| 同命令加 `TASK_060_LEGACY=1` | fail，A60-07 Runtime 启动异常，可重复 |
| `pnpm check`（Node 24） | pass；构建、TypeScript 与全仓测试完成；`apps/runtime` 123/123、`apps/desktop` 21/21。当前自动化单元测试尚未覆盖 A60-07 的真实启动链。 |

总体结论：新式工作会话的主要桌面业务路径通过；旧 `default` 用户数据会阻止 Runtime 启动，**TASK-060 暂不能签收**。待 TASK-064 集成后，在修复 revision 上重跑 legacy Electron 路径，再更新本报告结论。
