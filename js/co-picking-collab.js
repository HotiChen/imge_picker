// Co-picking, the JOIN and COLLABORATOR side of the guest pick page (docs/co-picking.md, batch 3).
//   POST /api/pick/join {code, name}   -> {picker_key, ...}: a visitor with an 8-digit code becomes a collaborator
//   POST /api/pick/renewal             -> an expired collaborator asks the owner to continue
// js/pick.js calls CoPickingCollab.sync(PickController) after every state read. One banner (#coCollabBanner, under
// #pickBanner) says who you are: a viewer gets 我有邀請碼, a collaborator 你是協作者，到期 …, an expired one 協作已到期
// (+ 我要繼續 / waiting / the owner's cooldown), a removed one a plain read-only line. The edit rules themselves
// (hearts, notes, pins, no submit) are PickController's: it asks isCollab. Every text that came from a person
// reaches the DOM through textContent only; the toast renderer is innerHTML, so it gets static strings only.
(function () {
    'use strict';

    const POLL_MS = 30000;
    const OPEN_PHASES = ['picking', 'submitted'];
    const JOIN_ERR = {
        invalid_code: '邀請碼不正確或已失效',
        too_many_attempts: '嘗試次數過多，請稍後再試',
        owner_missing: '這個連結目前沒有挑選人，無法加入',
        retouching: '攝影師已開始修圖，現在不能加入',
        invalid_name: '請輸入 1–50 字的名字',
        invalid_body: '送出失敗，請再試一次',
        co_picking_unavailable: '協作功能尚未啟用，請稍後再試',
    };

    let ctrl = null;
    let sheet = null;
    let pollTimer = null;
    let visWired = false;
    let polling = false;
    let renewing = false;
    let renewErr = '';
    let joining = false;

    const el = (tag, cls, txt) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (txt != null) e.textContent = txt;
        return e;
    };
    const btn = (id, label, onClick, cls) => {
        const b = el('button', cls || 'co-btn', label);
        b.type = 'button';
        if (id) b.id = id;
        b.addEventListener('click', onClick);
        return b;
    };
    const fmt = v => (window.Util ? Util.fmtDate(v, 'mdhm') : '');
    const toastOk = msg => { if (typeof toast !== 'undefined') toast.success(msg); };

    // "1234-5678", "1234 5678", full-width digits and spaces -> exactly 8 ASCII digits, else ''
    function normalizeCode(raw) {
        const s = String(raw == null ? '' : raw)
            .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 48))
            .replace(/[\s　\-‐-―−－]/g, '');
        return /^[0-9]{8}$/.test(s) ? s : '';
    }

    // ── what the state says this person is ───────────────────────────────
    function modeOf(c) {
        const st = c && c.coState;
        if (!c || !c.active || !st || c.mode !== 'picking' || c.isOwner) return null;
        if (c.isCollab) return 'collab';
        if (st.myStatus === 'expired') return 'expired';
        if (st.myStatus === 'removed') return 'removed';
        if (c.ownerName != null && OPEN_PHASES.includes(c.phase) && !st.myStatus) return 'join';
        return null;
    }
    const declinedUntilMs = st => {
        const t = st && st.declinedUntil ? Date.parse(st.declinedUntil) : NaN;
        return Number.isFinite(t) && t > Date.now() ? t : null;
    };

    // ── banner ───────────────────────────────────────────────────────────
    function ensureBanner() {
        let b = document.getElementById('coCollabBanner');
        if (b) return b;
        const anchor = document.getElementById('pickBanner');
        if (!anchor || !anchor.parentNode) return null;
        b = el('div', 'pick-banner co-collab-banner');
        b.id = 'coCollabBanner';
        b.setAttribute('role', 'status');
        anchor.after(b);
        return b;
    }
    function removeBanner() {
        const b = document.getElementById('coCollabBanner');
        if (b) b.remove();
    }

    // A phone's active collaborator gets a compact chip in the header row of the studio name (css hides it above 600px, and
    // hides the full banner row below it): 協作者 · 到期 10/18. The full sentence stays in the title / aria-label.
    // Only for the active state; every actionable state keeps its banner.
    function syncChip(mode, st, full) {
        let chip = document.getElementById('coCollabChip');
        if (mode !== 'collab') { if (chip) chip.remove(); return; }
        if (!chip) {
            const host = document.querySelector('.header-left');
            if (!host) return;
            chip = el('span', 'co-collab-chip');
            chip.id = 'coCollabChip';
            const name = host.querySelector('.logo-name');
            if (name) name.after(chip); else host.append(chip);
        }
        const day = st.expiresAt && window.Util ? Util.fmtDate(st.expiresAt, 'md') : '';
        chip.textContent = st.expiresAt ? `協作者 · 到期 ${day}` : '協作者 · 到期不限';
        chip.title = full;
        chip.setAttribute('aria-label', full);
    }

    function render() {
        const mode = modeOf(ctrl);
        const st = ctrl && ctrl.coState;
        if (!mode) { removeBanner(); syncChip(null); closeSheet(); stopPoll(); return; }
        const b = ensureBanner();
        if (!b) return;
        b.replaceChildren();
        b.dataset.mode = mode;
        if (mode !== 'collab') syncChip(null);
        const line = txt => b.append(el('span', 'pick-banner-line', txt));
        if (mode === 'join') {
            line('受邀一起選片？');
            b.append(btn('coJoinOpen', '我有邀請碼', openSheet));
        } else {
            closeSheet();
            if (mode === 'collab') {
                const full = st.expiresAt ? `你是協作者，到期 ${fmt(st.expiresAt)}` : '你是協作者，到期 不限';
                line(full);
                syncChip(mode, st, full);
            } else if (mode === 'removed') {
                line('你已不是協作者，目前只能瀏覽');
            } else {
                const until = declinedUntilMs(st);
                if (st.renewalRequested) {
                    line('協作已到期，已通知主人，等待核准');
                } else if (until) {
                    line(`協作已到期。主人暫未同意，${fmt(new Date(until).toISOString())} 之後可再申請`);
                } else if (st.canRenew) {
                    line('協作已到期，目前只能瀏覽');
                    const r = btn('coRenewBtn', '我要繼續', renew);
                    r.disabled = renewing;
                    b.append(r);
                } else {
                    line('協作已到期，目前只能瀏覽');
                }
                if (renewErr) {
                    const e = el('span', 'co-collab-err', renewErr);
                    e.setAttribute('role', 'alert');
                    b.append(e);
                }
            }
        }
        if (mode === 'expired' && st.renewalRequested && !declinedUntilMs(st)) startPoll(); else stopPoll();
    }

    // ── renewal ──────────────────────────────────────────────────────────
    async function renew() {
        if (renewing || !ctrl) return;
        renewing = true;
        renewErr = '';
        render();
        const res = await ctrl._json('/api/pick/renewal', {
            method: 'POST',
            headers: ctrl.headers({ 'Content-Type': 'application/json' }),
            body: '{}',
        });
        renewing = false;
        const code = res.data && res.data.code;
        if (res.ok) {
            ctrl.coState.renewalRequested = true;
            ctrl.coState.canRenew = false;
            render();
            ctrl.reloadState();
        } else if (res.status === 409 && code === 'renewal_declined') {
            ctrl.coState.canRenew = false;
            ctrl.coState.declinedUntil = typeof res.data.until === 'string' ? res.data.until : new Date(Date.now() + 86400000).toISOString();
            render();
        } else if (res.status === 0) {
            renewErr = '無法連線，請檢查網路';
            render();
        } else {
            // 403 renewal_not_allowed and the rest: the state decides what is true now
            renewErr = '目前不能申請，請稍後再試';
            const r = await ctrl.reloadState();
            if (!r.ok) render();
        }
    }

    // ── the poll: only an expired person awaiting the owner's answer ─────
    function pollNow() {
        if (polling || !ctrl) return;
        polling = true;
        Promise.resolve(ctrl.reloadState()).catch(() => {}).finally(() => { polling = false; });
    }
    function onVisibility() { if (document.visibilityState === 'visible' && pollTimer) pollNow(); }
    function startPoll() {
        if (pollTimer) return;
        const ms = Number(window.CO_PICKING_POLL_MS) > 0 ? Number(window.CO_PICKING_POLL_MS) : POLL_MS;
        pollTimer = setInterval(() => { if (document.visibilityState === 'visible') pollNow(); }, ms);
        if (!visWired) { visWired = true; document.addEventListener('visibilitychange', onVisibility); }
    }
    function stopPoll() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    // ── the join sheet ───────────────────────────────────────────────────
    function buildSheet() {
        if (sheet) return sheet;
        const root = el('div');
        root.id = 'coJoinSheet';
        root.hidden = true;
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-labelledby', 'coJoinTitle');
        const backdrop = el('div', 'co-backdrop');
        backdrop.addEventListener('click', closeSheet);
        const card = el('div', 'co-join-card');
        const head = el('div', 'co-join-head');
        const title = el('h2', 'co-join-title', '輸入邀請碼');
        title.id = 'coJoinTitle';
        const close = el('button', 'co-close', '×');
        close.type = 'button';
        close.setAttribute('aria-label', '關閉');
        close.addEventListener('click', closeSheet);
        head.append(title, close);
        const hint = el('p', 'co-join-hint', '向選片的人要 8 位數邀請碼，再填上你的名字，就能一起挑照片。');
        const codeL = el('label', 'co-join-label', '邀請碼');
        codeL.htmlFor = 'coJoinCode';
        const code = el('input', 'input');
        code.id = 'coJoinCode';
        code.type = 'text';
        code.inputMode = 'numeric';
        code.autocomplete = 'one-time-code';
        code.maxLength = 24;
        code.placeholder = '1234 5678';
        const nameL = el('label', 'co-join-label', '你的名字');
        nameL.htmlFor = 'coJoinName';
        const name = el('input', 'input');
        name.id = 'coJoinName';
        name.type = 'text';
        name.maxLength = 50;
        name.autocomplete = 'name';
        name.placeholder = '請輸入您的姓名';
        const err = el('p', 'co-join-err');
        err.id = 'coJoinErr';
        err.setAttribute('role', 'alert');
        const go = btn('coJoinGo', '加入', submit, 'co-btn co-btn--primary');
        for (const i of [code, name]) i.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
        card.append(head, hint, codeL, code, nameL, name, err, go);
        root.append(backdrop, card);
        root.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
        document.body.append(root);
        sheet = root;
        return root;
    }
    function openSheet() {
        const s = buildSheet();
        s.hidden = false;
        const e = document.getElementById('coJoinErr');
        if (e) e.textContent = '';
        // at once, not after a delay: a late focus() would pull the cursor out of the field someone is already typing in
        const c = document.getElementById('coJoinCode');
        if (c) c.focus();
    }
    function closeSheet() {
        if (sheet) sheet.hidden = true;
    }
    const setErr = t => { const e = document.getElementById('coJoinErr'); if (e) e.textContent = t; };

    async function submit() {
        if (joining || !ctrl) return;
        setErr('');
        const code = normalizeCode(document.getElementById('coJoinCode').value);
        const name = (document.getElementById('coJoinName').value || '').trim();
        if (!code) { setErr('請輸入 8 位數的邀請碼'); return; }
        if (!name) { setErr('請輸入姓名'); return; }
        joining = true;
        const go = document.getElementById('coJoinGo');
        if (go) go.disabled = true;
        const res = await ctrl._json('/api/pick/join', {
            method: 'POST',
            headers: ctrl.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ code, name }),
        });
        joining = false;
        if (go) go.disabled = false;
        if (res.ok && res.data && typeof res.data.picker_key === 'string' && res.data.picker_key) {
            ctrl.setKey(res.data.picker_key);
            closeSheet();
            const r = await ctrl.reloadState();
            if (!r.ok) { window.location.reload(); return; }
            toastOk('已加入，你現在是協作者');
            return;
        }
        if (res.status === 0) { setErr('無法連線，請檢查網路'); return; }
        if (res.status === 401) { setErr('連結已失效，請向攝影師索取新的連結'); return; }
        // never the server's own words: one sentence per code, and a wrong code never says which part was wrong
        setErr(JOIN_ERR[res.data && res.data.code] || '送出失敗，請再試一次');
    }

    window.CoPickingCollab = {
        sync(c) {
            ctrl = c;
            render();
        },
        // for the tests
        _normalizeCode: normalizeCode,
    };
})();
