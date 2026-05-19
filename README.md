# Rightbrain Blog

A self-contained, framework-free static blog. Plain HTML/CSS, zero npm dependencies, deployable to any static host.

- **Directory page** — `<routePrefix>/` listing posts with tag filter chips (`?tag=`)
- **Post page** — `<routePrefix>/<slug>/` full article with SEO, Open Graph, JSON-LD, share links, and related posts
- **Feeds** — `sitemap.xml`, `robots.txt`, `feed.xml` (Atom)
- **Theme** — light/dark toggle (floating button, bottom-left); preference stored in `localStorage`
- **Navbar** — shared header/footer aligned with rightbrain.ai (external nav links; Resources highlights on blog pages)

The publish path is controlled by `site.routePrefix` in `config.json` (e.g. `/resources` on production, `/rb-blog-test` for staging).

---

## Requirements

- Node.js 20+ (see `.nvmrc`; run `nvm use` if you use nvm)
- No `npm install` — build, validate, ingest, and preview are vanilla Node.js ESM

---

## Project layout

```
blog/
├── config.json           # Site URL, routePrefix, directory/post CTAs
├── data/posts/*.json     # One JSON file per post (task output contract)
├── public/               # Static assets (logo, fonts, favicon, post images)
├── styles/               # CSS (tokens, base, prose, card, index, post)
├── templates/            # layout, index, post, partials (header, footer, seo)
├── scripts/
│   ├── build.js          # JSON → dist/
│   ├── validate.js       # Post contract checks
│   ├── preview.js        # Local server with routePrefix support
│   ├── ingest.js         # Pull a task run from the Rightbrain API
│   └── lib/              # render, tags, sitemap, rss
├── dist/                 # Build output (gitignored)
└── .github/workflows/    # GitHub Pages deploy on push to main
```

---

## Setup

```bash
cd blog/
nvm use   # optional
```

---

## Building the site

```bash
npm run build
# or: node scripts/build.js
```

Output lands in `dist/`. The build:

1. Loads `config.json`
2. Validates every `data/posts/*.json`
3. Sorts posts by `published_at` descending (mtime tiebreak)
4. Renders each post → `dist/<slug>/index.html`
5. Renders the directory → `dist/index.html`
6. Copies `styles/` and `public/` into `dist/`
7. Copies `public/favicon.png` → `dist/favicon.png`
8. Emits `sitemap.xml`, `robots.txt`, `feed.xml`

All pages set `<base href="<routePrefix>/">` so CSS, images, and scripts resolve correctly on nested post URLs. Card `href`s in `card_html` are rewritten to match `routePrefix`. Tag slugs in JSON (e.g. `case-study`) are displayed as Title Case (e.g. `Case Study`) via `scripts/lib/tags.js`.

Build exits non-zero if any post fails validation.

Other scripts:

```bash
npm run validate   # validate all posts (or one slug)
npm run ingest     # fetch a task run → data/posts/<slug>.json
npm run clean      # remove dist/
```

---

## Local preview

```bash
npm run build
npm run preview
```

Serves `dist/` at `http://localhost:4000<routePrefix>/` (port overridable with `PORT`).

**Important:** use the trailing slash (e.g. `http://localhost:4000/rb-blog-test/`). Requests without it are redirected so relative assets load correctly.

No hot-reload — rebuild after template or data changes.

---

## Adding a post

### Option A — manual paste

1. Run your Rightbrain task with the `.docx` uploaded.
2. Copy the JSON output from the task run.
3. Save as `data/posts/<slug>.json` where `<slug>` matches `post.slug`.
4. Run `npm run build`.

### Option B — API ingest

```bash
export RIGHTBRAIN_API_KEY=your-api-key
node scripts/ingest.js <run_id>
npm run build
```

`ingest.js` fetches the completed task run, validates `post.slug`, and writes `data/posts/<slug>.json`. Re-running the same `run_id` overwrites safely.

`RIGHTBRAIN_BASE_URL` defaults to `https://api.rightbrain.ai/v1` (override for self-hosted).

---

## Validating posts

```bash
npm run validate
node scripts/validate.js my-post-slug
```

