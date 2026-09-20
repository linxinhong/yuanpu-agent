import { greeting } from '@yuanpu-agent/core';

declare const __APP_VERSION__: string;

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(__APP_VERSION__);
} else {
  const nameIndex = args.indexOf('--name');
  const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
  console.log(greeting(name || 'world'));
}
