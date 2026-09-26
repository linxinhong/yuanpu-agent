import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { AgentRunRecord, AssistantDelegationRecord, AssistantEvidenceRef, AssistantLinkStatus,
  AssistantReviewJudgment, ScheduleRecord } from '@yuanpu-agent/protocol';
import { AppIcon } from '../shared/app-icon.js';
import { MessageContent } from '../shared/message-content.js';
import { readSavedContent, removeSavedContent, savedContentEvent } from '../shared/saved-content.js';
import { AssistantCompanion } from '../shared/assistant-companion.js';
import type { AssistantActivity } from '../shared/assistant-activity.js';
import './assistant-home.css';

const tabs = ['今日', '任务', '记忆', '连接'] as const;
type Tab = typeof tabs[number];
const runLabels: Record<AgentRunRecord['status'], string> = {
  queued: '等待执行', running: '正在执行', waiting_approval: '等待授权', succeeded: '已完成',
  failed: '执行失败', cancelled: '已取消', interrupted: '执行中断', result_unknown: '结果未知',
};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const dateTime = (at: string) => new Date(at).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const reviewLabels: Record<AssistantReviewJudgment, string> = {
  supported: '有证据支持', partial: '部分完成', failed: '未完成', unverified: '待核实',
};
const deliveryLabels = { not_requested: '仅在助理收件箱', accepted: '企业微信已接收，未确认已读',
  failed: '企微投递失败', unknown: '企微投递结果未知' } as const;
const delegationLabels: Record<AssistantDelegationRecord['status'], string> = {
  accepted: '已接受', running: '执行中', waiting_approval: '等待授权',
  completed: '子任务已完成，待核对证据', failed: '执行失败', cancelled: '已取消', unknown: '结果未知',
};

