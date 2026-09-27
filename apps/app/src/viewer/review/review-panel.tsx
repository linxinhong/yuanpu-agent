import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorkFileChangeEntry } from '@yuanpu-agent/protocol';

import { AppIcon } from '../../shared/app-icon.js';
import { FileDiffView } from '../preview/file-diff-view.js';
import { countDiffChanges, createUnifiedDiff } from '../preview/text-diff.js';

type ReviewScope = 'last-run' | 'conversation';

/**
 * 审查标签：按上一轮/本会话批量展示 agent 修改过的文件与前后 diff。
 * 数据来自 runtime 的文件变更台账；本组件不做任何持久化写入。
 */
export function ReviewPanel({ conversationId, lastRunId, refreshKey, active }: {
  conversationId?: string;
  lastRunId?: string;
  refreshKey: number;
  active: boolean;
}) {
  const desktop = window.yuanpu;
  const [scope, setScope] = useState<ReviewScope>('last-run');
  const [expandedPath, setExpandedPath] = useState<string>();
  const query = useQuery({
    queryKey: ['work', 'file-changes', conversationId ?? '', scope, lastRunId ?? '', refreshKey],
    queryFn: () => desktop!.listWorkFileChanges(scope === 'last-run' && lastRunId
      ? { conversationId: conversationId!, runId: lastRunId }
      : { conversationId: conversationId! }),
    enabled: active && Boolean(desktop) && Boolean(conversationId)
      && (scope === 'conversation' || Boolean(lastRunId)),
  });
  const files = query.data?.files ?? [];
  const stats = useMemo(() => new Map(files.map((entry) => [entry.path, fileStats(entry)])), [files]);
  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    let oversized = 0;
    for (const value of stats.values()) {
      if (!value) { oversized += 1; continue; }
      added += value.added;
      removed += value.removed;
    }
    return { added, removed, oversized };
  }, [stats]);

  const emptyHint = scope === 'last-run' ? '最近一轮没有文件修改。' : '本会话还没有文件修改。';
  return <div className="review-panel">
    <div className="review-toolbar">
      <div className="review-scope" role="group" aria-label="审查范围">
        <button type="button" aria-pressed={scope === 'last-run'} title={lastRunId ? undefined : '运行结束后可查看'}
          onClick={() => setScope('last-run')}>上一轮</button>
        <button type="button" aria-pressed={scope === 'conversation'} onClick={() => setScope('conversation')}>本会话</button>
      </div>
      {query.data && <span className="file-diff-stats review-summary">
        <b className="add">+{totals.added}</b> <b className="del">-{totals.removed}</b>
        {totals.oversized > 0 && <span className="review-oversized-note">· {totals.oversized} 个大文件未计入</span>}
      </span>}
      <button type="button" className="review-refresh" title="刷新审查数据" aria-label="刷新审查数据"
        onClick={() => void query.refetch()}><AppIcon name="refresh" /></button>
    </div>
    <div className="review-body">
      {!desktop && <p className="review-note" role="note">请在桌面应用中查看审查数据。</p>}
      {desktop && !conversationId && <p className="review-note" role="note">选择或新建工作后，这里会汇总文件修改。</p>}
      {desktop && conversationId && scope === 'last-run' && !lastRunId
        && <p className="review-note" role="note">运行结束后可查看上一轮的文件修改。</p>}
      {query.isLoading && <p className="review-note" role="status">正在读取文件变更…</p>}
      {query.error && <p className="review-note" role="alert">文件变更读取失败：{String(query.error)}</p>}
      {query.data && files.length === 0 && <p className="review-note" role="status">{emptyHint}</p>}
      {files.length > 0 && <ul className="review-list">
        {files.map((entry) => <ReviewItem key={`${entry.path}:${entry.updatedAt}`} entry={entry}
          stat={stats.get(entry.path)} expanded={expandedPath === entry.path}
          onToggle={() => setExpandedPath((current) => current === entry.path ? undefined : entry.path)} />)}
      </ul>}
    </div>
  </div>;
}

function ReviewItem({ entry, stat, expanded, onToggle }: {
  entry: WorkFileChangeEntry;
  stat: { added: number; removed: number } | undefined;
  expanded: boolean;
  onToggle: () => void;
}) {
  const oversized = entry.before?.truncated || entry.after.truncated;
  const unchanged = entry.before?.content === entry.after.content;
  return <li className="review-item">
    <button type="button" className="review-item-row" aria-expanded={expanded} onClick={onToggle}>
      <AppIcon name={entry.before ? 'edit' : 'file'} />
      <span className="review-item-path" title={entry.path}>{entry.path}</span>
      {entry.before === null && <span className="review-tag">新建</span>}
      {oversized && <span className="review-tag">内容过大</span>}
      {!oversized && unchanged && <span className="review-tag">无净变化</span>}
      {!oversized && !unchanged && stat && <span className="file-diff-stats">
        <b className="add">+{stat.added}</b> <b className="del">-{stat.removed}</b>
      </span>}
      {!oversized && !unchanged && !stat && <span className="review-tag">大改动</span>}
    </button>
    {expanded && <div className="review-file-diff">
      {oversized
        ? <p className="review-note" role="note">文件内容超过快照上限，diff 不可用；请用「文件」标签查看当前内容。</p>
        : unchanged
          ? <p className="review-note" role="note">此范围内编辑又被还原，文件内容没有净变化。</p>
          : <FileDiffView fileName={entry.path} oldText={entry.before?.content ?? ''} newText={entry.after.content} />}
    </div>}
  </li>;
}

function fileStats(entry: WorkFileChangeEntry): { added: number; removed: number } | undefined {
  if (entry.before?.truncated || entry.after.truncated) return undefined;
  const patch = createUnifiedDiff(entry.before?.content ?? '', entry.after.content, entry.path);
  return patch ? countDiffChanges(patch) : { added: 0, removed: 0 };
}
