import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/** Shared frosted full-screen image preview for messages and workspace files. */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  return createPortal(<dialog ref={dialog} className="message-image-dialog" aria-label="全屏预览图片"
    onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <button type="button" className="message-image-dialog-close" onClick={onClose} aria-label="关闭图片预览">×</button>
    <img src={src} alt={alt} referrerPolicy="no-referrer" />
  </dialog>, document.body);
}
