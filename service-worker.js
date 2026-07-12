const CACHE_NAME = 'maria-onedrive-shell-v12';
const APP_SHELL = [
  './', './index.html', './manifest.json', './assets/css/styles.css?v=12', './assets/js/app.js?v=12',
  './assets/js/auth.js', './assets/js/graph.js', './assets/js/storage.js', './assets/js/photos.js', './assets/js/ui.js', './assets/js/migration.js',
  './assets/js/services/dataService.js?v=12', './assets/js/services/permissionsService.js', './assets/js/services/notificationService.js',
  './assets/js/services/chartService.js', './assets/js/services/reportService.js',
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
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    const copy = response.clone();
    if (new URL(event.request.url).origin === self.location.origin) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match('./index.html'))));
});