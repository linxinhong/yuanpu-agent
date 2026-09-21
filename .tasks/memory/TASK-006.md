# 自包含 Python 能力制品与安全更新（TASK-006）

- 关键词：python-artifact、pyinstaller、ed25519、atomic-install、kernel-lease、rollback
- Owner：codex-yuanpu-61529；记录日期：2026-09-21
- 验证 revision：`0920c74fce3f0a1e7074f29e2ddb398c19144f0c`
- 完整证据：`.tasks/verification/TASK-006/results.md`

Python 能力以 PyInstaller onedir `tar.gz` 交付，不要求目标机安装 Python。manifest 固定
Ed25519 信任根，绑定目标平台、大小、SHA-256、运行时兼容范围与发布时间；下载、解包、健康
检查、状态切换均有上限和失败回滚。活动状态单独存于 `artifact-state.json`，不会混入 Pi
插件 settings；历史版本保留以支持 Windows 占用文件下的切换与回滚。

安装互斥最终采用操作系统持有的 loopback TCP 端口租约，避免 stale 文件的 check/delete
replacement race。真实子进程持锁并被 SIGKILL 后，内核释放端口，等待方继续安装。Catalog
只发布签名 manifest 明确引用的固定文件名，并拒绝符号链接和发布根逃逸；manifest 客户端
读取上限为 256 KiB。

Release 矩阵只接收生产公钥；长期私钥仅进入 gate 的验证脚本 step 和最终 publish 签名
step。缺少任一生产变量或公私钥不匹配时 fail-closed。本地开发根会明确标记 ephemeral，
不能冒充生产信任根。

独立复审最终 PASS。macOS arm64 的检查、冻结能力、SEA 与 Electron ZIP/DMG 均通过；
Linux/Windows 托管 runner 和真实平台签名/公证仍为 UNVERIFIED，留给 TASK-008，不得据此
宣称生产可发布。

