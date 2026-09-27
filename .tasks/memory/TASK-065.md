# TASK-065 · 持续助理会话读取最新个人记忆

日期：2026-09-27。Owner：`root-assistant-live-memory-10414-10414-10414`。关键词：Assistant、personal memory、Pi Session、source refresh、legacy snapshot、forget。实现与测试提交：`53786b6`。

入口：`packages/yuanpu-assistant/src/executor.ts` 在 Pi `transform_context` 请求级 hook 插入临时检索段；`packages/yuanpu-assistant/src/memory-documents.ts` 的 `personalPromptContext()` 选择 personal/local-user 有效文档；`apps/runtime/src/assistant-worker.ts` 在单写入 Worker 中提供当前记忆，并管理来源同步健康状态。Work 会话和专业子代理不使用这段记忆。TASK-050 的原红测在 `apps/runtime/test/task-050-memory-refresh-probe.mjs`，现纳入 Runtime 常规测试。

SOUL 与助理技能仍按 Session 冻结；USER/MEMORY 不再冻结进新快照。打开旧 v1 快照时，只保留原 SOUL 与技能表，原子写入 v2；分隔符有歧义时拒绝迁移并保留原文件。旧 Home 中没有文档登记的非默认 USER/MEMORY 文件保持原样、继续启动助理，但其正文不作为已核实事实注入；Worker 记录提示，模型请求获得待复核通知。

当前检索按版本、受众、来源有效性、依赖链与 7700 字符左右的预算筛选。来源刷新正在运行、事件队列或分页尚未排空时，来源支持的事实暂不进入请求；刷新与扫描重叠会补扫。若一篇正文曾依赖已撤销证据，即使存储记录仍 active，相同正文不进入当前检索段；改写为新正文后可重新进入，因此新正文仍须由上层审阅。请求构造中若工作区写入或来源扫描发生变化，最多重取三次，持续变化则返回空段。

验证：Node 24.15.0 / pnpm 11.22.0，`pnpm check` runner `1790471575716397000.log` exit 0；Assistant 聚焦测试 `1790471566742683000.log` exit 0；Worker 的刷新重叠、51 条事件和 101 条分页删除测试 `1790471355685923000.log` exit 0。真实 Worker/Pi 同会话纠正、重启与遗忘探针 `1790471132379238000.log` exit 0。复核者 `/root/task043_readonly_review` 对稳定实现 `53786b6` 做只读审查。

限制：遗忘不物理改写旧 Pi 聊天记录；检索段只代表当前事实。字面历史匹配能保守阻止旧正文回绕，但不能仅凭文本与引用判断任意同义改写是否仍包含已撤销事实，相关内容仍需人工或模型复核。真实企业微信、外部模型回答质量和其他平台属于 TASK-050 验收，不由本卡测试代替。若更改 Pi hook、来源分页协议或文档修订语义，重跑上述请求级和来源队列回归。
