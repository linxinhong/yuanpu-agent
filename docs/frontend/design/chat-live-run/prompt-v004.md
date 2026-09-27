# 上下文按钮与子智能体 Viewer 图 v004

- 编辑底图：[子智能体与上下文草图 v002](design-v002-subagent-context.png)，实际 1585×992；原始 Yuanpu 工作界面见 [基线](../../evidence/task-059/tree-light.png)。
- 目标区域：仅修改圆环上的上下文弹层；右侧仍为独立子智能体过程 Viewer。
- 结果：[design-v004-context-button.png](design-v004-context-button.png)，实际 1585×992；所有内容为安全示例。

编辑提示：

> Precision edit of the Yuanpu child-agent/context screenshot. Preserve shell, left work tree, central chat/process list, bottom composer, single top workspace tab strip and right child-agent viewer. Change only the small context popover anchored above the 67% ring: delete its internal tab row 上下文 / 运行轨迹 completely. The popover contains only context details: header 上下文已用 67% 674K / 1M, segmented bar, rows 系统提示词, 工具定义, 对话消息, 其他, and a single bottom text button 打开运行轨迹 → separated by a fine divider. No event preview or trajectory tab in the popover. Keep no word 估算.

按钮会关闭弹层并打开右侧当前 Pi Session 轨迹；右侧子智能体 Viewer 的内容与上下文弹层相互独立。
