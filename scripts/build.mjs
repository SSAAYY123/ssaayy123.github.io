import { mkdir, copyFile, rm } from 'node:fs/promises';
await rm('public', { recursive: true, force: true });
await mkdir('public', { recursive: true });
for (const page of ['index.html', 'work.html']) {
  await copyFile(page, `public/${page}`);
}
console.log('Built 2 static pages.');
