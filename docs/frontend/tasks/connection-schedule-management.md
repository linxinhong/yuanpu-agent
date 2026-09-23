# UI Task Card — 连接与定时任务管理（TASK-020）

## Context

- Target app: `apps/app` React 19/Vite renderer inside Electron; pnpm monorepo.
- Target route: existing single-page shell (`AppView` currently `chat | skills`), adding `connections | schedules`; no browser router today.
- Primary user: owner of the local personal assistant and one paired Enterprise WeChat private chat.
- Primary task: inspect and manage the connection and scheduled runs without leaving the existing desktop shell.
- Business outcome: configuration, schedule state, run state and IM delivery state are visible from the authenticated local Runtime; no credential value is echoed.
- UI package/pattern package/private Registry/`components.json`: none found. Token source is `apps/app/src/styles.css`; use its existing dark green shell and form styles. No Playwright setup found; `agent-browser` is the available browser QA path. Dev command: `pnpm dev` or the existing Vite server.
- Source reference: `docs/application-architecture.md` §13 (user-owned untracked design source at task start), `.tasks/tasks.yaml` TASK-020, `docs/adr/0003-defer-native-notifications.md`. Current shell capture: `.tasks/ui/TASK-020/images/before-v001.png`, browser preview at `http://127.0.0.1:5173/`, 1440×900 CSS/pixels, DPR 1, scroll 0; browser mode has no Electron bridge and shows only synthetic greeting.

## Top questions

1. Is the Enterprise WeChat connection ready, disabled or in error, and what can I fix?
2. Which schedules are enabled, when will each run, and where will its result go?
3. Did the last run execute, wait for approval, fail, or reach an unknown state?
4. Was the IM result delivered, failed or unknown independently of Agent execution?
5. How can I return from a task/run to its conversation and cancel an active run safely?

## Proposed arrangement and flow

Keep the existing sidebar, brand, footer, colors and panel shell. Add `连接` and `定时任务` as peer navigation items, not connector-internal tabs. `定时任务` is the golden page: a compact schedule list with enabled state, next trigger and last outcome on the left; a selected task's run/history detail on the right. `新建任务` opens an editor in the detail region with name, instruction, workspace, timing/time zone and an explicitly bound output target. Before save, show the calculated next execution time in the chosen zone; after save, return to the selected detail. Errors retain the draft. Connection page reuses the list/detail arrangement for the one configured bot: status, pairing count, private-chat policy, configuration and test action. The initial proposal suggested a write-only secret input, but the implementation omits secret entry because no scoped Keychain writer exists in the App; neither credential nor Bot ID is redisplayed.

Entry: sidebar → list. Primary actions: `新建任务` or `配置连接` → validate/test → save → selected detail. Secondary: refresh, enable/disable, open run/conversation. Destructive/irreversible: cancel a running task or revoke an IM target requires an explicit confirmation. Failure: inline explanation plus retry with input retained. Notification preferences and native-click navigation stay outside TASK-020. The implemented connection editor accepts a bot ID for a new record, but does not collect or display a secret: it binds a fixed system-Keychain reference whose value must be provisioned separately.

## Region tree

```text
AppShell
├── ExistingSidebar (chat, skills, connections, schedules)
└── ManagementPanel
    ├── PageHeader (title, Runtime status, primary action)
    ├── ItemList (status, next/last fact, selection)
    └── DetailRegion
        ├── Summary (schedule/connection identity and actions)
        ├── Editor or StatusInspector
        └── RunHistory (execution, IM delivery, conversation link)
```

## Component responsibilities

| Region | Inputs/actions | Reuse / new |
| --- | --- | --- |
| Shell/sidebar | active view, navigation | Reuse existing `App`, `.sidebar`, `.nav-item`; no new primitive. |
| List | Runtime records, selection, refresh | Reuse panel/row/status styles; page-local list composition. |
| Detail/editor | selected record, draft, validation, save | Reuse existing plugin config form patterns; page-local forms. |
| Run history | schedule history, run status, IM delivery | Reuse existing status and conversation language; page-local inspector. |

## State matrix

| State | Trigger | UI behavior | Recovery/action |
| --- | --- | --- | --- |
| loading | bridge request pending | Stable list/detail placeholders | Wait; avoid duplicate submit. |
| populated | records returned | Selectable rows and detail | Edit, enable/disable, view run. |
| empty | no schedules/contact | Explain prerequisite | New schedule or wait for a paired message. |
| partial | run exists, delivery pending/unknown | Separate run and delivery labels | Inspect details; do not imply success. |
| error/offline | Runtime request fails | Inline error with retained draft | Retry/refocus configuration. |
| permission denied | unbound/revoked IM target | Disable invalid selection | Bind an observed private contact. |
| disabled | connection/schedule off | Show paused reason and next action | Explicit enable. |
| waiting approval/running | active run | Clear status and cancel action | Return to run/conversation. |
| long/dense | long names, prompts or history | Truncate in rows; scroll detail | Open full text in detail. |
| narrow viewport | <= 1024 px | List then dedicated detail/edit view | Back preserves selection/draft. |

