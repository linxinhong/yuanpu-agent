import type { Tokens } from 'marked';

const PREVIEW_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

/** A code token is usable only after its closing fence arrives in the stream. */
export function completeHtmlPreview(token: Tokens.Code): boolean {
  if (token.lang?.trim() !== 'html-preview') return false;
  const opening = token.raw.match(/^(`{3,}|~{3,})[^\n]*\n/);
  if (!opening) return false;
  const marker = opening[1]![0]!;
  const count = opening[1]!.length;
  return new RegExp(`(?:^|\\n)${marker === '~' ? '~' : '`'}{${count},}[ \\t]*(?:\\n|$)`).test(token.raw.slice(opening[0].length));
}

/** The same inert document is used in the sandbox and for downloads. */
export function htmlPreviewDocument(content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{box-sizing:border-box}*,*:before,*:after{box-sizing:inherit}body{margin:0;padding:16px;color:#20272d;background:#fff;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}svg{display:block;max-width:100%;height:auto;margin:auto}svg:not([width]){width:min(100%,760px)}</style></head><body>${content}</body></html>`;
}

/** Markdown images never receive executable or local-file URLs. */
export function safeImageSource(source: string): { kind: 'url' | 'workspace'; value: string } | null {
  const trimmed = source.trim();
  if (/^https:\/\/[^\s]+$/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.username || url.password) return null;
      return { kind: 'url', value: url.href };
    } catch { return null; }
  }
  if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/=]+$/i.test(trimmed) && trimmed.length <= 8_000_000) {
    return { kind: 'url', value: trimmed };
  }
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('~') || trimmed.includes('\\') || trimmed.includes(':')
    || trimmed.includes('?') || trimmed.includes('#') || trimmed.includes('\0')) return null;
  const path = trimmed.replace(/^\.\//, '');
  if (!/\.(?:png|jpe?g|gif|webp|avif)$/i.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return { kind: 'workspace', value: path };
}
