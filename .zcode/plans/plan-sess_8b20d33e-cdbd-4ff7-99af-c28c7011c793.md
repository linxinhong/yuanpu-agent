# 工作对话右侧栏「文件预览」— 任务卡工作流

## 执行方式（按你的要求）

1. **architect 建卡**：调用 `architect` 技能，把下面的设计写成 `.tasks/` 中的开发任务卡（含验收标准与证据要求）。
2. **coding-owner 领卡**：调用 `coding-owner` 技能领取该卡，**在独立 git worktree**（`task/task-xxx-file-preview` 分支）中实现，完成后按卡内验收标准提交证据。

## 功能设计（已确认的范围）

在工作对话右侧活动面板加第三个 tab「文件」：

- **文件树**：懒加载当前工作会话 `workingDirectory` 的目录树，点击文件栏内预览。
- **聊天内路径可点击**：识别消息文本/codespan 中的文件路径，点击打开「文件」tab 并预览。
- **格式**：文本（行号、>256KB 截断）、Markdown（复用 `MessageContent`）、图片（base64）、PDF（新增 `pdfjs-dist`）；二进制/超限给明确提示。
- **链路**：protocol 类型/路由 + DesktopBridge → sidecar 路由（新模块 `apps/runtime/src/workspace-files.ts`）→ RuntimeManager/main.ts/preload 三处接线 → renderer 组件（`shared/work-file-tree.tsx`、`work-file-preview.tsx`、`work-file-pdf.tsx`、`work-file-utils.ts`）+ chat.tsx/message-content.tsx 集成。
- **安全**：渲染层只见 conversationId + 相对路径；sidecar 做 containment + realpath 符号链接逃逸校验。
- **测试**：runtime 单测（temp 目录）+ 路由测试、app 工具函数单测；theme-contract / composition-boundary 契约保持通过；最终 `pnpm check`。