# Rightbrain Blog

A self-contained, framework-free static blog. Plain HTML/CSS, zero runtime dependencies, fully deployable to any static host.

- **Directory page** — `/resources/` listing all posts with filter chips
- **Post page** — `/resources/<slug>/` full article with SEO, OG tags, JSON-LD, share links
- **Feeds** — `sitemap.xml`, `robots.txt`, `feed.xml` (Atom)

---

## Requirements

- Node.js 20+ (`cat .nvmrc` shows the exact version; `nvm use` picks it up automatically)
- No npm packages required — zero runtime deps

---

## Setup

```bash
cd blog/
# Optional: if you use nvm
nvm use
```

No `npm install` needed. The build, validate, and ingest scripts are all vanilla Node.js ESM.

---

## Building the site

```bash
node scripts/build.js
# or
npm run build
```

Output lands in `dist/`. The build:

1. Loads `config.json` for site-wide settings
2. Validates every `data/posts/*.json` against the task output contract
3. Sorts posts by `published_at` descending
4. Renders each post → `dist/<slug>/index.html`
5. Renders the directory → `dist/index.html`
6. Copies `styles/` and `public/` into `dist/`
7. Emits `dist/sitemap.xml`, `dist/robots.txt`, `dist/feed.xml`

Build exits non-zero if any post fails validation, so bad data never reaches `dist/`.

---

## Local preview

```bash
npm run preview
```

Opens a minimal HTTP server at `http://localhost:4000` serving `dist/`. No hot-reload — rebuild to see changes.

---

## Adding a post

### Option A — manual paste (simplest)

1. Run your Rightbrain task with the `.docx` file uploaded.
2. Copy the JSON output from the task run result.
3. Save it as `data/posts/<slug>.json` where `<slug>` matches `post.slug` in the JSON.
4. Run `npm run build`.

### Option B — API ingest

```bash
export RIGHTBRAIN_API_KEY=your-api-key
node scripts/ingest.js <run_id>
npm run build
```

`ingest.js` fetches the completed task run from the Rightbrain API, validates the `post.slug`, and writes `data/posts/<slug>.json`. It's idempotent — re-running with the same `run_id` safely overwrites.

`RIGHTBRAIN_BASE_URL` can be overridden if you use a self-hosted instance (default: `https://api.rightbrain.ai/v1`).

---

## Validating posts without building

```bash
node scripts/validate.js              # validate all posts
node scripts/validate.js attio-account-researcher   # validate one post
npm run validate
```

Checks every post against the task output contract:

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

Edit `config.json` in the root of this folder:

```json
{
  "site": {
    "name": "Rightbrain",
    "baseUrl": "https://rightbrain.ai",
    "routePrefix": "/resources"
  },
  "directory": {
    "title": "Resources",
    "lede": "…",
    "ctaHref": "/book-demo"
  }
}
```

If you ever move the blog from `/resources/` to `/blog/`, change `routePrefix` and rebuild — no template edits needed. The build rewrites all canonical URLs, sitemaps, and OG tags automatically.

> **Note:** The Rightbrain task currently emits `/resources/<slug>/` in `card_html` hrefs. If you change `routePrefix`, `build.js` performs a single `String.replace` on each `card_html` to keep hrefs consistent.

---

## Inter font

The design uses Inter (variable, woff2), self-hosted for performance. You need to provide the font file:

1. Download `inter-var.woff2` from [rsms.me/inter](https://rsms.me/inter/) or [fonts.bunny.net](https://fonts.bunny.net/)
2. Place it at `public/fonts/inter-var.woff2`

Until the file is present, the browser falls back to the system sans-serif stack (`system-ui, -apple-system, Segoe UI, Roboto`), which is visually close on most operating systems.

---

## Deployment

The `dist/` folder is a fully self-contained static site. Deploy it to any static host:

### Cloudflare Pages

```bash
npm run build
# Then drag-and-drop dist/ in the Cloudflare Pages dashboard,
# or configure it as the build output directory in the Pages project.
```

### Vercel / Netlify

Set the **build command** to `node scripts/build.js` and the **publish directory** to `dist`.

### GitHub Pages / any CI

```yaml
# .github/workflows/deploy.yml (example)
- run: node scripts/build.js
  working-directory: blog
- uses: actions/upload-pages-artifact@v3
  with:
    path: blog/dist
```

---

## Post JSON contract

Every file in `data/posts/` must match this structure (mirrors the Rightbrain task output exactly):

```json
{
  "post": {
    "slug": "my-post-slug",
    "title": "Full post title",
    "subtitle": "Optional subtitle / lede sentence",
    "body_html": "<h2>…</h2><p>…</p>",
    "reading_time_minutes": 5,
    "tags": ["Use Case", "Sales"],
    "published_at": "2025-04-15",
    "seo": {
      "meta_title": "Post title ≤60 chars",
      "meta_description": "Description ≤155 chars",
      "og_image": "https://…/hero.jpg"
    }
  },
  "card": {
    "title": "Card title",
    "summary": "One-sentence summary for the card",
    "card_html": "<article class=\"post-card\">…</article>"
  },
  "copyedit": {
    "issues": [],
    "stats": { "word_count": 800, "issues_found": 0, "issues_fixed": 0 }
  }
}
```

`body_html` constraints (enforced by `validate.js` and the Rightbrain task system prompt):
- Only `h2`, `h3`, `h4` headings — no `h1` (the page already has one)
- No `<style>` or `<script>` tags
- No markdown artefacts (`**bold**`, `# Heading`, backtick fences)

---

## Future enhancements (out of scope v1)

- **Webhook receiver** — a small endpoint that accepts Rightbrain task forwarder POSTs, writes the JSON, and triggers a redeploy. The JSON contract is ready; no rework needed.
- **Syntax highlighting** — drop in Shiki at build time; wrap `<pre><code>` blocks in `build.js`. Doesn't change the data contract.
- **Search** — client-side JSON index (pagefind, fuse.js). The `data/posts/` folder is already structured for this.
- **Analytics** — one-line snippet in `templates/layout.html`.
- **Image CDN** — upload `post.seo.og_image` to Cloudflare Images or similar; update URL in the JSON.
