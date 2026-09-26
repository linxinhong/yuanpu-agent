# 记忆工作评估与委派阶段验证（TASK-047）

状态：**阶段服务链与持久化场景通过；无已知本卡阻断。** 本记录只证明 macOS 本地 Runtime、独立 Assistant Worker、Pi 子任务与合成 loopback 模型的列明行为。没有使用真实用户 Home、真实凭据或企微外发；外部模型语义质量、真实桌面界面和企微建议投递仍未验证，留给后续 TASK-048/049/050。

## 基线与方法

- 独立验证者使用 `task/task-047-assistant-stage-verification`，初始产品基线 `4a1632d`。发现多回合修复误判后，产品所有者在另一分支修复 `aa40a49` 并合入 main；又因验收发现重启后 Worker 停机可卡住，产品所有者修复 `dc396ff`。最终产品复测基线 `5effa0b`。测试文件和证据是本卡增量，不把测试内模拟模型当真实模型观察。
- macOS arm64；Node 24.15.0、pnpm 11.22.0、uv。所有新增场景使用临时 `YUANPU_HOME`、合成工作目录、loopback OpenAI 兼容 SSE 服务，实际启动 `apps/runtime/dist/index.cjs --serve`、Assistant Worker 与独立 Pi 专业任务。仅观测临时 SQLite 和 Markdown 文件，未读取用户 Home。
- 命令通过 `worktree-kit.py --root .worktrees/assistant-stage-verification run --cwd . --label <label> --timeout <seconds> -- <command>` 执行；详细 runner 日志在本仓 `.git/worktrees/assistant-stage-verification/coding-owner/`，不提交原始运行状态。检索先用本 worktree 的 zvec 语义查询定位 `TASK-047`、来源与委派链，再用 scoped `rg` 和指定文件范围读取；未建立或刷新持久索引。

## 场景