| Rule | Detail |
|------|--------|
| Required fields | `post.slug`, `post.title`, `post.body_html`, `post.tags`, `post.seo.*`, `card.*`, `copyedit.*` |
| Slug format | `^[a-z0-9][a-z0-9-]*[a-z0-9]$`, max 60 chars |
| `meta_description` | ≤ 155 chars |
| `meta_title` | ≤ 60 chars |
| `body_html` | No `<h1>`, `<style>`, `<script>`, or markdown artefacts |
| `card_html` | Must contain `<article`, href must reference the post slug |

---

## Site configuration

Edit `config.json`:

```json
{
  "site": {
    "name": "Rightbrain",
    "baseUrl": "https://rightbrain.ai",
    "routePrefix": "/resources",
    "language": "en",
    "themeDefault": "system"
  },
  "social": {
    "twitter": "@rightbrainai"
  },
  "directory": {
    "title": "Resources",
    "lede": "…",
    "ctaHref": "/book-demo",
    "ctaButtonLabel": "Book Demo"
  },
  "post": {
    "ctaTitle": "…",
    "ctaDescription": "…",
    "ctaHref": "/book-demo",
    "ctaButtonLabel": "Book demo"
  }
}
```

Change `routePrefix` and rebuild — canonical URLs, sitemaps, OG tags, and card links update automatically. No template edits required.

---

## Static assets

| Path | Purpose |
|------|---------|
| `public/logo.svg` | Header/footer logo |
| `public/favicon.png` | Favicon (copied to `dist/favicon.png`) |
| `public/slack-icon.png` | Slack button icon |
| `public/fonts/inter-var.woff2` | Inter variable font (optional; see below) |
| `public/images/<slug>/` | Post hero and inline images |

### Inter font

Download `inter-var.woff2` from [rsms.me/inter](https://rsms.me/inter/) or [fonts.bunny.net](https://fonts.bunny.net/) and place at `public/fonts/inter-var.woff2`. Without it, the site uses the system sans-serif stack.

---

## Deployment

`dist/` is a fully static site. This repo includes **GitHub Pages** deploy via `.github/workflows/deploy.yml`:

- Triggers on push to `main` when posts, templates, styles, scripts, `public/`, or `config.json` change
- Runs `validate.js` then `build.js`, uploads `dist/` as the Pages artifact

Enable **GitHub Pages** in the repo settings (source: **GitHub Actions**). The live URL follows `https://<user>.github.io/<repo>/` plus your `routePrefix` (e.g. `https://hgcam.github.io/rb-blog-test/` for the current staging config).

### Other hosts

**Cloudflare Pages / Vercel / Netlify** — build command: `node scripts/build.js`, publish directory: `dist`.

For a subdirectory on the main domain, set `routePrefix` to match (e.g. `/resources`) and deploy `dist/` behind that path.

---

## Post JSON contract

Every file in `data/posts/` mirrors the Rightbrain task output:

```json
{
  "post": {
    "slug": "my-post-slug",
    "title": "Full post title",
    "subtitle": "Optional subtitle",
    "body_html": "<h2>…</h2><p>…</p>",
    "reading_time_minutes": 5,
    "tags": ["case-study", "sales"],
    "published_at": "2025-04-15",
    "seo": {
      "meta_title": "Post title ≤60 chars",
      "meta_description": "Description ≤155 chars",
      "og_image": "/rb-blog-test/public/images/my-post-slug/hero.png"
    }
  },
  "card": {
    "title": "Card title",
    "summary": "One-sentence summary",
    "card_html": "<article class=\"post-card\">…</article>"
  },
  "copyedit": {
    "issues": [],
    "stats": { "word_count": 800, "issues_found": 0, "issues_fixed": 0 }
  }
}
```

`body_html` constraints:

- Only `h2`, `h3`, `h4` — no `h1` (the template provides the page title)
- No `<style>` or `<script>`
- No markdown artefacts (`**bold**`, `# Heading`, backtick fences)

Use **kebab-case** tag slugs in JSON; the build formats them for display.

Image paths in `og_image` and `body_html` should include `routePrefix` when hosted under a subpath (or use absolute URLs).

---

## Future enhancements (out of scope v1)

- **Webhook receiver** — `webhook/` contains a starter Cloudflare Worker; wire it to task forwarder POSTs for auto-ingest + redeploy.
- **Syntax highlighting** — Shiki at build time for `<pre><code>` blocks.
- **Search** — client-side index (Pagefind, Fuse.js) over `data/posts/`.
- **Analytics** — snippet in `templates/layout.html`.
