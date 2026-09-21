import { pathToFileURL } from 'node:url';

export function packagedRendererUrl(indexPath: string): string {
  return pathToFileURL(indexPath).href;
}

export function isTrustedRendererUrl(candidate: string, trustedEntry: string): boolean {
  try {
    const current = new URL(candidate);
    const trusted = new URL(trustedEntry);
    if (current.protocol !== trusted.protocol || current.origin !== trusted.origin) return false;
    if (trusted.protocol === 'file:') return current.pathname === trusted.pathname;
    return current.pathname === trusted.pathname;
  } catch {
    return false;
  }
}
