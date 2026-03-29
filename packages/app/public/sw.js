// Pyre World Service Worker — minimal, for PWA installability
// Caches the app shell for offline launch, delegates everything else to network

const CACHE_NAME = 'pyre-v1'
const SHELL = ['/', '/manifest.json']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL))
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  // Network-first for all requests — we're a live game, stale data is worse than no data
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  )
})
