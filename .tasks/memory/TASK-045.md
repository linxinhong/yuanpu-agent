# TASK-045 用户理解与自动工作整理

- 关键词：独立助理、用户原话、来源版本、纠正、临时不可用、英文专题、工作台账、承诺、待核验、委派结果。
- 实现：`packages/yuanpu-assistant/src/user-understanding.ts` 将独立助理 Session 提出的短候选原话绑定个人来源与版本，Work 中的稳定认识需跨两个不同 Work 重复；助理私聊中的直接陈述可进入专题。纠正按来源事件顺序撤销旧主张，遗忘／删除会清除候选与衍生笔记，暂不可用的既有主张逐条保留且可被明确纠正。短期状态有七天时效。`USER.md`／`MEMORY.md` 是有预算的摘要，细节存 `memories/user/*.md` 等英文路径；人工编辑优先。
- 工作：`work-organization.ts` 从当前审阅重建项目、上下文、待关注事项、单一主记录承诺与私有待跟进候选。摘要最多引用十二个近期项目，但全量活跃项目继续维护各自承诺与跟进；成功工具步骤本身不结案。候选经 `assistant_work_candidates` 给独立助理，助理可按需用现有 `delegate_and_verify` 对选定来源发起只读专业委派。委派结果以独立来源触发原 Work 再审阅，重启后可补偿；没有自动向 Work 对话或外部渠道发送建议。
- 技能：四份专属 `SKILL.md`（understand-user、maintain-memory、organize-work、follow-up）随包发布到独立 assistant Home。understand-user 在自动化隔离 Session 中执行；其余技能为助理会话可发现的操作指引，自动维护与组织的落盘由确定性 Worker 逻辑执行，follow-up 当前只形成候选。专业技能只在普通委派任务环境加载。
- 检索：当前宿主未暴露 zvec-grep 工具；按已知 TASK-045 卡片、源码路径及符号使用局部 `rg` 与定点文件阅读。
- 验证：Node 24.15.0 / pnpm 11.22.0。最终聚焦 assistant 构建／测试与 runtime 类型检查通过，runner `1790455229366555000.log`；真实 Worker + loopback 模型覆盖用户理解、工作审阅与委派完成事件后的复审，runner `1790455049417020000.log`。Runtime 子进程退出后清理的聚焦测试通过，runner `1790455374673505000.log`。最终完整 `pnpm check` 通过，runner `1790455563397250000.log`，`changed_during_run=false`；最终原生构建与烟测通过，runner `1790455622612548000.log`，`changed_during_run=false`。独立只读复核确认台账截断、按主张保留暂不可用认识和引用归属的可复现阻断已关闭；归属判断仍是保守启发式。集成后证据待补。
- 边界：真实企业微信私聊收发已在 TASK-042 单独验收；本卡未调用真实外部模型，也未在生产入口跑通“候选→助理实际发起委派→结果复审”的全旅程，不能把 loopback fixture 当业务完成。Windows/Linux 与云端运行未验证；TASK-047 负责独立业务验证，TASK-048 负责建议收件箱与主动投递。
