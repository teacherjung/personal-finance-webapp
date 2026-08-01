/* global URL, console, process */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const port = Number(process.env.PORT) || 4173;

const fixedFiles = new Map([
  ['/', join(here, 'index.html')],
  ['/index.html', join(here, 'index.html')],
  ['/forest-ui.css', join(here, 'forest-ui.css')],
  ['/forest-ui.js', join(here, 'forest-ui.js')],
  ['/forest-ui-model.js', join(here, 'forest-ui-model.js')],
  ['/modules/icons.js', join(repoRoot, 'public/modules/icons.js')],
  ['/vendor/chart.js', join(repoRoot, 'node_modules/chart.js/dist/chart.umd.js')]
]);

const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

function resolveRequest(pathname) {
  if (fixedFiles.has(pathname)) return fixedFiles.get(pathname);
  const match = pathname.match(/^\/assets\/([a-z0-9-]+\.(?:png|webp))$/i);
  return match ? join(here, 'assets', match[1]) : null;
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
  const file = resolveRequest(pathname);
  if (!file) {
    response.writeHead(404).end('Not found');
    return;
  }

  try {
    const info = await stat(file);
    response.writeHead(200, {
      'Content-Type': mime[extname(file)] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store'
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Forest UI Lab: http://127.0.0.1:${port}`);
});
