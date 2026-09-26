# TASK-059 工作树界面实施证据

- 环境：macOS、Node 24.15.0、pnpm 11.22.0；隔离 Git worktree `task/task-059-work-tree-ui`，临时 `YUANPU_HOME`，真实 Runtime/SQLite/Pi JSONL。未访问真实用户库。
- `pnpm check`：早期实现一次通过。最终代码的两次并发全量检查均通过构建/类型检查和本卡测试，但 Runtime 各有一项既有测试在清理临时 Home 的 `assistant/` 时触发 `ENOTEMPTY`（分别为 `workspace-file-routes.test.mjs` 与 `runtime.test.mjs`）。前者单独通过；随后以 `node --test --test-concurrency=1 'test/*.test.mjs'` 重跑 Runtime 全集，117/117 通过。并发清理竞态未在本卡修改。
- `apps/app/test/work-tree-model.test.mjs`：树深度、祖先路径、循环防护与隐藏归档节点下的可见顺序重排通过。
- `apps/runtime/test/task-059-work-navigation-guard.test.mjs`：模拟重载后仍持久存在的等待审批 Work run。切换、新建、归档、已归档预览均返回 409；结束后预览不改变当前会话、普通切换恢复。覆盖 DesktopBridge 显式 `previewArchived:false`。
- Playwright 浏览器旅程接真实 Runtime 路由：新建两层文件夹与会话、重命名、图标、多标签、Pi JSONL 消息搜索并以 entryId 定位、物理移动、归档恢复、55 条搜索结果分页，全部通过。桌面 preload 在浏览器中由同签名 bridge 适配器代替；右侧文件树读数为 fixture，真实桌面整体验收仍属 TASK-060。
- [浅色](tree-light.png)、[深色](tree-dark.png)、[MindLink](tree-mindlink.png)、[窄窗口展开树](tree-narrow.png)和[窄窗口收起树](tree-narrow-closed.png)截图均取自临时 Home 的虚构会话及文件夹数据；右侧预览的文件读取在此截图阶段由 bridge fixture 代替。1440px 宽时工作树为 300px；810px 时左树覆盖正文，点击顶部“收起工作列表”后正文输入宽度超过 300px，并仍能操作右侧文件栏。
- 未验证：Windows/Linux、打包 SEA/Electron、真实用户数据、大型历史下的交互延迟；TASK-060 仍需实际桌面走查。
