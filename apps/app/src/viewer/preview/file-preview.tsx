import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorkFilePreview } from '@yuanpu-agent/protocol';

import { AppIcon } from '../../shared/app-icon.js';
import { MessageContent } from '../../shared/message-content.js';
import { classifyWorkFile } from '../core/content-kind.js';
import { formatFileSize, formatFileTime } from '../core/format.js';
import type { ViewerFileHost } from '../host/file-host.js';
import { highlightLines, shikiLanguageForFile, type HighlightedLine } from './code-highlight.js';
import { FileDiffView } from './file-diff-view.js';
import { getKnownFileVersion, rememberFileVersion, type CachedFileVersion } from './file-version-cache.js';
import { countDiffChanges, createUnifiedDiff } from './text-diff.js';
import { PdfView } from './pdf-view.js';

const MAX_RENDERED_LINES = 2000;
type TextPreviewMode = 'result' | 'diff';
type ContentView = 'rendered' | 'source';

const HTML_PREVIEW_CSP = "default-src 'none'; img-src data: blob:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

function staticHtmlSrcDoc(content: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;
  const doctype = content.match(/^\s*<!doctype[^>]*>/i);
  return doctype ? `${doctype[0]}${policy}${content.slice(doctype[0].length)}` : `${policy}${content}`;
}

function TextPreview({ fileName, content }: { fileName: string; content: string }) {
  const lines = useMemo(() => {
    const split = content.split('\n');
    if (split.length > 1 && split[split.length - 1] === '') split.pop();
    return split;
  }, [content]);
  const displayLines = useMemo(() => lines.slice(0, MAX_RENDERED_LINES), [lines]);
  const language = shikiLanguageForFile(fileName);
  const [highlighted, setHighlighted] = useState<HighlightedLine[]>();

  useEffect(() => {
    if (!language) {
      setHighlighted(undefined);
      return;
    }
    let cancelled = false;
    setHighlighted(undefined);
    void highlightLines(displayLines.join('\n'), language).then((result) => {
      if (!cancelled) setHighlighted(result);
    });
    return () => { cancelled = true; };
  }, [language, displayLines]);

  return <pre className="file-preview-text"><code>{displayLines.map((line, index) => {
    const tokens = highlighted?.[index];
    if (!tokens) {
      return <span className="file-text-line" key={index}>
        <span className="file-line-no">{index + 1}</span>{highlighted ? '' : (line || ' ')}
      </span>;
    }
    return <span className="file-text-line" key={index}>
      <span className="file-line-no">{index + 1}</span>
      {tokens.length === 0 ? ' ' : tokens.map((token, tokenIndex) => token.text
        ? <span key={tokenIndex} className="file-code-token"
          style={{ '--file-code-light': token.light || 'inherit', '--file-code-dark': token.dark || token.light || 'inherit' } as CSSProperties}>{token.text}</span>
        : null)}
    </span>;
  })}</code></pre>;
}

/** Blob URL instead of inline base64: less memory and SVG never executes script; revoked on unmount. */
function ImageViewer({ mediaType, base64, alt }: { mediaType: string; base64: string; alt: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [base64, mediaType]);
  if (!src) return null;
  return <img className="file-preview-image" src={src} alt={alt} />;
}

