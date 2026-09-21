// 客戶頁面用的網址權杖（session token）。
//
// studio-token.js is this file's sibling: same trade, the other half of
// index.html. The photographer hands over PHOTOGRAPHER_TOKEN and gets back
// something an <img> can carry; a signed-in client hands over their D1 session
// and gets back the same shape, scoped to the one folder their account owns.
//
// Both land in CONFIG.SHARE_TOKEN, so layouts.js:_thumbUrl and
// driveManager.getImageUrl stay the single place a URL gets signed. One
// mechanism, now three fillers — a share link's ?t=, a studio token, this.
//
// fetch() is not a customer of the ?t= form. It can send a header, so listings
// send X-Share-Token and keep the credential out of proxy and access logs.
//
// The session itself never goes anywhere but the mint. It is a month of
// account access; this is an hour of read access to one folder.
(function () {
    // A token inside this much of its deadline counts as spent, so a grid that
    // starts loading late does not 401 halfway down. The Worker will not reuse
    // a row with under fifteen minutes on it either, so a page that gives up
    // here is asking for something the Worker was going to re-mint anyway.
    const SKEW_MS = 5 * 60 * 1000;
    // Only used when the Worker answers without a readable expires_at, so a
    // malformed reply still ages out instead of being trusted forever.
    const FALLBACK_TTL_MS = 60 * 60 * 1000;

    const SessionToken = {
        value: '',
        expiresAt: 0,
        // Exactly one entry, slash-terminated, straight from the Worker. The
        // client's own user.folder_path is NOT interchangeable with it: an
        // admin who typed `20260819` without the slash named a prefix the
        // Worker refuses to list, because it would also reach 20260819-other/.
        folders: [],
        // 403 — an account state only the photographer can change. Held here
        // in the Worker's own wording, because a message the client can act on
        // is the only useful reading of it.
        error: '',
        // 401 — the session is dead or unknown. Nothing on this page fixes it.
        expired: false,
        // The session credential the Worker refused, exactly as studio-token.js
        // remembers the admin token it was refused. Terminal for THAT session,
        // so a refusal costs one request rather than one per tile — but keyed
        // on the credential rather than latched, because a client who signs in
        // again in another tab hands us a different one, and a flat boolean
        // would refuse to ask about it for as long as the page stayed open.
        _deniedFor: '',
        _inflight: null,
        // The token we have already replaced after a tile failed. One
        // replacement per token, however many tiles report it dead.
        _retriedFor: '',

        // Safari in private mode throws on sessionStorage rather than
        // returning null, and an unreadable session is simply no session.
        _credential() {
            try {
                const raw = sessionStorage.getItem('client_session') || 'null';
                const s = JSON.parse(raw);
                return (s && s.token) || '';
            } catch (e) {
                return '';
            }
        },

        fresh() {
            return !!this.value && Date.now() < this.expiresAt - SKEW_MS;
        },

        /**
         * A usable token, minting one if the cached one is missing or close to
         * its deadline. Concurrent callers share a single request.
         * Returns '' when there is no session to trade, or the trade was
         * refused — in which case `error` / `expired` say which.
         */
        async ensure() {
            if (this.fresh()) return this.value;
            const sess = this._credential();
            if (!sess || this._deniedFor === sess) return '';
            if (!this._inflight) {
                this._inflight = this._mint(sess);
                this._inflight.then(
                    () => { this._inflight = null; },
                    () => { this._inflight = null; }
                );
            }
            return this._inflight;
        },

        /**
         * The one prefix this account may list, once the token is in hand.
         * '' for a photographer, for a refused account, and for anyone with no
         * session at all — every one of which must not fall back to listing
         * the bucket root, which is a 401 by design.
         */
        async scope() {
            await this.ensure();
            return this.folders[0] || '';
        },

        async _mint(sess) {
            // A previous session's refusal is not this one's: whatever we are
            // about to learn replaces it, including learning nothing.
            this.error = '';
            this.expired = false;
            let res;
            try {
                res = await fetch(`${CONFIG.WORKER_URL}/api/auth/session-token`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${sess}` }
                });
            } catch (e) {
                // Transient: a later caller may try again. Nothing is cached,
                // so nothing has to be invalidated.
                return '';
            }
            if (res.status === 401) {
                this._deniedFor = sess;
                this.expired = true;
                return '';
            }
            if (res.status === 403) {
                this._deniedFor = sess;
                this.error = (await this._errorText(res)) || '無法存取相簿，請聯繫攝影師';
                return '';
            }
            if (!res.ok) return '';
            let data;
            try { data = await res.json(); } catch (e) { return ''; }
            if (!data || !data.token) return '';
            this.value = data.token;
            this.expiresAt = Date.parse(data.expires_at) || (Date.now() + FALLBACK_TTL_MS);
            this.folders = Array.isArray(data.folders)
                ? data.folders.filter(f => typeof f === 'string' && f)
                : [];
            if (typeof CONFIG !== 'undefined') CONFIG.SHARE_TOKEN = this.value;
            return this.value;
        },

        async _errorText(res) {
            try {
                const body = await res.json();
                return (body && typeof body.error === 'string') ? body.error : '';
            } catch (e) {
                return '';
            }
        },

        /**
         * A tile carrying `stale` came back 401 — the only signal a page gets
         * that its token died underneath it. An hour outlives a sitting but
         * not a tab left open over lunch.
         *
         * Replaces it at most once per token: if the replacement fails too,
         * the session is the problem rather than the token, and a page full of
         * broken tiles must not mint one each.
         */
        async replace(stale) {
            if (!stale) return this.value;
            if (this.value !== stale) return this.value;   // someone got there first
            if (this._retriedFor === stale) {
                return this._inflight ? this._inflight : '';
            }
            this._retriedFor = stale;
            this.expiresAt = 0;
            return this.ensure();
        }
    };

    // Each element gets one retry, so a tile that fails again with the fresh
    // token stops there instead of looping on its own error handler.
    const retried = new WeakSet();

    // An <img> load error does not bubble, so this has to listen in the
    // capture phase to see it at all.
    window.addEventListener('error', function (e) {
        const el = e.target;
        if (!el || el.tagName !== 'IMG' || retried.has(el)) return;
        const stale = SessionToken.value;
        if (!stale || typeof CONFIG === 'undefined') return;
        const src = el.getAttribute('src') || '';
        const marker = `t=${encodeURIComponent(stale)}`;
        if (src.indexOf(CONFIG.WORKER_URL) !== 0 || src.indexOf(marker) < 0) return;
        retried.add(el);
        SessionToken.replace(stale).then(fresh => {
            if (fresh && fresh !== stale) {
                el.src = src.split(marker).join(`t=${encodeURIComponent(fresh)}`);
            }
        });
    }, true);

    window.SessionToken = SessionToken;
})();
