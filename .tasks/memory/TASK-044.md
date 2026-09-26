# TASK-044 助理工作审阅

- 关键词：独立助理、工作审阅、来源版本、工具结果、产物快照、待核实、前台抢占、费用、来源撤销。
- 实现：`packages/yuanpu-assistant/src/work-review.ts` 在助理私有 `state.sqlite` 管理审阅记录及 Markdown 写入意图；输出位于 `~/.yuanpu/assistant/reviews/<work-id>/<review-id>.md`。`apps/runtime/src/assistant-automation-handler.ts` 消费 TASK-051 的 `review-work` job，`apps/runtime/src/assistant-worker.ts` 调用独立 Session 的 `review-work` 技能。该 Session 只加载审阅技能，没有委派工具；Work 页不插入建议。
- 来源：只消费 TASK-043/061 经宿主验证后进入助理来源仓库的 Work 回合、工具结果和成功写入快照。快照按 work ID、受众、来源 ID/版本绑定并限量；材料缺失、截断、版本改变或撤销不作为完成证据。重复事件由既有 job 去重，审阅自身不生成 Work 来源事件。
- 判定：模型仅提出 JSON 候选；宿主核对引用和当前来源版本。`supported` 限于一条用户字面指令 `Write exactly [literal] to [path].`（实际指令中 literal 与 path 分别用反引号括起），且成功 `write` 工具结果与宿主校验过的产物快照同源、路径和全文均严格相等。普通成功写入只支持 `partial`，模型自述不能证明业务完成；失败工具且没有后续成功结果才可给出 `failed`，其他情况 `unverified`。此窄规则故意不宣称已自动理解任意业务验收条件。
- 恢复：模型调用紧前写 attempt，成功提案先持久保存，再经 Engine 费用、时限、前台及来源版本门禁原子提交审阅与 checkpoint。模型结果丢失时不重做已可能计费的回合，原 job 写可见 `unverified`；已存提案而材料变化同样降为 `unverified`，新来源版本可触发新评估。Markdown 文件由持久写入意图恢复。临时不可用使 API 与 Markdown 结论降为待核实，恢复后回到原有判断；来源删除／换版本撤销正文与候选，即使文件曾被人工编辑也覆盖撤销文本。
- 安全：解析限制字段长度与引用，模型文本折叠为单行并在保存提案、审阅 JSON 与 Markdown 前脱敏常见凭据；来源快照是数据，不是指令。该文本脱敏是纵深防护，不能替代来源访问控制；本卡未给审阅授权执行、外发或自动提交记忆／台账修订。
- 验证：Node 24.15.0 / pnpm 11.22.0，聚焦构建、类型检查与测试通过，runner `1790451138658097000.log`；完整 `pnpm check` 通过，runner `1790451166255743000.log`，`changed_during_run=false`；`pnpm build:native && pnpm smoke:native` 通过，runner `1790451229715325000.log`，`changed_during_run=false`。真实 Worker + loopback 模型证明审阅技能、工具/产物配对与独立写入；未调用真实外部模型或用户工作任务，也未验证 Windows/Linux 与云端运行。
