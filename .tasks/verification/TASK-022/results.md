# 试点 Jev 辅助验收证据核验（TASK-022）

## 边界

- 数据集全部为人工编写的虚构内容，仅使用替换 ID；未发送源码、原始日志、聊天、数据库、真实身份、凭据或本机路径。
- 精确检查先验证 evidence ID 关联所需的 revision、platform、fixture/real mode 和 command exit code；语义判断不能覆盖这些失败。
- `supported` 仅表示所给摘要支持验收短句，不证明原始事实真实，不授权业务动作或任务状态变更。
- 默认命令为 dry-run。真实 API 必须显式提供 `--live --confirm-synthetic`，最多一次有界请求且无自动重试。

## 数据集

固定数据集含 24 个虚构人工标注样例，tuning 与 holdout 各 12 个，覆盖 supported、contradicted、insufficient。反例包括 build 冒充验收、旧 revision、缺平台、fixture 冒充真实、submitted 冒充已读、delivery unknown、跨 session、重复执行和摘要内提示注入。

## 可复现命令

```sh
node scripts/verification/jev-evidence-review.mjs \
  --input scripts/verification/fixtures/jev-evidence-cases.json

node scripts/verification/jev-evidence-review.mjs \
  --input scripts/verification/fixtures/jev-evidence-cases.json \
  --fixture \
  --output .tasks/verification/TASK-022/offline-fixture.json
```

真实 API 评估另加 `--live --confirm-synthetic`。人工基线必须由真人对相同样本实测，并用 `--human-baseline-ms`、`--assisted-review-ms` 和 `--human-false-supported` 记录；不得由模型生成。

## 结果

在 Node 24.15.0 上，字段拒绝、精确检查、密钥隔离、无密钥、超时、429、无重试、错误响应和低置信度回退的离线测试通过。dry-run 和离线 fixture 运行成功。

一次有界真实 API 调用只发送上述 24 个虚构样例：实际模型 `jev-1.13.0`，端到端 1452 ms，输入 5699 tokens、输出 1199 tokens，按当日官方输入单价估算费用 USD 0.00023936。模型没有把任何 contradicted/insufficient 样例错判为 supported，固定留出集关键反例的错误 supported 为 0。它将 7 个标注为 insufficient 的范围不足样例判为 contradicted，说明三分类边界仍需调校；这不影响“关键反例不得标为 supported”的本次安全门槛，但不能据此宣称整体准确率合格。

真人对相同样本的基线耗时、辅助审阅耗时和人工漏检数尚未取得，均保持 `unverified`。因此当前采用建议为 `do_not_adopt`，不能声称已经提速或未增加人工漏检。完整逐例结果和混淆矩阵见 `live-synthetic.json`；离线结果见 `offline-fixture.json`。

## 检索

当前宿主没有可用的 ZG 工具；使用 scoped `rg` 检查 `scripts/`、Node test 惯例和 TASK-014/019/021/TASK-022 精确路径。TypeSafe API、Choice、confidence、models 与 citation-check 格式来自 2026-09-22 实时官方文档。
