# 工作会话文件夹树桌面业务验收（TASK-060）

## 环境与边界

- 独立验收分支 `task/task-060-work-tree-acceptance`，最初基线 `81b475a`（TASK-059 后）；旧会话修复由 main 集成 revision `e368b7e` 提供，并以等价的 cherry-pick `73c4a20` / `3b33cb9` 在本验收 worktree 复测。macOS，Node 24.15.0，pnpm 11.22.0。验收者未参与 TASK-055/056/057/059/064 的产品实现。
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
| A60-07 | 初始基线：旧 `default` Pi binding 导致 Runtime 在启动证据补扫时异常退出。TASK-064 修复后：同一临时 Home 场景重启正常，归档树显示“旧工作（只读）”，点击后显示旧 Pi 用户与助理消息，输入框禁用；与新 Work 历史隔离。 | **pass（复测）** | `electron-legacy-readonly.png`，Pi JSONL 可发现/可读断言，IPC/UI 断言 |
| A60-08 | 键盘 F2 重命名已覆盖；方向键导航、Escape 取消、拖拽排序、任意多层项目大规模数据、Windows/Linux、打包 SEA 均未在本轮桌面流程验证。 | unverified | 范围限制；后端相应安全/故障场景见 TASK-058 |

## A60-07 初始失败、修复与复测

1. 使用隔离 `YUANPU_HOME` 真正启动 Electron，创建至少一个正常 Work 会话并退出。
2. 用 `SessionManager.create(workspace, join(home,'agent','sessions'), { id:'legacy-pi-session' })` 创建旧 Pi JSONL，追加一条用户和一条完整的助理消息，使 Pi 将会话落盘；断言 `findById` 可发现文件及 `readYuanpuChatTranscript` 包含旧消息。
3. 按 `packages/yuanpu-runtime/test/work-conversation.test.mjs` 的旧数据形状，仅向 `yp_conversation_bindings` 插入 `conversation_id='default'`、`pi_session_id='legacy-pi-session'`、`workspace_id=workspace`，没有 `yp_work_conversations` 行。
4. 重启 Electron。最初在基线 `81b475a` 上，含旧 binding 时 Runtime 健康检查前失败；无旧 binding 时，核心场景通过。

原启动栈：`apps/runtime/dist/index.cjs:4141:64 UCn.recordToolResults` → `:5065:11291 L` → `:5065:11411 HDn`；主进程报告 `Runtime exited before becoming healthy (code=1): Work evidence is not bound to a local conversation.` 根因是启动证据补扫遍历旧 `default` binding，但旧会话没有 `yp_work_conversations` 行。TASK-064 修复让精确绑定的本地旧会话通过此检查。

在首次复测时，验收 fixture 只有用户消息，Pi `SessionManager` 尚未写 JSONL，导致旧 transcript 为空；这是 fixture 失误而非产品回归。补上完整助理消息后，修复 revision `3b33cb9`（等价于主线 `e368b7e` 的 TASK-064 产品改动）重新构建 `packages/yuanpu-runtime` **及** `apps/runtime`，真实 Electron 命令 `TASK_060_LEGACY=1 TASK_060_RENDERER_URL=http://127.0.0.1:5179/ node apps/desktop/test/task-060-work-tree-app-probe.mjs` 通过。最终截图可见旧问答和只读输入提示。验收者没有修改产品实现。

## 命令与结论

| 命令 | 结果 |
| --- | --- |
| `TASK_060_RENDERER_URL=http://127.0.0.1:5179/ node apps/desktop/test/task-060-work-tree-app-probe.mjs`（Node 24） | pass，真实 Electron/Runtime 核心流程、重启、三主题，本地 SSE 模型 5 次请求含后台标题请求 |
| 同命令加 `TASK_060_LEGACY=1`，TASK-064 修复与正确 fixture 后 | pass，A60-07 真实 Electron 旧历史/只读验证通过 |
| `pnpm check`（Node 24，初始验收基线） | pass；构建、TypeScript 与全仓测试完成；`apps/runtime` 123/123、`apps/desktop` 21/21。 |
| `pnpm check`（Node 24，修复版 `3b33cb9`） | pass；构建、TypeScript 与全仓测试完成；`apps/runtime` 124/124。 |

总体结论：TASK-064 修复后，TASK-060 要求的主要桌面业务路径通过，包括旧 `default` 的归档只读历史。A60-08 所列扩展场景仍未验证，不纳入本次桌面验收保证。
