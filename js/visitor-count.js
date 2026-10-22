// Decorative "N visitors" footnote. Stays hidden on every failure: adblocker,
// offline, a brand-new path with no data yet, or the "visitor counts" setting
// off. Lives in its own file because the CSP doesn't allow inline scripts.
(function () {
    'use strict';

    function showVisitorCount() {
        const box = document.querySelector('.visitor-counter');
        const out = document.getElementById('visitor-count');
        if (!box || !out) return;

        // Read the endpoint off the beacon tag so the site URL lives in one place.
        const tag = document.querySelector('script[data-goatcounter]');
        const endpoint = tag && tag.getAttribute('data-goatcounter');
        if (!endpoint) return;

        // This page's path only. Never /counter/TOTAL.json, which sums every
        // project. pathname WITHOUT location.search, on purpose: views that
        // arrive with ?fbclid=… are recorded separately but still see this total.
        const path = window.location.pathname;

        // A fixed date before this project's first pageview. All-time is the
        // default, so this doesn't change the count; it gives the response its
        // own cache key, sidestepping a 404 cached before any data existed.
        const START = '2026-01-01';

        const base = endpoint.replace(/\/count$/, '');
        fetch(base + '/counter/' + encodeURIComponent(path) + '.json?start=' + START)
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error('bad status'))))
            .then((data) => {
                // `count` is already a formatted string: render it as-is.
                // GoatCounter caches this response for ~4h.
                if (data && data.count != null) {
                    out.textContent = String(data.count);
                    box.hidden = false;
                }
            })
            .catch(() => { /* decorative: stay hidden */ });
    }

    // Loaded with `defer` just before the beacon tag, so the tag is parsed by
    // the time this runs. Guard anyway in case `defer` is ever dropped.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', showVisitorCount, { once: true });
    } else {
        showVisitorCount();
    }
})();
