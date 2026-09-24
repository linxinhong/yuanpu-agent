import { useEffect, useState } from 'react';

import { AppIcon } from './app-icon.js';
import { MessageContent } from './message-content.js';
import type { ReplyRunInfo } from './reply-run-cache.js';
import { isSavedContent, readSavedContent, removeSavedContent, saveContent, savedContentEvent, type SavedContentKind } from './saved-content.js';

function elapsedLabel(run: ReplyRunInfo): string | undefined {
  const elapsed = new Date(run.updatedAt).getTime() - new Date(run.createdAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return undefined;
  const seconds = Math.round(elapsed / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

export function AssistantReply({
  text,
  surface,
  run,
}: {
  text: string;
  surface: 'work' | 'assistant';
  run?: ReplyRunInfo;
}) {
  const [copied, setCopied] = useState(false);
  const [errorNotice, setErrorNotice] = useState('');
  const [, setSavedVersion] = useState(0);
  useEffect(() => {
    const update = () => setSavedVersion((value) => value + 1);
    window.addEventListener(savedContentEvent, update);
    return () => window.removeEventListener(savedContentEvent, update);
  }, []);
  const savedMemory = isSavedContent('memory', surface, text);
  const savedKnowledge = isSavedContent('knowledge', surface, text);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setErrorNotice('');
    } catch { setErrorNotice('复制失败，请检查剪贴板权限'); }
  }

  function toggleSaved(kind: SavedContentKind) {
    try {
      const existing = readSavedContent().find((item) => item.kind === kind && item.surface === surface && item.text === text);
      if (existing) removeSavedContent(existing.id);
      else saveContent(kind, surface, text);
      setErrorNotice('');
    } catch { setErrorNotice('保存状态更新失败，请检查本地存储空间'); }
  }

  return <div className="assistant-reply">
    {run && <details className="reply-run-details">
      <summary><span className={`reply-run-meta ${run.status}`}>{run.status === 'succeeded' ? '已完成' : run.status}</span>{elapsedLabel(run) && <span className="reply-run-duration">· 用时 {elapsedLabel(run)}</span>}<AppIcon name="chevron" /></summary>
      <div className="reply-run-content">
        <div className="reply-run-facts"><span>开始 {new Date(run.createdAt).toLocaleTimeString('zh-CN')}</span><span>结束 {new Date(run.updatedAt).toLocaleTimeString('zh-CN')}</span></div>
        {run.events.length > 0 && <ol>{run.events.map((event) => <li key={event.id}><span>{event.title}</span>{event.detail && <small>{event.detail}</small>}<time>{new Date(event.at).toLocaleTimeString('zh-CN')}</time></li>)}</ol>}
        {run.tools.length ? <div className="reply-run-tools">{run.tools.map((tool) => <span key={tool.name}>{tool.status === 'completed' ? '✓' : '!'} {tool.name}</span>)}</div> : null}
        {run.events.length === 0 && !run.tools.length && <p>没有更详细的运行步骤。</p>}
      </div>
    </details>}
    <MessageContent text={text} />
    <div className="reply-toolbar" role="toolbar" aria-label="回复操作">
      <button type="button" className={copied ? 'copied' : ''} aria-label={copied ? '已复制' : '复制'} data-tooltip={copied ? '已复制' : '复制'} onClick={() => void copy()}><AppIcon name={copied ? 'check' : 'copy'} /></button>
      <button type="button" className={savedMemory ? 'saved' : ''} aria-label={savedMemory ? '取消保存到记忆' : '保存到记忆'} aria-pressed={savedMemory}
        data-tooltip={savedMemory ? '取消保存到记忆' : '保存到记忆'} onClick={() => toggleSaved('memory')}><AppIcon name={savedMemory ? 'bookmark-filled' : 'bookmark'} /></button>
      <button type="button" className={savedKnowledge ? 'saved' : ''} aria-label={savedKnowledge ? '取消保存到知识库' : '保存到知识库'} aria-pressed={savedKnowledge}
        data-tooltip={savedKnowledge ? '取消保存到知识库' : '保存到知识库'} onClick={() => toggleSaved('knowledge')}><AppIcon name={savedKnowledge ? 'knowledge-filled' : 'knowledge'} /></button>
      {errorNotice && <span className="reply-action-notice" role="alert">{errorNotice}</span>}
    </div>
  </div>;
}