## Interaction map

| Interaction | Entry | Result | Feedback |
| --- | --- | --- | --- |
| Test connection | connection detail | Live diagnostic state, no secret echo | Busy, failure retains inputs, retry. |
| Create schedule | task list primary action | Saved record and next trigger | Preview before save, validation errors inline. |
| Toggle schedule | task row/detail | Persisted enabled state | Optimistic action avoided; confirm server result. |
| Open run | history item | Run status/output and conversation context | Missing/expired target explained. |
| Cancel run | active detail | Terminal/cancellation-requested state | Confirm, then poll/refetch until final. |

## Registry mapping and responsive strategy

No `components.json`, shared UI package, private Registry or Playwright config is present in this repository. Reuse local CSS classes and forms; do not import a second design system. At 1440/1280 px use list+detail. At 1024 px reduce sidebar/list width and prioritize status. At 390 px present list → detail → edit as successive full-width tasks rather than squeezing the desktop split.

## Validation targets and risks

- Browser viewports: 1440×900, 1280×800, 1024×768, 390×844; real Electron test for authenticated bridge actions.
- Observe real Runtime API and SQLite persistence for save/toggle/history, not just preview fixtures.
- At task start, Runtime had schedule list/create/update/enable/history and IM-target bind routes, but DesktopBridge exposed none of them; connection configuration/test routes were absent. The implementation added authenticated bridge routes and a sanitized connection summary. `docs/application-architecture.md` is an untracked user-owned file in the main checkout; do not rewrite it as an implementation artifact.
- Existing personal App process remains running; isolated test homes and ports must avoid its user data and credentials.

## Implementation verification

- Visual capture: [desktop schedules](../../../.tasks/ui/TASK-020/images/implemented-schedules-1440.png), [desktop connections](../../../.tasks/ui/TASK-020/images/implemented-connections-1440.png), [1280px](../../../.tasks/ui/TASK-020/images/implemented-schedules-1280.png), [1024px](../../../.tasks/ui/TASK-020/images/implemented-schedules-1024.png), [mobile 390px](../../../.tasks/ui/TASK-020/images/implemented-schedules-390.png). All use synthetic preview data, clearly labeled in-browser; no personal connection data was captured.
- Browser task walkthrough passed: sidebar navigation, create/preview/save schedule, list/detail, return to conversation, connection configuration/test failure with draft retained. At 1440, 1280, 1024 and 390 CSS px, no horizontal overflow was observed. Reloaded axe-core WCAG A/AA audit found zero violations; gradient-backed text remained `incomplete` for manual color-contrast review.
- An isolated Electron process using temporary `YUANPU_HOME`, userData and workspace passed actual Runtime bridge persistence for connection and schedule, schedule enable state, chat submission/cancellation, and Runtime child cleanup. No real Enterprise WeChat message was sent.
- Read-only independent review found stale history after list refresh and two connection-reconfiguration issues; all three were repaired. Focused tests now cover authentication-failure diagnostics without secret echo and per-connection startup. Enabled saves wait at most 12 seconds for authentication and restore the previous document on failure; connection test retries a disconnected target without restarting unrelated bots. Real SDK failure/retry and live in-flight delivery during reconfiguration remain for TASK-021 business verification.
- `pnpm check` passed with the repository-required Node 24.15.0 and pnpm 11.22.0. A preliminary attempt under system-default Node 26 failed only in the existing runtime-updater test because its executable could not find `libnode.147.dylib`.

## Review decision

Approved by the user on 2026-09-23: “可以，按此实现” in response to the TASK-020 sidebar + schedule list/detail layout review. [Current shell](../../../.tasks/ui/TASK-020/images/before-v001.png), [selected design v001](../../../.tasks/ui/TASK-020/images/design-v001.png), and [generation prompt](../../../.tasks/ui/TASK-020/images/prompt-v001.md) are preserved as review evidence. The image is 1586×992 (near the 1440×900 reference aspect ratio); its 2024 dates, task names, paths and execution statuses are illustrative only. Product copy and labels must use live Runtime states and correct separation of Agent execution, approval and IM delivery.
