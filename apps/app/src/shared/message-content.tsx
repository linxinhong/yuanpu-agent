import { useMemo, type ReactNode } from 'react';
import { marked, type Token, type Tokens } from 'marked';

import { splitTextByFilePaths } from './work-file-utils.js';

type RenderOptions = { onOpenFilePath?: (path: string) => void };

function fileLink(path: string, options: RenderOptions, key: string): ReactNode {
  return <button key={key} type="button" className="message-file-link"
    title="在工作区中打开" onClick={() => options.onOpenFilePath?.(path)}>{path}</button>;
}

function textWithFilePaths(text: string, options: RenderOptions, key: string): ReactNode {
  const parts = splitTextByFilePaths(text);
  if (parts.length === 1 && parts[0]?.kind === 'text') return <span key={key}>{text}</span>;
  return <span key={key}>{parts.map((part, index) => part.kind === 'text'
    ? <span key={index}>{part.value}</span>
    : fileLink(part.value, options, `${key}-${index}`))}</span>;
}

function inline(tokens: Token[], options: RenderOptions): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${token.type}-${index}`;
    switch (token.type) {
      case 'strong': return <strong key={key}>{inline((token as Tokens.Strong).tokens, options)}</strong>;
      case 'em': return <em key={key}>{inline((token as Tokens.Em).tokens, options)}</em>;
      case 'del': return <del key={key}>{inline((token as Tokens.Del).tokens, options)}</del>;
      case 'codespan': {
        const code = (token as Tokens.Codespan).text;
        const trimmed = code.trim();
        if (options.onOpenFilePath && trimmed && !trimmed.includes(' ')) {
          const candidates = splitTextByFilePaths(trimmed);
          if (candidates.length === 1 && candidates[0]?.kind === 'path') {
            return fileLink(trimmed, options, key);
          }
        }
        return <code key={key}>{code}</code>;
      }
      case 'br': return <br key={key} />;
      case 'link': return <span key={key} className="message-link">{inline((token as Tokens.Link).tokens, options)}</span>;
      case 'image': return <span key={key}>{(token as Tokens.Image).text}</span>;
      case 'text': {
        const text = token as Tokens.Text;
        if (text.tokens) return <span key={key}>{inline(text.tokens, options)}</span>;
        return options.onOpenFilePath
          ? textWithFilePaths(text.text, options, key)
          : <span key={key}>{text.text}</span>;
      }
      default: return <span key={key}>{'text' in token ? String(token.text) : token.raw}</span>;
    }
  });
}

function blocks(tokens: Token[], options: RenderOptions): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${token.type}-${index}`;
    switch (token.type) {
      case 'space': return null;
      case 'paragraph': return <p key={key}>{inline((token as Tokens.Paragraph).tokens, options)}</p>;
      case 'text': {
        const text = token as Tokens.Text;
        if (text.tokens) return <p key={key}>{inline(text.tokens, options)}</p>;
        return options.onOpenFilePath
          ? textWithFilePaths(text.text, options, key)
          : <p key={key}>{text.text}</p>;
      }
      case 'heading': {
        const heading = token as Tokens.Heading;
        return heading.depth <= 2
          ? <h2 key={key}>{inline(heading.tokens, options)}</h2>
          : <h3 key={key}>{inline(heading.tokens, options)}</h3>;
      }
      case 'list': {
        const list = token as Tokens.List;
        const items = list.items.map((item, itemIndex) => <li key={itemIndex}>{blocks(item.tokens, options)}</li>);
        return list.ordered
          ? <ol key={key} start={typeof list.start === 'number' ? list.start : undefined}>{items}</ol>
          : <ul key={key}>{items}</ul>;
      }
      case 'blockquote': return <blockquote key={key}>{blocks((token as Tokens.Blockquote).tokens, options)}</blockquote>;
      case 'code': {
        const code = token as Tokens.Code;
        return <pre key={key}><code>{code.text}</code></pre>;
      }
      case 'hr': return <hr key={key} />;
      case 'table': {
        const table = token as Tokens.Table;
        return <div key={key} className="message-table-scroll"><table>
          <thead><tr>{table.header.map((cell, cellIndex) => <th key={cellIndex}>{inline(cell.tokens, options)}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell.tokens, options)}</td>)}</tr>)}</tbody>
        </table></div>;
      }
      default: return <p key={key}>{'text' in token ? String(token.text) : token.raw}</p>;
    }
  });
}

export function MessageContent({ text, onOpenFilePath }: { text: string; onOpenFilePath?: (path: string) => void }) {
  const tokens = useMemo(() => marked.lexer(text, { gfm: true }), [text]);
  return <div className="message-markdown">{blocks(tokens, { onOpenFilePath })}</div>;
}
