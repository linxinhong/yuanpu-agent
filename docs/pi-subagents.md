# 内置子 Agent

## 接入方式

`createYuanpuChatSession` 默认注册 `subagent` 工具，随 Yuanpu Runtime 一起构建。
无需安装插件，也不写入用户的插件配置。实现位于
`packages/yuanpu-runtime/src/pi/subagents/`，没有修改同步的 Pi 上游包。
低层 `createYuanpuAgentSession` 仍可由调用方显式选择工具；不会自动引入子任务生命周期。

参考来源：pi-subagents 0.71.0，commit
`2e9c51bada2da6a9ba73b6973e1545a9afa0d057`。保留 MIT 许可和来源说明。
这是适配到 Yuanpu 的原生实现，不是上游扩展的完整复制。

## 使用

用户或项目指令授权委派后，Agent 可调用：

```json
{"action":"list"}
```

```json
{"action":"run","agent":"scout","task":"检查登录流程，返回相关文件和风险"}
```

```json
{"action":"run","tasks":[{"agent":"scout","task":"检查 API"},{"agent":"reviewer","task":"审查测试覆盖"}]}
```

```json
{"action":"run","chain":[{"agent":"scout","task":"定位问题"},{"agent":"worker","task":"根据调查修复：{previous}"}]}
```

`async: true` 返回后台任务 ID。通过 `action: "status"` / `"cancel"` 和 `runId`
查询或取消；`list` 同时返回当前父会话的任务。后台完成后不会自动唤醒父 Agent，需查询结果。

## 角色和上下文

内置 scout、worker、reviewer、oracle、delegate、researcher、evidence-auditor。
角色提示词与工具配置集中在 `profiles.ts`，可随项目源码维护。

子任务使用父会话启动委派时的模型、认证、工作目录和能力审批上下文。
每个子任务使用独立的 Pi 会话；父会话历史不会自动复制，所需资料通过 `task` / `context` 提供。
串行模式将上一步输出作为上下文，并支持 `{previous}` 替换。子任务失败或等待审批后停止后续步骤。

工具为角色工具与父会话当前工具的交集；子会话不加载扩展、不提供 `subagent`。
项目上下文和技能仍由 Pi 的资源加载器读取。默认父会话提供 read/grep/find/ls、write/edit/bash 和两个外部能力入口。
scout/reviewer 等只读角色只能使用 read/grep/find/ls。角色声明不等于新增父会话权限。
外部能力继续走原来的 search_capabilities / execute_capability，审批 ID 回传父会话。
待审批的子任务不会自动恢复；处理审批后需要明确重新发起任务。

这不是文件系统沙箱。worker/delegate 共享工作目录，可使用父会话允许的本地工具。
并行写入任务应指定互不重叠的文件范围；不会自动创建 Git worktree。

## 生命周期与限额

- 每个父会话最多同时执行 3 个子任务，每次最多 8 个，累计最多 64 个。
- 默认超时 5 分钟，`timeoutMs` 最大 30 分钟，包括排队时间。
- 单次返回的每个子任务正文最多 16000 字符，完整结果保留在磁盘。
- 输出位于 `<agentDir>/subagent-runs/<runId>/`，默认是 `~/.yuanpu/agent/subagent-runs/`。
  包含 request.json、result.json 和各子任务的会话记录。目录权限 0700，请求/结果文件 0600。
- 父会话停止或释放时取消所有子任务；完成的普通消息不取消后台任务。
- 进程退出后不会恢复后台任务。记录可能含工作资料，不应提交到仓库。

## 与上游的边界

保留核心单任务、并行、串行、角色、进度、后台查询、取消和结果记录能力。
没有引入上游的 TUI 面板、slash 命令、workflowScript 脚本执行器、独立后台进程、
intercom、自定义角色文件发现或跨重启恢复。上游最新工具参数与这里的 Yuanpu 参数并不相同。
因此不能直接把上游 workflowScript 当作这里的输入。

## 验证

`packages/yuanpu-runtime/test/subagents.test.mjs` 覆盖并发上限、工具交集、串行传递、
审批中断、取消、超时、错误和真实 SDK 父子模型调用。模型测试使用本地模拟服务，无外部 API 消耗。
