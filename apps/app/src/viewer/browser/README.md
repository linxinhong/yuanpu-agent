# browser/ — 内置浏览器视图（预留）

规划中的查看器模块：地址栏、导航历史与浏览器状态 UI。界面和控制协议放在本模块；原生浏览器实例由宿主（apps/desktop，Electron `WebContentsView`）提供，viewer 通过 `host/` 接口使用，不直接绑定 Electron 窗口。浏览器 MCP 调用宿主的浏览器控制接口，与 viewer 共用同一浏览器会话。

在浏览器视图立项前，本目录只保留约定，不放实现。
