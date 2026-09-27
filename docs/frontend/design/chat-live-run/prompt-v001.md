# 主运行轨迹图 v001

- 原始参考：[当前 Yuanpu 工作界面](../../evidence/task-059/tree-light.png)，图像像素 1440×900；实际浏览器 CSS 视口、DPR 与滚动位置未记录。画面是工作树展开、中央空会话、右侧文件 Viewer 的状态。
- 目标区域：中央消息（原图约 x=350–1120）、输入卡片右下（约 x=850–1100, y=500–605）、右栏顶部标签与内容（约 x=1120–1440）。左侧工作树、顶栏和面板比例应保持。
- 生成结果：[design-v001-run-trace.png](design-v001-run-trace.png)，实际 1585×992。图像是安全合成数据的交互预览，不是应用截图或功能证据。

首次编辑提示：

> Create a conservative edit of the exact existing Yuanpu screenshot. Preserve the original four-column geometry, work tree, header, white/light gray/pale green palette, input-card shape and spacing. Add a compact streamed assistant message with single-line observed process rows for 思考、Skill、Web 搜索、读取、编辑、代码执行、MCP、子智能体. Add model/effort selector and 67% context ring beside the send button. In the existing single top tab strip, keep 文件 and add 运行轨迹、子智能体. Replace the right body with a dense chronological trace. Do not add a large task card or alter the shell.

修订提示（选定版本）：

> Precision correction of the Yuanpu design screenshot. Preserve the four columns, work tree, chat typography, composer and proportions. Delete the accidental duplicate second tab row inside the right panel; retain only the global top tab chips 文件、运行轨迹、子智能体 and plus. Move the run selector/search into the freed space. Add two additional single-line event types to chat and right trace: Bash · pnpm check and 工具调用 · get_context_usage, distinct from the existing eight; update count to 10 个事件. Keep chronological ordering and status marks. No large card or new shell.

检查：生成结果保留单层右栏标签条，宽高比相对原图偏差约 0.14%。示例中的 GPT-4o、67% 与 10 项事件均为占位数据，实际值以会话与运行观测为准。
