# 按 Muse 参考框架交付 Yuanpu 聊天 UI（TASK-036）验收

2026-09-24，macOS arm64，Node 24.15.0，pnpm 11.22.0。实现提交 `49af3bd`（UI 主提交 `c151456`）。独立工作区为 `.worktrees/codex-ui`；隔离 Vite 地址 `http://127.0.0.1:5186/`。运行器使用 coding-owner worktree-kit，依赖/输出位于本工作区，复用 pnpm 缓存和已有离线模型元数据；无 Pi 上游改动。

| 环境与场景 | 操作和观测 | 结果 |
| --- | --- | --- |
| 浏览器 bridge fixture | 输入法组合 Enter 不提交；轮询断开后恢复原 run，提交次数不增加；保留下一条草稿 | PASS |
| 浏览器 bridge fixture | 授权绑定尚未就绪时按钮禁用；就绪后可授权，授权后运行未结束仍禁止发送；取消后的迟到轮询不复活任务 | PASS |
| 真实 Electron / Runtime + 受控本地模型服务 | 成功回复、HTTP 400 显示 failed 并保留输入、禁止重复提交、取消到达 cancelled；退出无残留 Runtime | PASS |
| 真实 Electron / Runtime + 已配置 LongCat-2.0 | 普通文本回复；搜索并调用受管 Python `yuanpu_approved_echo`，允许一次得到回显且只展示一个结果；第二次拒绝后 run failed，工具不再标 completed | PASS |
| 真实 Electron 管理数据 | 隔离目录创建并停用连接、预览/保存/停用计划，导航后可见真实状态；未连接企业微信或发送外部消息 | PASS |
| 1440×900 / 1280×800 / 1024×768 / 390×844 | 无横向溢出、输入栏可达；窄屏原生 dialog 打开、Escape 关闭并恢复触发按钮焦点 | PASS |
| 浏览器四个导航页面 | 聊天、技能、连接、定时任务页面 axe WCAG A/AA 均 0 violations / 0 incomplete | PASS |
| 原生 macOS 窗口 | Computer Use 观察到本卡 5186 页面、本地 Runtime 已连接及原生关闭/最小化/全屏按钮；标题栏留白与 CSS drag 区、按钮 no-drag 已实现 | PASS（原生控件观察；非截图像素测量） |

截图使用合成对话和隔离数据；CDP 图像包含网页内容，不包含原生交通灯。批准/拒绝图中的 opaque capability ID 是公开能力标识，非凭据。截图采用 DPR 1、顶部视口，不拉伸：[真实聊天 1440](live-chat-1440.png)、[1280](live-chat-1280.png)、[1024](live-chat-1024.png)、[390](live-chat-390.png)、[允许一次](live-approval-approved.png)、[拒绝](live-approval-denied.png)、[取消](fixture-cancelled.png)。

## 可复现命令

在项目要求的 Node 24 环境先安装并构建，启动隔离 Vite：

```sh
pnpm install --frozen-lockfile --ignore-pnpmfile
pnpm build
pnpm prepare:python-capabilities
pnpm --filter @yuanpu-agent/app dev --host 127.0.0.1 --port 5186 --strictPort
```

另一个终端执行：

```sh
TASK_036_RENDERER_URL=http://127.0.0.1:5186/ node apps/app/test/task-036-chat-probe.mjs
TASK_036_RENDERER_URL=http://127.0.0.1:5186/ node apps/desktop/test/task-036-ui-app-probe.mjs
TASK_036_LIVE=1 TASK_036_RENDERER_URL=http://127.0.0.1:5186/ node apps/desktop/test/task-036-ui-app-probe.mjs
node --test packages/yuanpu-runtime/test/pi.test.mjs
pnpm --filter @yuanpu-agent/app typecheck
pnpm --filter @yuanpu-agent/desktop test
pnpm check
```

浏览器探针需要已安装的 agent-browser。真实模型模式只读取本机既有模型配置，凭据通过既有环境变量传入，不打印、不写入证据；临时 YUANPU_HOME、工作区、userData 和数据库运行后删除。只发送合成提示词和调用无副作用回显。退出探针验证 Runtime 子进程清理。无模型环境时可跑 fixture，但不能声称真实模型验收。

## 证据与限制

- 本地 worktree-kit 记录（`.git/worktrees/codex-ui/coding-owner/`）：`1790216989408113000` 浏览器恢复；`1790217206296491000` 最终受控 Electron；`1790217204991895000` 最终真实模型；`1790216629055514000` Pi 错误回归；`1790216793562678000` desktop tests；`1790217077309831000` c151456 全量检查。最终两个 Electron 探针在 c151456 加本次适配层修正的工作树执行，代码随后提交为 49af3bd；不将旧树全量检查冒称为最终集成验证。
- 独立 reviewer 未执行；这是实施者的测试和代码复核。本卡不涉及授权契约或持久化格式修改。
- Windows/Linux 原生窗口、签名包、真实企业微信业务和系统通知验收不在本卡结果中。通知定位保留既有入口并增加错误重试；相关 desktop 原有测试纳入全量门禁。
- 后续若修改桥接契约、授权状态或 Pi 适配事件，重新运行相应探针。仅修改图片/记录不重复全量构建。

## 集成后验证

main `886f067`（实现代码与 `49af3bd` 一致）上 `pnpm check` PASS，记录 `.git/coding-owner/1790217363497491000.json`；主预览 5173 上浏览器恢复/授权/取消回归 PASS，记录 `1790217383483447000.json`。原工作区用户改动保留，环境自动写入的空 pnpmfileChecksum 已移除；这些用户文档差异不属于本卡源码。

## 输入区后续调整验证（2026-09-24）

在 main 工作树上完成两层输入布局。1440×900 与 390×844 实际浏览器截图无横向溢出，390 下输入区底边 776px 小于视口 844px；聚焦 textarea 的 outline 为 none，外框保留焦点样式。Shift+Enter 实测插入换行，Enter 发送后清空输入；已有 task-036-chat-probe 全部 PASS。两个视口 axe WCAG A/AA 均 0 violations / 0 incomplete；app typecheck 与 pnpm check PASS。此项为 TASK-036 完成后的布局微调工作树验证，未冒称原提交包含该变更。
