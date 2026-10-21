import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = new URL('../', import.meta.url);
let failures = 0;
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (/\.(js|mjs)$/.test(file)) {
      const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (checked.status) { process.stderr.write(checked.stderr); failures++; }
    } else if (entry.name === 'package.json' || entry.name === 'vercel.json') {
      try { JSON.parse(await readFile(file, 'utf8')); } catch (error) { process.stderr.write(`${file}: ${error.message}\n`); failures++; }
    }
  }
}
await walk(root.pathname);
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
if (new Set(ids).size !== ids.length) { process.stderr.write('Duplicate HTML IDs\n'); failures++; }
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
for (const [, id] of app.matchAll(/\$\('([^']+)'\)/g)) {
  if (!ids.includes(id)) { process.stderr.write(`Missing HTML element: ${id}\n`); failures++; }
}
if (failures) process.exitCode = 1;
else process.stdout.write('Syntax, JSON, and browser element references passed.\n');
