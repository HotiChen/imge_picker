// Retouch-pin helpers shared by the guest pages (docs/guest-picking.md, docs/revision-pins.md §7.1).
//
// Two things live here:
//   - the pin data rules that used to be spread over annotation.js and pick.js: the one shape guard
//     (`clean`), the note rules the Worker enforces (`sanitize`, `len`, the limits), and
//   - a DOM overlay (`attach`) that draws numbered pins over an <img> shown with object-fit: contain —
//     the finals lightbox and the round history. The picking stage keeps drawing its pins on the
//     annotation canvas (it follows zoom and pan); only the data rules are shared with it.
//
// Pins are `{x, y, note}`, x/y as 0–1 fractions of the PHOTO (not of the box it is shown in). Every
// string that came from outside reaches the DOM through textContent / setAttribute only.
(function () {
    'use strict';

    const PIN_MAX = 10;          // per photo (server PICK_MARKS_MAX)
    const NOTE_MAX = 100;        // characters (server PICK_MARK_NOTE_MAX)
    // control / line-separator characters the server refuses in a note
    const NOTE_BAD = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

    const sanitize = v => String(v == null ? '' : v).replace(NOTE_BAD, '');
    const len = v => Array.from(String(v)).length;
    const round4 = n => Math.round(n * 10000) / 10000;

    // finite x,y in [0,1] and a string note; `max` caps the list where a UI needs it
    const clean = (arr, max = Infinity) => (Array.isArray(arr) ? arr : []).slice(0, max)
        .filter(m => m && Number.isFinite(m.x) && Number.isFinite(m.y) && m.x >= 0 && m.x <= 1 && m.y >= 0 && m.y <= 1)
        .map(m => ({ x: m.x, y: m.y, note: typeof m.note === 'string' ? m.note : '' }));

    // The rectangle (viewport coordinates) the PHOTO covers inside an <img> shown with
    // object-fit: contain — the box minus the bars. Anything else (fill, a photo that has not
    // loaded) is the box itself.
    function contentRect(img) {
        const box = img.getBoundingClientRect();
        const nw = img.naturalWidth, nh = img.naturalHeight;
        let fit = 'fill';
        try { fit = getComputedStyle(img).objectFit || 'fill'; } catch (e) { /* box */ }
        if (!(nw > 0 && nh > 0) || !(box.width > 0 && box.height > 0) || (fit !== 'contain' && fit !== 'scale-down')) return box;
        const s = Math.min(box.width / nw, box.height / nh);
        const w = nw * s, h = nh * s;
        const left = box.left + (box.width - w) / 2, top = box.top + (box.height - h) / 2;
        return { left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top };
    }

    // a point (viewport coordinates) -> {x, y} fractions of the photo, null in the bars / outside it
    function toFraction(rect, clientX, clientY) {
        if (!rect || !(rect.width > 0 && rect.height > 0)) return null;
        if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
        return { x: round4((clientX - rect.left) / rect.width), y: round4((clientY - rect.top) / rect.height) };
    }

    // Draw pins over `img` inside `host` (a positioned element that contains the img).
    // opts: { readOnly, max, onAdd(x, y), onSelect(i) }. Returns { set(marks), select(i), setReadOnly(b), refresh(), destroy() }.
    function attach(host, img, opts) {
        const o = Object.assign({ readOnly: false, max: PIN_MAX }, opts || {});
        const layer = document.createElement('div');
        layer.className = 'pin-layer';
        host.appendChild(layer);
        let marks = [];
        let selected = -1;
        let readOnly = !!o.readOnly;
        let ro = null;
        const dots = [];

        const paint = () => {
            const hostBox = host.getBoundingClientRect();
            const r = contentRect(img);
            marks.forEach((m, i) => {
                const d = dots[i];
                if (!d) return;
                d.style.left = `${r.left - hostBox.left + m.x * r.width}px`;
                d.style.top = `${r.top - hostBox.top + m.y * r.height}px`;
            });
        };
        const build = () => {
            dots.splice(0).forEach(d => d.remove());
            marks.forEach((m, i) => {
                const d = document.createElement('button');
                d.type = 'button';
                d.className = 'pin-layer-pin';
                d.textContent = String(i + 1);
                d.setAttribute('aria-label', `標示 ${i + 1}${m.note ? `：${m.note}` : ''}`);
                if (i === selected) d.classList.add('on');
                d.addEventListener('click', e => {
                    e.stopPropagation();
                    if (o.onSelect) o.onSelect(i);
                });
                layer.appendChild(d);
                dots.push(d);
            });
            paint();
        };
        const sync = () => {
            layer.classList.toggle('pin-layer--edit', !readOnly);
            layer.dataset.readonly = readOnly ? 'true' : 'false';
        };
        layer.addEventListener('click', e => {
            if (readOnly || !o.onAdd) return;
            const p = toFraction(contentRect(img), e.clientX, e.clientY);
            if (!p) return;                                  // a tap in the black bars is not on the photo
            if (marks.length >= o.max) { if (o.onFull) o.onFull(); return; }
            o.onAdd(p.x, p.y);
        });
        const onLoad = () => paint();
        img.addEventListener('load', onLoad);
        if (typeof ResizeObserver === 'function') {
            ro = new ResizeObserver(() => paint());
            ro.observe(host);
            ro.observe(img);
        } else {
            window.addEventListener('resize', onLoad);
        }
        sync();

        return {
            layer,
            set(next) { marks = clean(next, o.max); if (selected >= marks.length) selected = -1; build(); },
            select(i) {
                selected = i;
                dots.forEach((d, k) => d.classList.toggle('on', k === i));
            },
            setReadOnly(b) { readOnly = !!b; sync(); },
            refresh: paint,
            destroy() {
                img.removeEventListener('load', onLoad);
                if (ro) ro.disconnect(); else window.removeEventListener('resize', onLoad);
                layer.remove();
            },
        };
    }

    window.PinLayer = { PIN_MAX, NOTE_MAX, clean, sanitize, len, contentRect, toFraction, attach };
})();
