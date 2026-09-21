# 实现宿主一次性授权（TASK-003）

- 关键词：approval、Ed25519、replay、binding、Pi-bash、host-auth
- Owner：codex-yuanpu；记录日期：2026-09-21
- 实现修订：`65f4dd0`、`612febd`、`143b514`、`cd75c74`
- 依赖：固定能力与制品公共契约（TASK-002）

`CapabilityApprovalStore` 位于 `packages/yuanpu-runtime/src/capabilities/approval.ts`。
待审批记录只保存参数 SHA-256 摘要，绑定 session、workspace、source、非空包版本、
能力 ID 和过期时间。批准先持久化为 consumed，再派发；并发消费只有一次成功。
重启会取消遗留 pending/approved，headless 无 authorizer 时拒绝执行。

Electron 临时生成 Ed25519 密钥对，私钥不离开 main；Runtime 仅从一次性 stdin bootstrap
接收 bearer 与公钥。审批决定签名绑定 requestId/decision/issuedAt/nonce，Runtime 执行
验签、30 秒时间窗和 nonce 重放检查。普通 bearer 不具有批准权，凭据不在 argv/env。
Pi adapter 将 needs_approval/requestId 结构化返回，但 requestId 本身不授权。

独立安全复核先复现了 argv bearer 可由默认 Pi bash 经 ps 读取的 CRITICAL 路径；
上述签名与 stdin bootstrap 修复后第二轮复核通过。复核同时确认版本变化拒绝成立，
并明确本机制不是全局 Pi/bash 或同 UID 原生调试沙箱。

验证环境：macOS arm64、Node 24.15.0、pnpm 11.22.0。

- runtime-kit 授权/适配测试：通过（含伪造、过期、绑定变化、版本变化、并发、重放、重启）。
- runtime HTTP 测试：通过（认证、伪签名、有效签名、nonce 重放、argv 无 token）。
- `pnpm check`：最终修订通过。

若审批签名格式、Runtime 启动通道、Pi 默认工具或授权持久化位置改变，必须重新做安全复核。
