import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = resolve(desktopRoot, '../app');
const iconRoot = resolve(appRoot, 'src/assets');
const config = JSON.parse(await readFile(resolve(appRoot, 'emo.json'), 'utf8'));
const icon = resolve(iconRoot, config.brand.icon);
if (!icon.startsWith(`${iconRoot}${sep}`) || !icon.endsWith('.png')) {
  throw new Error('emo.json brand.icon must point to a PNG under apps/app/src/assets');
}
const output = resolve(desktopRoot, 'dist/emo-icon.png');
await mkdir(dirname(output), { recursive: true });
await copyFile(icon, output);
