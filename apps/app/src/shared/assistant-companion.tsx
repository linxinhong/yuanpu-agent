import { useEffect, useRef, useState } from 'react';
import { assistantActionLabels, completedNow, executionAction, type AssistantAction, type AssistantActivity } from './assistant-activity.js';

const animations = import.meta.glob('../assets/assistant/actions/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const posters = import.meta.glob('../assets/assistant/actions/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export function AssistantCompanion({ active, activity }: { active: boolean; activity: AssistantActivity }) {
  const [feedback, setFeedback] = useState<{ action: 'wave' | 'heart'; runId?: string }>();
  const [playback, setPlayback] = useState(0);
  const [manualPlayback, setManualPlayback] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const previous = useRef<AssistantActivity>(activity);
  const greeted = useRef(false);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (active && completedNow(previous.current, activity)) setFeedback({ action: 'heart', runId: activity.runId });
    else if (active && !greeted.current && !activity.status) setFeedback({ action: 'wave' });
    if (active) greeted.current = true;
    previous.current = activity;
  }, [active, activity.runId, activity.status]);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(undefined), 6000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    if (!manualPlayback) return;
    const timer = window.setTimeout(() => setManualPlayback(false), 6000);
    return () => window.clearTimeout(timer);
  }, [manualPlayback, playback]);

  const showFeedback = feedback && !activity.disconnected && (feedback.action === 'heart'
    ? activity.runId === feedback.runId && activity.status === 'succeeded'
    : !activity.status);
  const action: AssistantAction = showFeedback ? feedback.action : executionAction(activity);
  const label = activity.disconnected ? '连接中断，等待恢复' : activity.status === 'waiting_approval' ? '等待授权'
    : activity.status === 'queued' ? '等待执行' : activity.status === 'failed' ? '执行失败'
    : activity.status === 'cancelled' ? '任务已取消' : activity.status === 'interrupted' ? '执行中断'
    : activity.status === 'result_unknown' ? '结果待确认' : assistantActionLabels[action];
  const src = active && (!reducedMotion || manualPlayback)
    ? animations[`../assets/assistant/actions/${action}.webp`]
    : posters[`../assets/assistant/actions/${action}.png`];
  return <button type="button" className="assistant-companion" data-action={action}
    aria-label={`${label}，点击重播动画`} title={`${label} · 点击重播动画`}
    onClick={() => { setPlayback((value) => value + 1); setManualPlayback(true); }}>
    <span className="assistant-companion-frame">
      <img key={`${action}-${playback}-${active}-${reducedMotion}`} src={src} alt="" width={192} height={192} />
    </span>
  </button>;
}
