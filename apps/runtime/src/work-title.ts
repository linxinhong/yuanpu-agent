/** A short, readable title for the first message of a Work conversation. */
export function titleFromFirstMessage(message: string): string {
  const clean = message
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/gi, '网页')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '内容')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const firstClause = clean.split(/[。！？!?；;]+/)[0]?.trim() || clean;
  const chars = Array.from(firstClause);
  return chars.length > 26 ? `${chars.slice(0, 26).join('').trimEnd()}…` : firstClause || '新工作会话';
}
