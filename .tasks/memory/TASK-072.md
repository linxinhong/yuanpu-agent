# TASK-072 工作会话审查标签 — 任务记忆

## 结果

- 分支 `task/task-072-review-tab`（实现 3e15a2c，领取基线 9905a98）已合并 main（merge 0e1d1ee）；worktree `.worktrees/review-tab` 保留。
- 工作会话右侧栏新增「审查」tab：上一轮（按最近 run 的 runId）/ 本会话两种范围；文件列表（相对路径 + 每文件 +N -N + 新建/内容过大/无净变化徽标）；展开为 unified diff（复用 @pierre/diffs 的 PatchDiff，行号/红绿/未修改行折叠）。run 到终态时自动刷新（chat.tsx observeRun 终态分支 bump reviewRefreshKey）。

## 机制（ZCode 式自产快照，不依赖 git）

- 捕获：`packages/yuanpu-runtime/src/pi/index.ts` runPrompt 的 session.subscribe —— tool_execution_start 对 edit/write 且 args.path 解析后在工作目录内时读 before（ENOENT → null=新建）；tool_execution_end 且 status=completed 时读 after；sha 相同或 after 读取失败则跳过。before 读取拒绝会取消整笔记录（不冒充新文件）。核心在 `src/pi/file-changes.ts`（纯函数 + 注入 reader，可 node 测试）。
- 流转：`YuanpuChatResult.fileChanges` → `RuntimeAgentExecutor.execute` 经 `onWorkFileChanges` 回调（仅 desktop + work:* 会话）→ `metadata.workFileChanges.record`（try/catch，失败不影响会话）。不进 run output（避免 256KB 内容进 output_json）。
- 持久化：schema v16 表 `yp_work_file_changes`（UNIQUE(run_id, tool_call_id) 幂等；before/after 各 ≤256KB 截断 + sha256 + size）。conversation_id 落库时剥掉 `work:` 前缀。
- 读取：`GET /v1/work/file-changes?conversationId=&runId=`（runId 缺省=本会话聚合）→ mergeWorkFileChanges（首 before + 末 after，按文件保持首现顺序）→ 渲染端自行用 createUnifiedDiff/countDiffChanges 算统计与渲染（零新增依赖，diff 生成全在渲染端既有管线）。
- 渲染端：chat.tsx `activityTab` 加 'review'；file-tabs FileTab/label/icon/「+」菜单/内容分支；`viewer/review/review-panel.tsx` 用 window.yuanpu.listWorkFileChanges + react-query（queryKey 含 refreshKey）。样式全部走已声明 --yp-* token，theme-contract 保持通过。

## 集成与融合记录

- merge 时与 main 新进的"文件预览优化"（5b9165f）冲突 6 处（protocol 路由/DesktopBridge、app-icon eye/external、desktop 三接线、runtime 双路由）→ 全部双方并存。
- stash pop 时与并行 WIP（会话轨迹/子代理 tab 改造，把 activityTab 的 activity/run 换成 trajectory/subagents）冲突 4 文件 → 融合为 `'trajectory' | 'subagents' | 'files' | 'review'` 联合类型、菜单三按钮并存、runContent 归 WIP、reviewContent 归本卡；WIP 保持未提交态。
- 融合后验证：app typecheck ✓ + 44/44、desktop typecheck + 22/22、runtime typecheck ✓、kit 202/204（两失败为陈旧 dist，重建后 store 5/5 + persistence 14/14 ✓）。

## 验证与证据

- 单测：路径含界、捕获语义（新建/修改/未变化跳过/before 失败跳过/截断）、合并口径、store 幂等与 runId 过滤（packages/yuanpu-runtime/test/work-file-changes.test.mjs）。
- 视觉：Playwright + 桩 bridge（addInitScript 注入 Proxy —— 注意 addInitScript 参数经 JSON 序列化，函数属性会丢失，必须在页面内构造 Proxy）截图于 `.tasks/ui/task-072-review-tab/images/`：审查列表（+9 -1 · 大文件未计入）、展开 diff（行号/红绿/未修改行折叠）、上一轮空态引导。
- pnpm check：全部包绿，唯 runtime-kit 一个预存在失败（mcp-source「tool discovery timeout…」：fixture 子进程初始化即退出 Connection closed 而非挂起；在基线 9905a98 用 stash+重建验证同样失败，4bf9352→9905a98 区间内 MCP 源码无改动，与本卡无关，列为后续候选）。

## 后续候选

- mcp-source 挂起用例的预存在失败（独立修复卡）。
- bash 间接修改与子代理会话的文件变更捕获；trajectory WIP 合入后审查 tab 与运行轨迹 tab 的入口打通（如轨迹内跳转审查）。
- 审查数据无清理策略（表随会话增长），可按会话归档/清理。
