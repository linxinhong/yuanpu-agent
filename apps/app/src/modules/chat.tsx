import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CapabilityApprovalSummary,
  NotificationNavigationTarget,
  AgentRunRecord,
  PrivateImRunSummary,
} from '@yuanpu-agent/protocol';
import mindlinkSeal from '../../themes/assets/mindlink-seal.png';

import { AppIcon } from '../shared/app-icon.js';
import { AssistantReply } from '../shared/assistant-reply.js';
import { AvatarMark } from '../shared/avatar-mark.js';
import { cacheReplyRun, findReplyRun, type ReplyRunInfo } from '../shared/reply-run-cache.js';

type ToolState = { name: string; status: 'started' | 'completed' | 'failed' };
type ChatMessage = {
  id: number;
  role: 'user' | 'assistant' | 'error';
  text: string;
  at?: string;
  tools?: ToolState[];
  run?: ReplyRunInfo;
};
type ActivityEvent = {
  id: number;
  runId: string;
  title: string;
  detail?: string;
  at: string;
  tone: 'active' | 'done' | 'warning' | 'error';
};

function runStatusLabel(status: AgentRunRecord['status']): string {
  return {
    queued: '等待执行',
    running: '正在执行',
    waiting_approval: '等待授权',
    succeeded: '已完成',
    failed: '执行失败',
    cancelled: '已取消',
    interrupted: '执行中断',
    result_unknown: '结果未知',
  }[status];
}

