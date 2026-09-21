// 攝影師頁面用的網址權杖（studio token）。
//
// An <img> cannot send an Authorization header, so gating `GET /<key>` took
// every photographer-facing tile down with it. POST /api/auth/studio-token
// trades the real credential — in a header, where a master key belongs — for
// a read-only token that fits in a query string and dies in twelve hours.
//
// The result lands in CONFIG.SHARE_TOKEN, the same field the client viewer
// fills from its own ?t=. There is then exactly one "token that may ride in a
// URL" on the page, and every builder that already reads it — _thumbUrl,
// driveManager.getImageUrl — needs no second mechanism.
//
// fetch() is deliberately not a customer of this. It can send a header, so it
// sends the real credential and keeps it out of request URLs and access logs.
(function () {
    // A token inside this much of its deadline counts as spent. A grid that
    // starts loading with four minutes left must not 401 halfway down.
    const SKEW_MS = 5 * 60 * 1000;
    // Only used when the Worker answers without a readable expires_at, so a
    // malformed reply still ages out instead of being trusted forever.
    const FALLBACK_TTL_MS = 60 * 60 * 1000;

    const StudioToken = {
        value: '',
        expiresAt: 0,
        _inflight: null,
        // The admin credential the Worker refused. A mistyped password gets
        // the user past the login overlay (see auth.js), and every tile then
        // 401s; without this, each one would ask for another token.
        _deniedFor: '',
        // The token we have already replaced after a tile failed. One
        // replacement per token, however many tiles report it dead.
        _retriedFor: '',

        _admin() {
            return (typeof CONFIG !== 'undefined' && CONFIG.PHOTOGRAPHER_TOKEN) || '';
        },

        fresh() {
            return !!this.value && Date.now() < this.expiresAt - SKEW_MS;
        },

        /**
         * A usable token, minting one if the cached one is missing or close to
         * its deadline. Concurrent callers share a single request.
         * Returns '' when there is nothing to trade or the trade was refused —
         * callers build an unsigned URL and let the tile fail visibly rather
         * than blocking the page.
         */
        async ensure() {
            if (this.fresh()) return this.value;
            const admin = this._admin();
            if (!admin || this._deniedFor === admin) return '';
            if (!this._inflight) {
                this._inflight = this._mint(admin);
                this._inflight.then(
                    () => { this._inflight = null; },
                    () => { this._inflight = null; }
                );
            }
            return this._inflight;
        },

        async _mint(admin) {
            try {
                const res = await fetch(`${CONFIG.WORKER_URL}/api/auth/studio-token`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${admin}` }
                });
                // The credential is wrong, not expired. Stop asking.
                if (res.status === 401 || res.status === 403) {
                    this._deniedFor = admin;
                    return '';
                }
                if (!res.ok) return '';
                const data = await res.json();
                if (!data || !data.token) return '';
                this.value = data.token;
                this.expiresAt = Date.parse(data.expires_at) || (Date.now() + FALLBACK_TTL_MS);
                if (typeof CONFIG !== 'undefined') CONFIG.SHARE_TOKEN = this.value;
                return this.value;
            } catch (e) {
                // Transient: a later caller may try again. Nothing is cached,
                // so nothing has to be invalidated.
                return '';
            }
        },

        /**
         * A tile carrying `stale` came back 401. That is the only signal a page
         * gets that its token died underneath it — twelve hours outlives a
         * working session but not a tab left open overnight.
         *
         * Replaces it at most once per token: if the replacement fails too, the
         * credential is wrong rather than stale, and a page full of broken
         * tiles must not mint a token each.
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
        const stale = StudioToken.value;
        if (!stale || typeof CONFIG === 'undefined') return;
        const src = el.getAttribute('src') || '';
        const marker = `t=${encodeURIComponent(stale)}`;
        if (src.indexOf(CONFIG.WORKER_URL) !== 0 || src.indexOf(marker) < 0) return;
        retried.add(el);
        StudioToken.replace(stale).then(fresh => {
            if (fresh && fresh !== stale) {
                el.src = src.split(marker).join(`t=${encodeURIComponent(fresh)}`);
            }
        });
    }, true);

    window.StudioToken = StudioToken;
})();
