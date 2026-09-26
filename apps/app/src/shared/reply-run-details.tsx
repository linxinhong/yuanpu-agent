import { AppIcon } from './app-icon.js';
import type { ReplyRunInfo } from './reply-run-cache.js';

export function elapsedLabel(run: Pick<ReplyRunInfo, 'createdAt' | 'updatedAt'>): string | undefined {
  const elapsed = new Date(run.updatedAt).getTime() - new Date(run.createdAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return undefined;
  const seconds = Math.max(1, Math.round(elapsed / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

const statusLabels: Record<ReplyRunInfo['status'], string> = {
  queued: '等待执行', running: '正在处理', waiting_approval: '等待授权', succeeded: '已完成',
  failed: '执行失败', cancelled: '已取消', interrupted: '执行中断', result_unknown: '结果未知',
};

export function ReplyRunDetails({ run, summary }: { run?: ReplyRunInfo; summary?: string }) {
  return <details className="reply-run-details">
    <summary>{summary
      ? <span className={`reply-run-meta ${run?.status ?? 'cancelled'}`}>{summary}</span>
      : run && <><span className={`reply-run-meta ${run.status}`}>{statusLabels[run.status]}</span>
        {elapsedLabel(run) && <span className="reply-run-duration">· 用时 {elapsedLabel(run)}</span>}</>}
      <AppIcon name="chevron" /></summary>
    <div className="reply-run-content">
      {run && <div className="reply-run-facts"><span>开始 {new Date(run.createdAt).toLocaleTimeString('zh-CN')}</span><span>结束 {new Date(run.updatedAt).toLocaleTimeString('zh-CN')}</span></div>}
      {run && run.events.length > 0 ? <ol>{run.events.map((event) => <li key={event.id}><span>{event.title}</span>{event.detail && <small>{event.detail}</small>}<time>{new Date(event.at).toLocaleTimeString('zh-CN')}</time></li>)}</ol> : <p>没有更详细的运行步骤。</p>}
    </div>
  </details>;
}
