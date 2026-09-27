import { useEffect, useId, useState } from 'react';

import { HtmlPreviewCard } from './html-preview-card.js';

let initialized = false;

export function MermaidPreviewCard({ code, language, onAddToConversation }: {
  code: string;
  language: 'mermaid' | 'graph';
  onAddToConversation?: (markdown: string) => void;
}) {
  const id = useId().replace(/[^a-z\d]/gi, '');
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(undefined);
    setError(false);
    if (!code.trim() || code.length > 20_000) { setError(true); return; }
    void import('mermaid').then(async ({ default: mermaid }) => {
      if (!initialized) {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
          maxTextSize: 20_000, maxEdges: 300, suppressErrorRendering: true, theme: 'neutral' });
        initialized = true;
      }
      const result = await mermaid.render(`yuanpuGraph${id}`, code);
      if (!cancelled) setSvg(result.svg);
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [code, id]);

  if (error) return <pre className="html-preview-error"><code>{code}</code><span>图表无法预览，请检查语法。</span></pre>;
  if (!svg) return <div className="html-preview-pending" role="status">正在生成图表…</div>;
  return <HtmlPreviewCard html={svg} source={code} sourceLanguage={language} title="图表预览"
    onAddToConversation={onAddToConversation} />;
}
