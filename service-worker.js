self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());
// (Add caching later if needed)
// service-worker.js
// service-worker.js
const CACHE_VERSION = 'v1.1.1';                 
const CACHE_NAME = `bagvoyage-${CACHE_VERSION}`;
const PRECACHE = [
  './',                                        
  './index.html',
  './manifest.json',
  './img/bagvoyage-icon-32.png',
  './img/bagvoyage-icon-180.png',
  './img/bagvoyage-icon-192.png',
  './img/bagvoyage-icon-512.png'
];

// (keep the rest of your SW code the same)


// Install: pre-cache core assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith('bagvoyage-') && k !== CACHE_NAME)
        .map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Runtime caching: network-first for HTML; cache-first for static
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET
  if (req.method !== 'GET') return;

  // HTML/doc requests → network-first, fallback to cache
  if (req.destination === 'document' || req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Static assets (css/js/img/fonts) → cache-first, fallback to network
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        // Cache successful responses
        if (res.ok && (req.url.startsWith(self.location.origin) || req.destination)) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, copy));
        }
        return res;
      });
    })
  );
});