/** Read-only preview of one workspace file with a review-style toolbar: view toggle, diff stats and quick actions. */
export function FilePreview({ host, scopeKey, filePath, onRequestLocate }: {
  host: ViewerFileHost;
  /** Opaque identity of the browsed scope (the Work conversation id). */
  scopeKey: string;
  filePath: string;
  onRequestLocate?: (path: string) => void;
}) {
  const query = useQuery({
    queryKey: ['viewer', 'file', scopeKey, filePath],
    queryFn: () => host.readFile(filePath),
  });
  const preview = query.data;
  const name = filePath.split('/').pop() ?? filePath;
  const meta = preview && preview.kind !== 'unsupported'
    ? [formatFileSize(preview.size), formatFileTime(preview.updatedAt)].filter(Boolean).join(' · ')
    : preview?.size !== undefined ? formatFileSize(preview.size) : '';

  const [previous, setPrevious] = useState<CachedFileVersion>();
  const [mode, setMode] = useState<TextPreviewMode>('result');
  const [contentView, setContentView] = useState<ContentView>('rendered');
  useEffect(() => { setContentView('rendered'); }, [filePath]);
  useEffect(() => {
    if (preview?.kind !== 'text') return;
    const known = getKnownFileVersion(scopeKey, filePath);
    const changed = Boolean(known) && (known!.content !== preview.content || known!.updatedAt !== preview.updatedAt);
    setPrevious(changed ? known : undefined);
    // A newly detected change surfaces the replacement effect; refetches of
    // unchanged content never disturb the visitor's current view.
    if (changed) setMode('diff');
    rememberFileVersion(scopeKey, filePath, {
      content: preview.content, truncated: preview.truncated, size: preview.size, updatedAt: preview.updatedAt,
    });
  }, [preview, scopeKey, filePath]);

  const stats = useMemo(() => {
    if (!previous || preview?.kind !== 'text') return undefined;
    const patch = createUnifiedDiff(previous.content, preview.content, name);
    return patch ? countDiffChanges(patch) : undefined;
  }, [previous, preview, name]);

  const isTextWithPrevious = Boolean(previous && preview?.kind === 'text');
  const contentKind = classifyWorkFile(name);
  const isHtml = /\.html?$/i.test(name);
  const canRender = preview?.kind === 'text' && (contentKind === 'markdown' || isHtml);
  const toolbarVisible = Boolean(preview) && (isTextWithPrevious || Boolean(meta) || preview?.kind === 'text');
  return <div className="file-preview">
    {toolbarVisible && <div className="file-toolbar">
      <div className="file-toolbar-side">
        {preview?.kind === 'text' && <div className="file-content-toggle" role="group" aria-label="文件显示方式">
          {canRender && <button type="button" title="渲染预览" aria-label="渲染预览" aria-pressed={contentView === 'rendered'}
            onClick={() => { setContentView('rendered'); setMode('result'); }}><AppIcon name="eye" /></button>}
          <button type="button" title="查看源代码" aria-label="查看源代码" aria-pressed={!canRender || contentView === 'source'}
            onClick={() => { setContentView('source'); setMode('result'); }}><AppIcon name="code" /></button>
        </div>}
        {isTextWithPrevious ? <>
          <div className="file-view-toggle" role="tablist" aria-label="预览视图切换">
            <button type="button" aria-pressed={mode === 'result'} onClick={() => setMode('result')}>最终内容</button>
            <button type="button" aria-pressed={mode === 'diff'} onClick={() => setMode('diff')}>替换效果</button>
          </div>
          {mode === 'diff' && stats && <span className="file-diff-stats">
            <b className="add">+{stats.added}</b> <b className="del">-{stats.removed}</b>
          </span>}
        </> : <span className="file-preview-meta">{meta}</span>}
      </div>
      {preview && <div className="file-toolbar-actions">
        {onRequestLocate && <button type="button" className="file-toolbar-button" title="在文件树中定位"
          aria-label="在文件树中定位" onClick={() => onRequestLocate(filePath)}><AppIcon name="locate" /></button>}
        <button type="button" className="file-toolbar-button" title="复制路径" aria-label="复制路径"
          onClick={() => { void navigator.clipboard.writeText(filePath); }}><AppIcon name="copy" /></button>
        <button type="button" className="file-toolbar-button" title="刷新" aria-label="刷新"
          onClick={() => { void query.refetch(); }}><AppIcon name="refresh" /></button>
      </div>}
    </div>}
    <div className="file-preview-body">
      {query.isLoading && <p className="file-preview-loading">正在读取文件…</p>}
      {query.error && <p className="file-preview-error" role="alert">文件无法预览：{query.error instanceof Error ? query.error.message : String(query.error)}</p>}
      {preview?.kind === 'unsupported' && <p className="file-preview-error" role="alert">{preview.reason}</p>}
      {preview?.kind === 'image' && <ImageViewer mediaType={preview.mediaType} base64={preview.base64} alt={name} />}
      {preview?.kind === 'pdf' && <PdfView base64={preview.base64} />}
      {preview?.kind === 'text' && <>
        {preview.truncated && <p className="file-preview-truncated" role="status">文件超过 256 KB，仅显示开头部分。</p>}
        {mode === 'diff' && previous
          ? <FileDiffView fileName={name} oldText={previous.content} newText={preview.content} />
          : canRender && contentView === 'rendered' && contentKind === 'markdown'
            ? <div className="file-preview-markdown"><MessageContent text={preview.content} /></div>
            : canRender && contentView === 'rendered' && isHtml
              ? <iframe className="file-preview-html" title={`${name} 渲染预览`} sandbox="" referrerPolicy="no-referrer"
                  srcDoc={staticHtmlSrcDoc(preview.content)} />
            : <TextPreview fileName={name} content={preview.content} />}
      </>}
    </div>
  </div>;
}
