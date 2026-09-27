# 子智能体与上下文图 v002

- 参考：[主运行轨迹图 v001](design-v001-run-trace.png)，图像像素 1585×992；原始 Yuanpu 截图见 [基线](../../evidence/task-059/tree-light.png)。
- 目标区域：仅切换右栏 Viewer 内容与激活标签，并在输入卡片的 67% 圆环上方展开上下文弹层；保留原有工作树、消息与输入卡片几何。
- 生成结果：[design-v002-subagent-context.png](design-v002-subagent-context.png)，实际 1585×992。数据全为安全示例。

编辑提示：

> Make a second state of the exact Yuanpu design screenshot, preserving the shell, work tree, central chat, bottom composer, colors, proportions and single top tab strip. Make 子智能体 active instead of 运行轨迹. The right body is a separate child-agent process viewer with breadcrumb 子智能体 / 界面审查, delegated task summary, and a chronological read-only child session timeline of file read, thought summary, tool call and reply. Do not add a duplicate tab row. Above the existing 67% context ring open a compact anchored popover with tabs 上下文 active and 运行轨迹 inactive, title 上下文已用 67% / 674K / 1M, a segmented bar and category rows 系统提示词、工具定义、对话消息、其他. Do not display 估算. Keep the popover in the central chat column.

检查：上下文弹层和子智能体 Viewer 属于两个独立交互层；父运行轨迹只显示子智能体摘要，子会话详情由右栏 Viewer 展示。图中部分完成状态仅用于说明排版，实施时必须以真实事件为准。
