const DIAGRAM_NOUN = /(?:架构图|流程图|示意图|关系图|结构图|architecture diagram|flowchart|diagram)/i;
const DRAW_VERB = /(?:画|绘制|生成|制作|展示|给我看|来一张|draw|create|generate|show)/i;
const NEGATED_DRAW = /(?:不要|不用|无需|别(?:再)?)\s*(?:画|绘制|生成|制作|展示|给我看)|(?:do not|don't)\s*(?:draw|create|generate|show)/i;
const SPECIFIC_TARGET = /(?:当前|这个|现有|本项目|仓库|代码|文件|目录|根据|基于|yuanpu|repository|codebase|project|source|attached)/i;

/** Keep simple, standalone diagram requests inside the reply instead of invoking render tools. */
export function prepareVisualReply(message: string): { prompt: string; renderOnly: boolean } {
  const trimmed = message.trim();
  if (!DIAGRAM_NOUN.test(trimmed) || !DRAW_VERB.test(trimmed) || NEGATED_DRAW.test(trimmed)) {
    return { prompt: message, renderOnly: false };
  }
  const renderOnly = trimmed.length <= 160 && !trimmed.includes('\n') && !SPECIFIC_TARGET.test(trimmed);
  const instruction = [
    '<yuanpu_visual_reply_contract>',
    'This request asks to SEE a diagram in the chat reply. The renderer previews a complete html-preview fenced block directly in Markdown.',
    'Your final reply MUST contain that closed block between explanatory paragraphs. Do not only describe a file or give a download path.',
    'Use this exact fence syntax: three backticks followed immediately by html-preview, then a newline, the static HTML/CSS or inline SVG, then a newline and three closing backticks. Do NOT use an html fence containing an <html-preview> tag. Do not use Mermaid for this request; do not use scripts, external resources, or fetch calls.',
    'Opening line: ```html-preview ; closing line: ``` . Replace the content between them with the requested diagram.',
    'Do not install mermaid-cli, Puppeteer, Chrome, or another renderer; do not use a browser or create an HTML file merely to show the diagram.',
    renderOnly
      ? 'This is a standalone example request. Draw a useful example directly; do not inspect the workspace or call tools.'
      : 'If the user names a specific project, inspect only the information needed to represent it accurately.',
    '</yuanpu_visual_reply_contract>',
  ].join('\n');
  return { prompt: `${message}\n\n${instruction}`, renderOnly };
}
