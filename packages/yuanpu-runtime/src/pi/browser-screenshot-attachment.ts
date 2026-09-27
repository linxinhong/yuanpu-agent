/** Only a successful result from the built-in browser may become a chat image. */
export function browserScreenshotPath(details: unknown): string | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const result = details as Record<string, unknown>;
  if (result.sourceInstanceId !== 'builtin.host.browser' || result.isError === true) return undefined;
  if (typeof result.capability !== 'string'
    || !result.capability.endsWith(':YnJvd3Nlcl9zY3JlZW5zaG90')) return undefined;
  const structured = result.structuredContent;
  if (!structured || typeof structured !== 'object') return undefined;
  const screenshot = (structured as Record<string, unknown>).screenshot;
  if (!screenshot || typeof screenshot !== 'object') return undefined;
  const path = (screenshot as Record<string, unknown>).relativePath;
  return typeof path === 'string' && /^images\/browser-[a-z\d-]+\.png$/i.test(path) ? path : undefined;
}

export function withBrowserScreenshots(reply: string, paths: readonly string[]): string {
  const missing = [...new Set(paths)].filter((path) => !reply.split('\n')
    .some((line) => line.includes('![') && line.includes(`](${path})`)));
  return missing.length ? `${reply.trimEnd()}\n\n${missing.map((path) => `![浏览器截图](${path})`).join('\n\n')}` : reply;
}
