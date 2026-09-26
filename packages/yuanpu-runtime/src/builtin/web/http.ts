import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
const ipv6Global = new BlockList();
ipv6Global.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(address, prefix, 'ipv6');
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && ipv6Global.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
async function abortableLookup(hostname: string, signal: AbortSignal) {
  return new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { signal.removeEventListener('abort', abort); reject(signal.reason); return; }
    void lookup(hostname, { all: true }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export function webProxyFor(url: URL, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const bypass = (env.no_proxy ?? env.NO_PROXY ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (bypass.some((entry) => {
    if (entry === '*') return true;
    const match = /^(.*?)(?::(\d+))?$/.exec(entry)!;
    if (match[2] && match[2] !== port) return false;
    const domain = match[1]!.replace(/^\*?\./, '');
    return host === domain || host.endsWith(`.${domain}`);
  })) return undefined;
  return (url.protocol === 'https:' ? env.https_proxy ?? env.HTTPS_PROXY : env.http_proxy ?? env.HTTP_PROXY) ?? env.all_proxy ?? env.ALL_PROXY;
}
export interface WebResponse { url: string; status: number; headers: Record<string, string | string[] | undefined>; text: string }
export type WebTransport = (url: string, options?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<WebResponse>;

/** Pin validated DNS results to the connection; redirects are validated independently. */
export const publicWebRequest: WebTransport = async (address, options = {}) => {
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]);
  let url = new URL(address);
  const originalOrigin = url.origin;
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP(S) URLs without credentials are supported.');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const resolved = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortableLookup(hostname, signal);
    signal.throwIfAborted();
    if (!resolved.length || resolved.some((entry) => !isPublicAddress(entry.address))) throw new Error('Private, reserved and loopback destinations are blocked.');
    const pinned = resolved[0]!;
    const proxyUrl = webProxyFor(url);
    if (proxyUrl && !['http:', 'https:'].includes(new URL(proxyUrl).protocol)) throw new Error('Only HTTP(S) environment proxies are supported.');
    const proxy = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
    const response = await new Promise<WebResponse>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: options.method ?? 'GET', signal, agent: proxy ?? false,
        ...(proxy ? { hostname: pinned.address, servername: hostname } : {}),
        headers: { 'user-agent': 'YuanpuAgent/WebAccess', 'accept-encoding': 'identity', ...options.headers, host: url.host },
        lookup: (_host, opts, callback) => {
          if (opts.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      }, (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('error', reject);
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
          res.destroy(new Error('Compressed response was not requested.')); return;
        }
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) res.destroy(new Error('Web response exceeds 8 MiB.'));
          else chunks.push(chunk);
        });
        res.on('end', () => resolve({ url: url.href, status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(options.body);
    }).finally(() => proxy?.destroy());
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.location;
    if (typeof location !== 'string') throw new Error('Redirect missing location.');
    url = new URL(location, url);
    if (options.method === 'POST' || (Object.keys(options.headers ?? {}).length && url.origin !== originalOrigin)) throw new Error('Credentialed or POST redirects are not followed.');
  }
  throw new Error('Too many redirects.');
};
