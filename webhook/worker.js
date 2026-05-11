/**
 * Rightbrain → GitHub webhook receiver
 * Deploy as a Cloudflare Worker.
 *
 * Environment variables (set in Cloudflare Workers dashboard → Settings → Variables):
 *   WEBHOOK_SECRET   — a shared secret you paste into the Rightbrain Task Forwarder header
 *   GITHUB_TOKEN     — a GitHub fine-grained PAT with Contents: Read & Write on the target repo
 *   GITHUB_OWNER     — GitHub username or org (e.g. "rightbrainai")
 *   GITHUB_REPO      — repo name (e.g. "blog")
 *   GITHUB_BRANCH    — branch to commit to (default: "main")
 *   BLOG_DATA_PATH   — path inside the repo where posts live (default: "blog/data/posts")
 *   ROUTE_PREFIX     — site routePrefix used to rewrite card hrefs (default: "/resources")
 *   TASK_HREF_PREFIX — prefix the Rightbrain task emits in card_html hrefs (default: "/blog")
 *
 * How it works:
 *   1. Receives POST from Rightbrain Task Forwarder
 *   2. Verifies HMAC-SHA256 signature (x-hub-signature-256 header)
 *   3. Extracts run.response (the blog post JSON)
 *   4. Commits data/posts/<slug>.json to GitHub via the Contents API
 *   5. The commit triggers GitHub Actions → build → deploy
 */

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const body = await request.text();

    // ── 1. Verify signature ───────────────────────────────────────
    const sigHeader = request.headers.get('x-hub-signature-256') || '';
    if (env.WEBHOOK_SECRET) {
      const valid = await verifySignature(body, sigHeader, env.WEBHOOK_SECRET);
      if (!valid) {
        console.error('Signature verification failed');
        return new Response('Unauthorized', { status: 401 });
      }
    }

    // ── 2. Parse payload ──────────────────────────────────────────
    let run;
    try {
      run = JSON.parse(body);
    } catch {
      return new Response('Bad JSON', { status: 400 });
    }

    // Skip error runs
    if (run.is_error) {
      console.warn(`Skipping run ${run.id} — is_error=true`);
      return new Response('Skipped (is_error)', { status: 200 });
    }

    const output = run.response;
    if (!output?.post?.slug) {
      console.error('Missing response.post.slug in payload');
      return new Response('Missing post.slug', { status: 422 });
    }

    const slug = output.post.slug;

    // Normalise nullable fields
    if (!output.post.tags) output.post.tags = [];
    if (!output.post.published_at) {
      output.post.published_at = new Date().toISOString().slice(0, 10);
    }

    // Rewrite card_html href prefix if needed
    const taskPrefix  = env.TASK_HREF_PREFIX  || '/blog';
    const routePrefix = env.ROUTE_PREFIX      || '/resources';
    if (output.card?.card_html && routePrefix !== taskPrefix) {
      output.card.card_html = output.card.card_html
        .split(`href="${taskPrefix}/`).join(`href="${routePrefix}/`);
    }

    // Enrich with ingest metadata
    const enriched = {
      ...output,
      _ingest: {
        run_id:      run.id,
        task_id:     run.task_id,
        ingested_at: new Date().toISOString(),
        source:      'rightbrain-webhook',
      },
    };

    // ── 3. Commit to GitHub ───────────────────────────────────────
    const owner      = env.GITHUB_OWNER;
    const repo       = env.GITHUB_REPO;
    const branch     = env.GITHUB_BRANCH || 'main';
    const dataPath   = (env.BLOG_DATA_PATH || 'blog/data/posts').replace(/\/$/, '');
    const filePath   = `${dataPath}/${slug}.json`;
    const token      = env.GITHUB_TOKEN;

    if (!owner || !repo || !token) {
      console.error('Missing GITHUB_OWNER, GITHUB_REPO, or GITHUB_TOKEN');
      return new Response('Server misconfigured', { status: 500 });
    }

    const content = btoa(unescape(encodeURIComponent(JSON.stringify(enriched, null, 2))));
    const apiUrl  = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;

    // Check if file already exists (need its SHA to update)
    let sha;
    const existing = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'rightbrain-blog-webhook',
      },
    });
    if (existing.ok) {
      const data = await existing.json();
      sha = data.sha;
    }

    // Create or update the file
    const commitRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'rightbrain-blog-webhook',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `blog: add post "${output.post.title}"`,
        content,
        branch,
        ...(sha ? { sha } : {}),
      }),
    });

    if (!commitRes.ok) {
      const err = await commitRes.text();
      console.error(`GitHub API error ${commitRes.status}: ${err}`);
      return new Response(`GitHub error: ${commitRes.status}`, { status: 502 });
    }

    console.log(`✔ Committed ${filePath} to ${owner}/${repo}@${branch}`);
    return new Response(JSON.stringify({ ok: true, slug, file: filePath }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

// ── HMAC-SHA256 verification ──────────────────────────────────────

async function verifySignature(body, sigHeader, secret) {
  // sigHeader format: "sha256=<hex>"
  const [algo, hexSig] = sigHeader.split('=');
  if (algo !== 'sha256' || !hexSig) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const sigBytes = hexToBytes(hexSig);
  return crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(body));
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
