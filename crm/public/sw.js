/* CRM service worker (R4). Served at /sw.js with VERSION filled in per deploy (crm/src/app.js).
 * Caches only the app's CSS and JS (and the offline page) so it opens fast. Never caches pages or API
 * responses: lead data is private and phones are shared. When offline, pages show
 * /offline instead of the browser's error. */
const VERSION = '__ASSET_VERSION__';
// The client's branding version: renaming the business or changing its colour changes this file,
// so the phone installs a new worker and re-caches the offline page with the new name and colour.
const BRAND = '__BRAND_VERSION__';
const CACHE = `crm-${VERSION}-${BRAND}`;
const OFFLINE = '/offline';
const SHELL = [OFFLINE, `/static/css/app.css?v=${VERSION}`, `/static/js/app.js?v=${VERSION}`];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('crm-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // fonts etc.: the browser's own cache

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
    return;
  }
  // Versioned static files: cache first, they never change under the same URL.
  if (SHELL.includes(url.pathname + url.search)) {
    event.respondWith(caches.match(req).then(hit => hit || fetch(req)));
  }
});
