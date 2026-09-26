import { createHighlighterCore, type HighlighterCore, type LanguageRegistration } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

export interface HighlightedToken {
  text: string;
  light: string;
  dark?: string;
}

export type HighlightedLine = HighlightedToken[];

type GrammarModule = { default: LanguageRegistration[] };

/**
 * The oniguruma engine needs WebAssembly eval, which the renderer CSP
 * (`script-src 'self'`) forbids, so highlighting uses shiki's JavaScript
 * regex engine. Grammars load on demand; both themes register once so a
 * token pair can serve the light and dark app themes.
 */
const GRAMMAR_IMPORTS: Record<string, () => Promise<GrammarModule>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  shell: () => import('shiki/langs/shellscript.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  dockerfile: () => import('shiki/langs/docker.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
};

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', kts: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', swift: 'swift', scala: 'scala', sh: 'shell', bash: 'bash', zsh: 'shell',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', html: 'html', htm: 'html', css: 'css',
  sql: 'sql', lua: 'lua', dart: 'dart', dockerfile: 'dockerfile', graphql: 'graphql',
};

/** Maps a file name to a grammar id with a bundled shiki language; undefined means plain text. */
export function shikiLanguageForFile(fileName: string): string | undefined {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return EXTENSION_LANGUAGES[fileName.slice(dot + 1).toLowerCase()];
}

let highlighterPromise: Promise<HighlighterCore> | undefined;

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighterPromise;
}

/**
 * Tokenizes code once with both themes so the light and dark app themes can
 * recolor the same spans (shiki emits both colors per token; a single pass
 * keeps the token boundaries structurally aligned). Returns undefined when
 * highlighting is unavailable — the caller falls back to plain text.
 */
export async function highlightLines(code: string, lang: string): Promise<HighlightedLine[] | undefined> {
  const grammarImport = GRAMMAR_IMPORTS[lang];
  if (!grammarImport) return undefined;
  try {
    const highlighter = await getHighlighter();
    await highlighter.loadLanguage(grammarImport());
    const result = highlighter.codeToTokens(code, {
      lang,
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    });
    return result.tokens.map((lineTokens) => lineTokens.map((token) => ({
      text: token.content,
      light: token.htmlStyle?.['--shiki-light'] ?? '',
      dark: token.htmlStyle?.['--shiki-dark'],
    })));
  } catch {
    return undefined;
  }
}
