import config from '../emo.json';
import type { UiDestination } from './ui-registry.js';

type NavigationDestination = Exclude<UiDestination, 'settings'>;
const brandIcons = import.meta.glob('./assets/brand/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export const emo = config;

export function showNavigation(destination: UiDestination): boolean {
  return destination === 'settings' || emo.navigation[destination as NavigationDestination];
}

export function brandIconUrl(): string {
  return brandIcons[`./assets/${emo.brand.icon}`] ?? brandIcons['./assets/brand/app-icon.png'] ?? '';
}
