const CACHE_NAME = 'maria-onedrive-shell-v15';
const APP_SHELL = [
  './', './index.html', './manifest.json', './assets/css/styles.css?v=15', './assets/js/app.js?v=15',
  './assets/js/auth.js?v=15', './assets/js/graph.js?v=15', './assets/js/storage.js?v=15', './assets/js/photos.js?v=15', './assets/js/ui.js?v=15', './assets/js/migration.js?v=15', './assets/js/schemaMigration.js?v=15', './assets/js/adminStorage.js?v=15',
  './assets/js/services/dataService.js?v=15', './assets/js/services/permissionsService.js?v=15', './assets/js/services/notificationService.js?v=15',
  './assets/js/services/chartService.js?v=15', './assets/js/services/reportService.js?v=15',
  './assets/icons/app-icon.svg', './assets/icons/child-avatar.svg', './data/data.sample.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  const sameOrigin = requestUrl.origin === self.location.origin;
  if (!sameOrigin) return;

  const acceptsHtml = event.request.headers.get('accept')?.includes('text/html');
  const isHtmlNavigation = event.request.mode === 'navigate' && acceptsHtml;

  if (isHtmlNavigation) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(event.request)) || caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }))
  );
});