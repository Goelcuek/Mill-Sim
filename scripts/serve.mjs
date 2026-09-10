// Minimal static server. The app is plain ES modules, so it needs to be
// served over HTTP — opening index.html from the filesystem will not work.
//
//   npm start            → http://localhost:8080
//   npm start -- 3000    → http://localhost:3000

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.nc': 'text/plain; charset=utf-8',
  '.stl': 'model/stl',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer(async (req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  const target = join(ROOT, normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) throw new Error('directory');
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(target)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`Mill-Sim running at http://localhost:${PORT}`);
});
