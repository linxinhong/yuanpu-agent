import { WSClient } from '@wecom/aibot-node-sdk';

// Invoke with Node 24's --env-file. Never pass credentials as command arguments or print SDK frames.
const botId = process.env.WECOM_BOT_ID;
const secret = process.env.WECOM_BOT_SECRET;
if (!botId || !secret) {
  console.log(JSON.stringify({ authenticated: false, reason: 'missing_variables' }));
  process.exitCode = 1;
} else {
  let finish;
  const outcome = new Promise((resolve) => { finish = resolve; });
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error(message) {
      const match = /^Authentication failed: errcode=(-?[0-9]+)/u.exec(String(message));
      if (match) finish({ authenticated: false, errcode: Number(match[1]) });
    },
  };
  let client;
  let timeout;
  let result;
  try {
    client = new WSClient({
      botId,
      secret,
      logger,
      maxAuthFailureAttempts: 1,
      maxReconnectAttempts: 0,
      reconnectInterval: 1_000,
      requestTimeout: 7_000,
    });
    client.on('authenticated', () => finish({ authenticated: true }));
    client.on('error', () => undefined);
    timeout = setTimeout(() => finish({ authenticated: false, reason: 'timeout' }), 10_000);
    client.connect();
    result = await outcome;
  } catch {
    result = { authenticated: false, reason: 'client_error' };
  } finally {
    clearTimeout(timeout);
    try { client?.disconnect(); } catch { /* Do not print SDK errors. */ }
  }
  console.log(JSON.stringify(result));
  if (!result.authenticated) process.exitCode = 1;
}
