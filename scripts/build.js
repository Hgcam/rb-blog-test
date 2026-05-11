#!/usr/bin/env node
/**
 * build.js — main build script: JSON + templates → dist/
 *
 * Usage:  node scripts/build.js
 *
 * Steps:
 *   1. Load config.json
 *   2. Load + validate every data/posts/*.json
 *   3. Sort posts by published_at desc; tiebreak by file mtime
 *   4. Render each post → dist/<slug>/index.html
 *   5. Render index → dist/index.html
 *   6. Copy styles/ and public/ to dist/
 *   7. Write sitemap.xml, robots.txt, feed.xml
 */

import {
  readFileSync, writeFileSync, readdirSync, mkdirSync,
  cpSync, statSync, existsSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePost } from './validate.js';
import { render } from './lib/render.js';
import { buildSitemap, buildRobots } from './lib/sitemap.js';
import { buildAtomFeed } from './lib/rss.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const DATA_DIR = join(ROOT, 'data', 'posts');
const TEMPLATES_DIR = join(ROOT, 'templates');
const STYLES_DIR = join(ROOT, 'styles');
const PUBLIC_DIR = join(ROOT, 'public');

// ── Helpers ───────────────────────────────────────────────────────

function readTemplate(name) {
  return readFileSync(join(TEMPLATES_DIR, name), 'utf8');
}

function readPartial(name) {
  return readFileSync(join(TEMPLATES_DIR, 'partials', `${name}.html`), 'utf8');
}

function write(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  try {
    return new Date(isoStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch {
    return isoStr;
  }
}

/** Compute tag overlap count between two tag arrays. */
function tagOverlap(a, b) {
  const setA = new Set(a);
  return b.filter(t => setA.has(t)).length;
}

/** Build the full JSON-LD for a BlogPosting. */
function buildPostJsonLd(post, seoCanonical, siteName) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.seo?.meta_title || post.title,
    description: post.seo?.meta_description || '',
    url: seoCanonical,
    ...(post.seo?.og_image ? { image: post.seo.og_image } : {}),
    ...(post.published_at ? { datePublished: post.published_at } : {}),
    publisher: {
      '@type': 'Organization',
      name: siteName,
      logo: { '@type': 'ImageObject', url: '/public/favicon.svg' },
    },
    keywords: (post.tags || []).join(', '),
  };
  return JSON.stringify(schema);
}

