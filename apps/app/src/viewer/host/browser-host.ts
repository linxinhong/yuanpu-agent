import type { BrowserGuestAttachPayload } from '@yuanpu-agent/protocol';

/**
 * Host seam for the viewer browser module: how the embedded browser guest
 * registers with the Electron main process, how the guest lifecycle is
 * observed, and how pages escape to the system browser. Implemented over the
 * desktop bridge in chat.tsx; agent commands reach the same guests through
 * the main-process control service.
 */
export interface ViewerBrowserHost {
  attachGuest(payload: BrowserGuestAttachPayload): Promise<void>;
  detachGuest(key: string): Promise<void>;
  openInSystemBrowser(url: string): Promise<void>;
  onGuestCrashed(listener: (guestKey: string) => void): () => void;
  onSessionRequest(listener: (conversationId: string) => void): () => void;
}
