# viewer — 内容查看与交互模块

`apps/app/src/viewer/` 承载右侧面板里的内容查看器：文件树、各内容类型预览，以及后续的内置浏览器视图。它只负责查看器组件、内部交互和内容类型适配；面板布局、打开哪个视图、与会话的关联由上层（modules/chat 等）决定，宿主能力通过 `host/` 接缝注入。

## 模块

| 目录 | 职责 |
| --- | --- |
| `core/` | 视图类型、内容类型判定（`classifyWorkFile`）、展示格式化；随浏览器视图加入注册与状态恢复 |
| `files/` | 目录树浏览（懒加载、展开状态、选中联动） |
| `preview/` | 文本（行号/截断）、Markdown、图片、PDF（pdf.js 分批渲染）的只读预览 |
| `browser/` | 预留：地址栏、导航与浏览器状态 UI；原生实例由宿主提供 |
| `host/` | 宿主接口（`ViewerFileHost` 等）。实现方在 viewer 之外 |

## 职责边界

| 位置 | 职责 |
| --- | --- |
| `app/src/viewer/` | 查看器组件、内部交互、不同内容类型的适配 |
| `apps/app` 其余部分 | 右侧面板布局、拖拽比例、打开哪个视图、会话关联（conversationId → host 实现） |
| `apps/desktop`（含其管理的 runtime sidecar） | 实际文件读写（containment/realpath 校验在 sidecar）、创建 Electron 浏览器视图、系统能力 |

## 接缝约定

- viewer 组件不直接触碰 `window.yuanpu`、Electron 或存储布局，只消费 `host/` 中的接口。当前 `modules/chat.tsx` 用桌面桥 + 会话 ID 实现 `ViewerFileHost`。
- 数据契约类型沿用 `@yuanpu-agent/protocol`（`WorkFileEntry` / `WorkDirectoryListing` / `WorkFilePreview`），保持协议单一来源。
- 后续浏览器视图：界面与控制协议放在 `browser/`，宿主（apps/desktop）提供原生浏览器实例并实现控制接口；浏览器 MCP 复用同一浏览器会话。某模块需要独立复用或发布时，再从目录平移为 `packages/yuanpu-viewer`。