/** Build the JSON-LD for the CollectionPage / ItemList (index). */
function buildIndexJsonLd(posts, indexUrl, config) {
  const items = posts.map((p, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    url: `${config.site.baseUrl}${config.site.routePrefix}/${p.post.slug}/`,
    name: p.post.title,
  }));
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `${config.site.name} – ${config.directory.title}`,
    description: config.directory.lede,
    url: indexUrl,
    hasPart: items,
  };
  return JSON.stringify(schema);
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();

  // 1. Config
  const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
  const { site } = config;

  // Compute asset base: relative path from a post page (dist/<slug>/index.html) back to dist/.
  // Post is one directory deep: dist/<slug>/ → ../styles/
  // Index is at dist/ root → ./styles/
  const assetBasePost = '..';
  const assetBaseIndex = '.';

  // 2. Load & validate posts
  let postFiles = [];
  try {
    postFiles = readdirSync(DATA_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const filePath = join(DATA_DIR, f);
        const mtime = statSync(filePath).mtime;
        const raw = readFileSync(filePath, 'utf8');
        return { file: f, filePath, mtime, raw };
      });
  } catch {
    console.warn('⚠  data/posts/ is empty or missing — building index with no posts.');
  }

  let hasErrors = false;
  const posts = [];

  for (const { file, filePath, mtime, raw } of postFiles) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error(`✗ ${file}: invalid JSON — ${e.message}`);
      hasErrors = true;
      continue;
    }

    const { ok, errors } = validatePost(parsed, file);
    if (!ok) {
      errors.forEach(e => console.error(`  ✗ ${e}`));
      hasErrors = true;
      continue;
    }

    // Normalise nullable fields so templates never get null
    if (!parsed.post.tags) parsed.post.tags = [];
    if (!parsed.post.published_at) parsed.post.published_at = '';

    // Rewrite card_html href prefix if it doesn't match config routePrefix
    // e.g. task emits /blog/<slug>/ but site is served at /resources/<slug>/
    const TASK_PREFIX = '/blog';
    if (parsed.card?.card_html && site.routePrefix !== TASK_PREFIX) {
      parsed.card.card_html = parsed.card.card_html
        .split(`href="${TASK_PREFIX}/`).join(`href="${site.routePrefix}/`);
    }

    posts.push({ ...parsed, _mtime: mtime, _file: file });
  }

  if (hasErrors) {
    console.error('\n✗  Build aborted due to validation errors.');
    process.exit(1);
  }

  // 3. Sort: published_at desc, tiebreak mtime desc
  posts.sort((a, b) => {
    const dateA = a.post.published_at ? new Date(a.post.published_at).getTime() : 0;
    const dateB = b.post.published_at ? new Date(b.post.published_at).getTime() : 0;
    if (dateB !== dateA) return dateB - dateA;
    return b._mtime - a._mtime;
  });

  // 4. Prepare dist/
  if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  // Load shared templates
  const layoutTpl   = readTemplate('layout.html');
  const headerTpl   = readPartial('header');
  const footerTpl   = readPartial('footer');
  const seoTpl      = readPartial('seo');
  const postBodyTpl = readTemplate('post.html');
  const indexBodyTpl = readTemplate('index.html');

  const year = String(new Date().getFullYear());

  // 5. Render post pages
  for (const postData of posts) {
    const { post, card, copyedit } = postData;
    const slug = post.slug;
    const routePrefix = site.routePrefix;
    const canonical = `${site.baseUrl}${routePrefix}/${slug}/`;

    // Find up to 3 related posts by tag overlap (excluding self)
    const related = posts
      .filter(p => p.post.slug !== slug)
      .map(p => ({ p, score: tagOverlap(post.tags || [], p.post.tags || []) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(({ p }) => p);

    const relatedPostsHtml = related.map(r => r.card.card_html).join('\n');

    const primaryTag = (post.tags || [])[0] || '';
    const ogImage = post.seo?.og_image
      ? post.seo.og_image
      : `${site.baseUrl}/public/og-default.png`;

    const seoContext = {
      'seo.pageTitle': `${post.seo?.meta_title || post.title} — ${site.name}`,
      'seo.metaDescription': post.seo?.meta_description || '',
      'seo.canonical': canonical,
      'seo.ogType': 'article',
      'seo.ogTitle': post.seo?.meta_title || post.title,
      'seo.ogImage': ogImage,
      'seo.articlePublishedTime': post.published_at || '',
      'seo.articleTags': (post.tags || []),
      'seo.jsonLd': buildPostJsonLd(post, canonical, site.name),
    };

    const ctx = {
      site: {
        ...site,
        assetBase: assetBasePost,
        year,
        twitterHandle: config.social?.twitter || '',
        routePrefix,
      },
      config,
      post: {
        ...post,
        primaryTag,
        published_at_formatted: formatDate(post.published_at),
      },
      card,
      copyedit,
      seo: {
        pageTitle:             seoContext['seo.pageTitle'],
        metaDescription:       seoContext['seo.metaDescription'],
        canonical:             seoContext['seo.canonical'],
        ogType:                seoContext['seo.ogType'],
        ogTitle:               seoContext['seo.ogTitle'],
        ogImage:               seoContext['seo.ogImage'],
        articlePublishedTime:  seoContext['seo.articlePublishedTime'],
        articleTags:           seoContext['seo.articleTags'],
        jsonLd:                seoContext['seo.jsonLd'],
      },
      nav: { resourcesCurrent: 'page' },
      relatedPosts: related.length > 0,
      relatedPostsHtml,
    };

    // Render seo partial
    const renderedSeo = render(seoTpl, ctx);
    const renderedHeader = render(headerTpl, ctx);
    const renderedFooter = render(footerTpl, ctx);

    // Render post body — inject raw body_html
    let postBody = postBodyTpl;
    // Inject body_html raw (it's trusted HTML from the task)
    postBody = postBody.replace('{{post.body_html}}', post.body_html || '');
    // Inject relatedPostsHtml raw
    postBody = postBody.replace('{{relatedPostsHtml}}', relatedPostsHtml);
    const renderedBody = render(postBody, ctx);

    // Compose full page via layout
    let page = layoutTpl
      .replace('{{seo}}', renderedSeo)
      .replace('{{header}}', renderedHeader)
      .replace('{{body}}', renderedBody)
      .replace('{{footer}}', renderedFooter);

    page = render(page, ctx);

    write(join(DIST, slug, 'index.html'), page);
    console.log(`  ✔  dist/${slug}/index.html`);
  }

  // 6. Render index page
  const indexCanonical = `${site.baseUrl}${site.routePrefix}/`;
  const allTags = [...new Set(posts.flatMap(p => p.post.tags || []))].sort();

  const cardsHtml = posts.map(p => p.card.card_html).join('\n');

  const indexJsonLd = buildIndexJsonLd(posts, indexCanonical, config);

  const indexCtx = {
    site: {
      ...site,
      assetBase: assetBaseIndex,
      year,
      twitterHandle: config.social?.twitter || '',
      routePrefix: site.routePrefix,
    },
    config,
    seo: {
      pageTitle:       `${config.directory.title} — ${site.name}`,
      metaDescription: config.directory.lede,
      canonical:       indexCanonical,
      ogType:          'website',
      ogTitle:         `${config.directory.title} — ${site.name}`,
      ogImage:         `${site.baseUrl}/public/og-default.png`,
      articleTags:     [],
      articlePublishedTime: '',
      jsonLd:          indexJsonLd,
    },
    nav: { resourcesCurrent: 'page' },
    posts: posts.length > 0,
    allTags,
    activeTag: '',
    cardsHtml,
  };

  const indexSeo    = render(seoTpl, indexCtx);
  const indexHeader = render(headerTpl, indexCtx);
  const indexFooter = render(footerTpl, indexCtx);

  let indexBody = indexBodyTpl.replace('{{cardsHtml}}', cardsHtml);
  const renderedIndexBody = render(indexBody, indexCtx);

  let indexPage = layoutTpl
    .replace('{{seo}}', indexSeo)
    .replace('{{header}}', indexHeader)
    .replace('{{body}}', renderedIndexBody)
    .replace('{{footer}}', indexFooter);

  indexPage = render(indexPage, indexCtx);

  write(join(DIST, 'index.html'), indexPage);
  console.log(`  ✔  dist/index.html`);

  // 7. Copy styles/ and public/
  if (existsSync(STYLES_DIR)) {
    cpSync(STYLES_DIR, join(DIST, 'styles'), { recursive: true });
    console.log('  ✔  dist/styles/');
  }
  if (existsSync(PUBLIC_DIR)) {
    cpSync(PUBLIC_DIR, join(DIST, 'public'), { recursive: true });
    console.log('  ✔  dist/public/');
  }

  // Copy favicon to dist root for direct /favicon.svg access
  const faviconSrc = join(PUBLIC_DIR, 'favicon.svg');
  const faviconDst = join(DIST, 'favicon.svg');
  if (existsSync(faviconSrc)) {
    writeFileSync(faviconDst, readFileSync(faviconSrc));
  }

  // 8. Sitemap, robots.txt, feed.xml
  const sitemapEntries = [
    { url: indexCanonical, changefreq: 'weekly', priority: 1.0 },
    ...posts.map(p => ({
      url:        `${site.baseUrl}${site.routePrefix}/${p.post.slug}/`,
      lastmod:    p.post.published_at ? p.post.published_at.slice(0, 10) : undefined,
      changefreq: 'monthly',
      priority:   0.8,
    })),
  ];

  write(join(DIST, 'sitemap.xml'), buildSitemap(sitemapEntries));
  console.log('  ✔  dist/sitemap.xml');

  write(join(DIST, 'robots.txt'), buildRobots({
    baseUrl: site.baseUrl,
    sitemapUrl: `${site.baseUrl}/sitemap.xml`,
  }));
  console.log('  ✔  dist/robots.txt');

  write(join(DIST, 'feed.xml'), buildAtomFeed({
    site,
    posts: posts.map(p => p.post),
  }));
  console.log('  ✔  dist/feed.xml');

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(2);
  console.log(`\n✅  Build complete — ${posts.length} post(s) in ${elapsed}s → dist/`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
