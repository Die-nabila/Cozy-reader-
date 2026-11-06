// service-worker.js - offline support without trapping old files.
// App files use "network first, fall back to cache", so a new deploy is picked up as soon as the
// device is online. Bump CACHE_VERSION when you want old caches removed immediately.
const CACHE_VERSION = 'cozy-reader-v1';

const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'db.js', 'translate.js', 'words.js', 'epub-reader.js', 'pdf-reader.js',
  'manifest.json', 'lib/jszip.min.js', 'lib/pdf.min.mjs', 'lib/pdf.worker.min.mjs',
  'lib/wasm/openjpeg.wasm', 'lib/wasm/jbig2.wasm', 'lib/wasm/qcms_bg.wasm',
  'lib/standard_fonts/LiberationSans-Regular.ttf', 'lib/standard_fonts/LiberationSans-Bold.ttf',
  'lib/standard_fonts/LiberationSans-Italic.ttf', 'lib/standard_fonts/LiberationSans-BoldItalic.ttf',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Cache each file on its own so one missing file can't block installation.
    await Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // translation APIs etc. go straight to the network
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res && res.ok && !req.headers.has('range')) cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = (await cache.match(req, { ignoreSearch: true })) ||
        (req.mode === 'navigate' ? await cache.match('index.html') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
