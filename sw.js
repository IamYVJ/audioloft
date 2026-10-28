// AudioLoft service worker
//
// Network first, cache as fallback: a GitHub Pages deploy reaches people on
// their next load, and the app still opens with no connection. Every
// successful same-origin GET refreshes the cache. Cross-origin requests
// (the GoatCounter beacon and visitor count) are never touched: a beacon
// answered from cache records nothing.
//
// Bump CACHE_VERSION when the precache list changes.

const CACHE_VERSION = 'audioloft-v6';

const PRECACHE_URLS = [
    './',
    'index.html',
    'trim.html',
    'split.html',
    'join.html',
    'studio.html',
    'manifest.webmanifest',
    'css/style.css',
    'js/audio-core.js',
    'js/encoders.js',
    'js/mp3-worker.js',
    'lib/lame.min.js',
    'js/player.js',
    'js/waveform.js',
    'js/ui.js',
    'js/trim.js',
    'js/split.js',
    'js/join.js',
    'js/mixer.js',
    'js/session-store.js',
    'js/studio.js',
    'js/home.js',
    'js/sw-register.js',
    'js/visitor-count.js',
    'icons/icon.svg',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE_URLS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(
                names.filter((name) => name !== CACHE_VERSION).map((name) => caches.delete(name))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    if (new URL(request.url).origin !== self.location.origin) return;

    event.respondWith(
        fetch(request)
            .then((response) => {
                if (response && response.status === 200 && response.type === 'basic') {
                    const copy = response.clone();
                    caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
                }
                return response;
            })
            .catch(() => caches.match(request, { ignoreSearch: true }).then((cached) => {
                if (cached) return cached;
                if (request.mode === 'navigate') return caches.match('index.html');
                return Response.error();
            }))
    );
});
