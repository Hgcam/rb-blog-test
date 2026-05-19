#!/usr/bin/env node
/**
 * preview.js — minimal static file server for local development.
 *
 * Reads routePrefix from config.json and mounts dist/ at that prefix,
 * so card links (e.g. /rb-blog-test/my-post/) resolve correctly.
 *
 * Access at: http://localhost:4000<routePrefix>/
 * (trailing slash required — requests without it are redirected)
 */
import { createServer } from 'node:http';
import { createReadStream, statSync, readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || 4000;

let routePrefix = '';
try {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
  routePrefix = (cfg.site?.routePrefix || '').replace(/\/$/, '');
} catch {
  // serve from root
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('✗  dist/ is missing. Run: npm run build');
  process.exit(1);
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

function hasFileExtension(pathname) {
  const base = pathname.split('/').pop() || '';
  return base.includes('.');
}

createServer((req, res) => {
  const [pathname, search = ''] = req.url.split('?');
  const qs = search ? `?${search}` : '';

  // Redirect site root → blog prefix
  if (routePrefix && (pathname === '/' || pathname === '')) {
    res.writeHead(302, { Location: `${routePrefix}/${qs}` });
    res.end();
    return;
  }

  // Trailing slash: relative ./styles/ breaks without it (page looks blank)
  if (
    routePrefix
    && pathname.startsWith(routePrefix)
    && !pathname.endsWith('/')
    && !hasFileExtension(pathname)
  ) {
    res.writeHead(301, { Location: `${pathname}/${qs}` });
    res.end();
    return;
  }

  let urlPath = pathname;

  if (routePrefix && urlPath.startsWith(routePrefix)) {
    urlPath = urlPath.slice(routePrefix.length) || '/';
  } else if (routePrefix) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 Not Found\n\nBlog is served at http://localhost:${PORT}${routePrefix}/\n`);
    return;
  }

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
        return;
      }
    } catch {
      // try next candidate
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
}).listen(PORT, () => {
  const home = routePrefix
    ? `http://localhost:${PORT}${routePrefix}/`
    : `http://localhost:${PORT}/`;
  console.log(`\n✅  Blog preview running`);
  console.log(`    ${home}`);
  if (routePrefix) {
    console.log(`    (open this URL — include the trailing slash)\n`);
  } else {
    console.log('');
  }
});
