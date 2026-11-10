import { copyFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const artifact = new URL(`release/时笺-${version}-Windows-x64.exe`, root);
const destination = new URL('时笺.exe', root);
await copyFile(artifact, destination);
console.log(`已生成 ${fileURLToPath(destination)}`);
