// Fills in <span id="buildVersion"></span> with the version of the assets the
// browser actually loaded.
//
// Deliberately read from the DOM rather than written here by hand: a hardcoded
// number can read "new" while a stale script is running from cache, and that
// is the only case this exists to catch. A partly-cached page — new app.js
// against an old drive.js, say — breaks in confusing ways, so a mixed set is
// called out by name.
(function () {
    var MUTED = '#5a5248';
    var WARN = '#e5a448';

    function loadedVersions() {
        var nodes = document.querySelectorAll('script[src], link[rel="stylesheet"][href]');
        var seen = {};
        for (var i = 0; i < nodes.length; i++) {
            var url = nodes[i].getAttribute('src') || nodes[i].getAttribute('href') || '';
            if (/^https?:|^\/\//.test(url)) continue;   // CDN scripts and fonts are not ours
            var m = /[?&]v=([^&"]+)/.exec(url);
            if (!m) continue;
            if (!seen[m[1]]) seen[m[1]] = [];
            seen[m[1]].push(url.split('?')[0].split('/').pop());
        }
        return seen;
    }

    function render() {
        var el = document.getElementById('buildVersion');
        if (!el) return;

        el.style.fontFamily = "'IBM Plex Mono', ui-monospace, monospace";
        el.style.fontSize = '10px';
        el.style.letterSpacing = '0.06em';
        el.style.whiteSpace = 'nowrap';
        el.style.color = MUTED;

        var seen = loadedVersions();
        var keys = Object.keys(seen);
        if (!keys.length) { el.textContent = ''; return; }

        if (keys.length === 1) {
            el.textContent = 'v' + keys[0];
            el.title = '載入中的程式版本：' + keys[0];
            return;
        }

        keys.sort();
        el.textContent = 'v' + keys[keys.length - 1] + ' ⚠ 版本不一致';
        el.style.color = WARN;
        el.title = '偵測到混合版本，請強制重新整理：\n' + keys.map(function (k) {
            return k + ' → ' + seen[k].join(', ');
        }).join('\n');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', render);
    } else {
        render();
    }
})();
