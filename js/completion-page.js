// The 完成頁 (docs/delivery.md, client confirmation): what a delivered project shows once the client has
// CONFIRMED it. Same URL (?t=<share token>); js/pick.js decides *when* (delivered mode, finals view,
// confirmed_at set — for the owner and for viewers) and feeds this file; the unconfirmed delivered page
// (the 驗收頁 with the 確認完成 bar) is not touched by anything here.
//
// A light page on purpose (cream, home.html's tokens): everything lives under one root, `.cp`, with its own
// variables in css/completion-page.css. This file only builds the page and never changes the dark client
// theme; while it is mounted <html> carries `cp-on`, which is what hides the dark app chrome.
//
// Top to bottom:
//   1. hero: the first final, the title, the studio, a thank-you and 已確認完成（date）
//   2. the gallery: js/finals-gallery.js mounted into #cpGalleryHost (hero:false, theme:'light') — pick.js
//      feeds it the photos, the cover and the count come back through setCover / setCount
//   3. 下載全部精修 (pick.js does the listing and the zip)
//   4. 商品／加購: GET /api/pick/shop (information only: no cart, no order). Any failure or an empty list and
//      the whole section is simply not in the DOM
//   5. the album preview entry (js/album-preview.js puts it after #cpAlbumAnchor); the first album product's
//      min_pages / max_pages go to AlbumPreview.PLAN_OPTS as minSpreads / maxSpreads (spreads, never cropped),
//      and what the planner says about them comes back as a hint under the entry
//   6. share + contact footer
//
// Every string that came from outside (title, studio, product name / description / option label) only reaches
// the DOM through textContent / setAttribute / property assignment — no innerHTML in this file.
(function () {
    'use strict';

    const IMG_PREFIX = '/api/platform/products/';   // the only place a product image may come from
    const PRODUCTS_MAX = 50;                          // the Worker's own cap
    const OPTIONS_MAX = 20;
    const COVER_MIN_ASPECT = 1.2;                     // landscape enough for the 3:2 hero
    const COVER_CANDIDATES = 12;
    const COVER_PROBE_MS = 3000;

    const el = (tag, cls, txt, id) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (id) e.id = id;
        if (txt != null) e.textContent = txt;
        return e;
    };
    const btn = (id, cls, label) => {
        const b = el('button', cls, label, id);
        b.type = 'button';
        return b;
    };

    // ── pure helpers (also on CompletionPage for the tests) ─────────────────
    // image_url is RELATIVE to the Worker origin and must be a product image path: anything else
    // (another path, an absolute or protocol-relative URL, a ../ escape) is no image at all.
    function productImageUrl(workerUrl, path) {
        if (typeof path !== 'string' || !path.startsWith(IMG_PREFIX)) return null;
        if (/[\\\s\u0000-\u001F\u007F]/.test(path)) return null;
        try {
            const root = new URL(workerUrl);
            const u = new URL(path, root.origin + '/');
            if (u.origin !== root.origin || !u.pathname.startsWith(IMG_PREFIX)) return null;
        } catch (e) { return null; }
        return String(workerUrl).replace(/\/+$/, '') + path;
    }

    // min_pages / max_pages are SPREADS. null -> nothing.
    function rangeText(min, max) {
        if (min != null && max != null) return min === max ? `${min} 跨頁` : `${min}–${max} 跨頁`;
        if (min != null) return `至少 ${min} 跨頁`;
        if (max != null) return `最多 ${max} 跨頁`;
        return null;
    }
    // projects.shoot_date is 'YYYY-MM-DD' (the Worker checks it); anything else shows nothing.
    // Plain string work, no Date: a calendar day has no time zone to shift it.
    function shootDateText(v) {
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
        return `拍攝日期 ${v.replace(/-/g, '.')}`;
    }
    const formatPrice = n => Util.formatPrice(n);   // NT$5,000 (js/util.js, loaded before this file)
    const bound = v => (Number.isSafeInteger(v) && v >= 1 ? v : null);
    // extra_page_price: NT$ per spread above min_pages, a whole number >= 0, albums only
    const extraPrice = v => (Number.isSafeInteger(v) && v >= 0 ? v : null);

    // The Worker's products, kept only as far as they are well-formed: a print / album with a name and at
    // least one option whose price is a whole number >= 0. Nothing else from the row is used.
    function cleanProducts(list, workerUrl) {
        if (!Array.isArray(list)) return [];
        const out = [];
        for (const p of list.slice(0, PRODUCTS_MAX)) {
            if (!p || typeof p !== 'object') continue;
            if (p.kind !== 'print' && p.kind !== 'album') continue;
            if (typeof p.name !== 'string' || !p.name.trim()) continue;
            const options = [];
            for (const o of (Array.isArray(p.options) ? p.options.slice(0, OPTIONS_MAX) : [])) {
                if (!o || typeof o !== 'object' || !Number.isSafeInteger(o.price) || o.price < 0) continue;
                options.push({ label: typeof o.label === 'string' ? o.label : '', price: o.price });
            }
            if (!options.length) continue;
            const album = p.kind === 'album';
            out.push({
                id: typeof p.id === 'string' && p.id.length >= 1 && p.id.length <= 200 ? p.id : null,
                kind: p.kind, name: p.name, description: typeof p.description === 'string' ? p.description : '',
                min: album ? bound(p.min_pages) : null, max: album ? bound(p.max_pages) : null,
                extraPagePrice: album ? extraPrice(p.extra_page_price) : null,
                image: productImageUrl(workerUrl, p.image_url), options,
            });
        }
        return out;
    }

    // https only (the Worker validates it too; this page does not rely on that)
    function bookingLink(url) {
        if (typeof url !== 'string') return null;
        try { const u = new URL(url); return u.protocol === 'https:' ? u.href : null; } catch (e) { return null; }
    }

    // plain Chinese for what POST /api/pick/interest can answer (docs/guest-shop.md)
    function interestError(r) {
        const st = r && r.status, code = r && r.data && r.data.code;
        if (st === 401) return '連結已失效';
        if (st === 404 && code === 'not_found') return '這個商品目前不提供';
        if (st === 403 && code === 'not_owner') return '只有挑選人可以通知攝影師';
        if (st === 409 && code === 'not_confirmed') return '請先確認完成後再試';
        if (st === 409 && code === 'interest_cap') return '已通知多項商品，請直接聯絡攝影師';
        return '暫時無法通知，請稍後再試';
    }

    const CompletionPage = {
        cleanProducts, productImageUrl, rangeText, shootDateText, formatPrice, bookingLink,

        root: null, ctx: null, albumSec: null, coverKey: null,
        _interested: new Set(),   // product ids the owner has told the photographer about, kept until unmount
        _shopTok: 0, _shopDone: false, _planBase: null, _hadPlanBase: false,

        isMounted() { return !!this.root && this.root.isConnected; },
        galleryHost() { return this.root ? this.root.querySelector('#cpGalleryHost') : null; },
        albumAnchor() { return this.root ? this.root.querySelector('#cpAlbumAnchor') : null; },
        // true once the shop has answered (or failed): the album entry waits for it, so the bounds are in
        // AlbumPreview.PLAN_OPTS before the guest can press it
        shopSettled() { return this._shopDone; },

        // cfg = { title, studio: {name, hasLogo, logoUrl, bookingUrl}, confirmedText, workerUrl,
        //         onShare(), onDownloadAll(): Promise, fetchShop(): Promise<{ok, data}>, onShopSettled() }
        mount(cfg) {
            this.ctx = cfg;
            if (this.isMounted()) { this._fillHero(); this._fillFooter(); return; }
            this.unmount();
            this.ctx = cfg;

            const root = el('div', 'cp', null, 'completionPage');
            root.tabIndex = -1;
            const wrap = el('div', 'cp-wrap');

            // 1. hero
            const hero = el('header', 'cp-hero', null, 'cpHero');
            hero.append(el('div', 'cp-cover-frame'));
            const text = el('div', 'cp-hero-text');
            text.append(el('div', 'cp-studio', null, 'cpStudio'), el('h1', 'cp-title', null, 'cpTitle'),
                el('p', 'cp-thanks', '謝謝你的信任，願這些照片陪你把這一天留得久一點。', 'cpThanks'),
                el('p', 'cp-confirmed', null, 'cpConfirmed'), el('p', 'cp-shoot', null, 'cpShootDate'));
            hero.append(text);

            // 2. gallery
            const gal = el('section', 'cp-sec cp-gallery', null, 'cpGallerySec');
            const galHead = el('div', 'cp-sec-head');
            galHead.append(el('h2', 'cp-h2', '精修成品'), el('span', 'cp-count', null, 'cpCount'));
            gal.append(galHead, el('div', 'cp-gallery-host', null, 'cpGalleryHost'));

            // 3. download
            const dl = el('section', 'cp-sec cp-download', null, 'cpDownload');
            const dlBtn = btn('cpDownloadAll', 'cp-btn cp-btn--solid', '下載全部精修');
            dlBtn.addEventListener('click', () => this._downloadAll(dlBtn));
            dl.append(el('h2', 'cp-h2', '帶回家'), el('p', 'cp-sub', '把全部精修照片打包成一個檔案，存進你的手機或電腦。'), dlBtn);

            // 5. album (4., the shop, is inserted before this one if the Worker has products)
            const alb = el('section', 'cp-sec cp-album', null, 'cpAlbum');
            alb.append(el('h2', 'cp-h2', '相本預覽'), el('div', 'cp-album-anchor', null, 'cpAlbumAnchor'));
            this.albumSec = alb;

            // 6. footer
            const foot = el('footer', 'cp-foot', null, 'cpFooter');
            const share = btn('cpShare', 'cp-btn cp-btn--line', '分享這個相簿');
            share.addEventListener('click', () => { if (this.ctx && this.ctx.onShare) this.ctx.onShare(); });
            foot.append(share, el('div', 'cp-foot-studio', null, 'cpFooterStudio'));

            wrap.append(hero, gal, dl, alb, foot);
            root.append(wrap);
            document.body.append(root);
            this.root = root;
            document.documentElement.classList.add('cp-on');
            this._fillHero();
            this._fillFooter();

            // the album preview: bounds come with the shop answer; the hint comes back through onResult
            if (window.AlbumPreview) {
                this._hadPlanBase = true;
                this._planBase = AlbumPreview.PLAN_OPTS;
                AlbumPreview.PLAN_OPTS = { ...(this._planBase || {}), fit: 'contain' };
                AlbumPreview.onResult = hint => this._setHint(hint);
            }
            this._loadShop();
        },

        unmount() {
            this._shopTok++;
            this._shopDone = false;
            this._interested = new Set();
            if (this.root) this.root.remove();
            if (this._hadPlanBase && window.AlbumPreview) {
                AlbumPreview.PLAN_OPTS = this._planBase || {};
                AlbumPreview.onResult = null;
            }
            this._hadPlanBase = false; this._planBase = null;
            this.root = this.albumSec = null; this.coverKey = null;
            document.documentElement.classList.remove('cp-on');
            this.ctx = null;
        },

        // ── hero and footer ────────────────────────────────────────────
        _fillHero() {
            const c = this.ctx || {}, r = this.root;
            r.querySelector('#cpTitle').textContent = c.title || '精修成品';
            r.querySelector('#cpConfirmed').textContent = c.confirmedText || '';
            const shoot = shootDateText(c.shootDate);
            const sd = r.querySelector('#cpShootDate');
            sd.textContent = shoot || '';
            sd.hidden = !shoot;
            const box = r.querySelector('#cpStudio');
            box.replaceChildren();
            const s = c.studio;
            if (s && s.hasLogo && s.logoUrl) {
                const img = el('img', 'cp-studio-logo');
                img.alt = '';
                img.src = s.logoUrl;
                img.addEventListener('error', () => img.remove());
                box.append(img);
            }
            if (s && s.name) box.append(el('span', 'cp-studio-name', s.name));
            box.hidden = !box.childNodes.length;
        },

        _fillFooter() {
            const c = this.ctx || {}, s = c.studio || {};
            const box = this.root.querySelector('#cpFooterStudio');
            box.replaceChildren();
            if (s.name) box.append(el('span', 'cp-foot-name', s.name));
            const href = bookingLink(s.bookingUrl);
            if (href) {
                const a = el('a', 'cp-link', '聯絡攝影師', 'cpFooterLink');
                a.href = href; a.target = '_blank'; a.rel = 'noopener';
                box.append(a);
            }
            box.hidden = !box.childNodes.length;
        },

        // The cover: the first LANDSCAPE final (width/height >= COVER_MIN_ASPECT) among the first COVER_CANDIDATES,
        // else the first final. Candidates are probed in parallel as 400px thumbnails (the bucket the grid already
        // uses, so no new size is requested); the choice is made in list order, so it never depends on which
        // probe answered first. A probe that errors or takes longer than COVER_PROBE_MS is skipped.
        // The cover is chosen once per mount (coverKey), like before.
        setCover(photo, drive, candidates) {
            if (!this.root || this.coverKey || !photo || !drive) return;
            this.coverKey = photo.id;
            const frame = this.root.querySelector('.cp-cover-frame');
            const list = (Array.isArray(candidates) && candidates.length ? candidates : [photo])
                .filter(p => p && p.id).slice(0, COVER_CANDIDATES);
            const show = chosen => {
                if (!this.root || !this.root.contains(frame)) return;
                const w = frame.getBoundingClientRect().width || window.innerWidth;
                const img = el('img', 'cp-cover', null, 'cpCover');
                img.alt = '';
                img.decoding = 'async';
                img.fetchPriority = 'high';
                img.dataset.photoId = chosen.id;
                img.addEventListener('load', () => img.classList.add('on'));
                img.addEventListener('error', () => img.remove());
                img.src = drive.getImageUrl(chosen, drive.previewWidth(w, window.devicePixelRatio || 1));
                frame.replaceChildren(img);
            };
            if (list.length < 2) { show(photo); return; }
            const probes = list.map(p => new Promise(res => {
                const im = new Image();
                let done = false;
                const fin = v => { if (done) return; done = true; clearTimeout(t); im.onload = im.onerror = null; res(v); };
                const t = setTimeout(() => fin(0), COVER_PROBE_MS);
                im.onload = () => fin(im.naturalHeight > 0 ? im.naturalWidth / im.naturalHeight : 0);
                im.onerror = () => fin(0);
                im.src = drive.getImageUrl(p, 400);
            }));
            (async () => {
                let chosen = photo;
                for (let i = 0; i < probes.length; i++) {
                    if ((await probes[i]) >= COVER_MIN_ASPECT) { chosen = list[i]; break; }
                }
                show(chosen);
            })();
        },

        setCount(n) {
            const e = this.root && this.root.querySelector('#cpCount');
            if (e) e.textContent = n > 0 ? `${n} 張照片` : '';
        },

        // ── 下載全部精修 ───────────────────────────────────────────────
        async _downloadAll(button) {
            if (button.disabled || !this.ctx || !this.ctx.onDownloadAll) return;
            const label = button.textContent;
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            button.textContent = '準備中…';
            try { await this.ctx.onDownloadAll(); }
            catch (e) { /* the callback says what went wrong (a toast); the button must come back */ }
            finally {
                button.disabled = false;
                button.removeAttribute('aria-busy');
                button.textContent = label;
            }
        },

        // ── 商品／加購 ─────────────────────────────────────────────────
        _loadShop() {
            const tok = ++this._shopTok;
            this._shopDone = false;
            const cfg = this.ctx;
            const settle = r => {
                if (tok !== this._shopTok || !this.isMounted()) return;
                const workerUrl = cfg.workerUrl;
                const products = r && r.ok && r.data ? cleanProducts(r.data.products, workerUrl) : [];
                if (products.length) {
                    this._applyBounds(products.find(p => p.kind === 'album') || null);
                    this.albumSec.before(this._buildShop(products));
                }
                this._shopDone = true;
                if (cfg.onShopSettled) cfg.onShopSettled();
            };
            let p;
            try { p = Promise.resolve(cfg.fetchShop ? cfg.fetchShop() : null); } catch (e) { p = Promise.resolve(null); }
            p.then(settle, () => settle(null));
        },

        // the first album product's page range -> the planner (spreads), only the bounds that are set
        _applyBounds(album) {
            if (!window.AlbumPreview) return;
            const opts = { ...(this._planBase || {}), fit: 'contain' };
            if (album && album.min != null) opts.minSpreads = album.min;
            if (album && album.max != null) opts.maxSpreads = album.max;
            AlbumPreview.PLAN_OPTS = opts;
        },

        _buildShop(products) {
            const sec = el('section', 'cp-sec cp-shop', null, 'cpShop');
            sec.append(el('h2', 'cp-h2', '把這段回憶留下來'), el('p', 'cp-sub', '有些照片，值得變成真正的作品。'));
            const list = el('ul', 'cp-products');
            const owner = !!(this.ctx && this.ctx.isOwner && this.ctx.onInterest);
            for (const p of products) {
                const li = el('li', `cp-product cp-product--${p.kind}`);
                if (p.image) {
                    const frame = el('div', 'cp-product-img');
                    const img = el('img');
                    img.alt = '';
                    img.decoding = 'async';
                    img.addEventListener('error', () => frame.remove());
                    img.src = p.image;
                    frame.append(img);
                    li.append(frame);
                }
                const body = el('div', 'cp-product-body');
                body.append(el('h3', 'cp-product-name', p.name));
                const range = rangeText(p.min, p.max);
                if (range) body.append(el('p', 'cp-product-range', range));
                if (p.extraPagePrice !== null) {
                    // the option price covers the book up to `min` spreads; each spread above costs this
                    const parts = [`加頁 ${formatPrice(p.extraPagePrice)}／頁`];
                    if (p.min !== null) parts.push(`含 ${p.min} 頁`);
                    body.append(el('p', 'cp-product-extra', parts.join(' · ')));
                }
                if (p.description) body.append(el('p', 'cp-product-desc', p.description));
                const opts = el('ul', 'cp-options');
                for (const o of p.options) {
                    const row = el('li', 'cp-option');
                    if (o.label) row.append(el('span', 'cp-option-label', o.label));
                    row.append(el('span', 'cp-option-price', formatPrice(o.price)));
                    opts.append(row);
                }
                body.append(opts);
                // 「我有興趣」: the seat owner only (a viewer has no key and the Worker would answer 403)
                if (owner && p.id) body.append(this._buildInterest(p));
                li.append(body);
                list.append(li);
            }
            sec.append(list);
            // one call to action, information only: a link to the studio, or a plain line
            const cta = el('div', 'cp-cta', null, 'cpShopCta');
            const href = bookingLink(this.ctx && this.ctx.studio && this.ctx.studio.bookingUrl);
            if (href) {
                const a = el('a', 'cp-btn cp-btn--solid', '聯絡攝影師訂購', 'cpShopLink');
                a.href = href; a.target = '_blank'; a.rel = 'noopener';
                cta.append(a);
            } else {
                cta.append(el('p', 'cp-cta-plain', '想訂購請直接聯絡攝影師', 'cpShopNoLink'));
            }
            sec.append(cta);
            return sec;
        },

        // 「我有興趣」: one call to cfg.onInterest(product_id) -> {ok, status, data}. Disabled while in flight;
        // 200 (already or not) -> a disabled 「已通知攝影師」 for the rest of the mount; any error leaves it usable.
        _buildInterest(p) {
            const wrap = el('div', 'cp-interest');
            const btn = el('button', 'cp-btn cp-btn--line cp-interest-btn', '我有興趣');
            btn.type = 'button';
            btn.dataset.productId = p.id;
            const msg = el('p', 'cp-interest-msg');
            msg.setAttribute('role', 'status');
            const done = () => { btn.textContent = '已通知攝影師'; btn.disabled = true; btn.removeAttribute('aria-busy'); msg.textContent = ''; };
            if (this._interested.has(p.id)) done();
            btn.addEventListener('click', async () => {
                if (btn.disabled) return;
                btn.disabled = true;
                btn.setAttribute('aria-busy', 'true');
                msg.textContent = '';
                let r = null;
                try { r = await this.ctx.onInterest(p.id); } catch (e) { r = null; }
                if (r && r.ok) { this._interested.add(p.id); done(); return; }
                btn.disabled = false;
                btn.removeAttribute('aria-busy');
                msg.textContent = interestError(r);
            });
            wrap.append(btn, msg);
            return wrap;
        },

        // ── the album hint, under the entry ────────────────────────────
        _setHint(hint) {
            if (!this.albumSec) return;
            this.albumSec.querySelector('#cpAlbumHint')?.remove();
            if (!hint) return;
            const p = el('p', 'cp-hint', hint, 'cpAlbumHint');
            p.setAttribute('role', 'status');
            this.albumSec.append(p);
        },
    };

    window.CompletionPage = CompletionPage;
})();
