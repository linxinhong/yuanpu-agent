import { useMemo, type ReactNode } from 'react';
import { marked, type Token, type Tokens } from 'marked';

function inline(tokens: Token[]): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${token.type}-${index}`;
    switch (token.type) {
      case 'strong': return <strong key={key}>{inline((token as Tokens.Strong).tokens)}</strong>;
      case 'em': return <em key={key}>{inline((token as Tokens.Em).tokens)}</em>;
      case 'del': return <del key={key}>{inline((token as Tokens.Del).tokens)}</del>;
      case 'codespan': return <code key={key}>{(token as Tokens.Codespan).text}</code>;
      case 'br': return <br key={key} />;
      case 'link': return <span key={key} className="message-link">{inline((token as Tokens.Link).tokens)}</span>;
      case 'image': return <span key={key}>{(token as Tokens.Image).text}</span>;
      case 'text': {
        const text = token as Tokens.Text;
        return <span key={key}>{text.tokens ? inline(text.tokens) : text.text}</span>;
      }
      default: return <span key={key}>{'text' in token ? String(token.text) : token.raw}</span>;
    }
  });
}

function blocks(tokens: Token[]): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${token.type}-${index}`;
    switch (token.type) {
      case 'space': return null;
      case 'paragraph': return <p key={key}>{inline((token as Tokens.Paragraph).tokens)}</p>;
      case 'text': {
        const text = token as Tokens.Text;
        return <p key={key}>{text.tokens ? inline(text.tokens) : text.text}</p>;
      }
      case 'heading': {
        const heading = token as Tokens.Heading;
        return heading.depth <= 2
          ? <h2 key={key}>{inline(heading.tokens)}</h2>
          : <h3 key={key}>{inline(heading.tokens)}</h3>;
      }
      case 'list': {
        const list = token as Tokens.List;
        const items = list.items.map((item, itemIndex) => <li key={itemIndex}>{blocks(item.tokens)}</li>);
        return list.ordered
          ? <ol key={key} start={typeof list.start === 'number' ? list.start : undefined}>{items}</ol>
          : <ul key={key}>{items}</ul>;
      }
      case 'blockquote': return <blockquote key={key}>{blocks((token as Tokens.Blockquote).tokens)}</blockquote>;
      case 'code': {
        const code = token as Tokens.Code;
        return <pre key={key}><code>{code.text}</code></pre>;
      }
      case 'hr': return <hr key={key} />;
      case 'table': {
        const table = token as Tokens.Table;
        return <div key={key} className="message-table-scroll"><table>
          <thead><tr>{table.header.map((cell, cellIndex) => <th key={cellIndex}>{inline(cell.tokens)}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell.tokens)}</td>)}</tr>)}</tbody>
        </table></div>;
      }
      default: return <p key={key}>{'text' in token ? String(token.text) : token.raw}</p>;
    }
  });
}

export function MessageContent({ text }: { text: string }) {
  const tokens = useMemo(() => marked.lexer(text, { gfm: true }), [text]);
  return <div className="message-markdown">{blocks(tokens)}</div>;
}
