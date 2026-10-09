// The photographer's view of the revision rounds (docs/revision-pins.md 4.6, 6.2, 13.1).
//
// Shared by admin.html (project detail, 交件 block) and js/project-view.js (index.html?project=<id>).
// Takes one GET /api/admin/projects/:id `revision_requests` row and builds its card:
//   第 k 輪 · 標示 · N 張 · time · client · 未處理 / 已處理, the client's note (or "no note"),
// and for a pins round a foldable list of the photos with read-only pins (js/pin-layer.js) and the
// numbered notes; clicking a photo opens a 1200px look. A text round (docs/delivery.md) is just its text.
//
// Photos are read with the admin credential in an Authorization header (fetch -> blob), so no token
// ever rides in a URL. Every string that came from a guest reaches the DOM through textContent only,
// with dir="auto" (+ unicode-bidi: isolate in css/revision-rounds-view.css) against bidi characters.
(function () {
    'use strict';

    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';
    const KIND = { pins: '標示', text: '文字', selection: '選片' };
    const AUTO_NOTE = '客人未留言，請見照片標示';
    const circled = n => CIRCLED[n - 1] || `(${n})`;
    const fileName = key => String(key).slice(String(key).lastIndexOf('/') + 1);
    const keyUrl = key => String(key).split('/').map(encodeURIComponent).join('/');

    const kindOf = r => (r && (r.kind === 'pins' || r.kind === 'selection') ? r.kind : 'text');

    // [{key, name, pins}] of a pins round, in key (code point) order; pins as PinLayer.clean keeps them
    function photosOf(round) {
        const marks = round && round.marks && typeof round.marks === 'object' && !Array.isArray(round.marks) ? round.marks : {};
        const clean = window.PinLayer ? window.PinLayer.clean : (a => (Array.isArray(a) ? a : []));
        return Object.keys(marks).sort(cmp).map(key => ({ key, name: fileName(key), pins: clean(marks[key]) }));
    }

    // ── blobs: every one made here is revoked once its element has left the page ───────────────
    const blobs = [];
    function sweep() {
        for (let i = blobs.length - 1; i >= 0; i--) {
            if (blobs[i].el.isConnected) continue;
            try { URL.revokeObjectURL(blobs[i].url); } catch (e) { /* gone already */ }
            blobs.splice(i, 1);
        }
    }

    // Thumbnails are small and admin.html re-renders its detail after every action: their requests
    // (the promise, so two renders at once share one read) are kept for the page's life, newest 300.
    const thumbCache = new Map();
    const THUMB_CACHE_MAX = 300;
    async function readBlob(ctx, key, w) {
        const res = await fetch(`${ctx.workerUrl}/${keyUrl(key)}?w=${w}`, { headers: { Authorization: `Bearer ${ctx.token()}` } });
        if (!res.ok) throw new Error(String(res.status));
        return res.blob();
    }
    function fetchBlob(ctx, key, w) {
        if (w !== 400) return readBlob(ctx, key, w);
        const id = `${ctx.workerUrl}|${key}`;
        if (!thumbCache.has(id)) {
            const p = readBlob(ctx, key, w);
            p.catch(() => thumbCache.delete(id));          // a failed read is tried again next time
            thumbCache.set(id, p);
            if (thumbCache.size > THUMB_CACHE_MAX) thumbCache.delete(thumbCache.keys().next().value);
        }
        return thumbCache.get(id);
    }

    async function loadBlobInto(img, ctx, key, w) {
        const url = URL.createObjectURL(await fetchBlob(ctx, key, w));
        blobs.push({ el: img, url });
        img.src = url;
    }

    const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    };
    const guestText = (cls, text) => {
        const e = el('span', `${cls || ''} rrv-text`.trim(), text);
        e.setAttribute('dir', 'auto');
        return e;
    };

    // the numbered notes of one photo: ① 痘痘 ② (no note)
    function pinList(pins) {
        const ol = el('ol', 'rrv-pins');
        pins.forEach((p, i) => {
            const li = el('li');
            li.append(el('span', 'rrv-num', circled(i + 1)), guestText('', p.note || ''));
            ol.appendChild(li);
        });
        return ol;
    }

    // ── the 1200 look at one photo ─────────────────────────────────────────────────────────────
    let modalCleanup = null;
    function closeModal() { if (modalCleanup) modalCleanup(); }
    function openModal(photo, ctx, opener) {
        closeModal();
        const root = el('div', 'rrv-modal');
        root.id = 'rrvModal';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-label', `修改標示：${photo.name}`);
        const box = el('div', 'rrv-modal-box');
        const close = el('button', 'rrv-modal-close', '關閉');
        close.type = 'button';
        const head = el('div', 'rrv-modal-head');
        head.append(guestText('rrv-name', photo.name), close);
        const frame = el('div', 'rrv-frame rrv-frame-big');
        const img = el('img');
        img.id = 'rrvModalImg';
        img.alt = photo.name;
        frame.appendChild(img);
        const layer = window.PinLayer.attach(frame, img, { readOnly: true });
        layer.set(photo.pins);
        box.append(head, frame, pinList(photo.pins));
        root.appendChild(box);
        document.body.appendChild(root);
        const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); closeModal(); } };
        document.addEventListener('keydown', onKey, true);
        root.addEventListener('click', e => { if (e.target === root) closeModal(); });
        close.addEventListener('click', closeModal);
        loadBlobInto(img, ctx, photo.key, 1200).catch(() => {
            frame.appendChild(el('div', 'rrv-fail', '無法載入照片'));
        });
        close.focus();
        modalCleanup = () => {
            modalCleanup = null;
            document.removeEventListener('keydown', onKey, true);
            layer.destroy();
            root.remove();
            sweep();
            if (opener && opener.isConnected) opener.focus();
        };
    }

    // ── one photo row: thumbnail with pins, name, numbered notes ───────────────────────────────
    function photoRow(photo, ctx) {
        const row = el('div', 'rrv-photo');
        const thumb = el('div', 'rrv-thumb rrv-frame');
        thumb.setAttribute('role', 'button');
        thumb.tabIndex = 0;
        thumb.setAttribute('aria-label', `放大看 ${photo.name} 的標示`);
        const img = el('img');
        img.alt = photo.name;
        img.decoding = 'async';
        thumb.appendChild(img);
        const layer = window.PinLayer.attach(thumb, img, { readOnly: true });
        layer.set(photo.pins);
        // the pins are plain markers here: the whole thumbnail is the one control
        thumb.querySelectorAll('.pin-layer-pin').forEach(b => { b.tabIndex = -1; b.setAttribute('aria-hidden', 'true'); });
        loadBlobInto(img, ctx, photo.key, 400).catch(() => {
            thumb.appendChild(el('div', 'rrv-fail', '無法載入'));
        });
        const open = () => openModal(photo, ctx, thumb);
        thumb.addEventListener('click', open);
        thumb.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
        const side = el('div', 'rrv-side');
        side.append(guestText('rrv-name', photo.name), pinList(photo.pins));
        row.append(thumb, side);
        return row;
    }

    // the foldable photo block of a pins round; photos are only read once it is unfolded
    function photosBlock(round, ctx) {
        const photos = photosOf(round);
        const d = el('details', 'rrv-photos');
        d.appendChild(el('summary', null, `照片與標示（${photos.length} 張）`));
        const body = el('div', 'rrv-photo-list');
        d.appendChild(body);
        let loaded = false;
        const fill = () => {
            if (loaded || !d.open) return;
            loaded = true;
            sweep();
            photos.forEach(p => body.appendChild(photoRow(p, ctx)));
        };
        d.addEventListener('toggle', fill);
        if (!round.resolved_at) d.open = true;
        fill();
        return d;
    }

    // One round's card. `k` = its number (oldest = 1). ctx: {workerUrl, token(), onCsv(round, k)?}.
    // Keeps admin.html's .pd-rev / .resolved / .pd-rev-meta / .pd-rev-msg / .pd-rev-done classes.
    function renderRound(round, k, ctx) {
        const kind = kindOf(round);
        const item = el('div', 'pd-rev rrv-card' + (round.resolved_at ? ' resolved' : ''));
        item.dataset.roundId = round.id == null ? '' : String(round.id);
        item.dataset.kind = kind;
        const meta = el('div', 'pd-rev-meta');
        const bits = [`第 ${k} 輪`, KIND[kind]];
        if (kind === 'pins') bits.push(`${Number(round.photo_count) || photosOf(round).length} 張`);
        const when = ctx.fmtTime ? ctx.fmtTime(round.created_at) : String(round.created_at || '');
        bits.push(when);
        meta.append(`${bits.join(' · ')} · `);
        const who = guestText('rrv-who', round.picker_name || '（客人）');
        meta.append(who);
        if (round.resolved_at) meta.append(el('span', 'pd-rev-done', '已處理'));
        else meta.append(el('span', 'rrv-open', '未處理'));
        const msg = el('div', 'pd-rev-msg');
        if (kind === 'pins' && round.message_auto) {
            msg.classList.add('rrv-auto');
            msg.textContent = AUTO_NOTE;
        } else {
            msg.textContent = round.message == null ? '' : String(round.message);
            msg.setAttribute('dir', 'auto');
        }
        item.append(meta, msg);
        if (kind === 'pins') {
            item.appendChild(photosBlock(round, ctx));
            if (ctx.onCsv) {
                const csv = el('button', 'btn btn-outline rrv-csv', '下載此輪需求表 (CSV)');
                csv.type = 'button';
                csv.addEventListener('click', () => ctx.onCsv(round, k));
                item.appendChild(csv);
            }
        }
        return item;
    }

    window.RevisionRoundsView = { renderRound, photosOf, kindOf, closeModal, AUTO_NOTE };
})();
