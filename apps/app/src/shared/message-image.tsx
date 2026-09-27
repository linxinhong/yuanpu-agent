import { useEffect, useState } from 'react';

import { ImageLightbox } from './image-lightbox.js';
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

  if (!source) return <span className="message-image-error" role="img" aria-label={alt}>图片地址不可用</span>;
  return <span className="message-image-card">
    {resolved ? <>
      <button type="button" className="message-image-open" aria-label={`全屏预览图片：${alt || '图片'}`}
        onClick={() => setFullScreen(true)}><img src={resolved} alt={alt} loading="lazy" referrerPolicy="no-referrer" /></button>
      {onOpenInSidebar && <button type="button" className="message-image-sidebar"
        aria-label="在右侧栏打开图片" title="在右侧栏打开图片"
        onClick={() => onOpenInSidebar({ src: resolved, alt })}>在右侧栏打开图片</button>}
    </> : <span className="message-image-loading">正在加载图片…</span>}
    {fullScreen && resolved && <ImageLightbox src={resolved} alt={alt} onClose={() => setFullScreen(false)} />}
  </span>;
}
