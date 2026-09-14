const CACHE_NAME = 'maria-onedrive-shell-v41';
const APP_SHELL = [
  './', './index.html', './manifest.json?v=24', './assets/css/styles.css?v=30', './assets/js/bootstrap.js?v=26',
  './assets/js/auth.js?v=19', './assets/js/graph.js?v=19', './assets/js/storage.js?v=19', './assets/js/photos.js?v=19', './assets/js/ui.js?v=19', './assets/js/migration.js?v=19', './assets/js/schemaMigration.js?v=19', './assets/js/adminStorage.js?v=19',
  './assets/js/services/dataService.js?v=19', './assets/js/services/permissionsService.js?v=19', './assets/js/services/deviceAccessService.js?v=19', './assets/js/services/notificationService.js?v=19',
  './assets/js/services/chartService.js?v=19', './assets/js/services/reportService.js?v=19',
  './assets/js/next/app-next.js?v=20', './assets/js/next/medical-appointments-quick-v26.js?v=26', './assets/js/next/pwa-install-v24.js?v=24', './assets/js/next/supabase.js?v=20', './assets/js/next/config.js?v=20', './assets/js/next/permissions.js?v=20', './assets/js/next/file-picker.js?v=20', './assets/js/next/photo-editor.js?v=20', './assets/js/next/care-service.js?v=20', './assets/js/next/routine-service.js?v=20', './assets/js/next/ics.js?v=20', './assets/js/next/migration-preview.js?v=20', './assets/js/next/identity-client.js?v=20', './assets/js/next/document-service.js?v=20', './assets/js/next/recipe-service.js?v=20',
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
  if (requestUrl.origin !== self.location.origin) return;
  const acceptsHtml = event.request.headers.get('accept')?.includes('text/html');
  const isHtmlNavigation = event.request.mode === 'navigate' && acceptsHtml;
  if (isHtmlNavigation) {
    event.respondWith(fetch(event.request).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
      return response;
    }).catch(async () => (await caches.match(event.request)) || caches.match('./index.html')));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
    return response;
  })));
});
