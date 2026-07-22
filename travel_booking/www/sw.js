/* ============================================================
   Rarecation — Service Worker
   Cache strategy: Network first, fallback to cache
   ============================================================ */

const CACHE_NAME = 'rarecation-v3';
const STATIC_ASSETS = [
  '/traveller_portal',
  '/assets/travel_management/css/portal.css',
  '/assets/travel_management/js/portal.js',
  '/assets/travel_management/js/portal_booking.js',
  '/assets/travel_management/js/portal_payment.js',
  '/assets/travel_management/js/portal_traveller.js',
  '/assets/travel_management/js/portal_wizard.js',
  '/assets/travel_management/img/logo-horizontal.jpg',
  '/assets/travel_management/img/icon-rarecation-192.png',
  '/assets/travel_management/img/example_passport.jpg'
];

/* ── Install ── */
self.addEventListener('install', event => {
  self.skipWaiting();
});

/* ── Activate — clean old caches ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

/* ── Fetch — network first, fallback cache ── */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip API calls — always network
  if (url.pathname.startsWith('/api/')) return;

  // Skip non-GET
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then(cached => {
          return cached || new Response('Offline — please check your connection.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' }
          });
        });
      })
  );
});