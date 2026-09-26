import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const PageToolbarHost = createContext<HTMLDivElement | null>(null);

/** Only the visible page contributes controls to the window-wide toolbar. */
export function PageToolbar({ active, children }: { active: boolean; children: ReactNode }) {
  const host = useContext(PageToolbarHost);
  return active && host ? createPortal(children, host) : null;
}
