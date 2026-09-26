# Assistant companion actions

Seven approved dog-actions-v004 cutout animations, exported at 192 × 192,
30 fps, 6 seconds, looping WebP (quality 82), with static PNG posters.
Source gallery: `.tasks/ui/assistant-home/avatars/three-motion/rendered/dog-actions-v004/`.
Source rig: `.tasks/ui/assistant-home/avatars/dog-reading-remotion/`.
The app ships these assets and does not depend on the local gallery server.

## Runtime presentation policy

`shared/assistant-activity.ts` owns the task classification. This is a visual
activity model, not separate AI agents or a change to execution permissions.

- First assistant entry: wave once, then idle.
- Confirmed running: reading for research, typing for writing/computer work,
  backtyping for background/scheduled work, hammer for build/repair tasks.
- Queued, waiting approval, cancelled, failed, interrupted, unknown or lost
  connection: idle, with an accurate status tooltip.
- Observed success of the same run: heart for one cycle, then idle.
  Opening a historical successful run does not replay completion feedback.

Task selection uses the submitted request, excludes attachment bodies and model
output, and is scoped to its run id. Current run records expose only final tool
summaries, so this version does not claim to follow individual live tool calls.
Unknown remote tasks use typing, or backtyping for scheduler runs. Future live
activity events can feed this policy without changing the asset component.

Hidden panels use posters. Reduced-motion preferences use posters unless the
user explicitly clicks to play one cycle. Clicking normally restarts animation.
The existing circular mask and static chat portrait are preserved.
