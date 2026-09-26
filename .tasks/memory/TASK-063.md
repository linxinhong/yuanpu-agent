# TASK-063 内置浏览器标签与 agent 共享会话 — 任务记忆

## 来源修订
- 分支 `task/task-063-browser-tab`，实现提交 `ca03934`（基线领卡提交 `ce3a819`，含 TASK-052 合并后的 main）。
- 验证：worktree 内 `pnpm check` 全量通过；apps/app 38 测试（含 browser-state 3）、packages/yuanpu-runtime builtin-browser 3 测试。

## 架构与入口
- 渲染：renderer `<webview partition="persist:yuanpu-embedded-browser">`（apps/app/src/viewer/browser/browser-view.tsx），human 控制直驱 webview；main 侧 `apps/desktop/src/browser-guest-manager.ts` 管 guest 注册/CDP/崩溃。
- agent 链路：`builtin.host.browser` 能力源（packages/yuanpu-runtime/src/builtin/browser/source.ts）→ `BrowserControlClient`（builtin/browser/client.ts）→ main 回环服务（browser-control-service.ts，127.0.0.1 随机端口 + Bearer + 1MB 上限）→ `BrowserGuestManager.execute` → guest CDP/executeJavaScript。
- 引导：RuntimeManager launch 的 stdin JSON 增加 `browserControl: { port, token }`（main 在创建 RuntimeManager 前启动控制服务）。
- webview 安全：main.ts will-attach-webview 强制 guest sandbox/contextIsolation、剥 nodeintegration/disablewebsecurity/preload、仅 http(s) src；guest 弹窗 deny + shell.openExternal 转交系统浏览器；CDP 空闲 1.5s 释放（UAF 防护）。
- UI：FileWorkspace tab union 增加 browser tab；「+」为菜单（文件列表/浏览器）；tab 标题随页面 title；URL 按会话内存记忆。

## 可复用经验
- `.mjs` 测试不能有任何 TS 语法（含 `import type`/类型标注/`as` 断言）；`node:net` 的 `AddressInfo` 是类型不是运行时导出。
- shiki/monaco 教训沿用：沙箱网络对 models.dev 间歇放行，构建前先确认 packages/ai 数据目录完整（manifest 必须在 data/ 根而非 data/data/ 嵌套）。
- guest 崩溃自愈：renderer 以 webview generation 重建，重建前先 `browserDetachGuest` 让 main 侧 debugger 脱钩。

## 验证边界与未决
- Electron 真实交互（webview 渲染、agent 审批卡→执行→同一页面验证）待 `pnpm dev` 人工冒烟；自动化仅覆盖纯逻辑与 HTTP 层。
- browser_evaluate R3 审批后任意 JS 执行的风险边界（同 zcode）。
- follow-up：响应式视口、元素拾取、DevTools、录制、residency、Chrome 数据导入；diff 历史版本持久化。

## 主线集成候选
- 与主线 `84ec395` 的合并冲突集中在 `chat.tsx` 和 `file-tabs.tsx`：保留主线的工作面板标签、文件目录、图片预览，并增加浏览器标签。
- 浏览器标签切换后保持 webview 挂载；agent 请求会展开右侧栏并选中浏览器。增加 guest 所属窗口校验、非 http(s) 导航拦截，以及控制服务对 Origin 和 1 MiB 请求体的检查。
- 集成工作区以本地 Node 24.15.0 / pnpm 11.22.0 运行 `pnpm check` 通过；构建前复用本机已有的模型数据，避免访问 models.dev。真实 Electron 交互仍待验证，任务状态保持进行中。
