# 当前 Pi Session 轨迹图 v003

- Yuanpu 基线：[现有工作界面](../../evidence/task-059/tree-light.png)，图像像素 1440×900；CSS 视口与 DPR 未记录。
- 编辑底图：[运行轨迹草图 v001](design-v001-run-trace.png)，图像像素 1585×992。
- 视觉参考：用户本轮提供的 Pi Session 轨迹截图，仅提取「时长/轮次/调用」概览、输入/模型/工具分层色块、跨轮次角色行与工具入参→结果的排版；参考截图含真实工作内容，未复制进仓库或生成图。
- 目标区域：扩大现有右栏到约半屏，替换其一次运行清单为整个当前工作会话 Pi Session 的轨迹；中央消息与输入卡片在剩余宽度内收缩，左侧工作树不变。
- 结果：[design-v003-session-trajectory.png](design-v003-session-trajectory.png)，实际 1586×992，为合成数据的视觉稿。

生成提示：

> Edit the attached Yuanpu UI screenshot conservatively. Keep left navigation, work tree, chat and composer. Expand the right 运行轨迹 viewer to about half the window width. Change its body to a Pi SESSION transcript across several turns: top compact 时长 / 轮次 / 调用 with a multi-lane colored mini-map labeled 输入, 模型, 工具, 上下文; beneath it chronological round separators and dense rows labeled 用户, 助手, 工具, 子智能体, 上下文. Include safe synthetic short tool call input → result lines, with a failure in red. Do not show a simple one-run checklist. Preserve the single right tab strip and original Yuanpu colors and geometry.

标题校正提示：

> Change the right viewer's top-left selector 本次运行（Pi SESSION） to 当前会话 · 模型配置讨论, because this panel shows the whole current Pi Session across six turns. Remove any extra chevron suggesting a single run. Preserve the timeline, transcript and surrounding Yuanpu layout.

控件微调提示（以标题校正后的图为底图）：

> Keep the existing Yuanpu composition and all trajectory rows. Make 时长、轮次、调用 visibly selectable compact tabs, with a subtle blue underline under 时长. Add a small 搜索 field on the right, above the colored timeline. Preserve 当前会话 · 模型配置讨论 and all four timeline lanes.

图中「时长 48.2s / 轮次 6 / 调用 9」是展示位置和密度的示例，实际界面按设计文档把时长、轮次、调用做成可切换/可定位的概览，不从生成图反推统计实现。工具与文件路径全部为合成内容。
