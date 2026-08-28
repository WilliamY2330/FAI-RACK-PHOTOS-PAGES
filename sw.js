const CACHE_PREFIX = 'rack-photo-'
const scopeUrl = new URL(self.registration.scope)
const scopeKey = scopeUrl.pathname.replace(/[^a-z0-9]+/gi, '-') || 'root'
const scopeCachePrefix = `${CACHE_PREFIX}${scopeKey}`
const CACHE = `${scopeCachePrefix}v11`
const SHELL = ['', 'index.html', 'manifest.webmanifest', 'icon.svg', 'recovery.html', 'recovery.js'].map(path => new URL(path, scopeUrl).href)

self.addEventListener('install', (event) => event.waitUntil(
  caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()),
))

self.addEventListener('activate', (event) => event.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith(scopeCachePrefix) && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()),
))

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const requestUrl = new URL(event.request.url)
  if (requestUrl.origin !== scopeUrl.origin || !requestUrl.pathname.startsWith(scopeUrl.pathname)) return

  event.respondWith((async () => {
    try {
      const response = await fetch(event.request)
      if (response.ok) {
        const cache = await caches.open(CACHE)
        await cache.put(event.request, response.clone())
      }
      return response
    } catch {
      const cached = await caches.match(event.request)
      if (cached) return cached
      if (event.request.mode === 'navigate') return caches.match(new URL('index.html', scopeUrl).href)
      return Response.error()
    }
  })())
})
