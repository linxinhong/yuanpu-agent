# 接通技能管理与审批界面（TASK-007）交互方案

- 状态：agent-selected
- 决策依据：用户已要求执行全部任务卡；沿用现有技能页和对话页，不引入新页面/新布局模式。
- 检索：当前 host 未提供 zvec-grep；使用 scoped `rg` 检索 `apps/app/src`、`apps/desktop/src`、
  `apps/runtime/src`、`packages/yuanpu-{protocol,runtime}` 中 skill/plugin/approval/artifact/rollback 流。

## 页面安排

1. 技能市场卡片仍是安装入口。点击安装/更新先打开应用内信任确认对话框，展示来源、版本、
   权限、组件类型，并明确 Python 能力在进程外运行、不会作为 Pi extension 加载。
2. 安装失败不离开当前上下文；卡片显示仍在使用的活动版本与错误，可原地重试。
3. 已安装卡片显示活动版本和历史版本；历史版本仅由用户显式点击回滚。
4. 检测到旧 `pi-mcp-adapter` 与 Yuanpu 管理同名连接时，显示托管冲突对话框。默认保持
   旧 adapter 配置且不重复注册；用户必须显式选定托管方，取消不修改任何配置。
5. 对话产生 `needs_approval` 后，在消息流内显示待确认卡片。允许一次/拒绝由 Electron
   主进程签名后提交；允许后仅重试一次原消息，拒绝后回到输入状态，不自动再次申请。

## 状态与恢复

- 安装、回滚、审批按钮在请求中禁用，防止重复点击。
- 技能页每次进入/操作后从 Runtime 重新读取状态；刷新后活动版本与历史版本一致。
- 对话页启动时读取持久 pending approvals；只展示当前 Runtime 返回的待确认记录。
- 失败文案包含当前仍活动版本；重试复用相同显式动作，不自动降级或切换。

## 契约边界

- `yuanpu-protocol` 增加能力制品状态/回滚和审批桥接 DTO，不向 renderer 暴露私钥或进程句柄。
- Electron main 校验 IPC 来自当前受信窗口；preload 只暴露所需方法。
- Runtime 继续执行签名、哈希、兼容性和健康检查；前端确认不替代安全校验。
- 两个 MCP 元工具只覆盖 Yuanpu 管理能力，不描述为 Pi/bash/系统沙箱。

## 验收旅程

- 搜索 Python 示例能力 → 检查权限 → 确认安装 → 状态持久 → 配置/对话调用。
- 敏感调用 → 待确认 → 允许一次成功；新请求 → 拒绝，且不重复执行。
- 更新失败仍显示旧版 → 重试；存在历史版本时显式回滚。
- adapter 冲突取消不改旧配置；显式选择后只有一个托管方。

## 实施与迭代结果

- `before-v001.png`：现有技能页基线。
- `trust-dialog-v001.png`：应用内信任确认，展示来源、发布者、权限和进程边界。
- `installed-v001.png`：真实下载、验签、解包并激活 0.1.0 后的状态。
- `approval-v001.png`、`approval-restored-v001.png`：真实 LongCat 对话触发 R2 能力审批，且刷新后待审批状态恢复。
- `update-failure-v001.png`：0.2.0 使用不同测试签名时被 Runtime 拒绝，页面保留 0.1.0 并提供重试。
- `rollback-v001.png`：信任根一致后成功更新到 0.2.0，再由界面显式回滚至 0.1.0。
- `approval-exact-v002.png`：修复复核问题后，刷新 renderer 再允许；Runtime 以保存的原能力、
  参数和上下文直接执行，返回配置前缀与原参数，不再要求模型重构调用。

迭代中发现 catalog 的展示名称与能力包稳定 ID 不同，安装状态必须用 `id` 关联；同时发现
PyInstaller 入口在处理 `--version` 前导入 MCP 依赖会超过安装健康检查时限。最终实现分别改为
按 catalog `id` 匹配，以及在导入 MCP 前快速返回版本。

独立安全复核的首轮结果为 FAIL：IPC 未绑定 URL，审批依赖模型续跑，artifact 配置与签名权限
未接通，adapter 冲突判断过宽。v002 已将 IPC 绑定到配置的入口文档并拒绝非受信 frame；将
审批原始调用保存在 Runtime 内存中并由宿主精确执行；使用验签 manifest 的权限、配置 schema
和连接名；只在签名连接名与旧 adapter 配置重合时提示。外部页面实测仍可由 CDP 强制导航，
但 preload 调用被 main 进程拒绝；普通导航和新窗口也由 webContents 策略阻止。
