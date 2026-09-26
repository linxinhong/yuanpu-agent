import type { WorkDirectoryListing, WorkFilePreview } from '@yuanpu-agent/protocol';

/**
 * Host seam for the viewer modules: everything the viewer needs from the
 * embedding shell. Today that is file access scoped to one Work conversation
 * (implemented over the desktop bridge, actual IO in the desktop-owned
 * runtime sidecar); later it grows native browser mounting and shared
 * browser-session control. Implementations live outside `viewer/` so viewer
 * components never bind to Electron, the bridge, or a storage layout.
 */
export interface ViewerFileHost {
  listDirectory(dirPath?: string): Promise<WorkDirectoryListing>;
  readFile(filePath: string): Promise<WorkFilePreview>;
}
