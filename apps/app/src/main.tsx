import { StrictMode, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

type ToolState = { name: string; status: 'started' | 'completed' | 'failed' };
type ChatMessage = {
  id: number;
  role: 'user' | 'assistant' | 'error';
  text: string;
  tools?: ToolState[];
};

const initialMessages: ChatMessage[] = [{
  id: 1,
  role: 'assistant',
  text: '你好，我是 YuanpuAgent。你可以直接开始对话，也可以让我调用外部 MCP 能力。',
}];

function App() {
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [runtime, setRuntime] = useState({ connected: false, piVersion: '—', configRoot: '~/.yuanpu' });
  const nextId = useRef(2);
  const conversation = useRef<HTMLDivElement>(null);
  const desktop = window.yuanpu;

  useEffect(() => {
    if (!desktop) return;
    void desktop.runtimeInfo()
      .then((info) => setRuntime({
        connected: true,
        piVersion: info.piVersion,
        configRoot: info.configRoot,
      }))
      .catch(() => setRuntime((current) => ({ ...current, connected: false })));
  }, [desktop]);

  useEffect(() => {
    conversation.current?.scrollTo({ top: conversation.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || busy) return;
    setMessages((current) => [...current, { id: nextId.current++, role: 'user', text }]);
    setInput('');
    setBusy(true);

    try {
      const result = desktop
        ? await desktop.chat(text)
        : {
            message: '这是浏览器预览回复。通过 Electron 启动后，消息会交给 Pi coding-agent。',
            tools: text.toLowerCase().includes('echo')
              ? [{ name: 'yuanpu.echo', status: 'completed' as const }]
              : [],
          };
      setMessages((current) => [...current, {
        id: nextId.current++,
        role: 'assistant',
        text: result.message,
        tools: result.tools,
      }]);
    } catch (error) {
      setMessages((current) => [...current, {
        id: nextId.current++,
        role: 'error',
        text: error instanceof Error ? error.message : String(error),
      }]);
      setInput(text);
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">源</div>
          <div>
            <strong>YUANPU AGENT</strong>
            <span>本地工作助手</span>
          </div>
        </div>

        <button className="conversation-item" type="button" aria-current="page">
          <span className="conversation-icon" aria-hidden="true" />
          <span>
            <strong>新对话</strong>
            <small>当前会话</small>
          </span>
        </button>

        <div className="sidebar-footer">
          <span className="footer-label">配置目录</span>
          <code title={runtime.configRoot}>{runtime.configRoot}</code>
          <span className="route-note">Renderer → Electron → SEA</span>
        </div>
      </aside>

      <section className="chat-panel">
        <header className="chat-header">
          <div className="runtime-state">
            <span className={`status-dot ${runtime.connected ? 'online' : ''}`} />
            <div>
              <strong>{runtime.connected ? '本地 Runtime 已连接' : desktop ? '正在连接 Runtime' : '浏览器预览模式'}</strong>
              <span>{runtime.connected ? '对话仅在本机处理' : 'Electron 中启用真实 Pi 对话'}</span>
            </div>
          </div>
          <div className="runtime-meta">
            <span>Pi {runtime.piVersion}</span>
            <span className="mcp-count">2 个 MCP 元工具</span>
          </div>
        </header>

        <div className="conversation" ref={conversation} aria-live="polite">
          <div className="conversation-inner">
            {messages.map((message) => (
              <article key={message.id} className={`message ${message.role}`}>
                <div className="message-label">
                  {message.role === 'user' ? '你' : message.role === 'error' ? '运行错误' : 'YuanpuAgent'}
                </div>
                <div className="message-body">
                  <p>{message.text}</p>
                  {message.tools?.map((tool) => (
                    <div className={`tool-event ${tool.status}`} key={`${message.id}-${tool.name}`}>
                      <span className="tool-check">{tool.status === 'completed' ? '✓' : '!'}</span>
                      <span>调用 MCP</span>
                      <code>{tool.name}</code>
                      <small>{tool.status === 'completed' ? '已完成' : '失败'}</small>
                    </div>
                  ))}
                </div>
              </article>
            ))}
            {busy && (
              <article className="message assistant pending">
                <div className="message-label">YuanpuAgent</div>
                <div className="thinking"><span /><span /><span /> Pi 正在处理</div>
              </article>
            )}
          </div>
        </div>

        <div className="composer-wrap">
          <div className="composer">
            <textarea
              aria-label="消息"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="向 YuanpuAgent 发送消息…"
              rows={1}
            />
            <button type="button" onClick={() => void sendMessage()} disabled={!input.trim() || busy}>
              发送
            </button>
          </div>
          <p>Enter 发送 · Shift + Enter 换行 · 配置模型与密钥后即可开始</p>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
