import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveWorkspacePath } from './workspace-files.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_SCREENSHOT_BYTES = 50 * 1024 * 1024;

export interface SavedBrowserScreenshot {
  path: string;
  relativePath: string;
}

/** Save a browser capture under the owning Work conversation, never outside it. */
export async function saveBrowserScreenshot(workspaceRoot: string, base64: string): Promise<SavedBrowserScreenshot> {
  const png = Buffer.from(base64, 'base64');
  if (png.length < PNG_SIGNATURE.length || png.length > MAX_SCREENSHOT_BYTES
    || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('浏览器截图不是有效的 PNG，或超过 50 MB。');
  }

  const realRoot = await realpath(workspaceRoot);
  await mkdir(join(realRoot, 'images'), { recursive: true, mode: 0o700 });
  const imageDirectory = await resolveWorkspacePath(realRoot, 'images');
  const filename = `browser-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.png`;
  const relativePath = `images/${filename}`;
  const path = join(imageDirectory, filename);
  await writeFile(path, png, { flag: 'wx', mode: 0o600 });
  return { path, relativePath };
}
