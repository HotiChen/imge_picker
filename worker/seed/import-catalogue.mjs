#!/usr/bin/env node
// Applies worker/seed/photo-art-catalogue.mjs to the platform catalogue through
// the operator API (the same routes operator.html uses).
//
//   node worker/seed/import-catalogue.mjs            dry run: prints the plan, touches nothing
//   OPERATOR_TOKEN=... node worker/seed/import-catalogue.mjs --apply
//   WORKER_URL=https://...  overrides the default Worker (imagepicker.hotichen.workers.dev)
//
// - A product whose name is already in the catalogue is skipped, so a second
//   run adds nothing and an edit made in operator.html is never overwritten.
// - Discontinued items (retire: true in the seed) are created and then retired,
//   so they stay in the catalogue's history but a photographer cannot adopt them.
// - It stops at the first refusal and names the product. Products made before
//   that stay (the skip rule makes a re-run safe).
// - The token is read from the environment only and never printed.
//
// Before --apply: 2026-10-06-product-min-pages.sql must have been run in the D1
// console (every album carries min_pages 15; without the column the Worker
// answers 500 min_pages_unavailable on the first album).
import { pathToFileURL } from 'node:url';
import { PRODUCTS, toPayload } from './photo-art-catalogue.mjs';

const DEFAULT_WORKER = 'https://imagepicker.hotichen.workers.dev';

// What would be created and what is already there. `taken`: names in the catalogue.
export function buildPlan(products, taken) {
  const have = new Set(taken);
  const plan = { create: [], skip: [] };
  products.forEach((p, i) => {
    if (have.has(p.name)) plan.skip.push({ name: p.name });
    else plan.create.push({ name: p.name, retire: !!p.retire, body: toPayload(p, i) });
  });
  return plan;
}

// Runs the plan through `api(method, path, body) → {status, data}`. Returns
// {created, retired}; throws at the first refusal.
export async function applyPlan(plan, api) {
  let created = 0;
  let retired = 0;
  for (const item of plan.create) {
    const res = await api('POST', '/api/operator/products', item.body);
    if (res.status !== 201) throw new Error(`「${item.name}」建立失敗（${res.status} ${res.data?.code || res.data?.error || ''}）；之前已建立 ${created} 個`);
    created++;
    if (item.retire) {
      const off = await api('POST', `/api/operator/products/${encodeURIComponent(res.data.product.id)}/retire`);
      if (off.status !== 200) throw new Error(`「${item.name}」已建立但下架失敗（${off.status} ${off.data?.code || ''}）`);
      retired++;
    }
  }
  return { created, retired };
}

const money = n => `$${n.toLocaleString('en-US')}`;

function printPlan(plan) {
  console.log(`將建立 ${plan.create.length} 個商品，跳過 ${plan.skip.length} 個（名稱已存在）\n`);
  for (const item of plan.create) {
    const b = item.body;
    const sizes = b.options.map(o => `${o.label.split('｜')[0]} ${money(o.platform_price)}`).join(' / ');
    const flags = [item.retire && '建立後下架', b.description.includes('價格待確認：') && '含推算價'].filter(Boolean);
    console.log(`${String(b.sort / 10 + 1).padStart(2)}. [${b.kind}] ${item.name}  ${sizes}${flags.length ? `  (${flags.join('、')})` : ''}`);
  }
  for (const s of plan.skip) console.log(` - 已存在，跳過：${s.name}`);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const token = process.env.OPERATOR_TOKEN || '';
  const base = (process.env.WORKER_URL || DEFAULT_WORKER).replace(/\/+$/, '');
  if (apply && !token) { console.error('--apply 需要環境變數 OPERATOR_TOKEN'); process.exit(2); }

  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  let taken = [];
  if (token) {
    const r = await api('GET', '/api/operator/products');
    if (r.status === 401) { console.error('營運權杖不正確'); process.exit(2); }
    if (r.status !== 200) { console.error(`讀取現有商品失敗（${r.status}）`); process.exit(1); }
    taken = (r.data.products || []).map(p => p.name);
  } else {
    console.log('（沒有 OPERATOR_TOKEN：無法比對現有商品，以下假設目錄是空的）\n');
  }

  const plan = buildPlan(PRODUCTS, taken);
  printPlan(plan);
  if (!apply) { console.log('\n乾跑，未寫入任何資料。確認後加 --apply。'); return; }

  const { created, retired } = await applyPlan(plan, api);
  console.log(`\n完成：建立 ${created} 個，其中 ${retired} 個已下架。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
