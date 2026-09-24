import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const themeRoot = dirname(fileURLToPath(import.meta.url));
const outputRoot = resolve(process.argv[2] ?? join(homedir(), '.yuanpu', 'themes', 'mindlink-test'));
await mkdir(outputRoot, { recursive: true });
await Promise.all([
  copyFile(join(themeRoot, 'tokens.css'), join(outputRoot, 'tokens.css')),
  copyFile(join(themeRoot, 'assets', 'mindlink-seal.png'), join(outputRoot, 'logo.png')),
  copyFile(join(themeRoot, 'assets', 'xuan-paper-tile.jpg'), join(outputRoot, 'xuan-paper-tile.jpg')),
]);
const stylesheet = await readFile(join(themeRoot, 'mindlink.css'), 'utf8');
await writeFile(join(outputRoot, 'theme.css'), stylesheet.replaceAll("url('./assets/xuan-paper-tile.jpg')", "url('./xuan-paper-tile.jpg')"));
await writeFile(join(outputRoot, 'theme.json'), `${JSON.stringify({
  id: 'mindlink-test',
  name: '元朴思联 MindLink（测试）',
  version: 1,
  temporary: true,
  base: 'tokens.css',
  stylesheet: 'theme.css',
  logo: 'logo.png',
  paperTexture: 'xuan-paper-tile.jpg',
  selector: "data-yuanpu-theme='mindlink'",
}, null, 2)}\n`);
console.log(outputRoot);
