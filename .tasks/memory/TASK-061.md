# TASK-061 建立工作工具结果与产物的助理来源契约

- Owner：`root-assistant-artifacts-20260927-061-10414`；branch `task/task-061-assistant-artifact-sources`；worktree `.worktrees/assistant-artifacts`。核心提交 `a0438e4`，合入 TASK-051 为 `91e11ab`；路径安全复核后改为 write 内容快照，合入 TASK-055 v13 后以 v14 扩展。主线集成与卡状态尚待完成。

## 契约与实现

- 桌面 Work 运行成功时，`yp_agent_run_outputs` 持久保存有界的 Pi 工具结果（entryId、toolCallId、工具名、状态与 4K 文本），不再只存 `scheduler` 输出。Runtime 对成功 `write` 工具的入参内容进行字面路径校验并登记不超过 256 KiB/16 件的写入快照；不从模型正文猜文件，不打开可变的工作文件。`edit`、过大内容和缺失可信描述符的历史产物保持 `unavailable`。快照证明该内容交给成功的 write 工具，不证明当前磁盘文件仍在或内容未变。
- 宿主元数据迁移按 TASK-055 的 v13 工作会话树后接 v14 `yp_work_evidence_sources`。稳定来源 ID 使用 Pi Session/entryId，不含绝对路径；正文、工具结果、写入快照各有独立来源版本与不透明 contentRef。宿主读取重新核对受众、Work 绑定、成功 run、来源版本和对应持久输出。Worker 只通过 Host feed 获取内容，不访问 Work 路径或 Pi JSONL。
- Runtime 启动、Work 结算与周期扫描已保存 Pi branch。旧 Pi 工具结果只读补扫，无法确定的旧 write/edit 产物登记不可用占位。扫描与成功 run 结算交错时，旧未绑定工具结果/占位会提升为新事件 ID，不会把后来的可信来源锁死；游标与重启扫描幂等。显式删除 tombstone 优先于重扫创建，助理来源队列接 `work-evidence`/`work-deletions`。
- 旧 Pi JSONL 补扫仅接受 managed sessions 目录下非符号链接、普通、上限 32 MiB 的文件，先以带 `O_NOFOLLOW` 的 FD 读取再解析为内存 Pi branch；只有同 branch 中能配对 assistant toolCall ID/工具名的 toolResult 才可入源。文件不可信或超预算时不推断内容。助理产物读取以已结算宿主 `output_json` 快照为权威，不读工作文件或 Pi 路径。

## 验证与边界

- 临时 Home + 环回模型的真实 Runtime/Pi `write` 回合验证三类来源分别可读，Worker 持久入队、重启不重复及显式删除后撤回。拒绝测试覆盖错误受众、未知 ref、根外/绝对/遍历请求路径、超大/含 NUL 内容、Pi 会话文件/目录 symlink 与孤立工具结果；改动当前文件或将其换成 symlink 不影响历史写入快照。聚焦 runner：`1790446485810653000`（v13→v14 迁移/Work）、`1790446887004440000`（快照初版）、`1790447529979514000`（最终迁移/配对/来源测试 21/21）、`1790447752371688000`（Pi 根目录 symlink）。第一次并行全量运行 `1790447183524844000` 因运行中源码变更且 Runtime 子测试长时间未结束而主动终止，不作最终验收。最终 `pnpm check && pnpm build:native && pnpm smoke:native` 在 Node 24.15.0/pnpm 11.22.0/macOS arm64、提交 `64731c8` 上全过，runner `1790447641133747000`，changed_during_run=false；其后只新增上述回归测试与本证据，不改生产代码。
- TASK-055 v13 必须先于本卡 v14 进入主线并应用于真实用户库；本卡未访问真实 `~/.yuanpu`。TASK-062 负责用户界面的来源撤销操作；本卡仅实现可消费的宿主删除事件契约。平台原生行为目前仅在 macOS arm64 有待最后 smoke，Windows/Linux 未验证。
- 同机恶意进程若能同时篡改整个 `sessions` 根目录，Node 的常规路径 API 无法提供目录 FD 相对的原子遍历；当前静态 symlink 与文件 FD 无跟随检查不承诺防御这种同用户 Home 目录竞态。工作文件完全不读取，因此不受 Work 父目录 ABA 切换影响。超 32 MiB 的历史 Pi Session 只读补扫不可用，不宣称全量回填。
- 检索：本 host 无 zvec-grep 工具；基于已知 `AgentRunStore`、`SessionManager`、`RuntimeAssistantSourceHost`、`yp_work_turn_sources` 在 `apps/runtime`、`packages/yuanpu-runtime`、`packages/yuanpu-assistant` 和对应任务卡做限定 `rg`，未创建索引。
