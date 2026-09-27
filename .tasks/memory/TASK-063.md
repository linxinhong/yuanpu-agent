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

## 2026-09-27 浏览器部分主线集成验证
- 集成分支 `codex/browser-tab-integration` 保留主线 FileWorkspace、工作区文件树与图片标签，仅增加浏览器标签及共享 guest 控制链路。
- 修复两处端到端测试发现的问题：`RuntimeManager` 构造时保存控制端点并交给 Runtime；`BrowserView` 在 guest 已附着或 React StrictMode effect 重放时补做注册。首次地址导航固定 `src=about:blank`，避免重复加载干扰历史。
- `apps/desktop/test/task-063-browser-app-probe.mjs` 用临时 Home 和独立 Electron/Vite 实例实测地址栏导航、标签切换保持 guest、页面链接、前进后退、Agent 经 `search_capabilities`/`execute_capability` 调用 `browser_navigate` 驱动同一个 guest；结果通过，guest ID 保持一致。
- 在同步后的主线基底上 `pnpm check` 通过，真实 Electron probe 再次通过。其它 TASK-063 验收项仍按任务卡继续验证。

## 2026-09-27 完整验收与内置技能
- 检索：Pi `DefaultResourceLoader.additionalSkillPaths` 与 Electron Runtime 启动路径由工作区检索定位；随后以 scoped `rg`/文件范围确认实际调用链。内置 `browser-control` 源文件位于 `apps/app/src/skills/browser-control/SKILL.md`，开发态由 `RuntimeManager` 传入源目录，打包态通过 `extraResources` 进入 `resources/app/skills`。只在 Work Pi 会话中加载；隔离 Electron probe 已确认 Pi 系统提示包含该技能。
- 真实 Electron/Vite + 临时 Home + 本地 OpenAI 兼容 fixture：工作右侧栏「+」打开浏览器，地址导航、慢加载/失败提示、前进后退、刷新、系统浏览器交接、弹窗限制、面板拖宽、标签切换保留 guest、关闭重开按会话恢复 URL 均通过。
- 同一 Work 会话的 `search_capabilities` → `execute_capability` 驱动既有 guest 导航；`browser_screenshot` 返回真实 PNG 图像内容并传给支持图像的模型。发现隐藏 webview 的 CDP 截图会超时，现先请求激活共享标签、等待绘制后截图；隔离探针从文件标签触发截图成功。R2 `browser_click`、R3 `browser_evaluate` 均出现真实审批卡，拒绝后页面计数保持 0。
- `getLastWebPreferences()` 在真实 guest 上确认 sandbox/contextIsolation 开、nodeIntegration 关、webSecurity 未关、无 preload；页面内 `process`/`require` 不存在。HTTP 弹窗被拦截并转交系统浏览器，file 弹窗未转交。CDP `Page.crash` 后 guest 重建且恢复 URL；在另一未激活 Work 会话执行 `browser_snapshot` 返回明确缺少浏览器错误，未影响活跃 guest。
- 修复错误态：Electron `did-fail-load` 的字段可直接位于 event，且 `loadURL` 可直接 reject；两条路径现在都呈现失败原因。`pnpm check` 与 `node apps/desktop/test/task-063-browser-app-probe.mjs` 在 Node 24.15.0、macOS arm64 通过。浏览器控制服务的 Bearer/Origin/体积限制和能力风险级由仓库单测覆盖。
- 边界：本次没有构建 SEA/安装包，Windows/Linux 与签名发布未验证。浏览器能力当前限 Work，会话外的助理不加载此技能。
