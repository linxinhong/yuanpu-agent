# TASK-053 设置全局字体配置 — 任务记忆

## 结果

- 分支 `task/task-053-font-config`（实现提交 e542aeb，基于领取提交 4bf9352）已合并进 main；worktree `.worktrees/font-config` 保留。
- 用户可在设置的通用区配置：界面字体大小（紧凑 90% / 标准 100% / 大 110% / 特大 125%）、正文字体大小（13–17px 五档）、界面字型（系统默认 / 苹方·思源黑体 / 微软雅黑 / 宋体 / 自定义）。选择即时生效、localStorage 键 `yuanpu:font:v1` 跨启动保留、三套主题通用。

## 入口与机制

- 偏好模块 `apps/app/src/shared/font-preference.ts`：`normalizeFontPreference`（纯函数，可 node 测试）、`sanitizeCustomFontFamily`（逐段校验自定义 font-family，防污染内联声明）、`applyFontPreference`（向 `documentElement.style` 写 `--yp-font-scale-ui` / `--yp-font-size-content` / `--yp-font-family` 并持久化）。主题同款模式，无 IPC/protocol/runtime 改动。
- token 权威在 `apps/app/themes/tokens.css`（仅此一处声明）：`--yp-font-family`（默认即原系统栈）、`--yp-font-scale-ui: 1`、`--yp-font-size-content: 14px`。
- `muse-theme.css` 的 `:root` 使用 `font-family: var(--yp-font-family)` 与 `font-size: calc(16px * var(--yp-font-scale-ui))`。
- 两种缩放通道相互独立：界面文字走 rem（根字号缩放），聊天正文走 `--yp-font-size-content` 的 px token + `calc(var(--yp-font-size-content) * N / 14)` 衍生（h2 17、h3 15、pre code 12、table 13、assistant-home 13px 变体、composer textarea 与 `.message-body p` 行高 24/22 均为 calc 比例，避免 rem 行高串入界面缩放）。

## px→rem 转换记录（集成时增量文件已按同一规则补齐）

- 基准 16px，`Npx → N/16rem`（脚本一次性转换，核心 5 行：`font-size:`/`line-height:` 的 `(\d+(?:\.\d+)?)px\b` 替换，4 位小数去尾零）。转换时点 HEAD 4bf9352 计数：muse-theme 126、styles 65、management 27、mindlink 7。
- 集成融合（stash→merge→pop）后补齐：muse-theme 内 hotkey-settings 新增规则 5 处、`assistant-home.css` 15 处（其中 `.assistant-home .message-markdown` 13px 改为 content token 衍生）；`shell-layout.css` 无 px 字号。
- `theme-contract.test.mjs` 第二个测试禁绝 muse/styles/management/assistant-home/shell-layout/mindlink/dark 七个文件的硬编码 `font-size|line-height: Npx`，新文件入列即受守护；token 声明断言覆盖三个字体 token。

## 验证与证据

- `pnpm --filter @yuanpu-agent/app test`：任务分支 12/12；融合后主工作区 18/18（含增量任务的 hotkeys、assistant-activity 测试）。`pnpm check` 全量在任务分支（即合并进 main 的提交态）通过，Node 24.15.0 / pnpm 11.22.0，macOS arm64。`pnpm --filter @yuanpu-agent/app typecheck` 融合后通过。
- 视觉证据 `.tasks/ui/task-053-font-config/images/`（本地保留，.tasks/ui 不入库）：Playwright + vite 构建产物双服务对比——work/skills 页标准档截图与改造前**字节级一致**，settings 差异仅为新增设置块；computed styles 标准档完全一致（root 16px、composer 14px、breadcrumb 12px、同字族）。组合档（特大 125% + 正文 17 + 宋体）下 root 20px、composer 17px、breadcrumb 15px，界面/正文独立性成立，无溢出或挤压。

## 环境注意

- 干净 worktree 首次 `pnpm check` 会因 `scripts/hydrate-pi-model-data.mjs` 联网拉取模型数据超时失败；从主工作区复制 `packages/ai/src/providers/data/`（含 `.manifest.json`，已 gitignore）即可跳过联网。
- 融合期间主工作区存在其他任务未提交增量（hotkeys、assistant home、work conversations 等），已按"双方并存"原则融合，增量保持未提交状态；stash `task053-integration` 已在融合完成后丢弃。

## 未决 / 后续候选

- 代码字体（mono）未单独配置，可后续以 `--yp-font-family-mono` 扩展（styles.css/muse-theme.css 内的等宽栈仍为字面量）。
- 界面档位上限 125%：布局容器仍为固定 px（侧栏 220px 等），更大档位需同步评估布局尺寸策略。
- 无级 slider、多窗口差异化按卡片范围排除。
