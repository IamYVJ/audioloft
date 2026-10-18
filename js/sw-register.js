// Registers the service worker so AudioLoft works offline after the first
// visit. Service workers need a real origin, so file:// is skipped.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch((error) => {
            console.warn('Service worker registration failed:', error);
        });
    });
}
