// Kill-switch service worker.
//
// A previous build registered a caching service worker (vite-plugin-pwa)
// whose precache goes stale on every rebuild during active development,
// crashing the app for anyone with the old worker still installed. This
// file replaces it: it deletes every Cache Storage entry, unregisters
// itself, and hands control back to a normal (uncached) network fetch.
// Safe to leave in place even after the app stops shipping this file.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.registration.unregister();
      const clientsList = await self.clients.matchAll({ type: 'window' });
      clientsList.forEach((client) => client.navigate(client.url));
    })()
  );
});
