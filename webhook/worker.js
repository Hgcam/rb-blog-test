/**
 * Rightbrain → GitHub webhook receiver
 * Deploy as a Cloudflare Worker.
 *
 * Environment variables (set in Cloudflare Workers dashboard → Settings → Variables):
 *   WEBHOOK_SECRET   — shared secret set in the Rightbrain Task Forwarder
 *   GITHUB_TOKEN     — GitHub fine-grained PAT with Contents: Read & Write
 *   GITHUB_OWNER     — GitHub username or org
 *   GITHUB_REPO      — repo name
 *   GITHUB_BRANCH    — branch to commit to (default: "main")
 *   BLOG_DATA_PATH   — path inside the repo where posts live (default: "data/posts")
 *   ROUTE_PREFIX     — site routePrefix (default: "/resources")
 *   TASK_HREF_PREFIX — prefix the task emits in card_html hrefs (default: "/blog")
 *   RB_API_URL       — Rightbrain API base URL (e.g. "https://stag.leftbrain.me/api/v1")
 *   RB_API_KEY       — Rightbrain API key (set as a secret, not a plain var)
 *
 * How it works:
 *   1. Receives POST from Rightbrain Task Forwarder
 *   2. Verifies HMAC-SHA256 signature (x-hub-signature-256 header)
 *   3. Downloads any images referenced via data-blog-image and commits them to GitHub
 *   4. Rewrites image src paths in body_html / og_image / thumbnail to the public paths
 *   5. Commits data/posts/<slug>.json to GitHub
 *   6. The commit triggers GitHub Actions → build → deploy
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

    // Rewrite card_html href prefix
    const taskPrefix  = env.TASK_HREF_PREFIX || '/blog';
    const routePrefix = env.ROUTE_PREFIX     || '/resources';
    if (output.card?.card_html && routePrefix !== taskPrefix) {
      output.card.card_html = output.card.card_html
        .split(`href="${taskPrefix}/`).join(`href="${routePrefix}/`);
    }

    // ── 3. GitHub credentials ─────────────────────────────────────
    const owner  = env.GITHUB_OWNER;
    const repo   = env.GITHUB_REPO;
    const branch = env.GITHUB_BRANCH || 'main';
    const token  = env.GITHUB_TOKEN;

    if (!owner || !repo || !token) {
      console.error('Missing GITHUB_OWNER, GITHUB_REPO, or GITHUB_TOKEN');
      return new Response('Server misconfigured', { status: 500 });
    }

    // ── 4. Download & commit attached images ──────────────────────
    const rbApiUrl = (env.RB_API_URL || '').replace(/\/$/, '');
    const rbApiKey = env.RB_API_KEY  || '';

    // Map both original_filename and stored_filename → download_url.
    // The task model writes data-blog-image using the original filename the user
    // uploaded, but the API stores files under a UUID-based stored_filename.
    const fileMap = {};
    if (Array.isArray(run.files)) {
      for (const f of run.files) {
        if (!f.download_url) continue;
        if (f.original_filename && isImageFile(f.original_filename)) {
          fileMap[f.original_filename] = f.download_url;
        }
        if (f.stored_filename && isImageFile(f.stored_filename)) {
          fileMap[f.stored_filename] = f.download_url;
        }
      }
    }

    // Collect all image filenames referenced in the output
    const referencedFilenames = new Set();

    if (output.post?.body_html) {
      const re = /data-blog-image="([^"]+)"/g;
      let m;
      while ((m = re.exec(output.post.body_html)) !== null) {
        referencedFilenames.add(m[1]);
      }
    }
    if (output.post?.seo?.og_image && isImageFile(output.post.seo.og_image)) {
      referencedFilenames.add(output.post.seo.og_image);
    }
    if (output.card?.thumbnail && isImageFile(output.card.thumbnail)) {
      referencedFilenames.add(output.card.thumbnail);
    }

    // Download each image and commit to GitHub
    const committedImages = {}; // filename → public URL path

    for (const filename of referencedFilenames) {
      const downloadUrl = fileMap[filename];
      if (!downloadUrl) {
        console.warn(`No download URL for image "${filename}" — skipping`);
        continue;
      }
      if (!rbApiUrl || !rbApiKey) {
        console.warn(`RB_API_URL or RB_API_KEY not set — cannot download "${filename}"`);
        continue;
      }

      const fullUrl = downloadUrl.startsWith('http')
        ? downloadUrl
        : `${rbApiUrl}${downloadUrl}`;

      let imageBytes;
      try {
        const imgRes = await fetch(fullUrl, {
          headers: { Authorization: `Bearer ${rbApiKey}` },
        });
        if (!imgRes.ok) {
          console.error(`Failed to download "${filename}": HTTP ${imgRes.status}`);
          continue;
        }
        imageBytes = await imgRes.arrayBuffer();
      } catch (e) {
        console.error(`Error downloading "${filename}": ${e.message}`);
        continue;
      }

      // Commit image to GitHub at public/images/<slug>/<filename>
      const imgRepoPath = `public/images/${slug}/${filename}`;
      const imgApiUrl   = `https://api.github.com/repos/${owner}/${repo}/contents/${imgRepoPath}`;
      const ghHeaders   = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'rightbrain-blog-webhook',
      };

      let imgSha;
      const existingImg = await fetch(imgApiUrl, { headers: ghHeaders });
      if (existingImg.ok) {
        imgSha = (await existingImg.json()).sha;
      }

      const imgCommitRes = await fetch(imgApiUrl, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `blog: add image "${filename}" for post "${slug}"`,
          content: arrayBufferToBase64(imageBytes),
          branch,
          ...(imgSha ? { sha: imgSha } : {}),
        }),
      });

      if (!imgCommitRes.ok) {
        const err = await imgCommitRes.text();
        console.error(`GitHub image commit error ${imgCommitRes.status}: ${err}`);
        continue;
      }

      // Public path the blog will use at runtime
      committedImages[filename] = `${routePrefix}/public/images/${slug}/${filename}`;
      console.log(`✔ Committed image ${imgRepoPath}`);
    }

    // ── 5. Rewrite image references in the output ─────────────────
    if (Object.keys(committedImages).length > 0) {
      // Fill in src="" on <img data-blog-image="…"> in body_html
      if (output.post?.body_html) {
        output.post.body_html = output.post.body_html.replace(
          /(<img\b[^>]*?)data-blog-image="([^"]+)"([^>]*?)>/g,
          (_m, before, filename, after) => {
            const publicPath = committedImages[filename];
            if (!publicPath) return _m;
            let tag = `${before}data-blog-image="${filename}"${after}>`;
            // Replace existing src or inject one
            if (/\bsrc\s*=\s*["'][^"']*["']/.test(tag)) {
              tag = tag.replace(/\bsrc\s*=\s*["'][^"']*["']/, `src="${publicPath}"`);
            } else {
              tag = tag.replace(/^<img\b/, `<img src="${publicPath}"`);
            }
            return tag;
          }
        );
      }

      if (output.post?.seo?.og_image && committedImages[output.post.seo.og_image]) {
        output.post.seo.og_image = committedImages[output.post.seo.og_image];
      }
      if (output.card?.thumbnail && committedImages[output.card.thumbnail]) {
        output.card.thumbnail = committedImages[output.card.thumbnail];
      }
    }

    // ── 6. Commit post JSON to GitHub ─────────────────────────────
    const enriched = {
      ...output,
      _ingest: {
        run_id:      run.id,
        task_id:     run.task_id,
        ingested_at: new Date().toISOString(),
        source:      'rightbrain-webhook',
      },
    };

    const dataPath = (env.BLOG_DATA_PATH || 'data/posts').replace(/\/$/, '');
    const filePath = `${dataPath}/${slug}.json`;
    const apiUrl   = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
    const ghHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'rightbrain-blog-webhook',
    };

    let sha;
    const existing = await fetch(apiUrl, { headers: ghHeaders });
    if (existing.ok) {
      sha = (await existing.json()).sha;
    }

    const content = btoa(unescape(encodeURIComponent(JSON.stringify(enriched, null, 2))));
    const commitRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
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

    const committedImageCount = Object.keys(committedImages).length;
    console.log(`✔ Committed ${filePath} (${committedImageCount} image(s)) to ${owner}/${repo}@${branch}`);
    return new Response(JSON.stringify({
      ok: true,
      slug,
      file: filePath,
      images: committedImages,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

// ── Helpers ───────────────────────────────────────────────────────

function isImageFile(filename) {
  return typeof filename === 'string' && /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(filename);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ── HMAC-SHA256 verification ──────────────────────────────────────

async function verifySignature(body, sigHeader, secret) {
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
