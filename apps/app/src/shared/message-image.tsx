import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { safeImageSource } from './preview-content.js';

export type ImagePreview = { src: string; alt: string };

export function MessageImage({ href, alt, resolveWorkspaceImage, onOpenInSidebar }: {
  href: string;
  alt: string;
  resolveWorkspaceImage?: (path: string) => Promise<string | null>;
  onOpenInSidebar?: (image: ImagePreview) => void;
}) {
  const source = safeImageSource(href);
  const [resolved, setResolved] = useState<string>();
  const [fullScreen, setFullScreen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!source) { setResolved(undefined); return; }
    if (source.kind === 'url') { setResolved(source.value); return; }
    if (!resolveWorkspaceImage) { setResolved(undefined); return; }
    let cancelled = false;
    setResolved(undefined);
    void resolveWorkspaceImage(source.value).then((value) => { if (!cancelled) setResolved(value ?? undefined); })
      .catch(() => { if (!cancelled) setResolved(undefined); });
    return () => { cancelled = true; };
  }, [href, resolveWorkspaceImage]);

  useEffect(() => {
    if (!fullScreen) return;
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, [fullScreen]);

  if (!source) return <span className="message-image-error" role="img" aria-label={alt}>图片地址不可用</span>;
  return <span className="message-image-card">
    {resolved ? <>
      <button type="button" className="message-image-open" aria-label={`全屏预览图片：${alt || '图片'}`}
        onClick={() => setFullScreen(true)}><img src={resolved} alt={alt} loading="lazy" referrerPolicy="no-referrer" /></button>
      {onOpenInSidebar && <button type="button" className="message-image-sidebar"
        aria-label="在右侧栏打开图片" title="在右侧栏打开图片"
        onClick={() => onOpenInSidebar({ src: resolved, alt })}>在右侧栏打开图片</button>}
    </> : <span className="message-image-loading">正在加载图片…</span>}
    {fullScreen && resolved && createPortal(<dialog ref={dialog} className="message-image-dialog" aria-label="全屏预览图片"
      onClose={() => setFullScreen(false)} onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <button type="button" className="message-image-dialog-close" onClick={() => dialog.current?.close()} aria-label="关闭图片预览">×</button>
      <img src={resolved} alt={alt} referrerPolicy="no-referrer" />
    </dialog>, document.body)}
  </span>;
}
