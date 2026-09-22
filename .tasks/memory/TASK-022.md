# 试点 Jev 辅助验收证据核验（TASK-022）

- 关键词：Jev、证据核验、数据最小化、Choice、人工复核
- Owner：`sol-owner-task-022`
- 记录日期：2026-09-22
- 分支：`task/task-022-jev-evidence-review`
- 来源 revision：`d355ea8`
- 测试 revision：实现提交后更新；当前为工作区实现

## 交付入口

- `scripts/verification/jev-evidence-review.mjs`：默认 dry-run 的只读 CLI；导出校验、精确检查、出站净化、API 调用和指标函数。
- `scripts/verification/fixtures/jev-evidence-cases.json`：24 个虚构人工标注样例，tuning/holdout 各 12 个。
- `scripts/verification/jev-evidence-review.test.mjs`：字段拒绝、精确检查、API 故障和人工回退测试。
- `.tasks/verification/TASK-022/results.md`：运行边界、实测结果和当前采用结论。

## 决策与陷阱

- 只允许 `dataClassification=synthetic`；真实项目摘要仍需另行授权，不能通过修改输入字段绕过。
- 出站对象只有替换 case ID、验收短句、摘要和枚举事件；revision、platform、mode、command 及证据映射留在本地。
- Jev 真实调用固定一次请求、无重试、默认 15 秒超时；无密钥、超时、429、响应错误全部生成逐例人工复核待办。
- 模型将部分 `insufficient` 判断为 `contradicted`，三分类边界仍需调校；关键反例没有错误 `supported`。
- 没有真人同样本耗时与漏检基线，因此采用结论必须保持 `do_not_adopt`。

## 验证

- Node 24.15.0；`node --test scripts/verification/jev-evidence-review.test.mjs` 通过。
- `pnpm check` 通过；最终提交纳入根测试命令后需再跑一次。
- 真实虚构数据调用：Jev 1.13.0，24 例，1452 ms，输入 5699 tokens，输出 1199 tokens，估算 USD 0.00023936。
- ZG 不可用；scoped `rg` 覆盖 scripts、Node test 惯例与 TASK-014/019/021/022，官方文档通过实时 HTTPS 读取。

## 未完成与下一步

- 真实人工基线耗时、辅助审阅耗时及人工漏检数未验证；由真人在相同 24 例上计时后再评估是否试用。
- 集成者应在 main 合入后重跑 `pnpm check`；当前不自动 merge 或 complete。
