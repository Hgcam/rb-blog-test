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
    const rbApiUrl    = (env.RB_API_URL    || '').replace(/\/$/, '');
    const rbApiKey    = env.RB_API_KEY     || '';
    const rbOrgId     = env.RB_ORG_ID      || '';
    const rbProjectId = env.RB_PROJECT_ID  || '';

    // The webhook sends download_url as "" — construct the URL from known API path:
    // /org/{org}/project/{project}/task/{task_id}/run/{run_id}/file/{stored_filename}
    function buildDownloadUrl(storedFilename) {
      if (!rbApiUrl || !rbOrgId || !rbProjectId || !run.task_id || !run.id) return null;
      return `${rbApiUrl}/org/${rbOrgId}/project/${rbProjectId}/task/${run.task_id}/run/${run.id}/file/${storedFilename}`;
    }

    // Collect all image files from run.files
    const imageFiles = (run.files || []).filter(f => isImageFile(f.original_filename || f.stored_filename || ''));
    console.log(`Image files found: ${imageFiles.length}`);

    // Collect all image keys referenced in the output
    const referencedKeys = new Set();
    if (output.post?.body_html) {
      const re = /data-blog-image="([^"]+)"/g;
      let m;
      while ((m = re.exec(output.post.body_html)) !== null) referencedKeys.add(m[1]);
    }
    if (output.post?.seo?.og_image && isImageFile(output.post.seo.og_image)) referencedKeys.add(output.post.seo.og_image);
    if (output.card?.thumbnail     && isImageFile(output.card.thumbnail))     referencedKeys.add(output.card.thumbnail);
    console.log('data-blog-image keys in output:', JSON.stringify([...referencedKeys]));

    // Download & commit each image file, track public path by every key that matches
    const committedImages = {};           // data-blog-image key → public URL path
    const orderedPublicPaths = [];        // public paths in upload order, for positional fallback
    const ghBaseHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'rightbrain-blog-webhook',
    };

    for (const f of imageFiles) {
      if (!rbApiKey) {
        console.warn('RB_API_KEY not set — cannot download images');
        break;
      }

      const downloadUrl = buildDownloadUrl(f.stored_filename);
      if (!downloadUrl) {
        console.warn(`Cannot construct download URL for "${f.original_filename}" — missing RB env vars`);
        continue;
      }

      let imageBytes;
      try {
        const imgRes = await fetch(downloadUrl, {
          headers: { Authorization: `Bearer ${rbApiKey}` },
        });
        if (!imgRes.ok) {
          console.error(`Failed to download "${f.original_filename}": HTTP ${imgRes.status} from ${downloadUrl}`);
          continue;
        }
        imageBytes = await imgRes.arrayBuffer();
      } catch (e) {
        console.error(`Error downloading "${f.original_filename}": ${e.message}`);
        continue;
      }

      // Commit to GitHub using original_filename sanitised for safe URLs
      const safeFilename = f.original_filename
        .replace(/\s+/g, '-')       // spaces → single dash
        .replace(/-{2,}/g, '-');    // collapse multiple consecutive dashes
      const imgRepoPath  = `public/images/${slug}/${safeFilename}`;
      const imgApiUrl    = `https://api.github.com/repos/${owner}/${repo}/contents/${imgRepoPath}`;

      let imgSha;
      const existingImg = await fetch(imgApiUrl, { headers: ghBaseHeaders });
      if (existingImg.ok) imgSha = (await existingImg.json()).sha;

      const imgCommitRes = await fetch(imgApiUrl, {
        method: 'PUT',
        headers: { ...ghBaseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `blog: add image "${safeFilename}" for post "${slug}"`,
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

      const publicPath = `${routePrefix}/public/images/${slug}/${safeFilename}`;
      console.log(`✔ Committed image ${imgRepoPath} → ${publicPath}`);

      // Register under every reasonable lookup key for this file
      const indexInImages = imageFiles.indexOf(f) + 1;  // 1-indexed
      const keysForThisFile = [
        f.original_filename,
        safeFilename,
        slugifyFilename(f.original_filename),
        normalizeFilename(f.original_filename),
        `image_${indexInImages}`,    // positional: image_1, image_2, ...
        `image-${indexInImages}`,    // dash variant
        `image${indexInImages}`,     // no separator variant
      ];
      if (indexInImages === 1) keysForThisFile.push('hero_image', 'hero-image', 'hero');
      for (const key of keysForThisFile) {
        committedImages[key] = publicPath;
      }
      // Track ordered list for final positional fallback
      orderedPublicPaths.push(publicPath);
    }

    // ── 5. Rewrite image references in the output ─────────────────
    function resolveImage(key, positionalIndex = -1) {
      // 1. Direct lookup variants
      let path = committedImages[key]
        || committedImages[slugifyFilename(key)]
        || committedImages[normalizeFilename(key)];
      if (path) return path;

      // 2. Extract trailing digits from key (e.g. "pipeline-1-workflow" → "1", "image2" → "2")
      const digitMatch = (key.match(/(\d+)/) || [])[1];
      if (digitMatch) {
        path = committedImages[`image_${digitMatch}`];
        if (path) return path;
      }

      // 3. Positional fallback — use the N-th image in upload order
      if (positionalIndex >= 0 && orderedPublicPaths[positionalIndex]) {
        return orderedPublicPaths[positionalIndex];
      }
      return null;
    }

    if (orderedPublicPaths.length > 0) {
      if (output.post?.body_html) {
        let bodyImageIdx = 0;
        output.post.body_html = output.post.body_html.replace(
          /(<img\b[^>]*?)data-blog-image="([^"]+)"([^>]*?)>/g,
          (_m, before, key, after) => {
            // Hero is image 0 (used for og_image/thumbnail), so body images start at index 1
            const publicPath = resolveImage(key, bodyImageIdx + 1);
            bodyImageIdx++;
            if (!publicPath) {
              console.warn(`Could not resolve data-blog-image="${key}" — leaving as-is`);
              return _m;
            }
            console.log(`Resolved data-blog-image="${key}" → ${publicPath}`);
            let tag = `${before}data-blog-image="${key}"${after}>`;
            if (/\bsrc\s*=\s*["'][^"']*["']/.test(tag)) {
              tag = tag.replace(/\bsrc\s*=\s*["'][^"']*["']/, `src="${publicPath}"`);
            } else {
              tag = tag.replace(/^<img\b/, `<img src="${publicPath}"`);
            }
            return tag;
          }
        );
      }

      // Hero / thumbnail: try to resolve, fall back to image_1 (first uploaded image)
      if (output.post?.seo?.og_image) {
        const resolved = resolveImage(output.post.seo.og_image, 0);
        if (resolved) output.post.seo.og_image = resolved;
      }
      if (output.card?.thumbnail) {
        const resolved = resolveImage(output.card.thumbnail, 0);
        if (resolved) output.card.thumbnail = resolved;
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

// Strip extension and turn into a lowercase slug
function slugifyFilename(filename) {
  return (filename || '')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Strip extension AND all non-alphanumeric chars — broadest matching key
// e.g. "pipeline-1-workflow.png" and "pipeline1workflow" both → "pipeline1workflow"
function normalizeFilename(filename) {
  return (filename || '')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
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
