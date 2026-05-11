/**
 * slug.js — slug helpers used by build and ingest scripts.
 */

/**
 * Convert a title string to a URL-safe slug.
 * Mirrors the convention expected by the Rightbrain task output.
 *
 * @param {string} str
 * @returns {string}
 */
export function slugify(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9\s-]/g, '')    // keep alphanumeric, spaces, hyphens
    .trim()
    .replace(/[\s_]+/g, '-')         // spaces/underscores → hyphens
    .replace(/-{2,}/g, '-')          // collapse multiple hyphens
    .slice(0, 60);                    // max 60 chars
}

/**
 * Validate a slug matches the required pattern.
 * @param {string} slug
 * @returns {boolean}
 */
export function isValidSlug(slug) {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) && slug.length <= 60;
}
