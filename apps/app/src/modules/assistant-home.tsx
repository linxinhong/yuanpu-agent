import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { AgentRunRecord, AssistantLinkStatus, ScheduleRecord } from '@yuanpu-agent/protocol';
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

export function AssistantHome({ active, link, linkLoading, linkError, retryLink, run, activity, archiveOpen, onToggleArchive }: {
  active: boolean;
  link?: AssistantLinkStatus;
  linkLoading: boolean;
  linkError: unknown;
  retryLink: () => void;
  run?: AgentRunRecord;
  activity: AssistantActivity;
  archiveOpen: boolean;
  onToggleArchive: () => void;
}) {
  const desktop = window.yuanpu;
  const navigate = useNavigate();
  const client = useQueryClient();
  const [tab, setTab] = useState<Tab>('今日');
  const [selectedSchedule, setSelectedSchedule] = useState<string>();
  const [selectedMemory, setSelectedMemory] = useState<string>();
  const [memories, setMemories] = useState(readSavedContent);
  const [memoryError, setMemoryError] = useState('');
  const [taskKind, setTaskKind] = useState<'runs' | 'schedules'>('schedules');
  const scroll = useRef<HTMLDivElement>(null);
  const positions = useRef<Partial<Record<Tab, number>>>({});
  const schedules = useQuery({
    queryKey: ['assistant', 'schedules'], queryFn: () => desktop!.listSchedules(),
    enabled: active && Boolean(desktop), refetchInterval: active ? 10000 : false,
  });
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
  const memory = savedMemories.find((item) => item.id === selectedMemory);
  const schedule = schedules.data?.find((item) => item.scheduleId === selectedSchedule);
  const upcoming = (schedules.data ?? []).filter((item) => item.enabled && item.nextTriggerAt)
    .sort((a, b) => a.nextTriggerAt!.localeCompare(b.nextTriggerAt!));
  const boundConnection = connections.data?.connections.find((item) => item.connectionId === link?.connectionId);

  function changeTab(next: Tab) {
    if (scroll.current) positions.current[tab] = scroll.current.scrollTop;
    setTab(next);
  }
  function openSchedule(id: string) { setSelectedSchedule(id); setTaskKind('schedules'); changeTab('任务'); }
  function deleteMemory(id: string) {
    try { removeSavedContent(id); setSelectedMemory(undefined); setMemoryError(''); }
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
        {schedule ? <>
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
          <div className="assistant-task-filters" role="group" aria-label="任务类型"><button type="button" aria-pressed={taskKind === 'runs'} onClick={() => setTaskKind('runs')}>当前会话</button><button type="button" aria-pressed={taskKind === 'schedules'} onClick={() => setTaskKind('schedules')}>定时任务</button></div>
          {taskKind === 'runs' ? runCard ?? <div className="assistant-card assistant-empty"><h3>还没有运行记录</h3><p>在左侧交代一项工作，执行进展会显示在这里。</p></div> : <>
            <p className="assistant-home-note">本机定时任务</p>
            {schedules.isLoading && <p role="status">正在读取任务…</p>}
            {schedules.error && <p role="alert">任务读取失败。<button type="button" onClick={() => void schedules.refetch()}>重试</button></p>}
            {schedules.data?.map(scheduleRow)}
            {!schedules.isLoading && !schedules.error && !schedules.data?.length && <div className="assistant-card assistant-empty"><AppIcon name="schedules" /><h3>还没有定时任务</h3><p>前往定时任务设置执行时间与内容。</p></div>}
          </>}
        </>}
      </>}
      {tab === '记忆' && <>
        <div className="assistant-section-title"><h1>记忆</h1>{memory && <button type="button" onClick={() => setSelectedMemory(undefined)}>返回全部</button>}</div>
        <p className="assistant-home-note">来自本机手动保存的回复，尚未自动用于助理回答。</p>
        {memoryError && <p role="alert">{memoryError}</p>}
        {memory ? <article className="assistant-card"><MessageContent text={memory.text} /><div className="assistant-section-title"><time>{dateTime(memory.savedAt)}</time><button type="button" onClick={() => deleteMemory(memory.id)}>取消保存</button></div></article>
          : savedMemories.length ? savedMemories.map((item) => <button key={item.id} type="button" className="assistant-card assistant-item" onClick={() => setSelectedMemory(item.id)}><span className="assistant-item-icon"><AppIcon name="bookmark" /></span><span><strong>{item.text.split('\n').find((line) => line.trim())?.slice(0, 60)}</strong><small>{item.surface === 'assistant' ? '助理' : '工作'} · {dateTime(item.savedAt)}</small></span><AppIcon name="chevron" /></button>)
            : <div className="assistant-card assistant-empty"><AppIcon name="bookmark" /><h3>还没有保存的记忆</h3><p>在左侧回复下方点击书签，即可保存到这里。</p></div>}
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
