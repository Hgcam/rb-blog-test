#!/usr/bin/env node
/**
 * validate.js — validate all data/posts/*.json against the Rightbrain task output contract.
 *
 * Usage:
 *   node scripts/validate.js             # validate all posts
 *   node scripts/validate.js <slug>      # validate one post by slug
 *
 * Exits 0 on success, 1 on any validation failure.
 * Designed to be called by build.js before rendering.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data', 'posts');

// ── Validation rules ─────────────────────────────────────────────

/** @param {string} val @param {number} max */
function maxLen(val, max) {
  return typeof val === 'string' && val.length <= max;
}

/** @param {string} val @param {RegExp} re */
function matches(val, re) {
  return typeof val === 'string' && re.test(val);
}

/** @param {unknown} val */
function isNonEmptyString(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

/** @param {unknown} val */
function isStringArray(val) {
  return Array.isArray(val) && val.every(v => typeof v === 'string');
}

/** @param {unknown} val */
function isPositiveInteger(val) {
  return typeof val === 'number' && Number.isInteger(val) && val > 0;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const FORBIDDEN_IN_BODY = [
  { pattern: /<h1[\s>]/i,   message: 'body_html must NOT contain <h1>' },
  { pattern: /<style[\s>]/i, message: 'body_html must NOT contain <style>' },
  { pattern: /<script[\s>]/i, message: 'body_html must NOT contain <script>' },
  { pattern: /\*\*\S[^*]*\*\*/,  message: 'body_html must NOT contain markdown bold (**…**)' },
  { pattern: /^#{1,6}\s/m,       message: 'body_html must NOT contain markdown headings (# …)' },
  { pattern: /```/,              message: 'body_html must NOT contain markdown code fences (```)' },
];

/**
 * Validate a single parsed post JSON object.
 *
 * @param {object} data   — parsed JSON
 * @param {string} file   — source filename (for error messages)
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePost(data, file = '<unknown>') {
  const errors = [];

  // ── post object ────────────────────────────────────────────────
  if (!data || typeof data !== 'object') {
    return { ok: false, errors: [`${file}: root value must be an object`] };
  }
  if (!data.post || typeof data.post !== 'object') {
    errors.push(`${file}: missing or invalid "post" object`);
    return { ok: false, errors };
  }

  const { post } = data;

  // post.slug
  if (!isNonEmptyString(post.slug)) {
    errors.push(`${file}: post.slug is required`);
  } else if (!matches(post.slug, SLUG_RE)) {
    errors.push(`${file}: post.slug "${post.slug}" does not match ^[a-z0-9][a-z0-9-]*[a-z0-9]$`);
  } else if (post.slug.length > 60) {
    errors.push(`${file}: post.slug is longer than 60 chars`);
  }

  // post.title
  if (!isNonEmptyString(post.title)) {
    errors.push(`${file}: post.title is required`);
  }

  // post.body_html
  if (!isNonEmptyString(post.body_html)) {
    errors.push(`${file}: post.body_html is required`);
  } else {
    for (const { pattern, message } of FORBIDDEN_IN_BODY) {
      if (pattern.test(post.body_html)) {
        errors.push(`${file}: ${message}`);
      }
    }
  }

  // post.reading_time_minutes
  if (post.reading_time_minutes !== undefined && post.reading_time_minutes !== null && !isPositiveInteger(post.reading_time_minutes)) {
    errors.push(`${file}: post.reading_time_minutes must be a positive integer`);
  }

  // post.tags — null or missing is allowed (treated as empty); array of strings if present
  if (post.tags !== null && post.tags !== undefined && !isStringArray(post.tags)) {
    errors.push(`${file}: post.tags must be an array of strings (or null)`);
  }

  // post.seo
  if (!post.seo || typeof post.seo !== 'object') {
    errors.push(`${file}: post.seo is required`);
  } else {
    if (!isNonEmptyString(post.seo.meta_title)) {
      errors.push(`${file}: post.seo.meta_title is required`);
    } else if (!maxLen(post.seo.meta_title, 60)) {
      errors.push(`${file}: post.seo.meta_title exceeds 60 chars (${post.seo.meta_title.length})`);
    }

    if (!isNonEmptyString(post.seo.meta_description)) {
      errors.push(`${file}: post.seo.meta_description is required`);
    } else if (!maxLen(post.seo.meta_description, 155)) {
      errors.push(`${file}: post.seo.meta_description exceeds 155 chars (${post.seo.meta_description.length})`);
    }
  }

  // ── card object ───────────────────────────────────────────────
  if (!data.card || typeof data.card !== 'object') {
    errors.push(`${file}: missing or invalid "card" object`);
  } else {
    const { card } = data;

    if (!isNonEmptyString(card.title)) {
      errors.push(`${file}: card.title is required`);
    }
    if (!isNonEmptyString(card.summary)) {
      errors.push(`${file}: card.summary is required`);
    }
    if (!isNonEmptyString(card.card_html)) {
      errors.push(`${file}: card.card_html is required`);
    } else {
      if (!/<article/i.test(card.card_html)) {
        errors.push(`${file}: card.card_html must contain an <article> element`);
      }
      // Check that the href references the post's slug (if slug is valid)
      if (post.slug && !card.card_html.includes(`/${post.slug}/`)) {
        errors.push(`${file}: card.card_html href does not reference the post slug "/${post.slug}/"`);
      }
    }
  }

  // ── copyedit object ──────────────────────────────────────────
  if (!data.copyedit || typeof data.copyedit !== 'object') {
    errors.push(`${file}: missing or invalid "copyedit" object`);
  } else {
    const { copyedit } = data;
    if (!Array.isArray(copyedit.issues)) {
      errors.push(`${file}: copyedit.issues must be an array`);
    }
    if (!copyedit.stats || typeof copyedit.stats !== 'object') {
      errors.push(`${file}: copyedit.stats is required`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── CLI runner ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let files;

  if (args.length > 0) {
    files = args.map(a => {
      const name = a.endsWith('.json') ? a : `${a}.json`;
      return join(DATA_DIR, name);
    });
  } else {
    try {
      files = readdirSync(DATA_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => join(DATA_DIR, f));
    } catch {
      console.error('No data/posts/ directory found. Run npm run ingest or add posts manually.');
      process.exit(1);
    }
  }

  if (files.length === 0) {
    console.log('No post files found in data/posts/. Nothing to validate.');
    process.exit(0);
  }

  let totalErrors = 0;
  const results = [];

  for (const filePath of files) {
    const name = basename(filePath);
    let raw;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      console.error(`✗ ${name}: could not read file`);
      totalErrors++;
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error(`✗ ${name}: invalid JSON — ${e.message}`);
      totalErrors++;
      continue;
    }

    const { ok, errors } = validatePost(parsed, name);
    if (ok) {
      results.push({ name, ok: true });
    } else {
      totalErrors += errors.length;
      errors.forEach(e => console.error(`  ✗ ${e}`));
      results.push({ name, ok: false });
    }
  }

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;

  if (totalErrors === 0) {
    console.log(`✔  All ${passed} post(s) passed validation.`);
    process.exit(0);
  } else {
    console.error(`\n✗  ${failed} post(s) failed validation (${totalErrors} error(s) total). Fix before building.`);
    process.exit(1);
  }
}

// Run when executed directly
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
