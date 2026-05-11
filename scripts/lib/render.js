/**
 * render.js — minimal mustache-style template renderer. Zero deps.
 *
 * Supported grammar:
 *   {{var}}               — escape-safe variable substitution
 *   {{var.path.deep}}     — dot-path lookup
 *   {{.}}                 — current item in an #each loop
 *   {{raw:var}}           — raw (unescaped) variable injection (for body_html etc.)
 *   {{#if var}}…{{/if}}  — truthy conditional block
 *   {{#unless var}}…{{/unless}} — falsy conditional block
 *   {{#each list}}…{{/each}}    — iteration; {{.}} is the current item, {{@index}} is 0-based index
 *   {{> partial}}         — inline partial inclusion (partials map passed as third arg)
 */

/** HTML-escape a string. */
function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Deep property lookup by dot-path string. */
function get(obj, path) {
  // '.' means "current item" — stored under the '.' key in each-loop contexts
  if (path === '.') return obj['.'] !== undefined ? obj['.'] : obj;
  return path.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

/**
 * Render a template string with the provided data context.
 *
 * @param {string} template
 * @param {object} data
 * @param {Record<string, string>} [partials]
 * @returns {string}
 */
export function render(template, data, partials = {}) {
  // Resolve all block-level tags (if, unless, each) first, innermost-first via recursion.
  let result = template;

  // ── {{> partial}} ──────────────────────────────────────────────
  result = result.replace(/\{\{>\s*(\w+)\s*\}\}/g, (_m, name) => {
    const partial = partials[name];
    if (!partial) return '';
    return render(partial, data, partials);
  });

  // ── {{#if var}} … {{/if}} ──────────────────────────────────────
  // Supports single-level only; nesting not required by the template grammar.
  result = result.replace(/\{\{#if\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m, path, inner) => {
    const val = get(data, path);
    if (!val || (Array.isArray(val) && val.length === 0)) return '';
    return render(inner, data, partials);
  });

  // ── {{#unless var}} … {{/unless}} ─────────────────────────────
  result = result.replace(/\{\{#unless\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/unless\}\}/g, (_m, path, inner) => {
    const val = get(data, path);
    if (val && !(Array.isArray(val) && val.length === 0)) return '';
    return render(inner, data, partials);
  });

  // ── {{#each list}} … {{/each}} ────────────────────────────────
  result = result.replace(/\{\{#each\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g, (_m, path, inner) => {
    const list = get(data, path);
    if (!Array.isArray(list) || list.length === 0) return '';
    return list.map((item, index) => {
      // Create a per-item context: merge parent data, override . and @index
      const itemCtx = { ...data, '.': item, '@index': index };
      // Also expose top-level keys of object items
      if (item && typeof item === 'object') Object.assign(itemCtx, item);
      return render(inner, itemCtx, partials);
    }).join('');
  });

  // ── {{raw:var}} (unescaped) ─────────────────────────────────────
  result = result.replace(/\{\{raw:([\w.]+)\}\}/g, (_m, path) => {
    const val = get(data, path);
    return val == null ? '' : String(val);
  });

  // ── {{var}} and {{var.deep}} (escaped) ─────────────────────────
  result = result.replace(/\{\{([\w.@]+)\}\}/g, (_m, path) => {
    const val = get(data, path);
    if (val == null) return '';
    return esc(val);
  });

  return result;
}

/**
 * Render a template but inject `body_html`, `card_html`, and any other
 * `*_html` fields RAW (un-escaped). Convenience wrapper for the build script.
 *
 * @param {string} template
 * @param {object} data   — flat context (use renderDeep for nested)
 * @param {Record<string, string>} [partials]
 * @returns {string}
 */
export function renderRaw(template, data, partials = {}) {
  // Pre-convert all *_html keys to raw: prefixed access so they bypass escaping.
  // We do this by pre-injecting them as raw placeholders before the main render.
  let tpl = template;
  for (const [key, val] of Object.entries(data)) {
    if (typeof key === 'string' && key.endsWith('_html') && typeof val === 'string') {
      // Replace {{key}} with the literal HTML (unescaped)
      const re = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      tpl = tpl.replace(re, val);
    }
  }
  return render(tpl, data, partials);
}
