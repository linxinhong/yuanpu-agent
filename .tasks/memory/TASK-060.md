# TASK-060 验收记忆

- 独立分支：`task/task-060-work-tree-acceptance`，基线 `81b475a`。仅在隔离 worktree 写测试与证据；没有修改产品代码或真实 `~/.yuanpu`。
- 真实 Electron + preload + Runtime + 本地 SSE fixture 的桌面探针：`apps/desktop/test/task-060-work-tree-app-probe.mjs`。Vite renderer 应先由独立进程在 `127.0.0.1:5179` 启动，脚本需 `TASK_060_RENDERER_URL=http://127.0.0.1:5179/`；使用 Node 24。
- 不加 `TASK_060_LEGACY`：三层文件夹/双会话、改名/图标/标签、磁盘搬迁、右侧文件预览、续聊、符号链接拒绝、标题/标签/正文搜索、归档恢复、重启历史及第三轮续聊、三主题通过。
- 加 `TASK_060_LEGACY=1`：重启前注入旧 `default` Pi JSONL/binding，Runtime `Work evidence is not bound to a local conversation.` 启动失败。父任务已将产品原因指向启动证据补扫与旧 binding 无 `yp_work_conversations` 行，分派 TASK-064 修复。验收报告需待修复 revision 复测再签收。
- `pnpm check` 在 Node 24 下通过。完整结果和截图见 `.tasks/verification/TASK-060/results.md`。
- Probe 的临时 Home 在退出时自动删除，截图仅含合成数据。右侧文件树的文件行使用固定 1440×900 下的坐标点击，这是桌面验收探针的脆弱点；后续若需长期 CI，应改为文件面板可定位的语义选择器。
