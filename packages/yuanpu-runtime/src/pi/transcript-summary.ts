import type { DesktopReplyRunInfo, DesktopTranscriptMessage } from '@yuanpu-agent/protocol';
import { browserScreenshotPath, withBrowserScreenshots } from './browser-screenshot-attachment.js';

type TranscriptEntry = {
  id: string;
  timestamp: string;
  type: string;
  message?: {
    role: string;
    content?: string | Array<{ type: string; text?: string }>;
    stopReason?: string;
    toolName?: string;
    isError?: boolean;
    details?: unknown;
  };
};

/** Derive a public summary from the selected Pi branch, without leaking tool payloads. */
export function summarizeTranscript(
  entries: readonly TranscriptEntry[],
  options: { limit?: number; completedOnly?: boolean } = {},
): DesktopTranscriptMessage[] {
  const messages: DesktopTranscriptMessage[] = [];
  let startedAt: string | undefined;
  let events: DesktopReplyRunInfo['events'] = [];
  let tools: DesktopReplyRunInfo['tools'] = [];
  let browserScreenshots: string[] = [];
  for (const entry of entries) {
    const message = entry.message;
    if (entry.type !== 'message' || !message) continue;
    if (message.role === 'user') {
      startedAt = entry.timestamp;
      events = [{ id: 0, title: '收到消息', at: entry.timestamp }];
      tools = [];
      browserScreenshots = [];
    }
    if (message.role === 'toolResult' && startedAt && message.toolName) {
      if (message.toolName === 'execute_capability') {
        const path = browserScreenshotPath(message.details);
        if (path) browserScreenshots.push(path);
      }
      tools.push({ name: message.toolName, status: message.isError ? 'failed' : 'completed' });
      events.push({ id: events.length, title: message.isError ? '工具调用失败' : '工具调用完成', detail: message.toolName, at: entry.timestamp });
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (options.completedOnly && message.role === 'assistant' && message.stopReason !== 'stop') continue;
    const text = typeof message.content === 'string' ? message.content
      : (message.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');
    if (!text.trim()) continue;
    const status = message.stopReason === 'error' ? 'failed' : message.stopReason === 'aborted' ? 'cancelled'
      : message.stopReason === 'toolUse' ? 'running' : ['stop', 'length'].includes(message.stopReason ?? '') ? 'succeeded' : undefined;
    const run: DesktopReplyRunInfo | undefined = message.role === 'assistant' && startedAt && status ? {
      source: 'transcript', status, createdAt: startedAt, updatedAt: entry.timestamp,
      events: [...events, { id: events.length, title: status === 'succeeded' ? '已生成回复' : status === 'running' ? '继续处理' : '处理结束', at: entry.timestamp }],
      tools: [...tools],
    } : undefined;
    messages.push({ id: entry.id, role: message.role,
      text: message.role === 'assistant' && status === 'succeeded'
        ? withBrowserScreenshots(text, browserScreenshots) : text,
      at: entry.timestamp, ...(run ? { run } : {}) });
  }
  return messages.slice(-(options.limit ?? 100));
}
