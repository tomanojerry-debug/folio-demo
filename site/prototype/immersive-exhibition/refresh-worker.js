// Navigation marker only. Deliberately no fetch handler and no offline cache.
// Browsers bypass this controller on a forced refresh.
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
