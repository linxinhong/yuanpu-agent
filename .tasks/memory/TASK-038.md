# TASK-038 创建独立助理包与专属执行环境

- 关键词：assistant Home、Pi Harness、专属技能、会话快照、技能隔离、loopback。
- Owner：assistant-architecture-sol1；记录日期：2026-09-26。
- 来源：领取提交 `0d3af4e`；实现与测试提交 `c70dd7f`，分支 `task/task-038-assistant-core`，专属 worktree `.worktrees/assistant-architecture`。本记录是分支交接；main 集成和卡片完成由主线 writer 执行。

## 入口与行为

- `packages/yuanpu-assistant/src/index.ts` 导出 `createAssistantExecutor`、Home 初始化与技能加载。包名为 `@yuanpu-agent/assistant`；依赖 Pi 底层包、共享协议及 YAML，不依赖 `runtime-kit` 或 `apps`。根 `@yuanpu-agent/*` build/typecheck/test 脚本覆盖本包。
- `AssistantHost.resolveModel()` 是本卡唯一宿主接口。宿主显式传绝对 `assistantHome`；核心不读 Electron、Work 数据库、固定凭据路径或来源目录。来源、委派和交付适配归后续卡；本地版仍由 App 宿主控制生命周期。
- Home 初始化 `SOUL.md`、空的 `memories/USER.md` 与 `MEMORY.md`、`config.json`、`skills/`、`sessions/pi` 和 `sessions/snapshots`。默认 USER/MEMORY 不填写推断用户事实。新 Session 冻结核心提示词至私有快照，重开继续使用原提示词；新 Session 才读更新的记忆。
- 执行器直接装配 Pi `JsonlSessionRepo`、`AgentHarness` 和显式 `resources: { skills }`，工具列表为空；Session 可 `prompt`、调用已加载技能和关闭。助理自身没有调用 Work 会话工厂或 Pi 默认/项目资源发现。
- 技能只从助理 Home 的 `skills/` 直接子目录加载；YAML frontmatter 支持折叠描述。加载拒绝整个技能树中的 symlink、逃逸的本地 Markdown 引用、`file://` 引用。包内版本化资源首次递归复制，已有用户编辑不覆盖。七份产品默认 SKILL.md 由 TASK-044/045/046/048 提供；本卡只交付种子机制。

## 复核与验证

- 独立只读审查复现 `sessions/pi` 可被预置 symlink 指向 Home 外；已在 Home 初始化时要求真实目录，回归确认外部目录未写入。修复后审查未发现其他本卡阻塞问题。
- 工具链：macOS arm64、Node 24.15.0、pnpm 11.22.0；使用 coding-owner `worktree-kit.py run`，锁文件变更后执行 frozen install。根工作区用户未提交文件和同步 Pi 上游包均未修改。
- 依次执行 `pnpm --filter @yuanpu-agent/assistant build`、`pnpm --filter @yuanpu-agent/assistant typecheck`、`pnpm --filter @yuanpu-agent/assistant test` 均通过。5 个测试覆盖 Home/技能种子、Work 与 symlink 隔离、会话目录保护、真实 Pi HTTP loopback 回合、记忆冻结/重开和不同绝对 Home 的独立回合、真实技能调用。
- 最终 `pnpm check` 通过（33.6 秒，日志：`.git/worktrees/assistant-architecture/coding-owner/1790430221274182000.log`），新包 5/5 测试、runtime-kit 138/138、apps/runtime 27/27；执行期间工作树未变化。
- 未验证：真实模型账号、Electron/SEA 宿主退出、企业微信接入、云端部署、并发恶意文件系统篡改。技能版本冲突索引与七份具体技能由后续卡完成，目录校验不等于 OS 沙箱。
- 下一步：主线 writer 将 `c70dd7f` 和本 memory 集成到含云端迁移设计提交 `ac62599` 的 main，在集成树运行 `pnpm check` 后调用 task tool complete。
- 检索：当前宿主未提供 zvec-grep 工具；按精确锚点使用 scoped `rg` 检索设计、Pi Harness/技能实现、根脚本与相关依赖，未创建索引。
