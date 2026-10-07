// Guest ordering on the 完成頁 (docs/guest-shop.md, 「S2 — built (Worker, WP1)」). The CLIENT side of
//   GET /api/pick/shop `ordering`, POST /api/pick/orders, GET /api/pick/orders, POST /api/pick/orders/:id/cancel.
//
// js/completion-page.js decides WHEN this exists (ordering non-null AND the seat owner AND a confirmed project);
// this file is the flow: 訂購 on a product card -> a bottom sheet with steps
//   product (option, qty, one final as the photo / the spreads) -> cart -> contact -> review -> receipt,
// plus 「我的訂單」 (the list, 取消 while 待確認).
//
// The Worker computes every price; this page only shows the same arithmetic so the guest knows what they
// agree to, and sends it as `expected_total` (the Worker answers 409 price_changed with a quote when they differ):
//   print  unit = option price
//   album  unit = option price + (spreads - min_pages) * extra_page_price     (per copy)
//
// request_id: a fresh UUID v4 per submit ATTEMPT, kept while the answer is unknown (network error, 5xx) so the
// Worker's replay returns the order that may already have landed, and dropped after any definitive answer or any
// edit. The picker key travels only in the X-Picker-Key header (cfg.api, js/pick.js), never in a URL.
//
// Every string that came from outside only reaches the DOM through textContent / property assignment.
(function () {
    'use strict';

    // Placeholder wording, 待審閱 (to be reviewed by Tim / a lawyer before real guests use it). The ONE place it lives.
    const PRIVACY_NOTICE = '我們會收集你的姓名與聯絡方式，只用來處理這筆訂單、與你聯絡面交事宜。'
        + '訂單完成後，攝影師可依需要清除你的聯絡資料。我們不會把它提供給無關的第三方。';

    const NOTE_MAX = 500;
    const NAME_MAX = 50;
    const LINE_ID_MAX = 50;
    const PHONE_RE = /^[0-9+\-() ]{6,20}$/;
    const SPREADS_CAP = 200;

    const STATUS_TEXT = { requested: '待確認', confirmed: '已確認', fulfilled: '已完成', cancelled: '已取消' };
    const STATUS_HINT = {
        requested: '攝影師確認後，這裡會顯示付款方式。在確認之前，你可以隨時取消。',
        confirmed: '攝影師已確認這筆訂單。請依下方方式付款，並與攝影師約面交時間。',
        fulfilled: '這筆訂單已完成，謝謝你。',
        cancelled: '這筆訂單已取消。',
    };

    const el = (tag, cls, txt) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (txt != null) e.textContent = txt;
        return e;
    };
    const btn = (cls, label, onClick) => {
        const b = el('button', cls, label);
        b.type = 'button';
        if (onClick) b.addEventListener('click', onClick);
        return b;
    };
    const money = n => Util.formatPrice(n);
    const whole = v => Number.isSafeInteger(v) && v >= 0;

    function uuid4() {
        const c = window.crypto;
        if (c && typeof c.randomUUID === 'function') return c.randomUUID();
        const b = new Uint8Array(16);
        if (c && c.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
        b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
        const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }

    // ── pure helpers (also on GuestOrder for the tests) ─────────────────────
    // `ordering` as the Worker sends it, kept only as far as it is well-formed; anything else = no ordering
    function cleanOrdering(o) {
        if (!o || typeof o !== 'object') return null;
        if (typeof o.consent_version !== 'string' || !o.consent_version) return null;
        const pos = (v, d) => (Number.isSafeInteger(v) && v >= 1 ? v : d);
        return {
            consent_version: o.consent_version,
            max_lines: pos(o.max_lines, 20), print_qty_max: pos(o.print_qty_max, 10), album_qty_max: pos(o.album_qty_max, 3),
        };
    }
    // an album without min_pages cannot be ordered (album_not_orderable); a print always can
    function orderable(p) { return !!p && p.id != null && (p.kind === 'print' || (p.kind === 'album' && p.min != null)); }
    // the largest spread count that can be priced: above min only if the product says what an extra spread costs
    function spreadsMax(p) {
        if (p.min == null) return 0;
        if (p.extraPagePrice == null) return p.min;
        return Math.max(p.min, Math.min(p.max == null ? SPREADS_CAP : p.max, SPREADS_CAP));
    }
    // per copy, exactly as the Worker: option price + (spreads - min) * extra_page_price
    function unitPrice(p, option, spreads) {
        if (p.kind !== 'album') return option.price;
        return option.price + (spreads - p.min) * (p.extraPagePrice || 0);
    }
    const lineTotal = l => l.unit * l.qty;
    // what the guest is shown AND what goes out as expected_total: the sum of the lines, or the Worker's own quote after price_changed
    const shownTotal = () => (S.quote ? S.quote.total : cartTotal(S.cart));
    const cartTotal = cart => cart.reduce((a, l) => a + lineTotal(l), 0);
    const fileName = k => String(k).split('/').pop();

    // plain Chinese for every code the order routes can answer; `to` says where the page sends the guest
    function errorInfo(r) {
        const st = r && r.status, d = (r && r.data) || {}, code = d.code;
        if (!r || st === 0 || st == null) return { msg: '無法連線，請檢查網路後再按一次送出。同一筆訂單不會重複送出。', keep: true };
        if (st === 401) return { msg: '連結已失效，請向攝影師索取新的連結。' };
        if (st === 413) return { msg: '訂單內容太大，請減少項目後再試。', to: 'cart' };
        const T = {
            not_owner: ['只有挑選人可以下單。'],
            ordering_disabled: ['目前暫不開放線上訂購，你可以按「我有興趣」通知攝影師。', null, true],
            not_confirmed: ['請先確認完成交件，才能下單。'],
            too_large: ['訂單內容太大，請減少項目後再試。', 'cart'],
            invalid_body: ['訂單資料有誤，請重新整理頁面後再試。'],
            invalid_request_id: ['送出時發生問題，請再按一次送出。'],
            invalid_lines: ['訂單項目有誤，請檢查後再試。', 'cart'],
            too_many_lines: ['一張訂單最多只能放 20 個項目，請分開下單。', 'cart'],
            invalid_qty: ['數量不符合規定，請檢查項目的數量。', 'cart'],
            invalid_photo_key: ['有一張照片無法使用，請重新選擇。', 'cart'],
            duplicate_line: ['有項目重複了，請合併後再試。', 'cart'],
            invalid_spreads: ['相本的跨頁數不正確，請重新選擇。', 'cart'],
            invalid_contact: ['聯絡資料有誤：請填姓名，以及電話或 LINE ID（至少一項）。', 'contact'],
            invalid_delivery: ['目前只提供面交。'],
            consent_required: ['請先勾選同意個資告知。', 'contact'],
            invalid_note: ['備註內容不符合規定，請修改後再試。', 'contact'],
            orders_unavailable: ['訂購功能暫時無法使用，請稍後再試，或直接聯絡攝影師。', null, false, true],
            shop_unavailable: ['商品資訊暫時無法使用，請稍後再試，或直接聯絡攝影師。', null, false, true],
            product_not_offered: ['有商品目前不提供了，請移除後再試。', 'cart'],
            not_in_finals: ['有一張照片不在精修成品裡，請重新選擇。', 'cart'],
            photo_not_found: ['有一張照片找不到，請重新選擇。', 'cart'],
            album_not_orderable: ['這本相簿目前無法線上訂購，請直接聯絡攝影師。', 'cart'],
            pages_below_min: ['相本跨頁數不足，請重新選擇。', 'cart'],
            pages_above_max: ['相本跨頁數超過上限，請重新選擇。', 'cart'],
            extra_pages_unpriced: ['這本相簿不能加頁，請減少跨頁數。', 'cart'],
            delivery_changed: ['交件內容剛剛更新了，請重新整理頁面後再試。'],
            too_many_open_orders: ['你已經有 3 筆待確認的訂單，請等攝影師確認後再下新單。'],
            order_cap: ['這個相簿的訂單已達上限，請直接聯絡攝影師。'],
            duplicate_request: ['送出時發生衝突，請再按一次送出。'],
            price_changed: ['價格有更新，請確認新的金額。'],
        };
        const t = T[code];
        if (t) return { msg: t[0], to: t[1] || null, disabled: !!t[2], unavailable: !!t[3] };
        if (st >= 500) return { msg: '暫時無法處理，請稍後再按一次送出。同一筆訂單不會重複送出。', keep: true };
        return { msg: '無法送出，請稍後再試。' };
    }
    function cancelError(r) {
        const st = r && r.status, code = r && r.data && r.data.code;
        if (!r || !st) return '無法連線，請檢查網路後再試。';
        if (st === 409 && code === 'bad_transition') return '攝影師已經確認這筆訂單，無法再取消。請直接聯絡攝影師。';
        if (st === 404) return '找不到這筆訂單。';
        if (st === 403) return '只有挑選人可以取消訂單。';
        if (st === 401) return '連結已失效';
        return '暫時無法取消，請稍後再試。';
    }

    // ── the flow ────────────────────────────────────────────────────────────
    const S = {
        ctx: null, ordering: null, cart: [], contact: { name: '', phone: '', line: '' }, note: '', consent: false,
        reqId: null, inflight: false, step: null, layer: null, sheet: null, body: null, foot: null, opener: null,
        draft: null, finals: null, finalsState: 'idle', orders: null, ordersState: 'idle', quote: null, error: '', receipt: null,
        bar: null, onChange: [],
    };
    const changed = () => S.onChange.forEach(f => { try { f(); } catch (e) { /* a dead bar */ } });
    const editedCart = () => { S.reqId = null; S.quote = null; S.error = ''; };

    function start(ctx) {
        reset();
        S.ctx = ctx;
        S.ordering = cleanOrdering(ctx.ordering);
        return !!S.ordering;
    }
    function reset() {
        close(true);
        Object.assign(S, { ctx: null, ordering: null, cart: [], contact: { name: '', phone: '', line: '' }, note: '', consent: false,
            reqId: null, inflight: false, step: null, draft: null, finals: null, finalsState: 'idle', orders: null, ordersState: 'idle',
            quote: null, error: '', receipt: null, bar: null, onChange: [] });
    }

    function orderButton(product, onTap) {
        const b = btn('cp-btn cp-btn--solid go-order-btn', '訂購', () => { S.opener = b; openProduct(product); if (onTap) onTap(); });
        b.dataset.productId = product.id;
        return b;
    }

    // 「查看訂單內容」 + 「我的訂單」: under the product list
    function buildBar() {
        const bar = el('div', 'go-bar');
        bar.id = 'goBar';
        const cart = btn('cp-btn cp-btn--solid go-bar-cart', '', () => { S.opener = cart; openStep('cart'); });
        cart.id = 'goBarCart';
        const mine = btn('cp-btn cp-btn--line go-bar-orders', '我的訂單', () => { S.opener = mine; openStep('orders'); });
        mine.id = 'goBarOrders';
        const paint = () => {
            cart.hidden = !S.cart.length;
            cart.textContent = `查看訂單內容（${S.cart.reduce((a, l) => a + l.qty, 0)} 件・${money(cartTotal(S.cart))}）`;
        };
        paint();
        S.onChange.push(paint);
        bar.append(cart, mine);
        return bar;
    }

    // ── sheet ───────────────────────────────────────────────────────────────
    function ensureSheet() {
        if (S.layer && S.layer.isConnected) return;
        const root = (S.ctx && S.ctx.root) || document.body;
        const layer = el('div', 'go-layer');
        layer.id = 'goLayer';
        const back = el('div', 'go-backdrop');
        back.addEventListener('click', () => close());
        const sheet = el('div', 'go-sheet');
        sheet.id = 'goSheet';
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        sheet.tabIndex = -1;
        sheet.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
        S.body = el('div', 'go-body');
        S.foot = el('div', 'go-foot');
        sheet.append(S.body, S.foot);
        layer.append(back, sheet);
        root.append(layer);
        S.layer = layer; S.sheet = sheet;
        document.documentElement.classList.add('go-open');
    }
    function close(silent) {
        if (S.layer) S.layer.remove();
        S.layer = S.sheet = S.body = S.foot = null;
        S.step = null;
        document.documentElement.classList.remove('go-open');
        if (!silent && S.opener && S.opener.isConnected) { try { S.opener.focus({ preventScroll: true }); } catch (e) { /* ok */ } }
    }
    function head(title, onBack) {
        const h = el('div', 'go-head');
        if (onBack) h.append(btn('go-icon', '‹', onBack));
        h.firstChild && (h.firstChild.setAttribute('aria-label', '返回'));
        const t = el('h2', 'go-title', title);
        t.id = 'goTitle';
        t.tabIndex = -1;
        const x = btn('go-icon go-close', '×', () => close());
        x.setAttribute('aria-label', '關閉');
        h.append(t, x);
        return h;
    }
    function paint(step, nodes, footNodes) {
        ensureSheet();
        S.step = step;
        S.sheet.dataset.step = step;
        S.body.replaceChildren(...nodes);
        S.foot.replaceChildren(...(footNodes || []));
        S.foot.hidden = !(footNodes && footNodes.length);
        S.body.scrollTop = 0;
        S.sheet.setAttribute('aria-labelledby', 'goTitle');
        const t = S.sheet.querySelector('#goTitle');
        try { (t || S.sheet).focus({ preventScroll: true }); } catch (e) { /* ok */ }
    }
    function openStep(step) {
        if (step === 'cart') return renderCart();
        if (step === 'contact') return renderContact();
        if (step === 'review') return renderReview();
        if (step === 'orders') return renderOrders();
        if (step === 'receipt') return renderReceipt();
    }

    // ── a quantity stepper ──────────────────────────────────────────────────
    function stepper(value, min, max, onChange, label) {
        const w = el('div', 'go-stepper');
        w.setAttribute('role', 'group');
        w.setAttribute('aria-label', label);
        const minus = btn('go-step go-step-minus', '−', () => onChange(value - 1));
        const plus = btn('go-step go-step-plus', '+', () => onChange(value + 1));
        minus.setAttribute('aria-label', `${label}減一`);
        plus.setAttribute('aria-label', `${label}加一`);
        minus.disabled = value <= min;
        plus.disabled = value >= max;
        const n = el('span', 'go-step-n', String(value));
        n.setAttribute('aria-live', 'polite');
        w.append(minus, n, plus);
        return w;
    }

    // ── step: a product ─────────────────────────────────────────────────────
    function openProduct(p) {
        const single = p.options.length === 1 ? p.options[0] : null;
        S.draft = { p, option: single, qty: 1, photo: null, spreads: p.kind === 'album' ? p.min : null };
        renderProduct();
        if (p.kind === 'print') loadFinals();
    }
    function loadFinals(force) {
        if (S.finalsState === 'loading' || (S.finalsState === 'ok' && !force)) return;
        const ctx = S.ctx;
        if (!ctx || typeof ctx.listFinals !== 'function') { S.finalsState = 'error'; return; }
        S.finalsState = 'loading';
        let p;
        try { p = Promise.resolve(ctx.listFinals()); } catch (e) { p = Promise.reject(e); }
        p.then(ids => {
            S.finals = Array.isArray(ids) ? ids.filter(k => typeof k === 'string' && k && !k.endsWith('/')) : [];
            S.finalsState = 'ok';
        }, () => { S.finalsState = 'error'; }).then(() => { if (S.step === 'product') renderProduct(); });
    }
    function renderProduct() {
        const d = S.draft, p = d.p;
        const qtyMax = p.kind === 'album' ? S.ordering.album_qty_max : S.ordering.print_qty_max;
        const nodes = [head(p.name)];
        if (p.description) nodes.push(el('p', 'go-desc', p.description));

        const optSec = el('section', 'go-sec');
        optSec.append(el('h3', 'go-h3', p.options.length > 1 ? '選擇規格' : '規格'));
        const list = el('div', 'go-opts');
        list.setAttribute('role', 'group');
        list.setAttribute('aria-label', '規格');
        for (const o of p.options) {
            const b = btn('go-opt', null, () => { d.option = o; renderProduct(); });
            b.dataset.optionId = o.id;
            b.setAttribute('aria-pressed', String(d.option === o));
            b.append(el('span', 'go-opt-label', o.label || '標準'), el('span', 'go-opt-price', money(o.price)));
            list.append(b);
        }
        optSec.append(list);
        nodes.push(optSec);

        if (p.kind === 'print') {
            const ps = el('section', 'go-sec');
            ps.append(el('h3', 'go-h3', '選一張照片'), el('p', 'go-sub', '從精修成品中選一張，要印幾份可以在下面調整。'));
            if (S.finalsState === 'loading' || S.finalsState === 'idle') ps.append(el('p', 'go-msg', '載入照片中…'));
            else if (S.finalsState === 'error') {
                ps.append(el('p', 'go-msg go-msg--err', '無法載入照片，請再試一次。'), btn('cp-btn cp-btn--line', '重新載入', () => { loadFinals(true); renderProduct(); }));
            } else if (!S.finals.length) ps.append(el('p', 'go-msg', '目前沒有可選的照片。'));
            else {
                const grid = el('div', 'go-photos');
                grid.id = 'goPhotos';
                grid.setAttribute('role', 'group');
                grid.setAttribute('aria-label', '照片');
                for (const k of S.finals) {
                    const b = btn('go-photo', null, () => { d.photo = k; renderProduct(); });
                    b.dataset.photoKey = k;
                    b.setAttribute('aria-pressed', String(d.photo === k));
                    b.setAttribute('aria-label', fileName(k));
                    const img = el('img');
                    img.alt = '';
                    img.loading = 'lazy';
                    img.decoding = 'async';
                    const url = S.ctx && S.ctx.thumbUrl ? S.ctx.thumbUrl(k) : null;
                    if (url) img.src = url;
                    b.append(img);
                    grid.append(b);
                }
                ps.append(grid);
            }
            nodes.push(ps);
        } else {
            const ss = el('section', 'go-sec');
            ss.append(el('h3', 'go-h3', '跨頁數'));
            const max = spreadsMax(p);
            ss.append(el('p', 'go-sub', p.extraPagePrice != null && max > p.min
                ? `含 ${p.min} 跨頁，最多 ${max} 跨頁；每多 1 跨頁加 ${money(p.extraPagePrice)}。使用你的全部精修，由攝影師排版。`
                : `${p.min} 跨頁（此相本不能加頁）。使用你的全部精修，由攝影師排版。`));
            if (max > p.min) {
                ss.append(stepper(d.spreads, p.min, max, v => { d.spreads = Math.max(p.min, Math.min(max, v)); renderProduct(); }, '跨頁'));
            } else ss.append(el('p', 'go-fixed', `${p.min} 跨頁`));
            nodes.push(ss);
        }

        const qs = el('section', 'go-sec go-sec--row');
        qs.append(el('h3', 'go-h3', '數量'), stepper(d.qty, 1, qtyMax, v => { d.qty = Math.max(1, Math.min(qtyMax, v)); renderProduct(); }, '數量'));
        nodes.push(qs);

        const unit = d.option ? unitPrice(p, d.option, d.spreads) : null;
        const exists = S.cart.some(l => sameLine(l, d));
        const full = !exists && S.cart.length >= S.ordering.max_lines;
        const ready = !!d.option && (p.kind === 'album' || !!d.photo) && !full;
        const foot = [];
        if (full) foot.push(el('p', 'go-msg go-msg--err', `一張訂單最多 ${S.ordering.max_lines} 個項目。`));
        const pl = el('p', 'go-price', unit == null ? '請先選擇規格' : `單價 ${money(unit)}　小計 ${money(unit * d.qty)}`);
        pl.id = 'goDraftPrice';
        foot.push(pl);
        if (!ready && d.option && p.kind === 'print' && !d.photo) foot.push(el('p', 'go-msg', '請選一張照片'));
        const add = btn('cp-btn cp-btn--solid go-primary', '加入訂單', addDraft);
        add.id = 'goAdd';
        add.disabled = !ready;
        foot.push(add);
        paint('product', nodes, foot);
    }
    const sameLine = (l, d) => l.productId === d.p.id && l.optionId === (d.option && d.option.id) && (d.p.kind === 'album' || l.photo === d.photo);
    function addDraft() {
        const d = S.draft;
        if (!d || !d.option) return;
        const p = d.p;
        const qtyMax = p.kind === 'album' ? S.ordering.album_qty_max : S.ordering.print_qty_max;
        const unit = unitPrice(p, d.option, d.spreads);
        const hit = S.cart.find(l => sameLine(l, d));
        if (hit) {
            // the Worker refuses the same option + photo (or the same album option) twice: one line
            if (p.kind === 'album') { hit.qty = d.qty; hit.spreads = d.spreads; hit.unit = unit; }
            else hit.qty = Math.min(qtyMax, hit.qty + d.qty);
        } else {
            if (S.cart.length >= S.ordering.max_lines) return;
            S.cart.push({ productId: p.id, kind: p.kind, name: p.name, optionId: d.option.id, optionLabel: d.option.label, qty: d.qty,
                photo: p.kind === 'print' ? d.photo : null, spreads: p.kind === 'album' ? d.spreads : null, unit, qtyMax, product: p, option: d.option });
        }
        editedCart();
        changed();
        S.draft = null;
        renderCart();
    }

    // ── step: the cart ──────────────────────────────────────────────────────
    function lineDetail(l) {
        return l.kind === 'album' ? `${l.spreads} 跨頁・全部精修` : fileName(l.photo);
    }
    function renderCart() {
        const nodes = [head('訂單內容')];
        const foot = [];
        if (!S.cart.length) {
            nodes.push(el('p', 'go-msg', '還沒有加入任何項目。'));
            foot.push(btn('cp-btn cp-btn--line go-primary', '回到商品', () => close()));
            paint('cart', nodes, foot);
            return;
        }
        const ul = el('ul', 'go-lines');
        ul.id = 'goLines';
        S.cart.forEach((l, i) => {
            const li = el('li', 'go-line');
            li.dataset.lineIndex = String(i);
            const info = el('div', 'go-line-info');
            info.append(el('div', 'go-line-name', l.optionLabel ? `${l.name}　${l.optionLabel}` : l.name), el('div', 'go-line-detail', lineDetail(l)),
                el('div', 'go-line-price', `${money(l.unit)} × ${l.qty} = ${money(lineTotal(l))}`));
            if (l.kind === 'print' && S.ctx && S.ctx.thumbUrl) {
                const img = el('img', 'go-line-thumb');
                img.alt = '';
                img.loading = 'lazy';
                img.src = S.ctx.thumbUrl(l.photo);
                li.append(img);
            }
            const acts = el('div', 'go-line-acts');
            acts.append(stepper(l.qty, 1, l.qtyMax, v => { l.qty = Math.max(1, Math.min(l.qtyMax, v)); editedCart(); changed(); renderCart(); }, '數量'),
                btn('go-remove', '移除', () => { S.cart.splice(i, 1); editedCart(); changed(); renderCart(); }));
            li.append(info, acts);
            ul.append(li);
        });
        nodes.push(ul);
        const total = el('p', 'go-total', `合計 ${money(cartTotal(S.cart))}`);
        total.id = 'goCartTotal';
        nodes.push(total);
        foot.push(btn('cp-btn cp-btn--line', '繼續挑商品', () => close()));
        const next = btn('cp-btn cp-btn--solid go-primary', '下一步：聯絡資料', () => renderContact());
        next.id = 'goToContact';
        foot.push(next);
        paint('cart', nodes, foot);
    }

    // ── step: contact ───────────────────────────────────────────────────────
    function field(id, label, input, hint) {
        const w = el('div', 'go-field');
        const l = el('label', 'go-label', label);
        l.htmlFor = id;
        input.id = id;
        w.append(l, input);
        if (hint) w.append(el('p', 'go-hint', hint));
        return w;
    }
    function renderContact(msg) {
        const nodes = [head('聯絡資料', () => renderCart())];
        const c = S.contact;
        const mk = (type, val, attrs) => {
            const i = el('input', 'go-input');
            i.type = type; i.value = val;
            Object.entries(attrs || {}).forEach(([k, v]) => i.setAttribute(k, v));
            return i;
        };
        const name = mk('text', c.name, { autocomplete: 'name', maxlength: String(NAME_MAX), enterkeyhint: 'next' });
        const phone = mk('tel', c.phone, { autocomplete: 'tel', inputmode: 'tel', maxlength: '20', enterkeyhint: 'next' });
        const line = mk('text', c.line, { autocomplete: 'off', maxlength: String(LINE_ID_MAX), autocapitalize: 'off', enterkeyhint: 'next' });
        const note = el('textarea', 'go-input go-textarea');
        note.value = S.note; note.rows = 3; note.maxLength = NOTE_MAX; note.setAttribute('enterkeyhint', 'done');
        const consent = el('input');
        consent.type = 'checkbox'; consent.checked = S.consent; consent.id = 'goConsent'; consent.className = 'go-check';
        const sync = () => { c.name = name.value; c.phone = phone.value; c.line = line.value; S.note = note.value; S.consent = consent.checked; editedCart(); };
        [name, phone, line, note].forEach(i => i.addEventListener('input', sync));
        consent.addEventListener('change', sync);

        nodes.push(field('goName', '姓名（必填）', name),
            field('goPhone', '電話', phone, '電話或 LINE ID 至少填一項'),
            field('goLine', 'LINE ID', line),
            field('goNote', '備註（選填，最多 500 字）', note));
        const del = el('div', 'go-field go-delivery');
        del.append(el('div', 'go-label', '取貨方式'), el('p', 'go-fixed', '面交（確認訂單後，與攝影師約時間地點）'));
        nodes.push(del);
        const cs = el('div', 'go-consent');
        const cl = el('label', 'go-consent-row');
        cl.append(consent, el('span', null, `我已閱讀並同意個資告知（版本 ${S.ordering.consent_version}）`));
        cs.append(el('p', 'go-notice', PRIVACY_NOTICE), cl);
        nodes.push(cs);
        const err = el('p', 'go-msg go-msg--err', msg || '');
        err.id = 'goContactError';
        err.setAttribute('role', 'alert');
        err.hidden = !msg;
        nodes.push(err);
        const next = btn('cp-btn cp-btn--solid go-primary', '下一步：確認訂單', () => {
            sync();
            const bad = contactProblem();
            if (bad) { err.textContent = bad; err.hidden = false; return; }
            S.error = '';
            renderReview();
        });
        next.id = 'goToReview';
        paint('contact', nodes, [next]);
    }
    function contactProblem() {
        const name = S.contact.name.trim(), phone = S.contact.phone.trim(), line = S.contact.line.trim();
        if (!name || name.length > NAME_MAX) return `請填姓名（1–${NAME_MAX} 字）。`;
        if (!phone && !line) return '電話或 LINE ID 至少要填一項。';
        if (phone && !PHONE_RE.test(phone)) return '電話格式不正確（6–20 碼，可含 + - ( ) 與空白）。';
        if (line && line.length > LINE_ID_MAX) return `LINE ID 最多 ${LINE_ID_MAX} 字。`;
        if (S.note.length > NOTE_MAX) return `備註最多 ${NOTE_MAX} 字。`;
        if (!S.consent) return '請先勾選同意個資告知。';
        return null;
    }

    // ── step: review + submit ───────────────────────────────────────────────
    function renderReview() {
        const nodes = [head('確認訂單', () => renderContact())];
        if (S.quote) {
            const q = el('p', 'go-banner', `價格有更新，新的合計是 ${money(S.quote.total)}。請確認後再送出。`);
            q.id = 'goQuote';
            q.setAttribute('role', 'alert');
            nodes.push(q);
        }
        const ul = el('ul', 'go-lines go-lines--ro');
        S.cart.forEach(l => {
            const li = el('li', 'go-line');
            const info = el('div', 'go-line-info');
            info.append(el('div', 'go-line-name', l.optionLabel ? `${l.name}　${l.optionLabel}` : l.name), el('div', 'go-line-detail', lineDetail(l)),
                el('div', 'go-line-price', `${money(l.unit)} × ${l.qty} = ${money(lineTotal(l))}`));
            li.append(info);
            ul.append(li);
        });
        nodes.push(ul);
        const total = el('p', 'go-total', `合計 ${money(shownTotal())}`);
        total.id = 'goReviewTotal';
        nodes.push(total);
        const who = el('div', 'go-who');
        const c = S.contact;
        who.append(el('p', null, `姓名：${c.name.trim()}`));
        if (c.phone.trim()) who.append(el('p', null, `電話：${c.phone.trim()}`));
        if (c.line.trim()) who.append(el('p', null, `LINE：${c.line.trim()}`));
        who.append(el('p', null, '取貨方式：面交'));
        if (S.note.trim()) who.append(el('p', 'go-note', `備註：${S.note}`));
        nodes.push(who);
        nodes.push(el('p', 'go-sub', '送出後是「待確認」：攝影師確認後，才會顯示付款方式。現在不用付款。'));
        const err = el('p', 'go-msg go-msg--err', S.error || '');
        err.id = 'goSubmitError';
        err.setAttribute('role', 'alert');
        err.hidden = !S.error;
        nodes.push(err);
        const submit = btn('cp-btn cp-btn--solid go-primary', `送出訂單　${money(shownTotal())}`, submitOrder);
        submit.id = 'goSubmit';
        paint('review', nodes, [submit]);
    }

    function buildBody() {
        const body = {
            request_id: S.reqId,
            lines: S.cart.map(l => l.kind === 'album'
                ? { option_id: l.optionId, qty: l.qty, spreads: l.spreads }
                : { option_id: l.optionId, qty: l.qty, photo_key: l.photo }),
            contact: { name: S.contact.name.trim() },
            delivery: { method: 'pickup' },
            expected_total: shownTotal(),
            consent: S.consent ? S.ordering.consent_version : '',
        };
        if (S.contact.phone.trim()) body.contact.phone = S.contact.phone.trim();
        if (S.contact.line.trim()) body.contact.line = S.contact.line.trim();
        if (S.note.trim()) body.note = S.note.trim();
        return body;
    }

    async function submitOrder() {
        if (S.inflight) return;
        if (!S.cart.length) return;
        const bad = contactProblem();
        if (bad) { renderContact(bad); return; }
        S.inflight = true;
        const b = S.foot && S.foot.querySelector('#goSubmit');
        if (b) { b.disabled = true; b.setAttribute('aria-busy', 'true'); b.textContent = '送出中…'; }
        if (!S.reqId) S.reqId = uuid4();
        let r = null;
        try { r = await S.ctx.api.post(buildBody()); } catch (e) { r = null; }
        S.inflight = false;
        if (!S.sheet) return;   // closed meanwhile; the cart and the request_id are kept
        if (r && r.ok && r.data && r.data.order) {
            S.receipt = r.data.order;
            S.cart = []; S.reqId = null; S.quote = null; S.error = ''; S.orders = null;
            S.consent = false;
            changed();
            renderReceipt();
            return;
        }
        const code = r && r.data && r.data.code;
        const info = errorInfo(r);
        if (!info.keep) S.reqId = null;   // a definitive answer: the next attempt is a new one
        if (r && r.status === 409 && code === 'price_changed' && r.data.quote && whole(r.data.quote.total)) {
            S.quote = r.data.quote;
            for (const ql of Array.isArray(r.data.quote.lines) ? r.data.quote.lines : []) {
                const l = S.cart.find(x => x.optionId === ql.option_id && x.qty === ql.qty && x.unit !== ql.unit_price);
                if (l && whole(ql.unit_price)) l.unit = ql.unit_price;
            }
            S.error = '';
            changed();
            renderReview();
            return;
        }
        S.quote = null;
        if (info.disabled) {
            S.error = info.msg;
            if (S.ctx.onOrderingDisabled) S.ctx.onOrderingDisabled();
            return;
        }
        if (info.to === 'contact') { renderContact(info.msg); return; }
        S.error = info.msg;
        if (info.to === 'cart') { S.error = ''; renderCart(); const e = el('p', 'go-msg go-msg--err', info.msg); e.id = 'goCartError'; e.setAttribute('role', 'alert'); S.body.insertBefore(e, S.body.children[1] || null); return; }
        renderReview();
    }

    // ── receipt + my orders ─────────────────────────────────────────────────
    function orderCard(o, opts) {
        const card = el('article', `go-order go-order--${o.status}`);
        card.dataset.orderId = o.id;
        card.dataset.status = o.status;
        const top = el('div', 'go-order-top');
        const st = el('span', 'go-status', STATUS_TEXT[o.status] || '處理中');
        st.dataset.status = o.status;
        top.append(st);
        if (o.created_at) top.append(el('span', 'go-order-date', String(o.created_at).slice(0, 10).replace(/-/g, '.')));
        card.append(top);
        const ul = el('ul', 'go-lines go-lines--ro');
        for (const i of (Array.isArray(o.items) ? o.items : [])) {
            const li = el('li', 'go-line');
            const info = el('div', 'go-line-info');
            const detail = i.kind === 'album' ? (i.spreads != null ? `${i.spreads} 跨頁・全部精修` : '') : (i.photo_name || '');
            info.append(el('div', 'go-line-name', i.option_label ? `${i.name}　${i.option_label}` : String(i.name)));
            if (detail) info.append(el('div', 'go-line-detail', detail));
            info.append(el('div', 'go-line-price', `${money(i.unit_price)} × ${i.qty}`));
            li.append(info);
            ul.append(li);
        }
        card.append(ul, el('p', 'go-total', `合計 ${money(o.total)}`));
        const hint = STATUS_HINT[o.status];
        if (hint) card.append(el('p', 'go-sub go-hintline', hint));
        // 付款方式: only a confirmed / fulfilled order, and only when the Worker sent it
        if ((o.status === 'confirmed' || o.status === 'fulfilled') && typeof o.transfer_info === 'string' && o.transfer_info.trim()) {
            const t = el('div', 'go-transfer');
            t.append(el('div', 'go-label', '付款方式'), el('div', 'go-transfer-text', o.transfer_info));
            card.append(t);
        }
        if (opts && opts.cancel && o.status === 'requested') {
            const msg = el('p', 'go-msg go-msg--err');
            msg.setAttribute('role', 'alert');
            msg.hidden = true;
            const row = el('div', 'go-cancel-row');
            const ask = btn('cp-btn cp-btn--line go-cancel', '取消這筆訂單', () => {
                ask.hidden = true; sure.hidden = false; keep.hidden = false;
            });
            const sure = btn('cp-btn cp-btn--solid go-cancel-sure', '確定取消', async () => {
                if (sure.disabled) return;
                sure.disabled = true; sure.setAttribute('aria-busy', 'true');
                let r = null;
                try { r = await S.ctx.api.cancel(o.id); } catch (e) { r = null; }
                if (r && r.ok && r.data && r.data.order) { opts.cancel(r.data.order); return; }
                sure.disabled = false; sure.removeAttribute('aria-busy');
                msg.textContent = cancelError(r); msg.hidden = false;
                if (r && r.status === 409) opts.cancel(null);   // it moved on: re-read
            });
            const keep = btn('cp-btn cp-btn--line', '先不取消', () => { ask.hidden = false; sure.hidden = true; keep.hidden = true; });
            sure.hidden = true; keep.hidden = true;
            row.append(ask, sure, keep);
            card.append(row, msg);
        }
        return card;
    }
    function renderReceipt() {
        const o = S.receipt;
        if (!o) return renderOrders();
        const nodes = [head(o.status === 'requested' ? '訂單已送出' : '訂單')];
        nodes.push(orderCard(o, { cancel: next => { if (next) S.receipt = next; renderReceipt(); } }));
        const foot = [btn('cp-btn cp-btn--line', '我的訂單', () => renderOrders()), btn('cp-btn cp-btn--solid go-primary', '完成', () => close())];
        paint('receipt', nodes, foot);
    }
    function renderOrders() {
        const nodes = [head('我的訂單')];
        if (S.orders === null && S.ordersState !== 'loading' && S.ordersState !== 'error') {
            S.ordersState = 'loading';
            S.ctx.api.list().then(r => {
                if (r && r.ok && r.data && Array.isArray(r.data.orders)) { S.orders = r.data.orders; S.ordersState = 'ok'; }
                else { S.ordersState = 'error'; S.ordersErr = errorInfo(r).msg; }
                if (S.step === 'orders') renderOrders();
            }, () => { S.ordersState = 'error'; S.ordersErr = '無法連線，請檢查網路後再試。'; if (S.step === 'orders') renderOrders(); });
        }
        if (S.ordersState === 'loading') nodes.push(el('p', 'go-msg', '載入中…'));
        else if (S.ordersState === 'error') {
            const e = el('p', 'go-msg go-msg--err', S.ordersErr || '暫時無法載入訂單。');
            e.setAttribute('role', 'alert');
            nodes.push(e, btn('cp-btn cp-btn--line', '重新載入', () => { S.ordersState = 'idle'; S.orders = null; renderOrders(); }));
        } else if (!S.orders.length) nodes.push(el('p', 'go-msg', '你還沒有訂單。'));
        else {
            const list = el('div', 'go-orders');
            list.id = 'goOrders';
            for (const o of S.orders) {
                list.append(orderCard(o, { cancel: next => {
                    if (next) { const i = S.orders.findIndex(x => x.id === next.id); if (i >= 0) S.orders[i] = next; }
                    else { S.ordersState = 'idle'; S.orders = null; }
                    renderOrders();
                } }));
            }
            nodes.push(list);
        }
        paint('orders', nodes, [btn('cp-btn cp-btn--solid go-primary', '關閉', () => close())]);
    }

    window.GuestOrder = {
        start, reset, close, orderButton, buildBar, orderable, cleanOrdering, unitPrice, spreadsMax, errorInfo, uuid4, PRIVACY_NOTICE,
        isOpen() { return !!S.layer; },
    };
})();
