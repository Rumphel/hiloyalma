const VERSION = 'v1'
const MANIFEST = self.__WB_MANIFEST

const hash = (text) => {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const BUILD = hash(MANIFEST.map((e) => `${e.url}@${e.revision ?? ''}`).join('|'))

const PRECACHE = `hiloyalma-precache-${BUILD}`
const PAGES = `hiloyalma-pages-${VERSION}`
const ASSETS = `hiloyalma-assets-${VERSION}`
const IMAGES = `hiloyalma-images-${VERSION}`
const CURRENT = [PRECACHE, PAGES, ASSETS, IMAGES]

const PLACEHOLDER =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#efe6d6"/><text x="200" y="210" font-size="22" text-anchor="middle" fill="#6a5f52" font-family="sans-serif">Imagen no guardada</text></svg>'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const isCatalog = (path) =>
  path === '/' || path.startsWith('/categoria/') || path.startsWith('/products/')

//Install
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE)

      await cache.addAll(MANIFEST.map((e) => new Request(e.url, { cache: 'reload' })))

      try {
        await cache.add(new Request('/', { cache: 'reload' }))
      } catch {
        //se ignora
      }

      await self.skipWaiting()
    })(),
  )
})

//Adios cache viejo
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((name) => name.startsWith('hiloyalma-') && !CURRENT.includes(name))
          .map((name) => caches.delete(name)),
      )
      await self.clients.claim()
    })(),
  )
})

//Fetch
self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  if (request.mode === 'navigate') {
    if (url.origin === self.location.origin) {
      event.respondWith(handleNavigation(request, url))
    }
    return
  }

  if (request.destination === 'image') {
    event.respondWith(handleImage(request))
    return
  }

  if (
    url.origin === self.location.origin &&
    ['style', 'script', 'font'].includes(request.destination)
  ) {
    event.respondWith(cacheFirst(request))
  }
})

async function handleNavigation(request, url) {
  const catalog = isCatalog(url.pathname)
  const pages = await caches.open(PAGES)
  const cached = catalog ? await pages.match(request) : undefined

  const network = fetch(request).then((response) => {
    if (response.ok) {
      if (catalog) pages.put(request, response.clone())
      return response
    }
    return cached || response
  })
  network.catch(() => {}) //avisos de red

  try {
    if (!cached) return await network
    return await Promise.race([network, wait(4000).then(() => cached)])
  } catch {
    return (
      cached ||
      (await caches.match(request)) ||
      (await caches.match('/offline.html'))
    )
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (response.ok) {
    const cache = await caches.open(ASSETS)
    await cache.put(request, response.clone())
  }
  return response
}

//imagenes al cache
async function handleImage(request) {
  const cached = await caches.match(request)
  if (cached) return cached

  try {
    const response = await fetch(request)
    if (response.ok || response.type === 'opaque') {
      const cache = await caches.open(IMAGES)
      await cache.put(request, response.clone())
      trim(IMAGES, 60)
    }
    return response
  } catch {
    return new Response(PLACEHOLDER, {
      headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' },
    })
  }
}

//el cache se nos vuelve locochon
async function trim(cacheName, max) {
  const cache = await caches.open(cacheName)
  const keys = await cache.keys()
  if (keys.length > max) {
    await Promise.all(keys.slice(0, keys.length - max).map((key) => cache.delete(key)))
  }
}