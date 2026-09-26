export type ViewerFileKind = 'text' | 'markdown' | 'image' | 'pdf' | 'other';

/** Pure extension-based classification; the runtime remains the authority on content. */
export function classifyWorkFile(name: string): ViewerFileKind {
  const dot = name.lastIndexOf('.');
  const extension = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(extension)) return 'image';
  if ([
    'txt', 'log', 'md', 'markdown', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'html', 'htm', 'css',
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp',
    'cs', 'php', 'sh', 'bash', 'zsh', 'toml', 'ini', 'cfg', 'conf', 'sql', 'env', 'lock',
  ].includes(extension)) return 'text';
  return 'other';
}
