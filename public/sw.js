// Minimal service worker. Required for PWA install prompt.
// Does not cache anything - Sublight is always online against localhost.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', () => {});
