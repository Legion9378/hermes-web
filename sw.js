const CACHE = 'hermes-web-v10';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'hermes_web_core.mjs', 'manifest.webmanifest', 'icons/icon-192.svg', 'icons/icon-512.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || url.pathname.includes('/hermes/')) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
