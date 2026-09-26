# TASK-010 交接

SEA Runtime 更新逻辑已从 Electron `RuntimeManager` 提炼到 `apps/desktop/src/runtime-updater.ts`。调用方只使用 `stage(currentVersion, manifestUrl)` 和 `activate(fallbackExecutable)`；文件校验、暂存、下次启动切换、原子 `current.json` 与失败清理由该模块集中负责。

回归分两层：`apps/desktop/test/runtime-updater.test.mjs` 覆盖成功和故障矩阵；`apps/desktop/scripts/smoke-runtime-updater.mjs` 通过本地 HTTP 下载刚构建的真实 SEA，并由根级 native smoke 与 runtime-bundle 三平台 workflow 调用。完整证据见 `.tasks/verification/TASK-010/results.md`。

恢复发布验收时仍需取得 Linux/Windows hosted-runner 结果。生产 Runtime manifest 尚无独立 Ed25519 签名，Apple/Windows 代码签名和 manifest 信任强化不能由本卡的 SHA-256 回归替代。
