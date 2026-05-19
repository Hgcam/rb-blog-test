/**
 * Human-readable labels for machine tags (kebab-case / snake_case slugs).
 */

/** @param {string} slug */
export function formatTagLabel(slug) {
  return String(slug)
    .trim()
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/** @param {string[]} slugs */
export function tagEntries(slugs) {
  return (slugs || []).map((slug) => ({
    slug,
    label: formatTagLabel(slug),
  }));
}

/** Rewrite <li> text inside post-card tag lists. */
export function formatTagsInCardHtml(html) {
  if (!html) return html;
  return html.replace(
    /(<ul\b[^>]*class="[^"]*post-card__tags[^"]*"[^>]*>)([\s\S]*?)(<\/ul>)/gi,
    (_m, open, inner, close) => {
      const formatted = inner.replace(
        /<li>([^<]*)<\/li>/gi,
        (_m2, text) => `<li>${formatTagLabel(text.trim())}</li>`,
      );
      return open + formatted + close;
    },
  );
}
