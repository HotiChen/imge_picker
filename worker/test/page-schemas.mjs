// schema.sql in the four states a deployed database can be in for the two
// hand-run album page-bound migrations (platform_products.min_pages from
// 2026-10-06-product-min-pages.sql, max_pages from
// 2026-10-06-product-max-pages.sql). Not a test file: imported only.
import { readFileSync } from 'node:fs';

export const FRESH = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

const cut = (re, to) => {
  const out = FRESH.replace(re, to);
  if (out === FRESH) throw new Error(`page-schemas: ${re} matched nothing in schema.sql`);
  return out;
};

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
