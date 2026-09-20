import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

function App() {
  const [name, setName] = useState('Yuanpu');
  const [message, setMessage] = useState('正在连接本地 Runtime…');
  const [runtimeVersion, setRuntimeVersion] = useState('—');
  const [updateText, setUpdateText] = useState('');
  const desktop = window.yuanpu;

  useEffect(() => {
    if (!desktop) {
      setMessage('当前为浏览器预览；请通过 Electron 启动以连接 Runtime。');
      return;
    }
    void desktop.runtimeInfo().then((info) => {
      setRuntimeVersion(`${info.version} · protocol ${info.protocolVersion}`);
      setMessage('Runtime 已就绪');
    });
  }, [desktop]);

  async function greet() {
    if (!desktop) return;
    const result = await desktop.greeting(name.trim() || 'world');
    setMessage(result.message);
  }

  async function checkRuntimeUpdate() {
    if (!desktop) return;
    setUpdateText('正在检查…');
    const state = await desktop.checkRuntimeUpdate();
    setUpdateText(
      state.status === 'current'
        ? `Runtime ${state.currentVersion} 已是最新版本`
        : state.message || state.status,
    );
  }

  async function checkDesktopUpdate() {
    if (!desktop) return;
    setUpdateText('正在检查桌面端更新；如有新版本，将在后台下载并于退出时安装。');
    try {
      await desktop.checkDesktopUpdate();
    } catch (error) {
      setUpdateText(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="shell">
      <header>
        <div className="brand-mark">源</div>
        <div>
          <p className="eyebrow">YUANPU AGENT</p>
          <h1>桌面端与智能运行时，已经解耦。</h1>
        </div>
      </header>

      <section className="hero-card">
        <div>
          <span className="status-dot" />
          <span className="status-label">LOCAL RUNTIME</span>
          <p className="message">{message}</p>
        </div>
        <dl>
          <div>
            <dt>Runtime</dt>
            <dd>{runtimeVersion}</dd>
          </div>
          <div>
            <dt>更新策略</dt>
            <dd>独立暂存 · 重启切换</dd>
          </div>
        </dl>
      </section>

      <section className="workspace">
        <div>
          <p className="section-label">通信链路验证</p>
          <h2>Renderer → Preload → Electron → SEA</h2>
          <p className="description">
            图形界面只调用受限的 preload API。Electron 管理 SEA 生命周期，Runtime 通过版本化的本地协议提供能力。
          </p>
        </div>
        <div className="controls">
          <label htmlFor="name">向 Runtime 发送名字</label>
          <div className="input-row">
            <input id="name" value={name} onChange={(event) => setName(event.target.value)} />
            <button type="button" onClick={() => void greet()} disabled={!desktop}>
              发送
            </button>
          </div>
          <button
            className="secondary"
            type="button"
            onClick={() => void checkRuntimeUpdate()}
            disabled={!desktop}
          >
            检查 Runtime 更新
          </button>
          <button
            className="secondary"
            type="button"
            onClick={() => void checkDesktopUpdate()}
            disabled={!desktop}
          >
            检查桌面端更新
          </button>
          {updateText && <p className="update-text">{updateText}</p>}
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
