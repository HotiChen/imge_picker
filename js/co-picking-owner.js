// Co-picking, the OWNER's side of the guest pick page (docs/co-picking.md, batch 2).
//   POST /api/pick/invites {window_days}                 -> an 8-digit code, shown once, valid for an hour
//   GET  /api/pick/collaborators                         -> the list, the unspent invites, pending renewals
//   PATCH | DELETE /api/pick/collaborators/:id           -> change the period / remove
//   POST /api/pick/collaborators/:id/decision            -> approve (a period) / decline a renewal request
// js/pick.js calls CoPickingOwner.sync(PickController) after every state read; the panel exists only for the seat
// owner (is_owner) of a project that is still being picked, and is removed from the DOM for everybody else and when
// the server answers 500 co_picking_unavailable (the migration has not run). Names are what other people typed:
// they reach the DOM through textContent only, and the toast (whose renderer is innerHTML) gets them escaped.
(function () {
    'use strict';

    const POLL_MS = 30000;
    const DAY_LABEL = { '1': '今天', '7': '一週', 'null': '到專案結束' };
    const STATUS_TEXT = { active: '使用中', expired: '已過期', removed: '已移除' };
    const ERR_TEXT = {
        collaborator_limit: '協作者最多 2 位（尚未使用的邀請碼也算）。請先移除一位，或等邀請碼過期。',
        retouching: '攝影師已開始修圖，現在不能再邀請或修改協作者。',
        not_owner: '只有挑選人可以管理協作者（座位可能已被攝影師重設）。',
        collaborator_removed: '這位協作者已被移除。',
        no_renewal_request: '這個續期要求已經不存在。',
        not_found: '找不到這位協作者，請重新整理。',
        invalid_window: '請重新選擇期限。',
    };

    let ctrl = null;
    let built = false;
    let dead = false;            // 500 co_picking_unavailable: leave it alone for this page view
    let data = null;             // the last good GET answer
    let seq = 0;                 // GET answers older than the newest are dropped
    let inflight = false;
    let pollTimer = null;
    let cdTimer = null;
    let firstLoad = true;
    let lastSig = '';
    const seen = new Set();      // "<picker_id>|<renewal_requested_at>" already known (a toast is raised for new ones only)
    const ui = { days: '7', confirming: null, approving: null, rowErr: new Map(), sel: new Map(), invite: null, renewalErr: '' };

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
    const $ = id => document.getElementById(id);
    const fmt = v => (window.Util ? Util.fmtDate(v, 'mdhm') : '');
    const nameOf = c => (typeof c.name === 'string' && c.name ? c.name : '（未命名）');
    const errText = (res, fallback) => {
        if (res.status === 0) return '無法連線，請檢查網路';
        const code = res.data && res.data.code;
        return ERR_TEXT[code] || fallback;
    };
    const daysOf = v => (v === 'null' ? null : Number(v));

    // a real request: a timestamp, never the 'declined:' marker (the server already hides those; belt and braces)
    const pendingRenewal = c => typeof c.renewal_requested_at === 'string' && c.renewal_requested_at !== '' &&
        !c.renewal_requested_at.startsWith('declined:') && c.status !== 'removed';

    // ── mount / unmount ──────────────────────────────────────────────────
    function build() {
        if (built) return;
        const anchor = $('pickBanner');
        if (!anchor || !anchor.parentNode) return;
        const bar = el('div', 'co-bar');
        bar.id = 'coPickBar';
        const entry = btn('co-btn', '協作者', () => openPanel());
        entry.id = 'coPickEntry';
        const badge = el('span');
        badge.id = 'coPickBadge';
        badge.hidden = true;
        entry.append(badge);
        bar.append(entry);

        const banner = el('div');
        banner.id = 'coRenewalBanner';
        banner.hidden = true;
        banner.setAttribute('role', 'status');
        const bl = el('div');
        bl.id = 'coRenewalList';
        const be = el('p', 'co-err');
        be.id = 'coRenewalErr';
        banner.append(bl, be);
        anchor.after(bar, banner);

        const panel = el('div');
        panel.id = 'coPanel';
        panel.hidden = true;
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-labelledby', 'coTitle');
        const backdrop = el('div', 'co-backdrop');
        backdrop.addEventListener('click', closePanel);
        const sheet = el('div', 'co-sheet');
        const head = el('div', 'co-head');
        const title = el('h2', 'co-title', '協作者');
        title.id = 'coTitle';
        const close = btn('co-close', '×', closePanel);
        close.setAttribute('aria-label', '關閉');
        head.append(title, close);
        const body = el('div', 'co-body');

        const inv = el('section', 'co-sec');
        inv.append(el('h3', 'co-h3', '邀請協作者'));
        inv.append(el('p', 'co-hint', '選好對方可以協作多久，產生 8 位數邀請碼，傳給對方。邀請碼 1 小時內有效、只能用一次。'));
        const days = el('div', 'co-days');
        for (const v of ['1', '7', 'null']) {
            const b = btn('co-btn', DAY_LABEL[v], () => { ui.days = v; syncDays(); });
            b.dataset.coDays = v;
            days.append(b);
        }
        const go = btn('co-btn co-btn--primary', '產生邀請碼', () => invite(go));
        go.id = 'coInviteBtn';
        const err = el('p', 'co-err');
        err.id = 'coInviteErr';
        err.setAttribute('role', 'alert');
        const box = el('div', 'co-code-box');
        box.id = 'coCodeBox';
        box.hidden = true;
        const code = el('div');
        code.id = 'coCode';
        code.hidden = true;
        const cd = el('p');
        cd.id = 'coCountdown';
        const copy = btn('co-btn', '複製邀請碼', copyCode);
        copy.id = 'coCopyBtn';
        copy.hidden = true;
        box.append(code, cd, copy);
        const info = el('p');
        info.id = 'coInviteInfo';
        inv.append(days, go, err, box, info);

        const list = el('section', 'co-sec');
        list.append(el('h3', 'co-h3', '目前的協作者'));
        const ul = el('ul', 'co-list');
        ul.id = 'coList';
        const empty = el('p', 'co-empty', '還沒有協作者。');
        empty.id = 'coEmpty';
        list.append(ul, empty);

        body.append(inv, list);
        sheet.append(head, body);
        panel.append(backdrop, sheet);
        document.body.append(panel);
        panel.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });
        built = true;
        syncDays();
        document.addEventListener('visibilitychange', onVisibility);
        const ms = Number(window.CO_PICKING_POLL_MS) > 0 ? Number(window.CO_PICKING_POLL_MS) : POLL_MS;
        pollTimer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, ms);
    }

    function teardown() {
        for (const id of ['coPickBar', 'coRenewalBanner', 'coPanel']) $(id)?.remove();
        clearInterval(pollTimer); pollTimer = null;
        clearInterval(cdTimer); cdTimer = null;
        document.removeEventListener('visibilitychange', onVisibility);
        document.documentElement.classList.remove('co-open');
        built = false;
        lastSig = '';
        ui.invite = null;
    }

    function onVisibility() {
        if (document.visibilityState === 'visible') refresh();
    }

    function openPanel() {
        const p = $('coPanel');
        if (!p) return;
        p.hidden = false;
        document.documentElement.classList.add('co-open');
        refresh();
        $('coInviteBtn')?.focus();
    }
    function closePanel() {
        const p = $('coPanel');
        if (p) p.hidden = true;
        document.documentElement.classList.remove('co-open');
        $('coPickEntry')?.focus();
    }

    function syncDays() {
        document.querySelectorAll('#coPanel [data-co-days]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.coDays === ui.days)));
    }

    // ── reading ──────────────────────────────────────────────────────────
    async function refresh() {
        if (!built || !ctrl || inflight) return;
        inflight = true;
        const mine = ++seq;
        let res;
        try {
            res = await ctrl._json('/api/pick/collaborators', { headers: ctrl.headers() });
        } finally { inflight = false; }
        if (mine !== seq || !built) return;
        if (res.status === 500 && res.data && res.data.code === 'co_picking_unavailable') { dead = true; teardown(); return; }
        if (res.status === 401 || res.status === 403) { teardown(); return; }
        if (!res.ok || !res.data || !Array.isArray(res.data.collaborators)) return;   // a network blip: keep what is on screen
        data = res.data;
        render();
        notifyNew();
    }

    function pendingList() {
        return data ? data.collaborators.filter(pendingRenewal) : [];
    }

    function notifyNew() {
        const fresh = [];
        for (const c of pendingList()) {
            const k = c.picker_id + '|' + c.renewal_requested_at;
            if (!seen.has(k)) { seen.add(k); if (!firstLoad) fresh.push(c); }
        }
        firstLoad = false;
        for (const c of fresh) {
            if (typeof toast !== 'undefined' && toast.info) toast.info(`${Util.escHtml(nameOf(c))} 想繼續協作`, 6000);
        }
    }

    // ── drawing ──────────────────────────────────────────────────────────
    function render() {
        if (!built || !data) return;
        const pending = pendingList();
        const badge = $('coPickBadge');
        badge.textContent = pending.length ? String(pending.length) : '';
        badge.hidden = !pending.length;
        renderBanner(pending);
        const info = $('coInviteInfo');
        const n = data.invites && data.invites.pending;
        info.textContent = n > 0 ? `還有 ${n} 個邀請碼尚未被使用（最早 ${fmt(data.invites.soonest_expires_at)} 失效）` : '';
        renderList();
    }

    function renderBanner(pending) {
        const banner = $('coRenewalBanner');
        const host = $('coRenewalList');
        host.replaceChildren();
        for (const c of pending) {
            const row = el('div', 'co-renewal-item');
            row.dataset.pickerId = c.picker_id;
            row.append(el('span', 'co-renewal-text', `${nameOf(c)} 想繼續協作`));
            const acts = el('div', 'co-renewal-actions');
            if (ui.approving === c.picker_id) {
                for (const v of ['1', '7', 'null']) {
                    const b = btn('co-btn co-btn--sm co-btn--primary', DAY_LABEL[v], () => decide(c, true, daysOf(v)));
                    b.dataset.approveDays = v;
                    acts.append(b);
                }
                acts.append(btn('co-btn co-btn--sm', '取消', () => { ui.approving = null; render(); }));
            } else {
                acts.append(btn('co-btn co-btn--sm co-btn--primary co-approve', '核准', () => { ui.approving = c.picker_id; ui.renewalErr = ''; render(); }));
                acts.append(btn('co-btn co-btn--sm co-decline', '拒絕', () => decide(c, false)));
            }
            row.append(acts);
            host.append(row);
        }
        $('coRenewalErr').textContent = pending.length ? ui.renewalErr : '';
        banner.hidden = pending.length === 0;
    }

    function renderList() {
        const ul = $('coList');
        const people = data.collaborators;
        const sig = JSON.stringify([people, ui.confirming, [...ui.rowErr], [...ui.sel]]);
        if (sig === lastSig) return;
        lastSig = sig;
        $('coEmpty').hidden = people.length > 0;
        ul.replaceChildren();
        for (const c of people) {
            const li = el('li', 'co-item');
            li.dataset.pickerId = c.picker_id;
            li.dataset.status = c.status;
            const top = el('div', 'co-item-top');
            top.append(el('span', 'co-name', nameOf(c)), el('span', 'co-status', STATUS_TEXT[c.status] || ''));
            li.append(top);
            const meta = el('p', 'co-meta');
            meta.append(el('span', 'co-joined', `加入 ${fmt(c.joined_at)}`), document.createElement('br'),
                el('span', 'co-until', c.expires_at ? `有效到 ${fmt(c.expires_at)}` : '有效期限：不限'));
            li.append(meta);
            if (c.status !== 'removed') {
                const acts = el('div', 'co-actions');
                const sel = el('select', 'co-period-sel');
                sel.setAttribute('aria-label', `${nameOf(c)} 的期限`);
                for (const v of ['1', '7', 'null']) {
                    const o = el('option', null, DAY_LABEL[v]);
                    o.value = v;
                    sel.append(o);
                }
                sel.value = ui.sel.get(c.picker_id) || (c.expires_at ? '7' : 'null');
                sel.addEventListener('change', () => ui.sel.set(c.picker_id, sel.value));
                acts.append(sel, btn('co-btn co-btn--sm co-period-apply', '套用', () => changePeriod(c, sel.value)),
                    btn('co-btn co-btn--sm co-btn--danger co-remove', '移除', () => { ui.confirming = c.picker_id; lastSig = ''; render(); }));
                li.append(acts);
                if (ui.confirming === c.picker_id) {
                    const box = el('div', 'co-confirm');
                    box.append(el('p', 'co-confirm-text', `確定要移除 ${nameOf(c)} 嗎？對方會馬上無法再挑選。`));
                    const a2 = el('div', 'co-actions');
                    a2.append(btn('co-btn co-btn--sm co-confirm-no', '取消', () => { ui.confirming = null; lastSig = ''; render(); }),
                        btn('co-btn co-btn--sm co-btn--danger co-confirm-yes', '移除', () => remove(c)));
                    box.append(a2);
                    li.append(box);
                }
            }
            const err = el('p', 'co-err co-row-err', ui.rowErr.get(c.picker_id) || '');
            li.append(err);
            ul.append(li);
        }
    }

    // ── actions ──────────────────────────────────────────────────────────
    const path = id => `/api/pick/collaborators/${encodeURIComponent(id)}`;
    const jsonHeaders = () => ctrl.headers({ 'Content-Type': 'application/json' });

    async function invite(button) {
        const err = $('coInviteErr');
        err.textContent = '';
        button.disabled = true;
        const res = await ctrl._json('/api/pick/invites', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ window_days: daysOf(ui.days) }) });
        button.disabled = false;
        if (!built) return;
        if (!res.ok) {
            err.textContent = errText(res, '產生邀請碼失敗，請再試一次');
            if (res.data && res.data.code === 'collaborator_limit') refresh();
            return;
        }
        ui.invite = { code: String(res.data.code || ''), expires: Date.parse(res.data.expires_at) };
        await refresh();
        if (!built) return;
        showCode();
    }

    function showCode() {
        const code = $('coCode'), copy = $('coCopyBtn'), box = $('coCodeBox'), cd = $('coCountdown');
        clearInterval(cdTimer);
        const inv = ui.invite;
        if (!inv || !/^\d{8}$/.test(inv.code)) { box.hidden = true; code.hidden = true; copy.hidden = true; return; }
        box.hidden = false;
        code.hidden = false;
        copy.hidden = false;
        code.textContent = `${inv.code.slice(0, 4)} ${inv.code.slice(4)}`;
        const tick = () => {
            const left = Math.max(0, Math.ceil((inv.expires - Date.now()) / 1000));
            if (!(left > 0)) {
                clearInterval(cdTimer);
                code.hidden = true;
                copy.hidden = true;
                cd.textContent = '邀請碼已失效，請重新產生';
                return;
            }
            const mm = String(Math.floor(left / 60)).padStart(2, '0'), ss = String(left % 60).padStart(2, '0');
            cd.textContent = `有效時間還剩 ${mm}:${ss}`;
        };
        tick();
        cdTimer = setInterval(tick, 1000);
    }

    async function copyCode() {
        const raw = ui.invite && ui.invite.code;
        if (!raw) return;
        let done = false;
        try { await navigator.clipboard.writeText(raw); done = true; } catch (e) { /* fall through */ }
        if (!done) {
            try {
                const ta = el('textarea');
                ta.value = raw;
                ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
                document.body.append(ta);
                ta.select();
                done = document.execCommand('copy');
                ta.remove();
            } catch (e) { done = false; }
        }
        if (typeof toast !== 'undefined') { if (done) toast.success('已複製邀請碼'); else toast.error('無法複製，請手動選取數字'); }
    }

    async function remove(c) {
        ui.rowErr.delete(c.picker_id);
        const res = await ctrl._json(path(c.picker_id), { method: 'DELETE', headers: ctrl.headers() });
        ui.confirming = null;
        if (!res.ok) ui.rowErr.set(c.picker_id, errText(res, '移除失敗，請再試一次'));
        await afterChange();
    }

    async function changePeriod(c, value) {
        ui.rowErr.delete(c.picker_id);
        const res = await ctrl._json(path(c.picker_id), { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ window_days: daysOf(value) }) });
        if (!res.ok) ui.rowErr.set(c.picker_id, errText(res, '修改期限失敗，請再試一次'));
        else ui.sel.delete(c.picker_id);
        await afterChange();
    }

    async function decide(c, approve, days) {
        ui.renewalErr = '';
        const body = approve ? { approve: true, window_days: days } : { approve: false };
        const res = await ctrl._json(`${path(c.picker_id)}/decision`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
        if (res.ok) ui.approving = null;
        else ui.renewalErr = errText(res, '送出失敗，請再試一次');
        await afterChange();
    }

    async function afterChange() {
        lastSig = '';
        inflight = false;
        await refresh();
        if (data) { lastSig = ''; render(); }
    }

    // ── entry point ──────────────────────────────────────────────────────
    // Called by js/pick.js whenever the state is (re)read. The panel is the seat owner's, while the project is picked.
    window.CoPickingOwner = {
        sync(c) {
            ctrl = c;
            if (!c || !c.isOwner || c.mode !== 'picking' || dead) { if (built) teardown(); return; }
            build();
            refresh();
        },
        // for the tests
        _pending: () => pendingList().length,
    };
})();
