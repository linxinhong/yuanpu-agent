# TASK-052 工作对话右侧栏文件预览 — 任务记忆

## 来源修订
- 分支 `task/task-052-file-preview`，实现提交 `9e3717a`（基线领卡提交 `56c5a5f`）。
- 验证：worktree 内 `pnpm check` 全量通过（build + typecheck:yuanpu + 全部包测试；apps/app 14、apps/runtime 41、packages/yuanpu-runtime 165、apps/desktop 21 等）。

## 入口
- 协议：`packages/yuanpu-protocol/src/index.ts`（RUNTIME_ROUTES.workFiles / workFileContent；WorkFileEntry / WorkDirectoryListing / WorkFilePreview；DesktopBridge.listWorkFiles / readWorkFile）。
- runtime：`apps/runtime/src/workspace-files.ts`（listWorkspaceFiles / readWorkspaceFile / resolveWorkspacePath / isProbablyBinary / WorkspaceFileAccessError）；路由在 `apps/runtime/src/index.ts` 的 workConversations 与 desktopTranscript 之间；workspace root = `home.config.workingDirectory`，会话校验含 legacy `default`。
- desktop：runtime-manager `listWorkFiles` / `readWorkFile`；IPC `work:files:list` / `work:files:read`。
- app：`shared/work-file-tree.tsx`（懒加载树）、`shared/work-file-preview.tsx`、`shared/work-file-pdf.tsx`（pdfjs-dist 6，worker 用 `?url` 导入）、`shared/work-file-utils.ts`；chat.tsx 第三个「文件」tab + `openWorkspaceFile`；message-content.tsx `onOpenFilePath`（仅 work surface 传入）。

## 可复用经验
- config.json 实际位于 `${YUANPU_HOME}/app/config.json`（appPath=root/app）；不写它时 workingDirectory 默认 homedir()，路由测试必须显式指向临时工作区。
- worktree 构建：`scripts/hydrate-pi-model-data.mjs` 需要 models.dev 网络；复制主检出 `packages/ai/src/providers/data/`（gitignore 的构建数据）后可离线构建。
- pdfjs-dist v6 的 `destroy()` 在 loading task（getDocument 返回值）上，不在 PDFDocumentProxy 上。
- renderer 全程不持绝对路径；路径安全在 sidecar：相对路径 + `..` 段拒绝 + 绝对路径拒绝 + realpath 复验 containment。

## 验证边界与未决
- 未做真实 UI 手工验收（无桌面环境交互）：文件树/预览交互需在 `pnpm dev` 冒烟确认。
- PDF >20MB 按卡内升级条件降级为 unsupported 提示；分段按需加载留待后续。
- HEAD 上所有 Work 会话共享 `home.config.workingDirectory`；主检出未提交改动正引入每会话独立 working_directory，集成时路由应改为优先取会话行的工作目录（transcript 路由已有同样 fallback 模式可对照）。

## 集成阻塞（截至本记忆）
- main 检出存在未提交改动，且与本项目修改文件重叠（chat.tsx、protocol/index.ts、runtime/index.ts、desktop 三件、muse-theme.css、assistant-reply.tsx、pnpm-lock.yaml）。git 拒绝在受影响文件本地修改时合并；不代用户提交或 stash。需用户处置未提交工作后再并入。

## 2026-09-26 模块化重构（应用户要求）

- 放弃独立 `packages/yuanpu-viewer` 包方案（用户改为 app 内组织）：查看器代码迁入 `apps/app/src/viewer/`，按 `core/`（内容类型判定与格式化）、`files/`（目录树）、`preview/`（文本/Markdown/图片/PDF）、`browser/`（预留，见其 README）、`host/`（`ViewerFileHost` 接缝）分模块，模块图见 `apps/app/src/viewer/README.md`。
- 职责边界（用户确认）：viewer=查看器组件与内容适配；apps/app 其余=面板布局、拖宽、打开哪个视图、会话关联；apps/desktop（含其管理的 sidecar）=实际文件读写与系统能力。viewer 组件不触碰 `window.yuanpu`，chat.tsx 用桥+会话 ID 实现 host。
- 会话关联修正：chat.tsx 给 `FileTree` 加 `key={workConversationId}`，切换/新建会话时文件树展开状态随预览一并重置（补齐验收项）。
- 聊天内路径链接工具更名 `shared/work-file-links.ts`（extract/split/normalize）；`classifyWorkFile`/格式化函数迁入 `viewer/core/`；`message-content.tsx` 只改导入。样式仍全部在 `muse-theme.css`（theme-contract 继续覆盖）。
- 验证：pnpm check 全过（app 15 测试）、vite 构建含 pdf worker、浏览器冒烟（work 文件页签空态正常、助理面板无文件入口）。
- 测试限制：`viewer/preview/*` 无法被 node:test（tsx）加载——pdf worker 的 `?url` 导入是 Vite 专有转换；viewer-modules.test.mjs 只覆盖 core/files，preview 行为靠构建与桌面冒烟。

## 2026-09-27 库选型与标签页/工具栏设计（4e82a70）

- 深度调研了 ~/projects/deepseek-harness（dsh）的同类实现（右侧栏文件树 + 文档预览 tab）并吸收其经验；用户据调研拍板：文本/代码用 **shiki**（弃 Monaco——oniguruma wasm 触发渲染进程 CSP `script-src 'self'` 禁 unsafe-eval，故用 shiki 的 **JS 正则引擎** + 懒加载语法包 + github-light/dark 双主题单例），目录树用 **@pierre/trees**，新增 **@pierre/diffs** 查看修改替换效果。zcode 本身用 @pierre/diffs 的 File 组件 + shiki（wasm 引擎）+ 自研 Markdown 渲染 + pdf.js。
- 标签页/工具栏按用户提供的「审查」参考图实现：胶囊标签条（树 tab + 每个文件一个可关 tab，「+」重开树）；每视图一条工具栏——文件：左「最终内容｜替换效果」切换 + `+N -N` 统计（绿/红），右「定位到树 / 复制路径 / 刷新」；树：左「工作区 · N 个文件」，右「刷新」。
- 替换效果链路：内存版本缓存（per conversation+path，上限 200 条）→ 重新读取时对比 content/updatedAt → 检测到修改自动切到 diff 视图；diff 由自研 `createUnifiedDiff`（前缀/后缀裁剪 + LCS + 上下文行 + 区域/产出行双护栏）生成统一 patch 交给 `PatchDiff` 渲染。diff 与最终内容两个视图可选手动切换，未变更的 refetch 不打扰当前视图。
- runtime 递归列举（`recursive=1`）：flat entries + `MAX_TREE_ENTRIES=5000` 截断标记、符号链接逃逸跳过、realpath 访问集切环、深度上限；供 @pierre/trees 的路径优先数据模型。
- 测试 24/24（app）+ 11/11（runtime 相关）+ 全量 pnpm check 通过；浏览器冒烟截图验证树/标签条/高亮/diff。修复：shiki 双主题并发取色竞态（改串行）、LCS 重放需三态步骤（match/remove/insert，布尔编码会把匹配行错标为删除）。
- 已知限制/后续候选：diff 仅对比「上次查看」版本（无磁盘历史）；PDF 视口附近渲染、tab 滚动位置恢复、树懒加载（dsh 式 per-level 状态机 + generation 防陈旧）未做；preview/* 不能进 node:test（shadow DOM 库依赖浏览器）。
