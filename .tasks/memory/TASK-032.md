# 修复非 macOS 企业微信凭据诊断（TASK-032）

关键词：WeCom、Keychain、Linux、credential_unavailable、Runtime readiness、CI。

- 记录：2026-09-23；实施者：codex-task021-followup-20260923；基线 `895edf9`。本卡源于 App 多入口与升级完整业务验收（TASK-021）的跨平台检查。
- 入口：`apps/runtime/src/wecom-channel.ts` 的 `resolveSystemKeychainCredential`；`apps/runtime/src/index.ts` 的 `wecomDiagnosticFor`；回归 `apps/runtime/test/runtime.test.mjs` 的 `unavailable Keychain credential`。
- 触发：Linux CI `main` `9c7712f` 的 run 35868424221；无 macOS Keychain 时解析器抛出平台专属文案，Runtime 分类器未识别，记录为 `connection_unavailable`，导致既有诊断断言失败。Runtime 本身仍 ready。
- 修复：非 macOS Keychain 不可用沿用 macOS 缺项时的脱敏 `credential could not be resolved` 错误文案，现有分类器统一得出 `credential_unavailable`。不新增平台凭据存储，不访问真实机器人、个人 `.env` 或 Keychain。
- 本地验证：macOS arm64，Node 24.15.0 / pnpm 11.22.0；`pnpm check` 通过（私有 runner `1790171103095862000.json`）；在 `apps/runtime` 为 cwd 的 `node --test test/runtime.test.mjs test/wecom-channel.test.mjs` 通过（`1790171167167651000.json`）。首次聚焦测试在构建前缺 workspace `dist`，第二次误用 repo 根 cwd，均为环境/调用错误，未计产品失败。
- Linux 复验：集成 `main` `56c6b77` 的 GitHub Actions [CI run 35869667122](https://github.com/linxinhong/yuanpu-agent/actions/runs/35869667122) 在 `ubuntu-24.04` 完整 `pnpm check` 通过；原失败的 Runtime Keychain 场景包含于该 gate。该证据针对 Linux CI，不声称 Windows/macOS 发行包验收。
- 边界：凭据仍由系统 Keychain 引用解析；若未来改成 SQLite 密文或跨平台系统密钥方案，应单独设计主密钥、Electron/Runtime 信任边界、迁移和 Linux 降级策略。本卡不变更此安全契约。
