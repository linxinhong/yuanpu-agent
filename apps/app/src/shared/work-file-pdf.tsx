import { useEffect, useRef, useState } from 'react';
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

const INITIAL_PAGES = 5;
const RENDER_BATCH = 5;

function base64ToBytes(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function PdfPage({ doc, pageNumber }: { doc: PDFDocumentProxy; pageNumber: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    void doc.getPage(pageNumber).then(async (page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale: 1.5 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [doc, pageNumber]);

  return <div className="file-pdf-page">
    {error ? <p className="file-preview-error">第 {pageNumber} 页渲染失败。</p>
      : <canvas ref={canvasRef} aria-label={`PDF 第 ${pageNumber} 页`} />}
  </div>;
}

/** Renders a base64 PDF payload page-by-page; heavy pages load in small batches. */
export function WorkFilePdf({ base64 }: { base64: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const [error, setError] = useState('');
  const [visiblePages, setVisiblePages] = useState(INITIAL_PAGES);

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof getDocument> | undefined;
    try {
      task = getDocument({ data: base64ToBytes(base64) });
      void task.promise.then((loadedDoc) => {
        if (cancelled) return;
        setDoc(loadedDoc);
      }).catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [base64]);

  useEffect(() => { setVisiblePages(INITIAL_PAGES); }, [base64]);

  if (error) return <p className="file-preview-error" role="alert">PDF 无法打开：{error}</p>;
  if (!doc) return <p className="file-preview-loading">正在解析 PDF…</p>;
  const total = doc.numPages;
  return <div className="file-pdf" aria-label={`PDF 共 ${total} 页`}>
    {Array.from({ length: Math.min(visiblePages, total) }, (_, index) =>
      <PdfPage key={index + 1} doc={doc} pageNumber={index + 1} />)}
    {visiblePages < total && <button type="button" className="file-pdf-more"
      onClick={() => setVisiblePages((current) => current + RENDER_BATCH)}>
      继续渲染（已显示 {Math.min(visiblePages, total)}/{total} 页）
    </button>}
  </div>;
}
