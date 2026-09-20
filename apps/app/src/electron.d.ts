import type { DesktopBridge } from '@yuanpu-agent/protocol';

declare global {
  interface Window {
    yuanpu?: DesktopBridge;
  }
}

export {};
