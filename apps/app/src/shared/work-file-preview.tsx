import { useQuery } from '@tanstack/react-query';
import type { WorkFilePreview as WorkFilePreviewData } from '@yuanpu-agent/protocol';

import { MessageContent } from './message-content.js';
import { WorkFilePdf } from './work-file-pdf.js';
import { classifyWorkFile, formatFileSize, formatFileTime } from './work-file-utils.js';

const MAX_RENDERED_LINES = 2000;

function TextPreview({ content, truncated }: { content: string; truncated: boolean }) {
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return <>
    {truncated && <p className="file-preview-truncated" role="status">文件超过 256 KB，仅显示开头部分。</p>}
    {lines.length > MAX_RENDERED_LINES && <p className="file-preview-truncated" role="status">行数较多，仅显示前 {MAX_RENDERED_LINES} 行。</p>}
    <pre className="file-preview-text"><code>{lines.slice(0, MAX_RENDERED_LINES).map((line, index) =>
      <span className="file-text-line" key={index}><span className="file-line-no">{index + 1}</span>{line || ' '}</span>)}
    </code></pre>
  </>;
}

function PreviewBody({ name, preview }: { name: string; preview: WorkFilePreviewData }) {
  if (preview.kind === 'unsupported') {
    return <p className="file-preview-error" role="alert">{preview.reason}</p>;
  }
  if (preview.kind === 'image') {
    return <img className="file-preview-image" src={`data:${preview.mediaType};base64,${preview.base64}`} alt={name} />;
  }
  if (preview.kind === 'pdf') {
    return <WorkFilePdf base64={preview.base64} />;
  }
  return classifyWorkFile(name) === 'markdown'
    ? <div className="file-preview-markdown"><MessageContent text={preview.content} /></div>
    : <TextPreview content={preview.content} truncated={preview.truncated} />;
}

/** Read-only preview of one workspace file with a back affordance to the tree. */
export function WorkFilePreview({ conversationId, filePath, onBack }: {
  conversationId: string;
  filePath: string;
  onBack: () => void;
}) {
  const query = useQuery({
    queryKey: ['work', 'file', conversationId, filePath],
    queryFn: () => window.yuanpu!.readWorkFile(conversationId, filePath),
    enabled: Boolean(conversationId) && Boolean(window.yuanpu),
  });
  const name = filePath.split('/').pop() ?? filePath;
  const meta = query.data && query.data.kind !== 'unsupported'
    ? [formatFileSize(query.data.size), formatFileTime(query.data.updatedAt)].filter(Boolean).join(' · ')
    : query.data?.size !== undefined ? formatFileSize(query.data.size) : '';
  return <div className="file-preview">
    <div className="file-preview-header">
      <button type="button" className="runtime-link" onClick={onBack}>← 文件列表</button>
      <strong title={filePath}>{name}</strong>
      {meta && <span className="file-preview-meta">{meta}</span>}
    </div>
    <div className="file-preview-body">
      {query.isLoading && <p className="file-preview-loading">正在读取文件…</p>}
      {query.error && <p className="file-preview-error" role="alert">文件无法预览：{query.error instanceof Error ? query.error.message : String(query.error)}</p>}
      {query.data && <PreviewBody name={name} preview={query.data} />}
    </div>
  </div>;
}
