// schema.sql in the four states a deployed database can be in for the two
// hand-run album page-bound migrations (platform_products.min_pages from
// 2026-10-06-product-min-pages.sql, max_pages from
// 2026-10-06-product-max-pages.sql), plus the state before the later
// bleed_mm migration (2026-10-07-product-bleed.sql) and the state before the
// extra_page_price migration (2026-10-07-product-extra-page-price.sql). Every
// earlier state lacks the later columns too (ALTER only appends), so a state
// + its migrations + BLEED_SQL + EXTRA_SQL is schema.sql.
// Not a test file: imported only.
import { readFileSync } from 'node:fs';

export const FRESH = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

const cutFrom = (src, re, to) => {
  const out = src.replace(re, to);
  if (out === src) throw new Error(`page-schemas: ${re} matched nothing in schema.sql`);
  return out;
};

// extra_page_price not there yet (everything before it is)
export const NO_EXTRA = cutFrom(FRESH, /(bleed_mm\s+REAL),\n(?:\s*--[^\n]*\n)*\s*extra_page_price\s+INTEGER\n\);/, '$1\n);');
// bleed_mm not there yet (min_pages and max_pages are)
export const NO_BLEED = cutFrom(NO_EXTRA, /(max_pages\s+INTEGER),\n(?:\s*--[^\n]*\n)*\s*bleed_mm\s+REAL\n\);/, '$1\n);');
const cut = (re, to) => cutFrom(NO_BLEED, re, to);

// neither migration has run
export const NO_PAGES = cut(
  /(updated_at\s+TEXT NOT NULL),\n(?:\s*--[^\n]*\n)*\s*min_pages\s+INTEGER,\n(?:\s*--[^\n]*\n)*\s*max_pages\s+INTEGER\n\);/,
  '$1\n);',
);
// min_pages ran, max_pages not yet
export const NO_MAX = cut(/(min_pages\s+INTEGER),\n(?:\s*--[^\n]*\n)*\s*max_pages\s+INTEGER\n\);/, '$1\n);');
// only max_pages ran (out of order)
export const NO_MIN = cut(/(updated_at\s+TEXT NOT NULL),\n(?:\s*--[^\n]*\n)*\s*min_pages\s+INTEGER,\n/, '$1,\n');

export const MIN_SQL = readFileSync(new URL('../migrations/2026-10-06-product-min-pages.sql', import.meta.url), 'utf8');
export const MAX_SQL = readFileSync(new URL('../migrations/2026-10-06-product-max-pages.sql', import.meta.url), 'utf8');
export const BLEED_SQL = readFileSync(new URL('../migrations/2026-10-07-product-bleed.sql', import.meta.url), 'utf8');
export const EXTRA_SQL = readFileSync(new URL('../migrations/2026-10-07-product-extra-page-price.sql', import.meta.url), 'utf8');
