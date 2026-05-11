#!/usr/bin/env node
/**
 * preview.js — minimal static file server for local development.
 *
 * Reads routePrefix from config.json and mounts dist/ at that prefix,
 * so card links (e.g. /resources/attio-account-researcher/) resolve correctly.
 *
 * Access at: http://localhost:4000<routePrefix>/
 */
import { createServer } from 'node:http';
import { createReadStream, statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const PORT = 4000;

// Read routePrefix from config.json (default to '' if missing)
let routePrefix = '';
try {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
  routePrefix = (cfg.site?.routePrefix || '').replace(/\/$/, '');
} catch {
  // ignore — serve from root
}

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.js':    'text/javascript; charset=utf-8',
  '.json':  'application/json',
  '.xml':   'application/xml',
  '.svg':   'image/svg+xml',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.webp':  'image/webp',
  '.woff2': 'font/woff2',
  '.ico':   'image/x-icon',
  '.txt':   'text/plain',
};

createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  // Strip routePrefix so dist/ is the root for all routes
  if (routePrefix && urlPath.startsWith(routePrefix)) {
    urlPath = urlPath.slice(routePrefix.length) || '/';
  }

  // Try exact path, then path/index.html
  const candidates = [
    join(DIST, urlPath),
    join(DIST, urlPath, 'index.html'),
  ];

  for (const filePath of candidates) {
    try {
      const stat = statSync(filePath);
      if (stat.isFile()) {
        const contentType = MIME[extname(filePath)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        createReadStream(filePath).pipe(res);
        console.log(`  200 ${req.url}`);
        return;
      }
    } catch {
      // not found, try next candidate
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
  console.log(`  404 ${req.url}`);
}).listen(PORT, () => {
  console.log(`\nPreview at http://localhost:${PORT}${routePrefix}/`);
  console.log(`  Directory:   http://localhost:${PORT}${routePrefix}/`);
  console.log(`  Sample post: http://localhost:${PORT}${routePrefix}/attio-account-researcher/\n`);
});
