# TASK-008 交接

## 最终完成：2026-09-25

TASK-008 按用户最新范围在 `main` `fbe7c05` 完成。产品与三平台验收基线 `63d3a0e` 的签名能力制品 CI 36130278894、Desktop Bundle 36130303550 全绿，`fbe7c05` 只增当前技能页 UI 验收脚本/说明且 main CI 36133234455 全绿。最终提交的 macOS 隔离 Electron UI 脚本 `1790338186722009000.json` 完成搜索、信任安装、配置、审批允许/拒绝、坏签名保旧、重试升级、回滚、刷新持久化，并正常退出 Runtime。受控模型 fixture 与临时 Ed25519 开发根不等于真实在线提供商或正式签名发布；断网目标机与正式平台代码签名已由用户移出本卡验收。详情见 `verification/TASK-008/results.md` 顶部。本地 `.tasks` 被 Git 忽略，按用户决定未提交远端；下面旧阶段的 BLOCKED 叙述仅是历史记录。

TASK-008 在 revision `bc83168` 的结论是 **BLOCKED / NOT PASS**，不能宣称发布就绪。

本地 macOS arm64 已通过全仓检查、干净输出首次 SEA/冻结 Python smoke 和 Electron ZIP/DMG 打包。TASK-009 修复了首次冷启动超时，并固化 `tools/list` 挂起后的进程清理回归。完整命令、制品摘要和 S1–S7 矩阵见 `.tasks/verification/TASK-008/results.md`。

阻塞项不是本机源码构建失败，而是当前 revision 尚未推送，因而没有 Linux/Windows hosted-runner 与三平台离线证据；同时缺少生产 Ed25519、Apple Developer ID/公证和 Windows Authenticode 凭据。TASK-010 已补齐 macOS 真实 SEA 的下载、暂存、失败保旧与模拟重启激活回归，但 Linux/Windows 尚无运行结果，Runtime manifest 也仍需独立生产信任验证。

恢复本卡时必须使用同一待验 revision（或明确记录新 revision）取得真实 CI/签名/平台证据；不得引用旧提交的绿色运行，也不得把 workflow 矩阵声明或源码检查写成 PASS。

2026-09-24 复验补充：当前产品基线 `710a5e8` 的 Runtime Bundle 三平台均绿；仅含探针的 `46787b9` Desktop Bundle 中 macOS/Linux 打包资源无 Python PATH smoke 通过，Windows 探针因完全清空 PATH 导致 `taskkill` 不可用，正确能力输出后仍超时。已在本地将探针 Windows PATH 缩为 System32，尚未重跑 CI。完整矩阵和运行链接见结果文档。正式签名、三平台断网目标机安装、当前版完整 UI 旅程仍缺，状态维持 BLOCKED。注意卡约束禁止本轮自动提交/推送；`46787b9` 曾为触发 CI 被提交并推到专用分支，此后不再自动推送。
