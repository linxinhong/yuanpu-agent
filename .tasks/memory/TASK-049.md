# TASK-049 助理记忆、工作评估与任务界面

- Keywords: `assistant workspace`, `memory correction`, `work review`, `delegation`, `preload`, `source navigation`。
- Owner: `root-assistant-ui-049-10414`；分支 `task/task-049-assistant-ui`；2026-09-27。实现和测试源修订 `bc89d1f`；最终状态以 `.tasks/tasks.yaml` 为准。
- `packages/yuanpu-assistant/src/workspace.ts` 从独立 Assistant Home 构造个人快照，并在 Worker 单写入队列中提交版本化纠正、遗忘、旧收藏显式导入与自动整理暂停。来源同步只统计 `personal/local-user`；旧认识、评估和专业任务可继续加载。工作页面没有建议入口。
- Runtime Worker、HTTP、DesktopBridge 和现有助理四页签接通同一服务。任务详情显示评估来源、子代理执行与证据关联记录；工作来源可以跳转原会话。专业任务追问通过 Host 持久请求 ID 去重；丢失响应后同内容重试不重复执行，未知结果不自动重放。
- 验证：真实 Worker 与 Runtime HTTP 聚焦测试通过（runner `1790464894926691000.log`），`pnpm check` 通过（`1790465110862907000.log`），原生构建与 smoke 通过（`1790465018088663000.log`、`1790465029136612000.log`）。浏览器可控适配器的点击、刷新、断线、窄屏与 axe 记录见 `docs/frontend/evidence/task-049/results.md`；截图仅虚构资料，不是 Electron 或真实用户资料验收。
- 边界：已配对测试账号的普通企业微信私聊真实往返由用户确认收到“收到”；主动建议真实送达、模型质量和真实桌面整套交互仍由 TASK-050 验收。用户撤销来源到宿主权威 tombstone 的操作由 TASK-062 实现；本卡的“遗忘”只处理助理记忆文档及派生关系，不等于删除原始 Work/Pi 记录。
- 检索：宿主未提供 zvec-grep；按已知入口用 scoped `rg` 定位协议、Worker/HTTP、桌面桥接、助理界面和源存储，未建立索引。
