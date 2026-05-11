#!/usr/bin/env node
/**
 * ingest.js — fetch a completed Rightbrain task run and write data/posts/<slug>.json.
 *
 * Prerequisites:
 *   Set the following env vars (or put them in blog/.env):
 *     RB_API_KEY      — your Rightbrain API key
 *     RB_API_URL      — e.g. https://stag.leftbrain.me/api/v1
 *     RB_ORG_ID       — organisation UUID
 *     RB_PROJECT_ID   — project UUID
 *     RB_TASK_ID      — UUID of the blog-post-builder task
 *
 * Usage:
 *   node scripts/ingest.js <run_id>
 *
 * The <run_id> is the execution UUID shown in the Rightbrain dashboard
 * after a task run completes (visible in the run history).
 *
 * Re-running with the same run_id is idempotent — it overwrites cleanly.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT     = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data', 'posts');

// ── Load .env if present (no deps, manual parse) ─────────────────

function loadDotEnv() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

loadDotEnv();

// ── Config ────────────────────────────────────────────────────────

const API_KEY    = process.env.RB_API_KEY;
const API_URL    = (process.env.RB_API_URL || '').replace(/\/$/, '');
const ORG_ID     = process.env.RB_ORG_ID;
const PROJECT_ID = process.env.RB_PROJECT_ID;
const TASK_ID    = process.env.RB_TASK_ID;

// ── Helpers ───────────────────────────────────────────────────────

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function checkEnv() {
  const missing = [];
  if (!API_KEY)    missing.push('RB_API_KEY');
  if (!API_URL)    missing.push('RB_API_URL');
  if (!ORG_ID)     missing.push('RB_ORG_ID');
  if (!PROJECT_ID) missing.push('RB_PROJECT_ID');
  if (!TASK_ID)    missing.push('RB_TASK_ID');
  if (missing.length) {
    fail(`Missing env vars: ${missing.join(', ')}\nSet them in blog/.env or export them before running.`);
  }
}

async function fetchRun(runId) {
  const url = `${API_URL}/org/${ORG_ID}/project/${PROJECT_ID}/task/${TASK_ID}/run/${runId}`;
  console.log(`  GET ${url}`);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    fail(`Rightbrain API returned ${res.status}: ${body}`);
  }

  return res.json();
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  checkEnv();

  const [runId] = process.argv.slice(2);
  if (!runId) {
    console.error('Usage: node scripts/ingest.js <run_id>');
    console.error('       <run_id> is the execution UUID from the Rightbrain dashboard run history.');
    process.exit(1);
  }

  console.log(`\nFetching run ${runId}…`);
  const run = await fetchRun(runId);

  // Check for task-level errors
  if (run.is_error) {
    fail(`Run ${runId} completed with an error:\n${JSON.stringify(run.response, null, 2)}`);
  }

  // Extract the structured response (the blog post JSON)
  const output = run.response;
  if (!output || typeof output !== 'object') {
    fail(`Run ${runId} has no structured output. Raw response:\n${JSON.stringify(run, null, 2)}`);
  }

  // Validate minimal required fields
  const slug = output?.post?.slug;
  if (!slug || typeof slug !== 'string') {
    fail(`Run output is missing post.slug. Got:\n${JSON.stringify(output, null, 2)}`);
  }

  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) || slug.length > 60) {
    fail(`post.slug "${slug}" is invalid — must match ^[a-z0-9][a-z0-9-]*[a-z0-9]$ and be ≤60 chars.`);
  }

  // Enrich with ingest metadata (non-destructive; build script ignores _ingest)
  const enriched = {
    ...output,
    _ingest: {
      run_id:      runId,
      task_id:     TASK_ID,
      ingested_at: new Date().toISOString(),
      source:      'rightbrain-api',
    },
  };

  // Default published_at to today if the task didn't set it
  if (!enriched.post.published_at) {
    enriched.post.published_at = new Date().toISOString().slice(0, 10);
    console.warn(`  ⚠  post.published_at was not set — defaulting to today (${enriched.post.published_at}).`);
  }

  // Write
  mkdirSync(DATA_DIR, { recursive: true });
  const outPath = join(DATA_DIR, `${slug}.json`);
  writeFileSync(outPath, JSON.stringify(enriched, null, 2), 'utf8');

  console.log(`\n✔  Saved → data/posts/${slug}.json`);
  console.log(`   Title: "${enriched.post.title}"`);
  console.log(`   Tags:  ${(enriched.post.tags || []).join(', ') || '(none)'}`);
  console.log(`\nRun "npm run build" to regenerate the site.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
