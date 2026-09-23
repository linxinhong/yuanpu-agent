# 修复跨平台打包验证流水线（TASK-034）

关键词：Runtime Bundle、Desktop Bundle、Windows pnpm、workspace build、开发临时签名、trust root。

- 记录：2026-09-23；实施者：codex-task021-followup-20260923；基线 `f331581`，源提交 `d7a19b2`；源于 App 多入口与升级完整业务验收（TASK-021）的三平台矩阵复验。
- 原始失败：`main` `e16cfef` 的 [Runtime Bundle run 35872575801](https://github.com/linxinhong/yuanpu-agent/actions/runs/35872575801) 三平台在 managed MCP 测试前缺 `@yuanpu-agent/protocol/dist`；[Desktop Bundle run 35872590465](https://github.com/linxinhong/yuanpu-agent/actions/runs/35872590465) Windows 在模型数据补全处 `spawnSync pnpm ENOENT`，macOS/Linux 因 CI 空 `YUANPU_ARTIFACT_SIGNING_KEY_ID` 错误阻断开发制品。
- 修复入口：`.github/workflows/runtime-bundle.yml` 在 Runtime 测试前执行完整 workspace build；`scripts/hydrate-pi-model-data.mjs` 优先用当前 pnpm 的 JS CLI 经 Node 启动，Windows 缺该路径时用系统命令解释器；`apps/python-capabilities/scripts/signing-key-id.mjs` 将空/空白 ID 视为未配置，但仅在无生产信任根时回退开发临时 ID。
- 安全边界：存在生产 trust root/签名密钥而 Key ID 缺失仍报错；没有改变签名、校验、artifact trust policy，也没有新增密钥值或修改 Pi 上游。
- 本机验证：macOS arm64 Node 24.15.0/pnpm 11.22.0；签名 ID 聚焦测试通过（runner `1790173162948117000.json`），`pnpm check` 通过（`1790173169128661000.json`）。`pnpm` 的空 lockfile checksum 已清理。
- 待复验：将该提交集成并推送 main，重新触发 Runtime Bundle 与 Desktop Bundle 三平台矩阵；必须逐项检查真实 SEA smoke、包上传及发行信任缺口。此前失败不能算平台可执行证据。
