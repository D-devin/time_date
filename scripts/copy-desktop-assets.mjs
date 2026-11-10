import { copyFile, mkdir } from 'node:fs/promises';

for (const file of ['renderer/index.html', 'renderer/styles.css', 'desktop/tray.png']) {
  const source = new URL('../src/' + file, import.meta.url);
  const target = new URL('../dist/src/' + file, import.meta.url);
  await mkdir(new URL('.', target), { recursive: true });
  await copyFile(source, target);
}

for (const [source, name] of [
  ['modular/sortable.complete.esm.js', 'sortable.js'],
  ['LICENSE', 'SortableJS.LICENSE'],
]) {
  const target = new URL('../dist/src/renderer/vendor/' + name, import.meta.url);
  await mkdir(new URL('.', target), { recursive: true });
  await copyFile(new URL('../node_modules/sortablejs/' + source, import.meta.url), target);
}
