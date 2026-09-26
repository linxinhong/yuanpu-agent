import type { BrowserControlCommand, BrowserControlResult } from '@yuanpu-agent/protocol';

export interface BrowserControlEndpoint {
  port: number;
  token: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const SCREENSHOT_TIMEOUT_MS = 60_000;

/**
 * Loopback client for the Electron-main browser control service. The endpoint
 * (random 127.0.0.1 port + bearer token) arrives through the runtime bootstrap
 * so the sidecar never listens and main never polls.
 */
export class BrowserControlClient {
  constructor(private readonly endpoint: BrowserControlEndpoint) {}

  async execute(command: BrowserControlCommand): Promise<BrowserControlResult> {
    const timeoutMs = command.method === 'screenshot' ? SCREENSHOT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    const response = await fetch(`http://127.0.0.1:${this.endpoint.port}/browser/execute`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}) as { error?: string });
      return { ok: false, method: command.method, error: body.error ?? `Browser control failed with HTTP ${response.status}` };
    }
    return await response.json() as BrowserControlResult;
  }
}
