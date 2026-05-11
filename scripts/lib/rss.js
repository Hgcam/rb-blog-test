/**
 * rss.js — generate an Atom 1.0 feed from post data.
 * Emits the latest N posts (default 50).
 */

/**
 * @typedef {{
 *   slug: string,
 *   title: string,
 *   subtitle?: string,
 *   published_at?: string,
 *   tags?: string[],
 *   seo?: { meta_description?: string, og_image?: string }
 * }} PostEntry
 */

/**
 * Build an Atom feed XML string.
 *
 * @param {{
 *   site: { name: string, baseUrl: string, routePrefix: string, language: string },
 *   posts: PostEntry[],
 *   limit?: number
 * }} opts
 * @returns {string}
 */
export function buildAtomFeed({ site, posts, limit = 50 }) {
  const feedUrl = `${site.baseUrl}/feed.xml`;
  const indexUrl = `${site.baseUrl}${site.routePrefix}/`;
  const now = new Date().toISOString();

  const entries = posts
    .slice(0, limit)
    .map(p => buildEntry(p, site));

  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${esc(site.language)}">`,
    `  <title>${esc(site.name)} – Resources</title>`,
    `  <subtitle>Latest articles, guides and use cases from ${esc(site.name)}.</subtitle>`,
    `  <link rel="alternate" type="text/html" href="${esc(indexUrl)}"/>`,
    `  <link rel="self" type="application/atom+xml" href="${esc(feedUrl)}"/>`,
    `  <id>${esc(feedUrl)}</id>`,
    `  <updated>${now}</updated>`,
    `  <generator uri="https://github.com/rightbrainai/blog">Rightbrain Blog</generator>`,
    ...entries,
    `</feed>`,
  ].join('\n');
}

/**
 * @param {PostEntry} post
 * @param {{ baseUrl: string, routePrefix: string }} site
 */
function buildEntry(post, site) {
  const url = `${site.baseUrl}${site.routePrefix}/${post.slug}/`;
  const updated = post.published_at
    ? new Date(post.published_at).toISOString()
    : new Date().toISOString();

  const summary = post.seo?.meta_description || post.subtitle || '';
  const tags = (post.tags || []).map(t => `  <category term="${esc(t)}"/>`).join('\n');
  const image = post.seo?.og_image
    ? `  <link rel="enclosure" type="image/jpeg" href="${esc(post.seo.og_image)}"/>`
    : '';

  return [
    `  <entry>`,
    `    <title>${esc(post.title)}</title>`,
    `    <link rel="alternate" type="text/html" href="${esc(url)}"/>`,
    `    <id>${esc(url)}</id>`,
    `    <updated>${updated}</updated>`,
    `    <published>${updated}</published>`,
    summary ? `    <summary type="text">${esc(summary)}</summary>` : '',
    tags,
    image,
    `  </entry>`,
  ].filter(Boolean).join('\n');
}

/** XML-escape a string. */
function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
