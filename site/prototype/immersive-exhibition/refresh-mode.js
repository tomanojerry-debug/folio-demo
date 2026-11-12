const marker = 'forme-refresh-controlled-v1';
const workerURL = new URL('./refresh-worker.js', import.meta.url);

export function isForcedRefresh({ type, previouslyControlled, controlled, registered }) {
  return type === 'reload' && previouslyControlled && !controlled && registered;
}

// Navigation Timing labels both refresh gestures "reload". A forced refresh
// bypasses an installed service worker (and has no controller); a normal one
// retains it. This worker has no fetch handler or caches and only scopes this app.
export async function initializeRefreshMode() {
  const type = performance.getEntriesByType('navigation')[0]?.type;
  let forced = false;
  if (!('serviceWorker' in navigator)) return { type, forced };
  try {
    const sw = navigator.serviceWorker;
    const owned = (worker) => worker?.scriptURL === workerURL.href;
    const controlled = owned(sw.controller);
    const registration = await sw.getRegistration(new URL('./', import.meta.url));
    forced = isForcedRefresh({ type, previouslyControlled: sessionStorage.getItem(marker) === '1', controlled, registered: owned(registration?.active) });
    const remember = () => {
      try { if (owned(sw.controller)) sessionStorage.setItem(marker, '1'); }
      catch { /* Storage may be disabled after initialization. */ }
    };
    remember();
    sw.addEventListener('controllerchange', remember);
    // Do not replace a different app's existing worker.
    if (!registration || owned(registration.active) || owned(registration.installing) || owned(registration.waiting)) {
      void sw.register(workerURL, { scope: new URL('./', import.meta.url).pathname, updateViaCache: 'none' }).catch(() => {});
    }
  } catch { /* Without worker/storage support, preserve ordinary restoration. */ }
  return { type, forced };
}
