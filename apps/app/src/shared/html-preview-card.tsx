import { useEffect, useMemo, useRef, useState } from 'react';

import { htmlPreviewDocument } from './preview-content.js';

export function HtmlPreviewCard({ html, onAddToConversation }: {
  html: string;
  onAddToConversation?: (markdown: string) => void;
}) {
  const [sourceOpen, setSourceOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const document = useMemo(() => htmlPreviewDocument(html), [html]);

  useEffect(() => {
    if (!expanded) return;
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, [expanded]);

  function download() {
    const url = URL.createObjectURL(new Blob([document], { type: 'text/html;charset=utf-8' }));
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = '图示.html';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  const frame = (className: string) => <iframe title="HTML 图示" className={className} srcDoc={document}
    sandbox="" referrerPolicy="no-referrer" loading="lazy" />;

  return <section className="html-preview-card" aria-label="可视化预览">
    <div className="html-preview-toolbar"><strong>图示预览</strong><div>
      <button type="button" onClick={() => setExpanded(true)} aria-label="放大图示">放大</button>
      <button type="button" onClick={() => setSourceOpen((value) => !value)} aria-pressed={sourceOpen}>源码</button>
      <button type="button" onClick={download}>下载</button>
      {onAddToConversation && <button type="button" onClick={() => onAddToConversation(`\`\`\`html-preview\n${html}\n\`\`\``)}>添加到对话</button>}
    </div></div>
    {sourceOpen ? <pre className="html-preview-source"><code>{html}</code></pre> : frame('html-preview-frame')}
    {expanded && <dialog ref={dialog} className="html-preview-dialog" aria-label="放大图示"
      onClose={() => setExpanded(false)} onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="html-preview-dialog-bar"><strong>图示预览</strong><button type="button" onClick={() => dialog.current?.close()} aria-label="关闭图示">关闭</button></div>
      {frame('html-preview-dialog-frame')}
    </dialog>}
  </section>;
}
