import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import config from '../api/config.js';
import mcp from '../api/mcp.js';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const port = Number(process.env.PORT || 3210);
http.createServer(async (req, res) => {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (value) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/config') return config(req, res);
  if (url.pathname === '/api/mcp') return mcp(req, res);
  const file = path.resolve(root, `.${url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${root}${path.sep}`)) { res.writeHead(403).end(); return; }
  try { const data = await readFile(file); res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); res.setHeader('Cache-Control', 'no-store'); res.end(data); }
  catch { res.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => process.stdout.write(`Still: http://127.0.0.1:${port}\n`));
