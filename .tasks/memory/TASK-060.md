# TASK-060 验收记忆

- 独立分支：`task/task-060-work-tree-acceptance`，基线 `81b475a`。仅在隔离 worktree 写测试与证据；没有修改产品代码或真实 `~/.yuanpu`。
- 真实 Electron + preload + Runtime + 本地 SSE fixture 的桌面探针：`apps/desktop/test/task-060-work-tree-app-probe.mjs`。Vite renderer 应先由独立进程在 `127.0.0.1:5179` 启动，脚本需 `TASK_060_RENDERER_URL=http://127.0.0.1:5179/`；使用 Node 24。
- 不加 `TASK_060_LEGACY`：三层文件夹/双会话、改名/图标/标签、磁盘搬迁、右侧文件预览、续聊、符号链接拒绝、标题/标签/正文搜索、归档恢复、重启历史及第三轮续聊、三主题通过。
- 初始基线加 `TASK_060_LEGACY=1` 时，旧 `default` binding 触发 Runtime 启动证据补扫失败；TASK-064 由其他代理修复。将修复 cherry-pick 到本分支（`73c4a20` / `3b33cb9`），正确构建 package + app Runtime 后，隔离 Electron 复测通过：旧历史可见、只读输入生效。早期仅有用户消息的 fixture 未生成 Pi JSONL，已补完整助理消息并加入发现/读取断言。
- 修复前后 `pnpm check` 均在 Node 24 下通过，修复版 `apps/runtime` 124/124。完整结果和截图见 `.tasks/verification/TASK-060/results.md`。
- Probe 的临时 Home 在退出时自动删除，截图仅含合成数据。右侧文件树的文件行使用固定 1440×900 下的坐标点击，这是桌面验收探针的脆弱点；后续若需长期 CI，应改为文件面板可定位的语义选择器。
