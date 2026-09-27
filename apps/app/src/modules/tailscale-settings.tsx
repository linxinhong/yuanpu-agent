import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SaveTailscaleConnectionInput, TailscaleConnectionSettings } from '@yuanpu-agent/protocol';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function TailscaleSettingsPanel({ active, configRoot }: { active: boolean; configRoot: string }) {
  const desktop = window.yuanpu;
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['connections', 'tailscale'],
    queryFn: () => desktop!.getTailscaleConnection(),
    enabled: active && Boolean(desktop),
  });
  const [authKey, setAuthKey] = useState('');
  const [removeAuthKey, setRemoveAuthKey] = useState(false);
  const [notice, setNotice] = useState('');
  const save = useMutation({
    mutationFn: (input: SaveTailscaleConnectionInput) => desktop!.saveTailscaleConnection(input),
    onSuccess: (settings: TailscaleConnectionSettings) => {
      client.setQueryData(['connections', 'tailscale'], settings);
      setAuthKey('');
      setRemoveAuthKey(false);
      setNotice('Tailscale 配置已保存。');
    },
    onError: () => setNotice(''),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice('');
    save.mutate({
      ...(authKey ? { authKey } : {}),
      ...(removeAuthKey ? { removeAuthKey: true } : {}),
    });
  }

  return <section className="tailscale-settings" aria-label="Tailscale 连接配置">
    <header><h2>Tailscale</h2><p>保存设备加入 Tailnet 所需的 Auth Key。</p></header>
    {!desktop && <p role="status">请在桌面应用中配置 Tailscale。</p>}
    {query.isLoading && <p role="status">正在读取配置…</p>}
    {query.error && <p role="alert">读取失败：{message(query.error)}</p>}
    <form onSubmit={submit}>
      <label>设备 Auth Key <span>{query.data?.hasAuthKey ? '已配置 · 留空保持原值' : '尚未配置'}</span>
        <input type="password" value={authKey} onChange={(event) => { setAuthKey(event.target.value); setRemoveAuthKey(false); }}
          placeholder="输入 Tailscale 设备 Auth Key" autoComplete="new-password" spellCheck={false} />
      </label>
      {query.data?.hasAuthKey && <label className="tailscale-remove"><input type="checkbox" checked={removeAuthKey}
        onChange={(event) => { setRemoveAuthKey(event.target.checked); if (event.target.checked) setAuthKey(''); }} />移除设备 Auth Key</label>}
      <p className="tailscale-file-note">保存在 <code>{configRoot}/app/connections/tailscale.json</code>。密钥只写入本机配置文件，界面不回显。</p>
      {save.error && <p role="alert">保存失败：{message(save.error)}</p>}
      {notice && <p role="status">{notice}</p>}
      <button type="submit" disabled={!desktop || save.isPending || query.isLoading || (!authKey && !removeAuthKey)}>{save.isPending ? '保存中…' : '保存配置'}</button>
    </form>
  </section>;
}