function activityTime(at: string): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function messageTime(at?: string): string | undefined {
  if (!at || !Number.isFinite(new Date(at).getTime())) return undefined;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('month')}月${value('day')}日 ${value('hour')}:${value('minute')}`;
}

function privateImDeliveryLabel(status: PrivateImRunSummary['replyDeliveryStatus']): string {
  return {
    not_created: '无回复投递记录',
    pending: '等待投递',
    delivering: '正在投递',
    accepted: '企业微信已接收（未确认对方可见）',
    failed: '投递失败',
    unknown: '投递结果未知（不会自动重发）',
  }[status];
}

const initialMessages: ChatMessage[] = [{
  id: 1,
  role: 'assistant',
  text: '你好，我是 YuanpuAgent。你可以直接开始对话，也可以让我调用外部 MCP 能力。',
}];
const assistantGreeting = '你好，我是你的助理。这里可以接续你绑定的企业微信私聊。';

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function maxRightPanelWidth(panelWidth: number, listOpen: boolean): number {
  const leftPanelWidth = listOpen && window.innerWidth > 780 ? window.innerWidth <= 1100 ? 240 : 260 : 0;
  const available = panelWidth - leftPanelWidth;
  return Math.max(260, Math.floor(available * 0.7));
}

export function ChatPanel({
  active,
  surface,
  navigationTarget,
  onReturnToSchedules,
  scheduleOrigin,
}: {
  active: boolean;
  surface: 'work' | 'assistant';
  navigationTarget?: NotificationNavigationTarget;
  onReturnToSchedules: () => void;
  scheduleOrigin: boolean;
}) {
  const [messages, setMessages] = useState(() => surface === 'assistant'
    ? [{ ...initialMessages[0]!, text: assistantGreeting }]
    : initialMessages);
  const [input, setInput] = useState(() => {
    try { return window.localStorage.getItem(`yuanpu:draft:${surface}`) ?? ''; }
    catch { return ''; }
  });
  const [attachments, setAttachments] = useState<Array<{ name: string; contents: string }>>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [redactionPreviewEnabled, setRedactionPreviewEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [approvals, setApprovals] = useState<CapabilityApprovalSummary[]>([]);
  const [approvalBusy, setApprovalBusy] = useState<string>();
  const [readyApprovals, setReadyApprovals] = useState<Set<string>>(new Set());
  const resolvedApprovals = useRef(new Set<string>());
  const [locationRetry, setLocationRetry] = useState(0);
  const [locatedRun, setLocatedRun] = useState<AgentRunRecord | 'loading' | 'error'>();
  const [privateImSummary, setPrivateImSummary] = useState<PrivateImRunSummary | 'loading'>();
  const [activeRunId, setActiveRunId] = useState<string>();
  const [activeRunStatus, setActiveRunStatus] = useState<AgentRunRecord['status']>();
  const [cancelBusy, setCancelBusy] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem('yuanpu:right-panel-width'));
      return stored >= 260 && stored <= 1600 ? stored : 320;
    } catch { return 320; }
  });
  const [rightPanelResizing, setRightPanelResizing] = useState(false);
  const [rightPanelMaximized, setRightPanelMaximized] = useState(false);
  const [activityTab, setActivityTab] = useState<'activity' | 'run'>('activity');
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const activityEventsRef = useRef<ActivityEvent[]>([]);
  const [lastRun, setLastRun] = useState<AgentRunRecord>();
  const [runRecovery, setRunRecovery] = useState<{ runId: string; text: string }>();
  const [bridgeError, setBridgeError] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [copiedUserMessageId, setCopiedUserMessageId] = useState<number>();
  const sending = useRef(false);
  const settledRuns = useRef(new Map<string, AgentRunRecord>());
  const activityDialog = useRef<HTMLDialogElement>(null);
  const chatPanel = useRef<HTMLElement>(null);
  const activityToggle = useRef<HTMLButtonElement>(null);
  const restoreActivityFocus = useRef(false);
  const nextActivityId = useRef(1);
  const nextId = useRef(2);
  const conversation = useRef<HTMLDivElement>(null);
  const conversationInner = useRef<HTMLDivElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const [watermarkCount, setWatermarkCount] = useState(1);
  const desktop = window.yuanpu;
  const queryClient = useQueryClient();
  const transcriptQuery = useQuery({
    queryKey: ['assistant', 'transcript', surface],
    queryFn: () => desktop!.getDesktopTranscript(surface),
    enabled: active && Boolean(desktop),
    refetchInterval: active ? 3000 : false,
  });
  const assistantLinkQuery = useQuery({
    queryKey: ['assistant', 'link'],
    queryFn: () => desktop!.getAssistantLink(),
    enabled: active && surface === 'assistant' && Boolean(desktop),
    refetchInterval: active && surface === 'assistant' ? 5000 : false,
  });
  const archiveQuery = useQuery({
    queryKey: ['assistant', 'archive'],
    queryFn: () => desktop!.getDesktopTranscript('assistantArchive'),
    enabled: active && surface === 'assistant' && archiveOpen && Boolean(desktop) && Boolean(assistantLinkQuery.data?.linked),
  });
  const mirrorQuery = useQuery({
    queryKey: ['assistant', 'mirrors', activeRunId],
    queryFn: () => desktop!.listAssistantMirrors(activeRunId!),
    enabled: active && surface === 'assistant' && Boolean(desktop) && Boolean(activeRunId),
    refetchInterval: active && surface === 'assistant' && activeRunId ? 3000 : false,
  });
  const retryMirror = useMutation({
    mutationFn: (mirrorId: string) => desktop!.retryAssistantMirror(mirrorId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['assistant', 'mirrors', activeRunId] }),
  });
  const appliedTranscript = useRef('');

  useEffect(() => {
    if (assistantLinkQuery.data && !assistantLinkQuery.data.linked) setArchiveOpen(false);
  }, [assistantLinkQuery.data?.linked]);

  useEffect(() => {
    if (busy || !transcriptQuery.data) return;
    const key = `${assistantLinkQuery.data?.contactId ?? 'local'}:${JSON.stringify(transcriptQuery.data)}`;
    if (key === appliedTranscript.current) return;
    appliedTranscript.current = key;
    nextId.current = transcriptQuery.data.length + 1;
    setMessages((current) => transcriptQuery.data!.length
      ? transcriptQuery.data!.map((item, index) => {
        const previous = current[index];
        const sameMessage = previous?.role === item.role && previous.text === item.text;
        const run = item.role === 'assistant' ? (sameMessage ? previous?.run : undefined) ?? findReplyRun(surface, item.id, item.text, item.at) : undefined;
        return sameMessage ? { ...previous, at: item.at, run } : { id: index + 1, role: item.role, text: item.text, at: item.at, run };
      })
      : surface === 'assistant'
        ? [{ ...initialMessages[0]!, text: assistantGreeting }]
        : initialMessages);
  }, [busy, transcriptQuery.data, assistantLinkQuery.data?.contactId, surface]);

  useEffect(() => {
    try { window.localStorage.setItem(`yuanpu:draft:${surface}`, input); }
    catch { /* Storage can be unavailable in a restricted preview. */ }
  }, [input, surface]);

  useEffect(() => {
    try { window.localStorage.setItem('yuanpu:right-panel-width', String(rightPanelWidth)); }
    catch { /* Storage can be unavailable in a restricted preview. */ }
  }, [rightPanelWidth]);

  useEffect(() => {
    if (!active || !chatPanel.current) return;
    const panel = chatPanel.current;
    const fit = () => setRightPanelWidth((current) => Math.min(current, maxRightPanelWidth(panel.getBoundingClientRect().width, listOpen)));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [active, listOpen]);

  useEffect(() => {
    if (surface !== 'work' || !conversationInner.current) return;
    const content = conversationInner.current;
    const update = () => setWatermarkCount(Math.max(1, Math.ceil((content.scrollHeight - 400) / 800)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(content);
    return () => observer.disconnect();
  }, [surface]);

  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 560px)');
    const compact = window.matchMedia('(max-width: 780px)');
    const handleWidthChange = (event: MediaQueryListEvent) => {
      if (event.matches) setActivityOpen(false);
    };
    narrow.addEventListener('change', handleWidthChange);
    compact.addEventListener('change', handleWidthChange);
    return () => {
      narrow.removeEventListener('change', handleWidthChange);
      compact.removeEventListener('change', handleWidthChange);
    };
  }, []);

  useEffect(() => {
    const dialog = activityDialog.current;
    if (activityOpen && active && dialog) {
      if (window.matchMedia('(max-width: 560px)').matches) dialog.showModal();
      else dialog.open = true;
      return () => dialog.close();
    }
    if (!activityOpen && active && restoreActivityFocus.current) {
      activityToggle.current?.focus();
      restoreActivityFocus.current = false;
    }
  }, [activityOpen, active]);

  function recordActivity(runId: string, title: string, tone: ActivityEvent['tone'], detail?: string, at = new Date().toISOString()) {
    const event = { id: nextActivityId.current++, runId, title, tone, detail, at };
    activityEventsRef.current = [...activityEventsRef.current, event];
    setActivityEvents((current) => [...current, event]);
  }

  async function refreshApprovals() {
    if (!desktop) return [];
    const pendingApprovals = await desktop.listCapabilityApprovals();
    const ready = await Promise.all(pendingApprovals.map(async (approval) => {
      if (!approval.runId) return approval.requestId;
      const run = await desktop.getAgentRun(approval.runId);
      return run.status === 'waiting_approval' && run.pendingApproval?.approvalRequestId === approval.requestId
        ? approval.requestId : undefined;
    }));
    setBridgeError(false);
    setReadyApprovals(new Set(ready.filter((id): id is string => Boolean(id))));
    setApprovals(pendingApprovals.filter((approval) => !resolvedApprovals.current.has(approval.requestId)));
    return pendingApprovals;
  }

  useEffect(() => {
    if (!desktop || !active) return;
    const refresh = () => void refreshApprovals().catch(() => setBridgeError(true));
    refresh();
    const timer = window.setInterval(refresh, 1_500);
    return () => window.clearInterval(timer);
  }, [desktop, active]);

  useEffect(() => {
    const runId = navigationTarget?.runId;
    if (!desktop || !runId) {
      setLocatedRun(undefined);
      setPrivateImSummary(undefined);
      return;
    }
    let cancelled = false;
    setLocatedRun('loading');
    setPrivateImSummary('loading');
    void desktop.getAgentRun(runId).then(
      (run) => { if (!cancelled) setLocatedRun(run); },
      () => { if (!cancelled) setLocatedRun('error'); },
    );
    void desktop.getPrivateImRunSummary(runId).then(
      (summary) => { if (!cancelled) setPrivateImSummary(summary); },
      () => { if (!cancelled) setPrivateImSummary(undefined); },
    );
    return () => { cancelled = true; };
  }, [desktop, navigationTarget?.runId, locationRetry]);

  useEffect(() => {
    if (!desktop || !active || !navigationTarget?.runId || !locatedRun || typeof locatedRun === 'string') return;
    if (['succeeded', 'failed', 'cancelled', 'interrupted', 'result_unknown'].includes(locatedRun.status)) return;
    let stale = false;
    const timer = window.setInterval(() => {
      void desktop.getAgentRun(navigationTarget.runId!).then((run) => {
        if (!stale) setLocatedRun(settledRuns.current.get(run.runId) ?? run);
      }).catch(() => { if (!stale) setLocatedRun('error'); });
    }, 1_200);
    return () => { stale = true; window.clearInterval(timer); };
  }, [desktop, active, navigationTarget?.runId, locatedRun]);

  useEffect(() => {
    if (!desktop || !active || !navigationTarget?.runId || !privateImSummary || privateImSummary === 'loading') return;
    if (!['not_created', 'pending', 'delivering'].includes(privateImSummary.replyDeliveryStatus)) return;
    const timer = window.setInterval(() => {
      void desktop.getPrivateImRunSummary(navigationTarget.runId!).then(setPrivateImSummary).catch(() => undefined);
    }, 1_200);
    return () => window.clearInterval(timer);
  }, [desktop, active, navigationTarget?.runId, privateImSummary]);

  useEffect(() => {
    conversation.current?.scrollTo({ top: conversation.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  useEffect(() => {
    if (navigationTarget?.runId && locatedRun && typeof locatedRun !== 'string') {
      conversation.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [navigationTarget?.runId, locatedRun]);

  async function observeRun(runId: string, text: string) {
    if (!desktop) return;
    let lastSeenStatus: AgentRunRecord['status'] | undefined;
    try {
      while (true) {
        const fetched = await desktop.getAgentRun(runId);
        const run = settledRuns.current.get(runId) ?? fetched;
        const terminal = ['succeeded', 'failed', 'cancelled', 'interrupted', 'result_unknown'].includes(run.status);
        if (terminal) settledRuns.current.set(runId, run);
        setLastRun(run);
        setActiveRunStatus(run.status);
        if (run.status !== lastSeenStatus) {
          const tone: ActivityEvent['tone'] = run.status === 'succeeded' ? 'done'
            : ['failed', 'interrupted', 'result_unknown'].includes(run.status) ? 'error'
              : ['waiting_approval', 'cancelled'].includes(run.status) ? 'warning' : 'active';
          recordActivity(run.runId, runStatusLabel(run.status), tone, run.failure?.message, run.updatedAt);
          lastSeenStatus = run.status;
        }
        if (terminal) {
          run.output?.tools.forEach((tool) => recordActivity(run.runId,
            tool.status === 'completed' ? '工具调用完成' : '工具调用失败',
            tool.status === 'completed' ? 'done' : 'error', tool.name, run.updatedAt));
          const replyText = run.status === 'succeeded' ? run.output?.message ?? '任务已完成；可在运行记录中查看结果。'
            : run.failure?.message ?? `任务结束：${runStatusLabel(run.status)}`;
          const replyRun = run.status === 'succeeded' ? cacheReplyRun(surface, replyText, run,
            activityEventsRef.current.filter((event) => event.runId === run.runId)) : undefined;
          setMessages((current) => [...current, {
            id: nextId.current++, role: run.status === 'succeeded' ? 'assistant' : 'error',
            text: replyText,
            tools: run.output?.tools.map((tool) => ({ name: tool.name, status: tool.status })),
            run: replyRun,
          }]);
          if (run.status !== 'succeeded') setInput((current) => current || text);
          setRunRecovery(undefined);
          setActiveRunId(undefined);
          setActiveRunStatus(undefined);
          return;
        }
        await new Promise((resolveWait) => window.setTimeout(resolveWait, 900));
      }
    } catch (error) {
      // The accepted run may still be executing. Resume observation, never resubmit it.
      setRunRecovery({ runId, text });
      recordActivity(runId, '状态获取失败', 'error', formatError(error));
    }
  }

  async function resumeRun() {
    if (!runRecovery || sending.current) return;
    sending.current = true;
    setBusy(true);
    try { await observeRun(runRecovery.runId, runRecovery.text); }
    finally { sending.current = false; setBusy(false); }
  }

  async function sendMessage() {
    const draft = input.trim();
    const includedAttachments = attachments;
    if ((!draft && !includedAttachments.length) || sending.current || runRecovery) return;
    const text = includedAttachments.length
      ? `${draft || '请阅读附件。'}\n\n${includedAttachments.map((file) => `附件 ${file.name}：\n${file.contents}`).join('\n\n')}`
      : draft;
    sending.current = true;
    setMessages((current) => [...current, { id: nextId.current++, role: 'user', text, at: new Date().toISOString() }]);
    setInput('');
    setAttachments([]);
    setBusy(true);
    setLastRun(undefined);
    setActiveRunStatus(undefined);
    try {
      if (!desktop) {
        setMessages((current) => [...current, { id: nextId.current++, role: 'assistant',
          text: '这是浏览器预览回复。通过桌面应用启动后，消息会交给本地助理处理。' }]);
      } else {
        const receipt = await desktop.submitDesktopMessage(text, surface);
        setActiveRunId(receipt.runId);
        setActiveRunStatus(receipt.status);
        recordActivity(receipt.runId, '已提交任务', 'done');
        await observeRun(receipt.runId, text);
      }
    } catch (error) {
      setMessages((current) => [...current, { id: nextId.current++, role: 'error', text: formatError(error) }]);
      recordActivity('submission', '提交失败', 'error', formatError(error));
      setInput((current) => current || draft);
      setAttachments(includedAttachments);
    } finally {
      sending.current = false;
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: ['assistant', 'transcript', surface] });
      void refreshApprovals().catch(() => setBridgeError(true));
    }
  }

  async function addAttachments(files: FileList | null) {
    const selected = Array.from(files ?? []);
    if (attachmentInput.current) attachmentInput.current.value = '';
    const remaining = Math.max(0, 3 - attachments.length);
    if (selected.length > remaining) setAttachmentError('每条消息最多添加 3 个文本附件。');
    else setAttachmentError('');
    const added: Array<{ name: string; contents: string }> = [];
    for (const file of selected.slice(0, remaining)) {
      if (file.size > 100_000 || !/\.(txt|md|json|csv|ts|tsx|js|jsx|py|yaml|yml|xml|html|css)$/i.test(file.name)) {
        setAttachmentError('仅支持 100 KB 以内的文本附件。');
        continue;
      }
      added.push({ name: file.name, contents: await file.text() });
    }
    if (added.length) setAttachments((current) => [...current, ...added]);
  }

  async function copyUserMessage(message: ChatMessage) {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopiedUserMessageId(message.id);
    } catch { setCopiedUserMessageId(undefined); }
  }

  async function cancelRun(runId: string) {
    if (!desktop || cancelBusy || !window.confirm('取消这个正在执行的任务？已经发生的外部操作无法撤销。')) return;
    setCancelBusy(true);
    try {
      const receipt = await desktop.cancelAgentRun(runId);
      if (receipt.result === 'not_found') throw new Error('任务不可用或无权取消。');
      const run = await desktop.getAgentRun(runId);
      if (['succeeded', 'failed', 'cancelled', 'interrupted', 'result_unknown'].includes(run.status)) {
        settledRuns.current.set(runId, run);
      }
      if (navigationTarget?.runId === runId) setLocatedRun(run);
      if (runRecovery?.runId === runId) await resumeRun();
    } catch (error) {
      setMessages((current) => [...current, { id: nextId.current++, role: 'error', text: `取消失败：${formatError(error)}` }]);
    } finally {
      setCancelBusy(false);
    }
  }

  async function decideApproval(
    approval: CapabilityApprovalSummary,
    decision: 'approved' | 'denied',
  ) {
    if (!desktop || approvalBusy || !readyApprovals.has(approval.requestId)) return;
    setApprovalBusy(approval.requestId);
    try {
      const result = await desktop.decideCapabilityApproval(approval.requestId, decision);
      resolvedApprovals.current.add(approval.requestId);
      setApprovals((current) => current.filter((item) => item.requestId !== approval.requestId));
      if (approval.runId && [activeRunId, lastRun?.runId, navigationTarget?.runId].includes(approval.runId)) {
        recordActivity(approval.runId, decision === 'approved' ? '已允许一次' : '已拒绝授权', decision === 'approved' ? 'done' : 'warning', approval.capabilityId);
      }
      if (decision === 'denied') {
        setMessages((current) => [...current, {
          id: nextId.current++,
          role: 'assistant',
          text: `已拒绝能力 ${approval.capabilityId} 的本次调用，没有执行外部操作。`,
        }]);
        return;
      }
      if (approval.runId === activeRunId) {
        await refreshApprovals();
        return;
      }
      setMessages((current) => [...current, {
        id: nextId.current++,
        role: 'assistant',
        text: result.message ?? `能力 ${approval.capabilityId} 已执行。`,
      }]);
      await refreshApprovals();
    } catch (error) {
      setMessages((current) => [...current, {
        id: nextId.current++,
        role: 'error',
        text: `审批处理失败：${formatError(error)}`,
      }]);
    } finally {
      setApprovalBusy(undefined);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      void sendMessage();
    }
  }

  const visibleRun = navigationTarget?.runId
    ? (locatedRun && typeof locatedRun !== 'string' ? locatedRun : undefined)
    : lastRun;
  const currentStatus = visibleRun?.status ?? (navigationTarget?.runId ? undefined : activeRunStatus);
  const visibleEvents = navigationTarget?.runId
    ? activityEvents.filter((event) => event.runId === navigationTarget.runId)
    : activityEvents;
  const emptyConversation = !archiveOpen && !busy && !locatedRun && !runRecovery
    && approvals.length === 0 && messages.length === 1 && messages[0]?.id === 1
    && messages[0].role === 'assistant'
    && messages[0].text === (surface === 'assistant' ? assistantGreeting : initialMessages[0]?.text);

  function resizeRightPanel(clientX: number, panel: HTMLElement) {
    const bounds = panel.getBoundingClientRect();
    const max = maxRightPanelWidth(bounds.width, listOpen);
    const requested = bounds.right - clientX;
    if (requested > max) {
      setRightPanelMaximized(true);
      return;
    }
    setRightPanelMaximized(false);
    setRightPanelWidth(Math.round(Math.max(260, Math.min(max, requested))));
  }

  return (
    <section ref={chatPanel} className={`chat-panel ${surface}-mode ${emptyConversation ? 'is-empty' : ''} ${listOpen ? 'list-open' : 'list-closed'} ${activityOpen ? 'activity-open' : 'activity-closed'} ${rightPanelMaximized ? 'right-panel-maximized' : ''} ${rightPanelResizing ? 'right-panel-resizing' : ''} ${active ? '' : 'view-hidden'}`}
      style={{ '--yp-right-panel-width': `${rightPanelWidth}px` } as CSSProperties} aria-hidden={!active}>
      {listOpen && <aside className="conversation-list-preview" aria-label={surface === 'work' ? '工作列表预览' : '会话列表预览'}>
        <div className="conversation-list-heading"><strong>{surface === 'work' ? '工作列表' : '会话列表'}</strong></div>
        <div className="conversation-list-current"><span>{archiveOpen ? '原桌面会话' : '当前会话'}</span><small>当前</small></div>
        <p>历史会话列表尚未接入，此处为界面预览。</p>
      </aside>}
      <div className="chat-main">
        {surface === 'work' && emptyConversation && <div className="mindlink-work-background" aria-hidden="true">
          <img src={mindlinkSeal} alt="" /><strong>元朴思联</strong><span>MindLink</span>
        </div>}
        <header className="chat-header">
          <div className="chat-heading">
            <button type="button" className="chat-list-toggle" title={`${listOpen ? '收起' : '打开'}${surface === 'work' ? '工作列表' : '会话列表'}（界面预览）`}
              aria-label={`${listOpen ? '收起' : '打开'}${surface === 'work' ? '工作列表' : '会话列表'}（界面预览）`} aria-expanded={listOpen}
              onClick={() => setListOpen((value) => !value)}><AppIcon name="panel-left" /></button>
            <span className="chat-toolbar-divider" aria-hidden="true" />
            <nav className="chat-breadcrumb" aria-label="会话位置">
              <span>{surface === 'work' ? '工作' : '助理'}</span><AppIcon name="chevron" />
              <strong>{archiveOpen ? '原桌面会话' : scheduleOrigin ? '定时任务会话' : '当前会话'}</strong>
            </nav>
            <button type="button" className="chat-rename-preview" disabled title="重命名会话尚未接入（界面预览）" aria-label="重命名会话（界面预览）"><AppIcon name="edit" /></button>
          </div>
          <div className="runtime-meta">
            {navigationTarget && (
              <span role="status">
                {locatedRun === 'loading' || (locatedRun === 'error' && privateImSummary === 'loading')
                  ? '正在加载任务记录…'
                  : privateImSummary && privateImSummary !== 'loading'
                    ? `企业微信 · ${privateImSummary.runStatus} · ${privateImDeliveryLabel(privateImSummary.replyDeliveryStatus)}`
                  : locatedRun === 'error'
                    ? '任务记录不可用'
                    : locatedRun
                      ? `${locatedRun.owner.entryPoint === 'scheduler' ? '定时任务' : locatedRun.owner.entryPoint === 'im' ? '企业微信' : '桌面'} · ${locatedRun.status} · 会话 ${locatedRun.context.conversation.conversationId}`
                      : `已定位会话 ${navigationTarget.conversationId}`}
              </span>
            )}
            {locatedRun === 'error' && <button type="button" className="runtime-link" onClick={() => setLocationRetry((value) => value + 1)}>重新获取任务</button>}
            {scheduleOrigin && <button type="button" className="runtime-link" onClick={onReturnToSchedules}>返回定时任务</button>}
            {locatedRun && typeof locatedRun !== 'string' && ['queued', 'running', 'waiting_approval'].includes(locatedRun.status) && locatedRun.owner.entryPoint !== 'im' && (
              <button type="button" className="runtime-link" disabled={cancelBusy} onClick={() => void cancelRun(locatedRun.runId)}>取消运行</button>
            )}
            {activityOpen && <button type="button" className="panel-maximize-toggle" title={rightPanelMaximized ? '还原右侧面板' : '铺满右侧面板'}
              aria-label={rightPanelMaximized ? '还原右侧面板' : '铺满右侧面板'} aria-pressed={rightPanelMaximized}
              onClick={() => setRightPanelMaximized((value) => !value)}><AppIcon name={rightPanelMaximized ? 'collapse' : 'expand'} /></button>}
            <button ref={activityToggle} type="button" className="panel-toggle" title={`${activityOpen ? '收起' : '打开'}运行详情`}
              aria-label={`${activityOpen ? '收起' : '打开'}运行详情`} aria-expanded={activityOpen}
              onClick={() => { restoreActivityFocus.current = true; if (activityOpen) setRightPanelMaximized(false); setActivityOpen((value) => !value); }}><AppIcon name="panel" /><span className="panel-toggle-label">运行详情</span></button>
          </div>
          {surface === 'assistant' && <div className="assistant-channel-state" role="status">
            {archiveOpen ? '原桌面会话归档 · 只读' : assistantLinkQuery.data?.linked
              ? '已连接企业微信私聊 · 桌面消息与回复将同步投递'
              : assistantLinkQuery.error ? '助理连接状态不可用' : '桌面助理 · 可在设置中绑定企业微信私聊'}
            {assistantLinkQuery.data?.linked && <button type="button" className="runtime-link" onClick={() => setArchiveOpen((value) => !value)}>
              {archiveOpen ? '返回已绑定会话' : '查看原桌面会话'}
            </button>}
          </div>}
        </header>

        <div className="conversation" ref={conversation} aria-live="polite">
          <div className="conversation-inner" ref={conversationInner}>
            {surface === 'work' && !emptyConversation && <div className="mindlink-work-background-track" aria-hidden="true">
              {Array.from({ length: watermarkCount }, (_, index) =>
                <div className="mindlink-work-background" key={index} style={{ top: `${400 + index * 800}px` }}>
                  <img src={mindlinkSeal} alt="" /><strong>元朴思联</strong><span>MindLink</span>
                </div>)}
            </div>}
            {emptyConversation && <div className="empty-chat">
              <div className="mindlink-welcome" aria-label="元朴思联 MindLink">
                <img src={mindlinkSeal} alt="" />
                <strong>元朴思联</strong><span>MindLink</span>
              </div>
              <div className="empty-chat-heading">
                <div className="empty-chat-mark" aria-hidden="true"><AvatarMark /></div>
                <h1>{surface === 'work' ? '开始一项工作' : '你的桌面助理'}</h1>
              </div>
              <p>{messages[0]?.text}</p>
            </div>}
            {locatedRun && typeof locatedRun !== 'string' && (
              <article className="located-run-card">
                <div className="approval-heading"><span>运行详情</span><strong>{locatedRun.owner.entryPoint === 'scheduler' ? '定时任务' : locatedRun.owner.entryPoint === 'im' ? '企业微信会话' : '桌面对话'}</strong></div>
                <dl>
                  <div><dt>运行状态</dt><dd>{locatedRun.status}</dd></div>
                  {locatedRun.owner.entryPoint === 'im' && <div><dt>回复投递</dt><dd>{privateImSummary && privateImSummary !== 'loading' ? privateImDeliveryLabel(privateImSummary.replyDeliveryStatus) : '状态暂不可用'}</dd></div>}
                  <div><dt>会话</dt><dd>{locatedRun.context.conversation.conversationId}</dd></div>
                  <div><dt>工作区</dt><dd>{locatedRun.context.workspaceId}</dd></div>
                </dl>
                {locatedRun.output?.message && <p>{locatedRun.output.message}</p>}
                {locatedRun.failure && <p role="alert">{locatedRun.failure.message}</p>}
                {scheduleOrigin && <button type="button" className="runtime-link" onClick={onReturnToSchedules}>返回关联定时任务</button>}
              </article>
            )}
            {locatedRun === 'error' && privateImSummary && privateImSummary !== 'loading' && (
              <article className="located-run-card">
                <div className="approval-heading"><span>运行详情</span><strong>企业微信私聊</strong></div>
                <dl>
                  <div><dt>运行状态</dt><dd>{privateImSummary.runStatus}</dd></div>
                  <div><dt>回复投递</dt><dd>{privateImDeliveryLabel(privateImSummary.replyDeliveryStatus)}</dd></div>
                </dl>
              </article>
            )}
            {(archiveOpen ? (archiveQuery.data ?? []).map((item, index): ChatMessage => ({ id: index + 1, role: item.role, text: item.text, at: item.at })) : emptyConversation ? [] : messages).map((message) => (
              <article key={message.id} className={`message ${message.role}`}>
                <div className="message-label">
                  {message.role === 'user' ? '你' : message.role === 'error' ? '运行错误' : 'YuanpuAgent'}
                </div>
                <div className="message-body">
                  {message.role === 'assistant' ? <AssistantReply text={message.text} surface={surface} run={message.run} /> : <p>{message.text}</p>}
                  {message.role !== 'assistant' && message.tools?.map((tool) => (
                    <div className={`tool-event ${tool.status}`} key={`${message.id}-${tool.name}`}>
                      <span className="tool-check">{tool.status === 'completed' ? '✓' : '!'}</span>
                      <span>调用 MCP</span><code>{tool.name}</code>
                      <small>{tool.status === 'completed' ? '已完成' : '失败'}</small>
                    </div>
                  ))}
                </div>
                {message.role === 'user' && <div className="user-message-meta">
                  {messageTime(message.at) && <time dateTime={message.at}>{messageTime(message.at)}</time>}
                  <button type="button" className={copiedUserMessageId === message.id ? 'copied' : ''}
                    aria-label={copiedUserMessageId === message.id ? '已复制这条消息' : '复制这条消息'} data-tooltip={copiedUserMessageId === message.id ? '已复制' : '复制'}
                    onClick={() => void copyUserMessage(message)}><AppIcon name={copiedUserMessageId === message.id ? 'check' : 'copy'} /></button>
                </div>}
              </article>
            ))}
            {archiveOpen && archiveQuery.isLoading && <p className="archive-notice">正在读取原桌面会话…</p>}
            {archiveOpen && archiveQuery.error && <p className="archive-notice" role="alert">原桌面会话读取失败：{formatError(archiveQuery.error)}</p>}
            {archiveOpen && archiveQuery.data?.length === 0 && <p className="archive-notice">原桌面会话还没有消息。</p>}
            {!archiveOpen && surface === 'assistant' && mirrorQuery.data?.length ? <div className="assistant-mirror-status" aria-label="企业微信投递状态">
              {mirrorQuery.data.map((mirror) => <div key={mirror.mirrorId}>
                <span>{mirror.part === 'user' ? '消息' : '回复'}：{mirror.status === 'accepted' ? '企业微信已接收' : mirror.status === 'pending' ? '等待投递' : mirror.status === 'delivering' ? '正在投递' : mirror.status === 'unknown' ? '结果未知' : '投递失败'}</span>
                {mirror.status === 'failed' && <button type="button" disabled={retryMirror.isPending} onClick={() => retryMirror.mutate(mirror.mirrorId)}>重试投递</button>}
              </div>)}
              {retryMirror.error && <p role="alert">{formatError(retryMirror.error)}</p>}
            </div> : null}
            {!archiveOpen && approvals.map((approval) => (
              <article className="approval-card" key={approval.requestId}>
                <div className="approval-heading">
                  <span>待确认</span>
                  <strong>外部能力请求一次性授权</strong>
                </div>
                <dl>
                  <div><dt>能力</dt><dd>{approval.capabilityId}</dd></div>
                  <div><dt>来源</dt><dd>{approval.sourceInstanceId}</dd></div>
                  <div><dt>版本</dt><dd>{approval.packageVersion ?? '未声明'}</dd></div>
                  <div><dt>参数摘要</dt><dd><code>{approval.argumentsDigest.slice(0, 16)}…</code></dd></div>
                </dl>
                <p>允许只对当前会话、当前参数和当前版本生效一次；刷新或重放不会复用。</p>
                <div className="approval-actions">
                  <button type="button" disabled={Boolean(approvalBusy) || !readyApprovals.has(approval.requestId)} onClick={() => void decideApproval(approval, 'denied')}>拒绝</button>
                  <button type="button" className="primary" disabled={Boolean(approvalBusy) || !readyApprovals.has(approval.requestId)} onClick={() => void decideApproval(approval, 'approved')}>
                    {approvalBusy === approval.requestId ? '处理中…' : !readyApprovals.has(approval.requestId) ? '正在准备授权…' : '允许一次'}
                  </button>
                </div>
              </article>
            ))}
            {!archiveOpen && busy && (
              <article className="message assistant pending">
                <div className="message-label">YuanpuAgent</div>
                <div className="thinking"><span /><span /><span /> {activeRunStatus === 'waiting_approval' ? '等待授权' : '正在处理'}{activeRunId && <button type="button" className="runtime-link" disabled={cancelBusy} onClick={() => void cancelRun(activeRunId)}>取消任务</button>}</div>
              </article>
            )}
          </div>
        </div>

        <div className="composer-wrap">
          {bridgeError && <p role="status">暂时无法读取授权状态，正在重连…</p>}
          {runRecovery && <div className="run-recovery" role="alert">
            <span>无法获取任务状态。任务可能仍在执行，请恢复查看后再发送。</span>
            <button type="button" disabled={busy} onClick={() => void resumeRun()}>重新获取状态</button>
            <button type="button" disabled={cancelBusy || busy} onClick={() => void cancelRun(runRecovery.runId)}>取消任务</button>
          </div>}
          <div className="composer">
            <input ref={attachmentInput} className="composer-attachment-input" type="file" multiple
              accept=".txt,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.yaml,.yml,.xml,.html,.css"
              onChange={(event) => void addAttachments(event.currentTarget.files)} />
            <textarea
              aria-label="消息"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={archiveOpen ? '归档只读，请返回已绑定会话继续对话' : '今天帮你做些什么？'}
              disabled={archiveOpen}
              rows={3}
            />
            {attachments.length > 0 && <div className="composer-attachments" aria-label="待发送附件">
              {attachments.map((file, index) => <span key={`${file.name}-${index}`}>{file.name}
                <button type="button" aria-label={`移除附件 ${file.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>
              </span>)}
            </div>}
            <div className="composer-toolbar">
              <div className="composer-actions">
                <button type="button" className="composer-utility" title="添加文本附件" aria-label="添加附件" disabled={archiveOpen || busy}
                  onClick={() => attachmentInput.current?.click()}><AppIcon name="plus" /></button>
                <details className="composer-permissions"><summary><AppIcon name="lock" />默认权限<AppIcon name="chevron" /></summary>
                  <div className="composer-permission-popover">
                    <p>当前使用 Runtime 默认权限，能力操作仍按现有审批规则执行。</p>
                    <label>允许完全访问 <input type="checkbox" disabled /></label>
                    <small>完全访问需接入 Runtime 策略后才能生效。</small>
                  </div>
                </details>
                <button type="button" className="composer-redaction-preview" title={`脱敏${redactionPreviewEnabled ? '已选中' : '未选中'} · 界面预览，尚未生效`}
                  aria-label={`${redactionPreviewEnabled ? '关闭' : '启用'}脱敏（界面预览，尚未生效）`} aria-pressed={redactionPreviewEnabled}
                  onClick={() => setRedactionPreviewEnabled((value) => !value)}><AppIcon name={redactionPreviewEnabled ? 'shield-filled' : 'shield'} /></button>
              </div>
              {(archiveOpen || busy) && <span className="composer-hint">{archiveOpen ? '原桌面会话归档只读' : '任务执行中'}</span>}
              <button type="button" onClick={() => void sendMessage()} disabled={archiveOpen || (!input.trim() && attachments.length === 0) || busy || Boolean(runRecovery)} aria-label="发送消息"><AppIcon name="send" /></button>
            </div>
          </div>
          {attachmentError && <p className="composer-attachment-error" role="alert">{attachmentError}</p>}
        </div>
      </div>
      {activityOpen && (
        <dialog ref={activityDialog} className="activity-panel" aria-label="当前会话动态" onCancel={() => { setActivityOpen(false); setRightPanelMaximized(false); }}>
          <div className="activity-resize-handle" role="separator" aria-label="调整右侧栏宽度" aria-orientation="vertical" aria-valuemin={260}
            aria-valuemax={maxRightPanelWidth(window.innerWidth - 100, listOpen)} aria-valuenow={rightPanelWidth} tabIndex={0}
            onPointerDown={(event) => {
              if (window.matchMedia('(max-width: 560px)').matches) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              setRightPanelResizing(true);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const panel = event.currentTarget.closest<HTMLElement>('.chat-panel');
              if (panel) resizeRightPanel(event.clientX, panel);
            }}
            onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setRightPanelResizing(false); }}
            onPointerCancel={() => setRightPanelResizing(false)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const panel = event.currentTarget.closest<HTMLElement>('.chat-panel');
              if (!panel) return;
              const bounds = panel.getBoundingClientRect();
              resizeRightPanel(bounds.right - rightPanelWidth + (event.key === 'ArrowLeft' ? -16 : 16), panel);
            }} />
          <div className="activity-panel-heading"><strong>运行详情</strong><span>{surface === 'work' ? '当前工作' : '助理会话'}</span></div>
          <div className="activity-tabs" role="group" aria-label="会话信息">
            <button type="button" aria-pressed={activityTab === 'activity'} onClick={() => setActivityTab('activity')}>动态</button>
            <button type="button" aria-pressed={activityTab === 'run'} onClick={() => setActivityTab('run')}>运行</button>
          </div>
          {activityTab === 'activity' ? (
            <div className="activity-content">
              <div className="activity-section-heading">
                <h2>当前会话</h2>
                <span>{currentStatus ? runStatusLabel(currentStatus) : '等待新任务'}</span>
              </div>
              {visibleRun && <div className={`activity-current ${visibleRun.status}`}>
                <span className="activity-current-dot" />
                <div><strong>{runStatusLabel(visibleRun.status)}</strong><small>{visibleRun.owner.entryPoint === 'scheduler' ? '定时任务' : visibleRun.owner.entryPoint === 'im' ? '企业微信任务' : '桌面对话任务'}</small></div>
                <time>{activityTime(visibleRun.updatedAt)}</time>
              </div>}
              <h3>活动记录</h3>
              {visibleEvents.length > 0 ? (
                <ol className="activity-list">
                  {[...visibleEvents].reverse().map((event) => <li className={`activity-item ${event.tone}`} key={event.id}>
                    <span className="activity-symbol" aria-hidden="true">{event.tone === 'done' ? '✓' : event.tone === 'error' ? '!' : event.tone === 'warning' ? '·' : '••'}</span>
                    <div><strong>{event.title}</strong>{event.detail && <small>{event.detail}</small>}<time>{activityTime(event.at)}</time></div>
                  </li>)}
                </ol>
              ) : visibleRun ? (
                <div className="activity-empty"><strong>{runStatusLabel(visibleRun.status)}</strong><span>该任务的详细过程暂无记录。</span></div>
              ) : (
                <div className="activity-empty"><strong>还没有运行记录</strong><span>发送消息后，当前会话的任务状态会显示在这里。</span></div>
              )}
            </div>
          ) : (
            <div className="activity-content">
              <h2>最近一次运行</h2>
              {visibleRun ? <dl className="activity-run-facts">
                <div><dt>状态</dt><dd>{runStatusLabel(visibleRun.status)}</dd></div>
                <div><dt>来源</dt><dd>{visibleRun.owner.entryPoint === 'scheduler' ? '定时任务' : visibleRun.owner.entryPoint === 'im' ? '企业微信' : '桌面'}</dd></div>
                <div><dt>开始</dt><dd>{new Date(visibleRun.createdAt).toLocaleString('zh-CN')}</dd></div>
                <div><dt>更新</dt><dd>{new Date(visibleRun.updatedAt).toLocaleString('zh-CN')}</dd></div>
                <div><dt>运行 ID</dt><dd><code>{visibleRun.runId}</code></dd></div>
              </dl> : <div className="activity-empty"><strong>还没有运行记录</strong><span>任务提交后可在这里查看状态与时间。</span></div>}
            </div>
          )}
        </dialog>
      )}
    </section>
  );
}