export function AssistantHome({ active, link, linkLoading, linkError, retryLink, run, activity,
  archiveOpen, onToggleArchive, onOpenWorkConversation }: {
  active: boolean;
  link?: AssistantLinkStatus;
  linkLoading: boolean;
  linkError: unknown;
  retryLink: () => void;
  run?: AgentRunRecord;
  activity: AssistantActivity;
  archiveOpen: boolean;
  onToggleArchive: () => void;
  onOpenWorkConversation: (conversationId: string) => void;
}) {
  const desktop = window.yuanpu;
  const navigate = useNavigate();
  const client = useQueryClient();
  const [tab, setTab] = useState<Tab>('今日');
  const [selectedSchedule, setSelectedSchedule] = useState<string>();
  const [selectedMemory, setSelectedMemory] = useState<string>();
  const [selectedSaved, setSelectedSaved] = useState<string>();
  const [selectedSuggestion, setSelectedSuggestion] = useState<string>();
  const [selectedReview, setSelectedReview] = useState<string>();
  const [selectedDelegation, setSelectedDelegation] = useState<string>();
  const [memoryDraft, setMemoryDraft] = useState('');
  const [editingMemory, setEditingMemory] = useState(false);
  const [forgetConfirm, setForgetConfirm] = useState(false);
  const [delegationDraft, setDelegationDraft] = useState('');
  const [memoryLimit, setMemoryLimit] = useState(100);
  const [memories, setMemories] = useState(readSavedContent);
  const [memoryError, setMemoryError] = useState('');
  const [taskKind, setTaskKind] = useState<'reviews' | 'delegations' | 'runs' | 'schedules'>('reviews');
  const scroll = useRef<HTMLDivElement>(null);
  const correctionRequest = useRef<{ id: string; version: number; text: string;
    revisionId: string } | undefined>(undefined);
  const positions = useRef<Partial<Record<Tab, number>>>({});
  const schedules = useQuery({
    queryKey: ['assistant', 'schedules'], queryFn: () => desktop!.listSchedules(),
    enabled: active && Boolean(desktop), refetchInterval: active ? 10000 : false,
  });
  const workspace = useQuery({ queryKey: ['assistant', 'workspace', memoryLimit],
    queryFn: () => desktop!.getAssistantWorkspace(memoryLimit), enabled: active && Boolean(desktop),
    refetchInterval: active ? 5000 : false });
  const suggestions = useQuery({ queryKey: ['assistant', 'suggestions'],
    queryFn: () => desktop!.listAssistantSuggestions(), enabled: active && Boolean(desktop),
    refetchInterval: active ? 5000 : false });
  const refreshWorkspace = () => void client.invalidateQueries({ queryKey: ['assistant', 'workspace'] });
  const refreshSuggestions = () => void client.invalidateQueries({ queryKey: ['assistant', 'suggestions'] });
  const suggestionFeedback = useMutation({ mutationFn: (input: { id: string;
    action: 'ignored' | 'snoozed' | 'accepted'; until?: string }) =>
    desktop!.feedbackAssistantSuggestion(input.id, input.action, input.until),
    onSuccess: refreshSuggestions });
  const suggestionRead = useMutation({ mutationFn: (id: string) => desktop!.markAssistantSuggestionRead(id),
    onSuccess: refreshSuggestions });
  const pauseSuggestions = useMutation({ mutationFn: (until?: string) =>
    desktop!.setAssistantSuggestionsPaused(until), onSuccess: refreshSuggestions });
  const correctMemory = useMutation({ mutationFn: (input: { id: string; version: number;
    text: string; revisionId: string }) =>
    desktop!.correctAssistantMemory(input.id, input.version, input.text, input.revisionId),
    onSuccess: () => { correctionRequest.current = undefined; setEditingMemory(false); refreshWorkspace(); } });
  const forgetMemory = useMutation({ mutationFn: (id: string) => desktop!.forgetAssistantMemory(id),
    onSuccess: () => { setSelectedMemory(undefined); setForgetConfirm(false); refreshWorkspace(); refreshSuggestions(); } });
  const organizingPause = useMutation({ mutationFn: (until?: string) =>
    desktop!.setAssistantOrganizingPaused(until), onSuccess: refreshWorkspace });
  const importSaved = useMutation({ mutationFn: (item: ReturnType<typeof readSavedContent>[number]) =>
    desktop!.importAssistantSavedMemory(item.id, item.surface, item.text, item.savedAt),
    onSuccess: () => { setSelectedSaved(undefined); refreshWorkspace(); } });
  const followUpDelegation = useMutation({ mutationFn: (id: string) =>
    desktop!.followUpAssistantDelegation(id, delegationDraft),
    onSuccess: () => { setDelegationDraft(''); refreshWorkspace(); },
    onError: refreshWorkspace });
  const cancelDelegation = useMutation({ mutationFn: (id: string) => desktop!.cancelAssistantDelegation(id),
    onSuccess: refreshWorkspace });
  const connections = useQuery({
    queryKey: ['assistant', 'connections'], queryFn: () => desktop!.listWecomConnections(),
    enabled: active && tab === '连接' && Boolean(desktop), refetchInterval: active && tab === '连接' ? 5000 : false,
  });
  const toggleSchedule = useMutation({
    mutationFn: (schedule: ScheduleRecord) => desktop!.setScheduleEnabled(schedule.scheduleId, !schedule.enabled),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['assistant', 'schedules'] }),
  });
  const history = useQuery({
    queryKey: ['assistant', 'schedule-history', selectedSchedule],
    queryFn: () => desktop!.getScheduleHistory(selectedSchedule!, 10),
    enabled: active && tab === '任务' && Boolean(desktop) && Boolean(selectedSchedule),
  });
  useEffect(() => {
    const refresh = () => setMemories(readSavedContent());
    refresh();
    window.addEventListener(savedContentEvent, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(savedContentEvent, refresh); window.removeEventListener('storage', refresh); };
  }, [active]);
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = positions.current[tab] ?? 0; }, [tab]);
  const savedMemories = memories.filter((item) => item.kind === 'memory');
  const memory = workspace.data?.memories.find((item) => item.id === selectedMemory);
  const saved = savedMemories.find((item) => item.id === selectedSaved);
  const suggestion = suggestions.data?.items.find((item) => item.suggestionId === selectedSuggestion);
  const review = workspace.data?.reviews.find((item) => item.reviewId === selectedReview);
  const delegation = workspace.data?.delegations.find((item) => item.taskId === selectedDelegation);
  const delegationVerification = delegation
    ? workspace.data?.delegationVerifications?.[delegation.taskId] : undefined;
  const schedule = schedules.data?.find((item) => item.scheduleId === selectedSchedule);
  const upcoming = (schedules.data ?? []).filter((item) => item.enabled && item.nextTriggerAt)
    .sort((a, b) => a.nextTriggerAt!.localeCompare(b.nextTriggerAt!));
  const boundConnection = connections.data?.connections.find((item) => item.connectionId === link?.connectionId);
  useEffect(() => {
    const pending = correctionRequest.current;
    if (editingMemory && pending && memory?.id === pending.id
      && memory.version === pending.version + 1 && memory.text === pending.text) {
      correctionRequest.current = undefined;
      setEditingMemory(false);
      correctMemory.reset();
    }
  }, [editingMemory, memory?.id, memory?.version, memory?.text]);

  function openMemory(id: string, text: string) {
    setSelectedSaved(undefined); setSelectedMemory(id); setMemoryDraft(text);
    correctionRequest.current = undefined;
    setEditingMemory(false); setForgetConfirm(false);
  }
  function submitCorrection(id: string, version: number) {
    const previous = correctionRequest.current;
    const request = previous?.id === id && previous.version === version && previous.text === memoryDraft
      ? previous : { id, version, text: memoryDraft, revisionId: crypto.randomUUID() };
    correctionRequest.current = request;
    correctMemory.mutate(request);
  }
  function sourceRefs(refs: AssistantEvidenceRef[]) {
    if (!refs.length) return <p>尚无可展示的来源引用。</p>;
    return <ul className="assistant-source-list">{refs.map((ref) => {
      const source = workspace.data?.sources.find((item) => item.sourceId === ref.sourceId
        && item.sourceVersion === ref.sourceVersion);
      return <li key={`${ref.sourceId}:${ref.sourceVersion}`}><span>{ref.sourceId} · {source?.availability === 'available'
        ? '可用' : source?.availability === 'temporarily_unavailable' ? '暂不可用'
          : source?.availability === 'deleted' ? '已撤回' : '待确认'}</span>
        {source?.workConversationId && <button type="button" onClick={() => onOpenWorkConversation(source.workConversationId!)}>打开工作</button>}
      </li>;
    })}</ul>;
  }

  function changeTab(next: Tab) {
    if (scroll.current) positions.current[tab] = scroll.current.scrollTop;
    setTab(next);
  }
  function openSchedule(id: string) { setSelectedSchedule(id); setTaskKind('schedules'); changeTab('任务'); }
  function deleteMemory(id: string) {
    try { removeSavedContent(id); setSelectedSaved(undefined); setMemoryError(''); }
    catch { setMemoryError('无法删除记忆，请检查本地存储后重试。'); }
  }
  function scheduleRow(item: ScheduleRecord) {
    return <button type="button" className="assistant-card assistant-item" key={item.scheduleId} onClick={() => openSchedule(item.scheduleId)}>
      <span className="assistant-item-icon"><AppIcon name="schedules" /></span>
      <span><strong>{item.name}</strong><small>{!item.enabled ? '已暂停' : item.nextTriggerAt ? dateTime(item.nextTriggerAt) : '暂无下一次执行'} · {item.timing.kind === 'cron' ? '重复任务' : '单次任务'}</small></span>
      <AppIcon name="chevron" />
    </button>;
  }
  const runCard = run && <article className="assistant-card assistant-run-card">
    <div className="assistant-section-title"><h3>{runLabels[run.status]}</h3><time>{dateTime(run.updatedAt)}</time></div>
    {run.output?.message && <MessageContent text={run.output.message} />}
    {run.failure && <p role="alert">{run.failure.message}</p>}
    {!run.output?.message && !run.failure && <p>任务状态会随助理运行更新，详细过程可在左侧对话中查看。</p>}
  </article>;

  return <div className="assistant-home">
    <header className="assistant-home-header">
    <div className="assistant-home-tabs" role="tablist" aria-label="助理面板">
      {tabs.map((name, index) => <button key={name} id={`assistant-tab-${index}`} type="button" role="tab"
        aria-selected={tab === name} aria-controls="assistant-tab-content" tabIndex={tab === name ? 0 : -1}
        onClick={() => changeTab(name)} onKeyDown={(event) => {
          const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
          if (next === undefined) return;
          event.preventDefault(); changeTab(tabs[next]!); document.getElementById(`assistant-tab-${next}`)?.focus();
        }}>{name}</button>)}
    </div>
    <AssistantCompanion active={active} activity={activity} />
    </header>
    <div ref={scroll} id="assistant-tab-content" className="assistant-home-content" role="tabpanel" aria-labelledby={`assistant-tab-${tabs.indexOf(tab)}`} tabIndex={0}>
      {tab === '今日' && <>
        <header className="assistant-day-heading"><time>{new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</time>
          <h1>先把重要的事，安排好。</h1><p>{upcoming.length ? `${upcoming.length} 项计划待执行。` : '把要跟进的事交给助理，从这里开始。'}</p></header>
        {suggestions.error && <div className="assistant-card" role="alert"><p>建议暂时无法读取：{errorMessage(suggestions.error)}</p><button type="button" onClick={() => void suggestions.refetch()}>重试</button></div>}
        {(suggestion || suggestions.data?.items.some((item) => item.feedback === 'none') || suggestions.data?.pausedUntil) &&
          <section><div className="assistant-section-title"><h2>助理建议</h2>
            <button type="button" disabled={pauseSuggestions.isPending} onClick={() => pauseSuggestions.mutate(
              suggestions.data?.pausedUntil && Date.parse(suggestions.data.pausedUntil) > Date.now()
                ? undefined : new Date(Date.now() + 86_400_000).toISOString())}>
              {suggestions.data?.pausedUntil && Date.parse(suggestions.data.pausedUntil) > Date.now() ? '恢复提醒' : '暂停 1 天'}</button></div>
            {pauseSuggestions.error && <p role="alert">提醒设置失败：{errorMessage(pauseSuggestions.error)}</p>}
            {suggestion ? <article className="assistant-card"><button type="button" onClick={() => setSelectedSuggestion(undefined)}>返回建议</button>
              <h3>{suggestion.reason}</h3><p>{suggestion.nextStep}</p>
              <p className="assistant-home-note">{deliveryLabels[suggestion.deliveryStatus]} · {suggestion.readAt ? '已在此查看' : '未查看'}</p>
              {sourceRefs(suggestion.evidence)}
              <div className="assistant-actions"><button type="button" disabled={suggestionFeedback.isPending}
                onClick={() => suggestionFeedback.mutate({ id: suggestion.suggestionId, action: 'accepted' })}>已处理</button>
                <button type="button" disabled={suggestionFeedback.isPending}
                  onClick={() => suggestionFeedback.mutate({ id: suggestion.suggestionId, action: 'snoozed',
                    until: new Date(Date.now() + 86_400_000).toISOString() })}>明天提醒</button>
                <button type="button" disabled={suggestionFeedback.isPending}
                  onClick={() => suggestionFeedback.mutate({ id: suggestion.suggestionId, action: 'ignored' })}>忽略</button></div>
              {suggestionFeedback.error && <p role="alert">反馈未保存：{errorMessage(suggestionFeedback.error)}</p>}
            </article> : suggestions.data?.items.filter((item) => item.feedback === 'none').map((item) =>
              <button type="button" className="assistant-card assistant-item" key={item.suggestionId}
                onClick={() => { setSelectedSuggestion(item.suggestionId); if (!item.readAt) suggestionRead.mutate(item.suggestionId); }}>
                <span className="assistant-item-icon"><AppIcon name="assistant" /></span>
                <span><strong>{item.reason}</strong><small>{item.nextStep} · {deliveryLabels[item.deliveryStatus]}</small></span>
                <AppIcon name="chevron" /></button>)}</section>}
        {!link?.linked && <article className="assistant-card assistant-feature-card"><span className="assistant-card-kicker"><AppIcon name="work" />企业微信</span>
          <h2>{linkLoading ? '正在读取连接…' : linkError ? '暂时无法读取连接' : '让助理接续你的企业微信私聊'}</h2>
          <p>绑定已配对联系人后，可以在桌面和企业微信继续同一段对话。</p>
          <button type="button" className="assistant-primary" onClick={() => changeTab('连接')}>查看连接</button></article>}
        <section><div className="assistant-section-title"><h2>持续跟进</h2><button type="button" onClick={() => changeTab('任务')}>查看任务<AppIcon name="chevron" /></button></div>
          {schedules.isLoading ? <p role="status">正在读取任务…</p> : schedules.error ? <div className="assistant-card" role="alert"><p>任务读取失败：{errorMessage(schedules.error)}</p><button type="button" onClick={() => void schedules.refetch()}>重试</button></div>
            : upcoming.length ? upcoming.slice(0, 3).map(scheduleRow) : <div className="assistant-card assistant-empty"><AppIcon name="schedules" /><h3>还没有待执行的计划</h3><p>创建定时任务后，下一次执行时间会显示在这里。</p><button type="button" onClick={() => navigate('/schedules')}>管理定时任务</button></div>}
        </section>
        {runCard && <section><div className="assistant-section-title"><h2>{run?.status === 'succeeded' ? '已为你完成' : '当前任务'}</h2></div>{runCard}</section>}
        <p className="assistant-home-note">仅展示本机已接入的事项。</p>
      </>}
      {tab === '任务' && <>
        {review ? <>
          <div className="assistant-section-title"><button type="button" onClick={() => setSelectedReview(undefined)}><span className="assistant-back"><AppIcon name="chevron" /></span>返回工作评估</button></div>
          <article className="assistant-card"><h2>{review.goal}</h2><p>{reviewLabels[review.judgment]} · 第 {review.reviewVersion} 版 · {dateTime(review.createdAt)}</p>
            {review.unresolved.length > 0 && <><h3>待核实</h3><ul>{review.unresolved.map((item, index) => <li key={index}>{item}</li>)}</ul></>}
            {review.findings.length > 0 && <><h3>评估发现</h3>{review.findings.map((finding, index) => <div key={index}>
              <p>{reviewLabels[finding.judgment]}：{finding.claim}</p>{sourceRefs(finding.evidence)}</div>)}</>}
            {review.followUp.length > 0 && <><h3>可跟进</h3><ul>{review.followUp.map((item, index) => <li key={index}>{item}</li>)}</ul></>}
            {review.workId.startsWith('work:') && <button type="button"
              onClick={() => onOpenWorkConversation(review.workId.slice(5))}>查看原工作</button>}
          </article>
        </> : delegation ? <>
          <div className="assistant-section-title"><button type="button" onClick={() => setSelectedDelegation(undefined)}><span className="assistant-back"><AppIcon name="chevron" /></span>返回专业任务</button></div>
          <article className="assistant-card"><h2>{delegation.goal}</h2><p>状态：{delegationVerification
            ? '助理已关联完成标准与返回的证据引用，内容仍需判断' : delegationLabels[delegation.status]}</p>
            <p>专业技能：{delegation.skillName} · {dateTime(delegation.updatedAt)}</p>
            <h3>完成标准</h3><ul>{delegation.completionCriteria.map((item, index) => <li key={index}>{item}</li>)}</ul>
            {delegationVerification && <>
              <p>核验记录：{dateTime(delegationVerification.checkedAt)}</p>
              <ul>{Object.entries(delegationVerification.evidenceByCriterion)
                .map(([criterion, refs]) => <li key={criterion}>{criterion}：{refs.join('、')}</li>)}</ul></>}
            {delegation.result?.summary && <MessageContent text={delegation.result.summary} />}
            {delegation.result?.resultRef && <p>结果引用：{delegation.result.resultRef}</p>}
            {delegation.result?.evidenceRefs?.length ? <p>证据引用：{delegation.result.evidenceRefs.join('、')}</p> : null}
            {['completed', 'failed'].includes(delegation.status) && <div className="assistant-form"><label htmlFor="assistant-delegation-follow-up">继续追问</label>
              <textarea id="assistant-delegation-follow-up" value={delegationDraft}
                onChange={(event) => setDelegationDraft(event.target.value)} placeholder="说明需要补充核对的内容" />
              <button type="button" disabled={!delegationDraft.trim() || followUpDelegation.isPending}
                onClick={() => followUpDelegation.mutate(delegation.taskId)}>提交追问</button></div>}
            {['accepted', 'running', 'waiting_approval'].includes(delegation.status) &&
              <button type="button" disabled={cancelDelegation.isPending}
                onClick={() => cancelDelegation.mutate(delegation.taskId)}>取消任务</button>}
            {followUpDelegation.error && <p role="alert">追问结果暂不明确，输入已保留；刷新状态后可用同一内容安全重试：{errorMessage(followUpDelegation.error)}</p>}
            {cancelDelegation.error && <p role="alert">取消失败：{errorMessage(cancelDelegation.error)}</p>}
          </article>
        </> : schedule ? <>
          <div className="assistant-section-title"><button type="button" onClick={() => setSelectedSchedule(undefined)}><span className="assistant-back"><AppIcon name="chevron" /></span>返回任务</button></div>
          <article className="assistant-card"><h2>{schedule.name}</h2><p>{schedule.prompt}</p><dl className="assistant-facts"><div><dt>下次执行</dt><dd>{schedule.nextTriggerAt ? dateTime(schedule.nextTriggerAt) : '暂无安排'}</dd></div><div><dt>时区</dt><dd>{schedule.timeZone}</dd></div><div><dt>状态</dt><dd>{schedule.enabled ? '已启用' : '已暂停'}</dd></div></dl>
            <button type="button" disabled={toggleSchedule.isPending} onClick={() => toggleSchedule.mutate(schedule)}>{toggleSchedule.isPending ? '正在更新…' : schedule.enabled ? '暂停任务' : '启用任务'}</button>
            {toggleSchedule.error && <p role="alert">更新失败：{errorMessage(toggleSchedule.error)}</p>}</article>
          <h2 className="assistant-section-label">最近执行</h2>
          {history.isLoading && <p role="status">正在读取记录…</p>}
          {history.error && <p role="alert">记录读取失败。<button type="button" onClick={() => void history.refetch()}>重试</button></p>}
          {history.data?.length === 0 && <div className="assistant-card assistant-empty">还没有运行记录。</div>}
          {history.data?.map((item) => <article className="assistant-card" key={item.triggerKey}><h3>{item.runStatus ? runLabels[item.runStatus] : '尚未执行'}</h3><time>{dateTime(item.scheduledAt)}</time>{item.output?.message && <MessageContent text={item.output.message} />}</article>)}
        </> : <>
          <div className="assistant-section-title"><h1>任务</h1><button type="button" onClick={() => navigate('/schedules')}><AppIcon name="plus" />管理定时任务</button></div>
          <div className="assistant-task-filters" role="group" aria-label="任务类型">
            <button type="button" aria-pressed={taskKind === 'reviews'} onClick={() => setTaskKind('reviews')}>工作评估</button>
            <button type="button" aria-pressed={taskKind === 'delegations'} onClick={() => setTaskKind('delegations')}>专业任务</button>
            <button type="button" aria-pressed={taskKind === 'runs'} onClick={() => setTaskKind('runs')}>当前会话</button>
            <button type="button" aria-pressed={taskKind === 'schedules'} onClick={() => setTaskKind('schedules')}>定时任务</button>
          </div>
          {workspace.error && <p role="alert">助理任务暂时无法读取：{errorMessage(workspace.error)} <button type="button" onClick={() => void workspace.refetch()}>重试</button></p>}
          {taskKind === 'delegations' && workspace.data?.delegationsUnavailable &&
            <p role="alert">部分专业任务状态暂时不可用，请稍后重新读取。</p>}
          {taskKind === 'reviews' ? workspace.isLoading ? <p role="status">正在读取工作评估…</p>
            : workspace.data?.reviews.length ? workspace.data.reviews.map((item) =>
              <button type="button" className="assistant-card assistant-item" key={item.reviewId}
                onClick={() => setSelectedReview(item.reviewId)}><span className="assistant-item-icon"><AppIcon name="work" /></span>
                <span><strong>{item.goal}</strong><small>{reviewLabels[item.judgment]} · {dateTime(item.createdAt)}</small></span><AppIcon name="chevron" /></button>)
              : !workspace.error && <div className="assistant-card assistant-empty">还没有工作评估。</div>
          : taskKind === 'delegations' ? workspace.isLoading ? <p role="status">正在读取专业任务…</p>
            : workspace.data?.delegations.length ? workspace.data.delegations.map((item) =>
              <button type="button" className="assistant-card assistant-item" key={item.taskId}
                onClick={() => { setSelectedDelegation(item.taskId); setDelegationDraft(''); }}>
                <span className="assistant-item-icon"><AppIcon name="schedules" /></span>
                <span><strong>{item.goal}</strong><small>{delegationLabels[item.status]} · {dateTime(item.updatedAt)}</small></span><AppIcon name="chevron" /></button>)
              : !workspace.error && <div className="assistant-card assistant-empty">还没有专业任务。</div>
          : taskKind === 'runs' ? runCard ?? <div className="assistant-card assistant-empty"><h3>还没有运行记录</h3><p>在左侧交代一项工作，执行进展会显示在这里。</p></div> : <>
            <p className="assistant-home-note">本机定时任务</p>
            {schedules.isLoading && <p role="status">正在读取任务…</p>}
            {schedules.error && <p role="alert">任务读取失败。<button type="button" onClick={() => void schedules.refetch()}>重试</button></p>}
            {schedules.data?.map(scheduleRow)}
            {!schedules.isLoading && !schedules.error && !schedules.data?.length && <div className="assistant-card assistant-empty"><AppIcon name="schedules" /><h3>还没有定时任务</h3><p>前往定时任务设置执行时间与内容。</p></div>}
          </>}
          {((taskKind === 'reviews' && workspace.data?.hasMoreReviews)
            || (taskKind === 'delegations' && workspace.data?.hasMoreDelegations)) &&
            <button type="button" disabled={workspace.isFetching}
              onClick={() => setMemoryLimit((limit) => Math.min(limit + 100, 10_000))}>加载更多记录</button>}
        </>}
      </>}
      {tab === '记忆' && <>
        <div className="assistant-section-title"><h1>记忆</h1>{(memory || saved) && <button type="button" onClick={() => { setSelectedMemory(undefined); setSelectedSaved(undefined); }}>返回全部</button>}</div>
        <p className="assistant-home-note">助理整理的个人认识会显示来源与修订状态；旧收藏需要你手动导入。</p>
        {!memory && !saved && <div className="assistant-section-title"><p className="assistant-home-note">
          已处理 {workspace.data?.sourceSync?.processed ?? 0} 条来源 · 待处理 {workspace.data?.sourceSync?.pending ?? 0} 条
          {(workspace.data?.sourceSync?.unavailable ?? 0) > 0 && ` · ${workspace.data!.sourceSync.unavailable} 条暂不可用`}
          {workspace.data?.sourceSync?.lastObservedAt && ` · 最近来源 ${dateTime(workspace.data.sourceSync.lastObservedAt)}`}
        </p><button type="button" disabled={organizingPause.isPending} onClick={() => organizingPause.mutate(
          workspace.data?.organizingPausedUntil && Date.parse(workspace.data.organizingPausedUntil) > Date.now()
            ? undefined : new Date(Date.now() + 86_400_000).toISOString())}>
          {workspace.data?.organizingPausedUntil && Date.parse(workspace.data.organizingPausedUntil) > Date.now()
            ? '恢复自动整理' : '暂停自动整理 1 天'}</button></div>}
        {organizingPause.error && <p role="alert">自动整理设置失败：{errorMessage(organizingPause.error)}</p>}
        {workspace.isLoading && <p role="status">正在读取助理记忆…</p>}
        {workspace.error && <p role="alert">记忆暂时无法读取：{errorMessage(workspace.error)} <button type="button" onClick={() => void workspace.refetch()}>重试</button></p>}
        {memoryError && <p role="alert">{memoryError}</p>}
        {memory ? <article className="assistant-card"><h2>{memory.context}</h2>
          <p>{memory.kind === 'explicit' ? '明确记录' : memory.kind === 'observed' ? '观察所得' : '推断，需核实'} · 第 {memory.version} 版 · {dateTime(memory.verifiedAt)}</p>
          {editingMemory ? <div className="assistant-form"><label htmlFor="assistant-memory-correction">纠正这条认识</label>
            <textarea id="assistant-memory-correction" value={memoryDraft}
              onChange={(event) => setMemoryDraft(event.target.value)} />
            <div className="assistant-actions"><button type="button" disabled={!memoryDraft.trim() || correctMemory.isPending}
              onClick={() => submitCorrection(memory.id, memory.version)}>保存纠正</button>
              <button type="button" onClick={() => setEditingMemory(false)}>取消</button></div>
            {correctMemory.error && <p role="alert">纠正未保存，内容已保留：{errorMessage(correctMemory.error)}</p>}
          </div> : <MessageContent text={memory.text} />}
          {sourceRefs(memory.evidence)}
          <div className="assistant-actions"><button type="button" onClick={() => { setMemoryDraft(memory.text); setEditingMemory(true); }}>纠正</button>
            <button type="button" onClick={() => setForgetConfirm(true)}>遗忘</button></div>
          {forgetConfirm && <div role="alert"><p>遗忘会撤回这条记忆及依赖它的整理内容，完成后才会从列表消失。</p>
            <button type="button" disabled={forgetMemory.isPending} onClick={() => forgetMemory.mutate(memory.id)}>
              {forgetMemory.isPending ? '正在遗忘…' : '确认遗忘'}</button>
            <button type="button" onClick={() => setForgetConfirm(false)}>保留</button></div>}
          {forgetMemory.error && <p role="alert">遗忘未完成：{errorMessage(forgetMemory.error)}</p>}
        </article> : saved ? <article className="assistant-card"><h2>旧本地收藏</h2><p>来自{saved.surface === 'assistant' ? '助理' : '工作'}回复 · {dateTime(saved.savedAt)}。尚不是助理自动记忆。</p>
          <MessageContent text={saved.text} /><div className="assistant-actions"><button type="button" disabled={importSaved.isPending}
            onClick={() => importSaved.mutate(saved)}>导入助理记忆</button>
            <button type="button" onClick={() => deleteMemory(saved.id)}>取消收藏</button></div>
          {importSaved.error && <p role="alert">导入未完成：{errorMessage(importSaved.error)}</p>}
        </article> : <>
          {workspace.data?.memories.length ? workspace.data.memories.map((item) =>
            <button key={item.id} type="button" className="assistant-card assistant-item"
              onClick={() => openMemory(item.id, item.text)}><span className="assistant-item-icon"><AppIcon name="bookmark" /></span>
              <span><strong>{item.context}</strong><small>{item.kind === 'explicit' ? '明确记录' : item.kind === 'observed' ? '观察所得' : '推断'} · {dateTime(item.verifiedAt)}</small></span>
              <AppIcon name="chevron" /></button>) : !workspace.isLoading && !workspace.error
              && <div className="assistant-card assistant-empty"><h3>还没有助理记忆</h3><p>助理会从可靠来源整理，也可以手动导入旧收藏。</p></div>}
          {workspace.data?.hasMoreMemories && <button type="button" disabled={workspace.isFetching}
            onClick={() => setMemoryLimit((limit) => Math.min(limit + 100, 10_000))}>加载更早的记忆</button>}
          {savedMemories.length > 0 && <section><div className="assistant-section-title"><h2>旧本地收藏</h2></div>
            <p className="assistant-home-note">它们来自本机手动保存的回复，点击后可选择导入。</p>
            {savedMemories.map((item) => <button key={item.id} type="button" className="assistant-card assistant-item"
              onClick={() => { setSelectedSaved(item.id); setSelectedMemory(undefined); }}><span className="assistant-item-icon"><AppIcon name="bookmark" /></span>
              <span><strong>{item.text.split('\n').find((line) => line.trim())?.slice(0, 60)}</strong>
                <small>{item.surface === 'assistant' ? '助理' : '工作'}旧收藏 · {dateTime(item.savedAt)}</small></span><AppIcon name="chevron" /></button>)}</section>}
        </>}
      </>}
      {tab === '连接' && <>
        <div className="assistant-section-title"><h1>连接</h1><button type="button" onClick={() => navigate('/settings?section=connections')}>管理连接</button></div>
        <article className="assistant-card assistant-connection-card"><span className="assistant-connection-mark"><AppIcon name="work" /></span><h2>企业微信</h2><p>接续已绑定的私聊，与桌面助理同步消息和回复。</p>
          {!desktop ? <p>请在桌面应用中连接企业微信。</p> : linkLoading ? <p role="status">正在读取绑定状态…</p> : linkError ? <p role="alert">连接状态不可用。<button type="button" onClick={retryLink}>重试</button></p> : <dl className="assistant-facts"><div><dt>助理会话</dt><dd>{link?.linked ? '已绑定' : '未绑定'}</dd></div>{link?.linked && <><div><dt>连接</dt><dd>{link.connectionId}</dd></div><div><dt>服务状态</dt><dd>{connections.isLoading ? '正在读取…' : connections.error ? '状态不可用' : boundConnection?.status === 'connected' ? '已连接' : boundConnection?.status === 'connecting' ? '正在连接' : '连接不可用'}</dd></div></>}</dl>}
          {connections.error && <button type="button" onClick={() => void connections.refetch()}>重新读取服务状态</button>}
          <button type="button" className="assistant-primary" onClick={() => navigate('/settings?section=connections')}>{link?.linked ? '连接设置' : '绑定企业微信'}</button>
        </article>
        {link?.linked && <article className="assistant-card"><h3>原桌面会话</h3><p>绑定前的桌面对话保留为只读归档。</p><button type="button" onClick={onToggleArchive}>{archiveOpen ? '返回已绑定会话' : '查看原桌面会话'}</button></article>}
      </>}
    </div>
  </div>;
}
