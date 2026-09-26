# TASK-064 旧 default 工作会话证据补扫

- 2026-09-27；owner `legacy-work-repair-sol-10677`；branch `task/task-064-legacy-work-evidence`，worktree `/Users/linxinhong/.codex/worktrees/legacy-work-repair/yuanpu-agent`。基线 `c1b0891`，实现及测试提交 `89d2e64`；主线集成与 TASK-060 隔离 Electron 验收待主代理执行。
- 关键词：legacy default、Pi JSONL、WorkEvidenceStore、desktop binding、启动补扫、幂等。

## 入口与结论

- `apps/runtime/src/index.ts` 的 `scanSavedWorkTurns` 在启动时读取 `WorkConversationStore.listExisting`，该列表能从精确 `yp_conversation_bindings` 显示只读 `default`，但旧会话没有 `yp_work_conversations` 行。此前 `WorkEvidenceStore.recordToolResults` 和 `recordUnverifiedArtifacts` 的内连接会抛错，阻断 Runtime ready。
- `packages/yuanpu-runtime/src/persistence/work-evidence-store.ts` 统一核对绑定：`desktop/local-desktop/local-user`、`desktop` namespace、空 thread、精确 conversation/Pi session；旧 `default` 仅允许没有新 Work 行的绑定，新 Work 则要求 Work 行的 Pi session 与工作目录匹配绑定。来源读取再次核对相同条件。成功 run 的产物登记也采用该守卫。
- 旧 Pi toolResult 仍需同一 branch 的 assistant toolCall ID 与工具名配对；历史 write/edit 无可信描述符时只登记 unavailable，不读取可变工作文件。旧会话不转换为新 Work 行，也不开放选择、执行或写入。

## 验证与后续

- `packages/yuanpu-runtime/test/work-evidence.test.mjs` 覆盖精确旧绑定成功、重复扫描、错误 entry point/身份/namespace/thread/Pi session、无绑定、来源失权。`apps/runtime/test/legacy-work-evidence-startup.test.mjs` 在临时 Home 用真实 SessionManager JSONL 验证 Runtime 两次启动、只读旧历史、工具结果与 unavailable 产物补扫幂等、JSONL 原样保留且无 `default` 新 Work 行。
- Node 24.15.0 / pnpm 11.22.0 / macOS arm64：聚焦两测试通过；`pnpm check` 通过，Runtime 125/125，runtime-kit 189/189。runner 日志 `1790466605417341000.log`，提交前受测树的代码即 `89d2e64`。未运行 native/Electron 与 Windows/Linux；TASK-060 负责隔离 Electron 复测。
- 首次 `pnpm build:pi` 因 models.dev 连接超时失败；从主 checkout 复制已生成且被忽略的 `packages/ai/src/providers/data` 到本 worktree 后，`pnpm build` 与 `pnpm check` 均通过。未修改 Pi 上游源码或真实用户 Home。
- 检索：本 host 未提供 zvec-grep 工具；依据已知 `WorkEvidenceStore`、`scanSavedWorkTurns`、`default` 做 `packages/yuanpu-runtime` 与 `apps/runtime` 范围的精确 `rg`，再读取指定源码与测试。未创建索引。
- 后续：主代理合入并在 main 复核 `pnpm check`；TASK-060 在隔离 Electron Home 复测既有旧会话。若修改绑定表结构、Work 会话工作目录或 Runtime 扫描路径，应重新检查本守卫和临时 Home 测试。