| ID | 模式和预期 | 观察及判定 | 可复验入口 |
| --- | --- | --- | --- |
| V47-01 | **真实服务链 + loopback 模型**：用户要求精确写 `# Report`，Pi 首次成功写入错误内容；助理据真实来源评为部分完成，用户请求只读核验，专业子任务读授权来源；Work 修复后依据新成功 write 工具和产物来源结案。 | **PASS**：首次磁盘内容为 `# Incomplete`、持久 review 为 `partial`；助理获取真实候选并通过 Host 启动 `readOnly=true`、空能力清单的 `reviewer` 专业任务；子任务调用 `read_task_source`，结果进入 `delegation:` 来源且被下一版 Work review 消费，仍为 `partial`；第二轮磁盘内容与保存的 write 快照均为 `# Report`，新版 review 为 `supported`。旧版 `4a1632d` 同场景第二轮仍 `partial`；修复 `aa40a49` 后复测通过，并验证不能复用旧目标的旧证据。 | [真实服务链阶段测试](../../../apps/runtime/test/task-047-work-repair-stage.test.mjs)，`node --test` runner `1790457213615273000.log`；扩展断言后 54/54 聚焦 runner `1790457805645179000.log`。旧版对照 `1790456458818779000.log`。 |
| V47-02 | **实际持久文件和专属技能**：评估、来源、工作焦点与后续候选需落在助理 Home；默认技能专属；专业技能只在委派环境加载。 | **PASS**：临时 Home 的 `state.sqlite` 有 Work artifact、delegation 来源和 review material 版本；`reviews/<work>/<review>.md` 分别保留 partial/supported，`memory_documents.work-focus` 从 active 转 withdrawn。六项默认技能在 `assistant/skills`，工作环境提供的 `reviewer` 未进入助理技能目录。实际模型工具清单显示 Work 才有 `write`，专业任务只有来源读取等受限工具，后台 `review-work` 无写入或委派工具。 | 同 V47-01；`assistant-executor.test.mjs`、`assistant-delegation-local.test.mjs` 包含于 54/54 聚焦。 |
| V47-03 | **画像纠正、暂不可用和遗忘**：两处 Work 原话形成认识，用户纠正后旧事实不再出现在画像；暂不可用不误删，遗忘后重启和旧 feed 重放不复活。 | **PASS（真实持久层 + 合成来源 Host）**：两条独立 Work 来源支持“徒步”；单源暂不可用时 Markdown 保留；助理来源明确纠正为“绘画”后旧句被移除；`forget('user-interests')` 删除可检索文档并在 `forgotten_sources` 留三条屏蔽记录。关闭并重开真实 SQLite/Markdown 仓库、重扫同一旧 feed，旧画像和搜索结果均未复活。该场景绕过尚未由 TASK-049 交付的 UI 修改入口。 | [画像生命周期阶段测试](../../../packages/yuanpu-assistant/test/task-047-memory-lifecycle-stage.test.mjs)，54/54 聚焦 runner `1790457805645179000.log`。 |
| V47-04 | **恶意材料、身份和路径边界**：模型伪造认识或把他人引述当用户事实、跨受众来源读取、符号链接和专业子任务访问助理目录应拒绝。 | **PASS（针对性回归与只读检查）**：`user-understanding` 对伪造/凭据引述拒绝；`assistant-memory` 的跨受众查询为空；`assistant-executor` 拒绝 Work/project instructions、外链技能与 symlink，Pi Session 存储不被链接导出；`assistant-delegation-local` 校验仅选中技能、受限工具与任务授权，`assistant-delegation-service` 拒绝 symlink ledger 根。独立阶段服务链再确认实际工具面。不能以这些本地检查推断同 UID 恶意进程无法篡改整个 Home。 | 54/54 聚焦 runner `1790457805645179000.log`，相关测试名见上述文件。 |
| V47-05 | **重复、乱序、崩溃、预算与前台**：来源和委派状态重复/重启不重复执行，前台抢占与取消不晚提交，未知外部效果不自动重放。 | **PASS（故障回归）**：`assistant-automation` 覆盖来源去重、离线事件越过、Worker 崩溃后的单次入队、乱序委派状态、前台/取消/预算/unknown；`assistant-delegation-service` 覆盖同任务 ID、等待审批、签名授权、取消中的 unknown、关闭子进程；`assistant-memory` 覆盖 Markdown pending 写入恢复。V47-01 提交助理请求后不保持客户端订阅，后台仍完成只读核验和复审，证明本地界面断开不取消已接收任务。 | 54/54 聚焦 runner `1790457805645179000.log`；`assistant-channel-live.test.mjs` 复用断开/重连行为。 |
| V47-06 | **可替换来源与专业适配器**：Worker 只通过 opaque refs 和 Host 查询，受众及版本由宿主重验；专业结果只有来源归属关联，不能将模型自述等同业务完成。 | **PASS（契约范围）**：临时 Host 的 `opaque:` ref、不同 feed 和重启行为通过；真实 Runtime 来源适配器与委派替换适配器的现有测试通过。V47-01 中 `evidence_linked` 仅证明该任务返回了已授权来源，Work 是否完成仍由后一轮真实 write 工具结果和宿主登记的产物快照判定。跨网络同步并未实现或验证。 | `assistant-source-live.test.mjs`、`assistant-delegation-adapter-swap.test.mjs`、V47-01；聚焦 runner与全仓检查。 |
| V47-07 | **进程停机与全仓门禁**：Worker 崩溃后重启、查询 interrupted，再停机须有上界；本卡新增测试和已集成修复在 Node 24 下通过。 | **RETEST PASS**：验收将原测试的无限 HTTP 等待改为 Worker `model-request` 同步门槛后，确证第二 Worker 在收到 `shutdown` 后 10 秒仍不退出、stderr 为空，即使 Host 对来源与模型请求均即时回应。产品所有者以 `dc396ff` 增加 4 秒 Worker 停机硬上界（宿主已有 5 秒兜底），同一隔离测试在最终基线 4.6 秒完成，interrupted 记录正确。完整 `pnpm check` exit 0：Assistant 38/38、Runtime 118/118、runtime-kit 187/187，其他包也全绿。另修复 `builtin-workflows.test.mjs` 临时目录清理竞态，明确先 dispose 再 rm。 | 停机红证据 `1790458904005426000.log`，修复后 `1790459027715121000.log`；完整 `pnpm check` runner `1790459052722586000.log`，Node 24.15.0、pnpm 11.22.0、uv、基线 `5effa0b` 加本卡测试/证据增量，exit 0。首次环境失败 `1790457835742329000.log`、清理竞态 `1790457889010386000.log`。 |

## 边界

- **UNVERIFIED**：外部真实模型对多样工作成果的语义判断质量、费用和复杂长期画像。这里的 loopback 模型固定返回结构化提案；可靠结案判定来自代码对实际工具结果和宿主产物快照的校验。不能把一次固定提案推广为真实模型准确率。
- **UNVERIFIED／后续卡**：TASK-048 的主动回顾和可选企微建议，TASK-049 的真实桌面记忆纠正/遗忘 UI，TASK-050 的获授权真实企微与完整桌面业务旅程。本卡未发外部消息；工作对话没有在本次验证中展示建议。
- **来源生命周期交接**：当前没有用户界面发起的权威 Work 删除入口；原始来源 tombstone 的用户操作→Host→Worker 路径由 TASK-062 承担。V47-03 验证的是现有来源/文档遗忘契约，不声称该 UI 删除链已交付。
- **平台限制**：本机 macOS arm64 的 Node Runtime；Windows/Linux、SEA 组合和云端多实例同步没有在本卡重跑。TASK-046 已有本机 native smoke，但不能替代本卡未执行的平台验收。
