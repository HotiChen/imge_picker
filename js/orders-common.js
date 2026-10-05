// Shared bits of the products / orders UI (docs/products-orders.md) — settings
// (商品), admin project detail (訂單), orders.html and the dashboard all format
// money, name statuses and turn Worker error codes into sentences the same way.
// Pure helpers plus one tiny fetch wrapper; no DOM, no page state.
(function () {
  const KIND_LABEL = { album: '相本', print: '輸出品', service: '服務', extra_pick: '加挑' };
  const STATUS_LABEL = { requested: '待確認', confirmed: '已確認', fulfilled: '已完成', cancelled: '已取消' };
  const METHOD_LABEL = { cash: '現金', transfer: '轉帳', other: '其他' };
  const SOURCE_LABEL = { admin: '手動建立', guest: '客人下單', system: '系統建立（加挑）' };

  // The moves the Worker allows (ORDER_ARROWS): [target status, button label].
  const STATUS_MOVES = {
    requested: [['confirmed', '確認'], ['cancelled', '取消訂單']],
    confirmed: [['fulfilled', '完成'], ['cancelled', '取消訂單']],
    fulfilled: [['confirmed', '復原為已確認'], ['cancelled', '取消訂單']],
    cancelled: [],
  };

  const ERROR_LABEL = {
    // orders
    below_paid: '訂單總額不能低於已收金額，請先調整或清除收款',
    overpaid: '收款金額不能超過訂單總額',
    conflict: '資料已被更新，請重新整理',
    cancelled: '訂單已取消，無法修改金額或收款',
    retired_option: '這個商品規格已下架，請改選其他規格',
    unknown_option: '找不到這個商品規格，請重新整理',
    unknown_line: '訂單品項已變動，請重新整理',
    invalid_lines: '請至少加入一個品項',
    too_many_lines: '品項太多了（最多 50 項）',
    invalid_qty: '數量需為 1–999 的整數',
    invalid_unit_price: '單價需為 0 以上的整數',
    invalid_photo_keys: '照片選擇不正確（輸出品每件最多 1 張，服務不需選照片）',
    photo_not_in_project: '選到了不屬於這個專案的照片',
    invalid_discount: '折扣需為 0 以上的整數',
    discount_exceeds_subtotal: '折扣不能超過小計',
    invalid_note: '備註太長了（500 字以內）',
    invalid_paid_amount: '收款金額需為 0 以上的整數',
    invalid_paid_method: '請選擇收款方式',
    invalid_paid_at: '收款日期不正確',
    invalid_status: '訂單狀態不正確',
    busy: '系統忙碌中，請稍後再試',
    // products
    invalid_kind: '請選擇商品類型',
    invalid_name: '商品名稱必填（60 字以內）',
    invalid_description: '商品說明太長了（500 字以內）',
    invalid_photo_count: '相本張數需為 1 以上的整數（或留空）',
    invalid_options: '請至少保留一個規格（最多 20 個）',
    invalid_label: '規格名稱太長了（60 字以內）',
    invalid_price: '售價需為 0 以上的整數',
    invalid_cost: '成本需為 0 以上的整數',
    // platform catalogue (A2)
    platform_only: '相本與輸出品要從「從平台加入」新增，自訂商品只能是服務',
    custom_products_disabled: '目前只能從平台加入商品',
    platform_managed: '名稱、類型、說明與張數由平台管理，無法修改',
    below_platform_price: '售價不能低於平台價',
    already_adopted: '已經加入過這個平台商品了',
    unknown_platform_product: '找不到這個平台商品，請重新整理',
    invalid_vendor_cost: '廠商成本需為 0 以上的整數',
    invalid_platform_price: '平台價需為 0 以上的整數',
    too_large: '圖片超過 200 KB，請壓縮後再試',
    unsupported_type: '不支援的檔案格式，僅限 PNG / JPEG / WebP',
    // album page range (operator): inside spreads, 1 spread = 1 P
    invalid_min_pages: '最少頁數需為 1–200 的整數（或留空）',
    invalid_max_pages: '最多頁數需為 1–200 的整數（或留空）',
    invalid_page_range: '最多頁數不能小於最少頁數',
    min_pages_unavailable: '最少頁數還不能存：D1 migration（2026-10-06-product-min-pages.sql）尚未執行',
    max_pages_unavailable: '最多頁數還不能存：D1 migration（2026-10-06-product-max-pages.sql）尚未執行',
  };

  // The one shared escaper (js/util.js, loaded before this file).
  const esc = window.escHtml;

  // NT$1,234 — money is an integer, tax included.
  function money(n) {
    const v = Number(n);
    return 'NT$' + (Number.isFinite(v) ? Math.round(v) : 0).toLocaleString('en-US');
  }

  // A friendly sentence for a failed call: the code's own text first, then
  // whatever the Worker said, then the bare status.
  function errorText(data, status) {
    data = data || {};
    if (data.code === 'bad_transition' && data.from && STATUS_LABEL[data.from]) {
      return `訂單目前是「${STATUS_LABEL[data.from]}」，無法執行這個操作，請重新整理`;
    }
    return ERROR_LABEL[data.code] || data.error || `失敗（${status}）`;
  }

  // 'unpaid' | 'partial' | 'paid' | 'free' — from the computed total, so the
  // wording cannot drift from the numbers next to it.
  function paymentState(o) {
    const total = Number(o.total) || 0;
    const paid = Number(o.paid_amount) || 0;
    if (total === 0 && paid === 0) return 'free';
    if (paid >= total) return 'paid';
    return paid > 0 ? 'partial' : 'unpaid';
  }
  const PAYMENT_LABEL = { unpaid: '未付款', partial: '部分已付', paid: '已付清', free: '免收款' };

  // A platform product's picture, served publicly (no token): `stamp` is its
  // image_updated_at, so a replaced picture is not shown from cache.
  function platformImageUrl(workerUrl, platformProductId, stamp) {
    return `${workerUrl}/api/platform/products/${encodeURIComponent(platformProductId)}/image?v=${encodeURIComponent(stamp || '')}`;
  }

  // An album's page range as a short label, inside spreads (1 spread = 1 P,
  // cover and back not counted): '10–30 跨頁' / '至少 10 跨頁' / '最多 30 跨頁'
  // ('10 跨頁' when both are the same). '' for anything that is not an album
  // or has neither bound. A value that is not a whole number >= 1 counts as none.
  function pageRangeText(p) {
    if (!p || p.kind !== 'album') return '';
    const bound = v => (Number.isSafeInteger(v) && v >= 1 ? v : null);
    const min = bound(p.min_pages), max = bound(p.max_pages);
    if (min !== null && max !== null) return min === max ? `${min} 跨頁` : `${min}–${max} 跨頁`;
    if (min !== null) return `至少 ${min} 跨頁`;
    if (max !== null) return `最多 ${max} 跨頁`;
    return '';
  }

  // "name 規格" — a line's display name.
  function lineName(i) {
    return i.option_label ? `${i.name} · ${i.option_label}` : i.name;
  }

  // Fetch wrapper for the admin API. Resolves {ok, status, data}; a network
  // failure is status 0 with a sentence, never a throw. A 401 calls
  // onUnauthorized (the page decides what signing out means).
  function client({ workerUrl, getToken, onUnauthorized }) {
    return async function call(path, method, body) {
      const opts = { method: method || 'GET', headers: { 'Authorization': `Bearer ${getToken()}` } };
      if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      let r;
      try { r = await fetch(`${workerUrl}${path}`, opts); }
      catch (e) { return { ok: false, status: 0, data: { error: '無法連線到 Worker' } }; }
      if (r.status === 401 && typeof onUnauthorized === 'function') onUnauthorized();
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data };
    };
  }

  window.Orders = {
    KIND_LABEL, STATUS_LABEL, METHOD_LABEL, SOURCE_LABEL, STATUS_MOVES, PAYMENT_LABEL,
    esc, money, errorText, paymentState, lineName, platformImageUrl, pageRangeText, client,
  };
})();
