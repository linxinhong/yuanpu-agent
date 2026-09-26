# TASK-048 助理主动回顾与建议投递

- Keywords: `assistant`, `reflect-and-suggest`, `suggestions`, `inbox`, `wecom`, `idempotency`, `source-retraction`。
- Owner: `root-assistant-suggestions-048-10414-10414`；分支 `task/task-048-assistant-suggestions`；2026-09-27。状态和最终提交以 `.tasks/tasks.yaml` 为准。
- `packages/yuanpu-assistant/src/suggestions.ts` 在独立 Assistant Home 保存候选判断、建议、忽略/稍后/接受、暂停、已读及投递尝试。指纹覆盖上下文、正文和全部来源证据；来源撤回/版本变更删除过时建议与已解析提案，临时不可用暂停投递，候选文件读取错误保留持久状态并使当前操作失败。七日冷却、每日投递上限和稍后提醒的新投递键避免重复打扰。
- `reflect-and-suggest/SKILL.md` 由包内置资源装载。每日/每周检查只对新候选调用独立不落盘回顾会话；计费尝试与已解析提案可恢复，回顾原始对话不存档。工作对话不注入建议。
- Runtime Assistant Worker 处理收件箱和反馈；桌面、Runtime HTTP 使用同一服务接口。企微主动发送默认关闭，须在 `~/.yuanpu/assistant/config.json` 显式开启并存在已绑定私聊目标；宿主在发送前再次核对每条来源，保存接受、失败、未知投递回执。渠道接受不等于用户已读；未知投递不自动重放。App 停止时 Worker 及投递流程有界结束。
- 验证：`pnpm --filter @yuanpu-agent/assistant test` 通过（runner `1790462149257445000.log`）；真实 Assistant Worker 进程使用临时 Home、已配对私聊和可控 transport，确认一次发送及重启不重放（`1790461984779382000.log`）；最终 `pnpm check` 通过（`1790462201534629000.log`）；`pnpm build:native` 与 `pnpm smoke:native` 通过（`1790462159700842000.log`、`1790462171700887000.log`）。只读复核确认已修复短时文件读取、九条以上证据、上下文指纹、来源预检、持久提案和长时稍后边界，未发现剩余阻断。
- 边界：企微普通私聊真实往返已由此前独立验收确认；本卡主动建议发送用可控 transport 验证，未向真实测试账号主动推送。外部模型的建议质量、跨平台投递和云端运行留待后续验收。没有读取或提交用户真实 Assistant Home。
