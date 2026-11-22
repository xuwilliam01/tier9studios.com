// Local preview server that behaves like GitHub Pages for this repository. No dependencies.
//
//   node tools/dev-server.mjs [--port 8080] [--api http://127.0.0.1:8787]
//
// What it copies from GitHub Pages:
//   - a folder URL serves its index.html, and a folder URL without the trailing slash redirects to it;
//   - a missing path answers 404 with the body of /404.html (the /abw/app deep-link fallback depends on this).
//
// --api points the careers pages at a local team site instead of the live one. Each careers page names
// the hiring API in <meta name="t9-api"> and allows it in its Content-Security-Policy; with --api, this
// server rewrites both in the HTML it serves. The files on disk are never changed, and the shipped
// JavaScript has no localhost switch of its own.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(arg('--port', '8080'));
const api = arg('--api', '').replace(/\/+$/, '');
const LIVE_API = 'https://team.tier9studios.com';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

function send(res, status, file) {
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  let body = fs.readFileSync(file);
  if (api && type.startsWith('text/html')) body = Buffer.from(body.toString('utf8').split(LIVE_API).join(api));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const file = path.join(root, pathname);
  const stat = fs.existsSync(file) ? fs.statSync(file) : null;
  // Never serve outside the repository, and never the Git folder. The check reads the path the file
  // system resolved, because Windows ignores case and gives "\" and ":" a meaning that the text of the
  // request path does not show.
  const inside = path.relative(root, stat ? fs.realpathSync.native(file) : file);
  if (inside.startsWith('..') || path.isAbsolute(inside) || inside.split(path.sep).includes('.git')) {
    res.writeHead(403).end();
    return;
  }
  if (stat && stat.isDirectory()) {
    if (!pathname.endsWith('/')) {
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      res.writeHead(301, { Location: pathname + '/' + query }).end();
      return;
    }
    const index = path.join(file, 'index.html');
    if (fs.existsSync(index)) { send(res, 200, index); return; }
  } else if (stat) {
    send(res, 200, file);
    return;
  }
  send(res, 404, path.join(root, '404.html'));
}).listen(port, '127.0.0.1', () => {
  console.log(`Serving ${root} at http://127.0.0.1:${port}/` + (api ? ` (careers API: ${api})` : ''));
});
