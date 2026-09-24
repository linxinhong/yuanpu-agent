import type { ReactNode } from 'react';
import type { UiDestination } from '../ui-registry.js';

type AppView = UiDestination;

export function AppIcon({ name }: { name: AppView | 'menu' | 'panel' | 'panel-left' | 'expand' | 'collapse' | 'send' | 'copy' | 'check' | 'bookmark' | 'bookmark-filled' | 'knowledge-filled' | 'chevron' | 'plus' | 'shield' | 'shield-filled' | 'lock' | 'edit' }) {
  const paths = {
    work: <path d="M20 11.5c0 4.2-3.8 7.5-8.5 7.5-1.4 0-2.7-.3-3.8-.8L3 20l1.4-4.1A7.2 7.2 0 0 1 3 11.5C3 7.4 6.8 4 11.5 4S20 7.4 20 11.5Z" />,
    assistant: <><circle cx="12" cy="7" r="3" /><path d="M5 20v-2a7 7 0 0 1 14 0v2M8 14h8" /></>,
    skills: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><path d="M17 13.5v7m-3.5-3.5h7" /></>,
    knowledge: <><path d="M12 5.5c-2.5-1.5-5.5-1.5-8 0v14c2.5-1.5 5.5-1.5 8 0m0-14c2.5-1.5 5.5-1.5 8 0v14c-2.5-1.5-5.5-1.5-8 0m0-14v14" /></>,
    settings: <><path d="M10 2.5h4l.4 2.2 1.7.7L18 4.2 20.8 7l-1.2 1.9.7 1.7 2.2.4v4l-2.2.4-.7 1.7 1.2 1.9-2.8 2.8-1.9-1.2-1.7.7-.4 2.2h-4l-.4-2.2-1.7-.7L6 21.8 3.2 19l1.2-1.9-.7-1.7-2.2-.4v-4l2.2-.4.7-1.7L3.2 7 6 4.2l1.9 1.2 1.7-.7z" /><circle cx="12" cy="13" r="3" /></>,
    schedules: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.4 2" /></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
    'panel-left': <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
    expand: <><path d="M10 14 4 20m0-6v6h6M14 10l6-6m-6 0h6v6" /></>,
    collapse: <><path d="m4 4 6 6m0-6v6H4m16 10-6-6m0 6v-6h6" /></>,
    send: <><path d="M12 19V5m-5 5 5-5 5 5" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
    check: <path d="m4.5 12.5 5 5 10-11" />,
    bookmark: <path d="M6 4.5h12v16l-6-4-6 4z" />,
    'bookmark-filled': <path d="M6 4.5h12v16l-6-4-6 4z" fill="currentColor" stroke="none" />,
    'knowledge-filled': <><path d="M3.5 5.5c2.5-1.4 5.5-1.4 8 .1v13.9c-2.5-1.5-5.5-1.5-8 0z" fill="currentColor" stroke="none" /><path d="M12.5 5.6c2.5-1.5 5.5-1.5 8-.1v14c-2.5-1.5-5.5-1.5-8 0z" fill="currentColor" stroke="none" /></>,
    chevron: <path d="m9 6 6 6-6 6" />,
    plus: <path d="M12 4v16M4 12h16" />,
    shield: <path d="M12 2.8 20 6v5.6c0 4.8-3.1 8.4-8 10-4.9-1.6-8-5.2-8-10V6z" />,
    'shield-filled': <><path d="M12 2.8 20 6v5.6c0 4.8-3.1 8.4-8 10-4.9-1.6-8-5.2-8-10V6z" fill="currentColor" stroke="none" /><path d="m8.5 12 2.3 2.3 4.7-4.7" stroke="var(--yp-surface)" strokeWidth="2" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
    edit: <><path d="M12 20h8M4 16.5V20h3.5L18.8 8.7l-3.5-3.5L4 16.5Z" /><path d="m13.8 6.7 3.5 3.5" /></>,
  } satisfies Record<AppView | 'menu' | 'panel' | 'panel-left' | 'expand' | 'collapse' | 'send' | 'copy' | 'check' | 'bookmark' | 'bookmark-filled' | 'knowledge-filled' | 'chevron' | 'plus' | 'shield' | 'shield-filled' | 'lock' | 'edit', ReactNode>;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
