/**
 * sitemap.js — generate sitemap.xml and robots.txt from a list of URL entries.
 */

/**
 * @typedef {{ url: string, lastmod?: string, changefreq?: string, priority?: number }} SitemapEntry
 */

/**
 * Build a sitemap.xml string.
 *
 * @param {SitemapEntry[]} entries
 * @returns {string}
 */
export function buildSitemap(entries) {
  const urls = entries.map(e => {
    const parts = [`  <url>`, `    <loc>${esc(e.url)}</loc>`];
    if (e.lastmod) parts.push(`    <lastmod>${e.lastmod}</lastmod>`);
    if (e.changefreq) parts.push(`    <changefreq>${e.changefreq}</changefreq>`);
    if (e.priority != null) parts.push(`    <priority>${e.priority.toFixed(1)}</priority>`);
    parts.push(`  </url>`);
    return parts.join('\n');
  }).join('\n');

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    urls,
    `</urlset>`,
  ].join('\n');
}

/**
 * Build a robots.txt string.
 *
 * @param {{ baseUrl: string, sitemapUrl?: string, disallow?: string[] }} opts
 * @returns {string}
 */
export function buildRobots({ baseUrl, sitemapUrl, disallow = [] }) {
  const lines = ['User-agent: *'];
  for (const path of disallow) lines.push(`Disallow: ${path}`);
  lines.push(`Allow: /`);
  lines.push('');
  lines.push(`Sitemap: ${sitemapUrl || `${baseUrl}/sitemap.xml`}`);
  return lines.join('\n');
}

/** XML-escape a string value used inside tags/attributes. */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
