import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './shell/app-shell.js';
import { applyThemePreference, readThemePreference } from './shared/theme-preference.js';
import '../themes/tokens.css';
import './styles.css';
import './muse-theme.css';
import '../themes/mindlink.css';

applyThemePreference(readThemePreference());
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false }, mutations: { retry: false } } });
createRoot(document.getElementById('root')!).render(
  <StrictMode><HashRouter><QueryClientProvider client={queryClient}><App /></QueryClientProvider></HashRouter></StrictMode>,
);
