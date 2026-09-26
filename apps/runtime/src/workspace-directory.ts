import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

function timestamp(date: Date): string {
  const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate(),
    date.getHours(), date.getMinutes(), date.getSeconds()];
  return parts.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
    .join('-');
}

/** An unnamed Work conversation owns a fresh directory; explicit directories remain user selected. */
export async function createWorkspaceDirectory(root: string, date = new Date()): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const directory = join(root, `${timestamp(date)}-${randomUUID().replaceAll('-', '').slice(0, 10)}`);
    try {
      await mkdir(directory, { mode: 0o700 });
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not allocate a unique workspace directory.');
}

export async function resolveSelectedWorkspaceDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('The selected workspace directory must be an absolute path.');
  const directory = resolve(path);
  if (!(await stat(directory)).isDirectory()) throw new Error('The selected workspace path is not a directory.');
  return directory;
}
