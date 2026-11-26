const VERSION = 'v1'
//solo archivos del front
const seen = new Set()
const MANIFEST = self.__WB_MANIFEST
  .filter((entry) =>
    /^(_astro\/|icons\/|favicon\.svg$|offline\.html$)/.test(entry.url.replace(/^\//, '')),
  )
  .filter((entry) => {
    const key = entry.url.replace(/^\//, '')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

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
const CATALOG = `hiloyalma-catalog-${VERSION}`
const CURRENT = [PRECACHE, PAGES, ASSETS, IMAGES, CATALOG]

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

      //cada archivo por separado
      const results = await Promise.allSettled(
        MANIFEST.map((e) => cache.add(new Request(e.url, { cache: 'reload' }))),
      )
      results.forEach((r, i) => {
        if (r.status === 'rejected') console.warn('[sw] no se pudo guardar', MANIFEST[i].url, r.reason)
      })

      //la pagina estando offline se guarda siempre
      try {
        await cache.add(new Request('/offline.html', { cache: 'reload' }))
      } catch (error) {
        console.warn('[sw] no se pudo guardar /offline.html', error)
      }

      //portada depende del back
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
      event.respondWith(handleNavigation(event, request, url))
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

//navegacion
async function handleNavigation(event, request, url) {
  const catalog = isCatalog(url.pathname)
  const pages = await caches.open(PAGES)
  const cached = catalog ? await pages.match(request, { ignoreVary: true }) : undefined

  const network = fetch(request).then(async (response) => {
    if (response.ok) {
      if (catalog) {
        pages.put(request, response.clone())
        //nombre, precio e imagen se guarda
        const job = indexProducts(response.clone())
        try {
          event.waitUntil(job)
        } catch {
          //segundo plano
        }
      }
      return response
    }
    //se usa el cache para cargar algo de perdida
    return cached || (catalog && (await offlineCatalogPage(url))) || response
  })
  network.catch(() => {}) //evita un aviso si la red pierde la carrera

  try {
    if (!cached) return await network
    return await Promise.race([network, wait(4000).then(() => cached)])
  } catch {
    return (
      cached ||
      (catalog && (await offlineCatalogPage(url))) ||
      (await caches.match(request, { ignoreVary: true })) ||
      (await caches.match('/offline.html')) ||
      offlineResponse()
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

//CATALOGO DE USO SIN CONEXION
const INDEX_KEY = '/__catalog-index'

const decode = (s = '') =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&')
const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const stripTags = (s = '') => decode(s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())

async function readIndex() {
  const cache = await caches.open(CATALOG)
  const hit = await cache.match(INDEX_KEY)
  return hit ? await hit.json() : {}
}

//se guardan las tarjetas
async function indexProducts(response) {
  try {
    const html = await response.text()
    const found = {}

    for (const [, id, inner] of html.matchAll(
      /<a\b[^>]*\bhref="\/products\/([^"?#/]+)"[^>]*>([\s\S]*?)<\/a>/g,
    )) {
      const name = inner.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/)
      if (!name) continue
      const price = inner.match(/<p\b[^>]*\bclass="[^"]*\bprice\b[^"]*"[^>]*>([\s\S]*?)<\/p>/)
      const img = inner.match(/<img\b[^>]*\bsrc="([^"]+)"/)
      const alt = inner.match(/<img\b[^>]*\balt="([^"]*)"/)

      found[id] = {
        id,
        name: stripTags(name[1]),
        price: price ? stripTags(price[1]) : '',
        img: img ? decode(img[1]) : '',
        alt: alt ? decode(alt[1]) : '',
      }
    }

    if (!Object.keys(found).length) return

    const index = { ...(await readIndex()), ...found }
    const cache = await caches.open(CATALOG)
    await cache.put(
      INDEX_KEY,
      new Response(JSON.stringify(index), { headers: { 'Content-Type': 'application/json' } }),
    )
  } catch {
    //opcional porque el resto funciona
  }
}

const STYLES = `
  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: #efe6d6;
    color: #2b241e;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }

  header {
    padding: 14px 20px;
    border-bottom: 1px solid #d8cbb3;
    background: #f6f1e7;
  }
  header a {
    color: #8b3a3a;
    font-weight: 700;
    text-decoration: none;
  }

  main {
    max-width: 720px;
    margin: 0 auto;
    padding: 20px;
  }

  .notice {
    background: #f6f1e7;
    border: 1px solid #d8cbb3;
    border-radius: 8px;
    padding: 12px 14px;
    color: #6a5f52;
    font-size: 14px;
    line-height: 1.45;
  }

  h1 { margin: 16px 0 6px; font-size: 26px; }
  .price { margin: 0 0 16px; font-size: 20px; font-weight: 700; color: #c98a2c; }

  .piece img {
    display: block;
    width: 100%;
    max-width: 400px;
    height: auto;
    aspect-ratio: 1 / 1;
    object-fit: cover;
    border-radius: 12px;
  }

  .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
  .actions a,
  .actions button {
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    padding: 10px 18px;
    border-radius: 8px;
    border: 2px solid #8b3a3a;
  }
  .actions button { background: #8b3a3a; color: #f6f1e7; }
  .actions a { color: #8b3a3a; }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 14px;
    margin-top: 16px;
  }

  .card {
    display: block;
    text-decoration: none;
    color: inherit;
    background: #f6f1e7;
    border: 1px solid #d8cbb3;
    border-radius: 10px;
    overflow: hidden;
  }
  .card img {
    display: block;
    width: 100%;
    height: auto;
    aspect-ratio: 1 / 1;
    object-fit: cover;
  }
  .card div { padding: 10px; }
  .card b { display: block; font-size: 14px; }
  .card span { font-size: 13px; color: #6a5f52; }
`

const page = (title, body) => `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#8b3a3a">
  <title>${esc(title)} | Hilo y Alma</title>
  <style>${STYLES}</style>
</head>
<body>
  <header><a href="/">✳ Hilo y Alma</a></header>
  <main>${body}</main>
  <script>addEventListener('online', () => location.reload())</script>
</body>
</html>`

const htmlResponse = (html) =>
  new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })

function productHtml(p) {
  const img = p.img
    ? `<img src="${esc(p.img)}" alt="${esc(p.alt || p.name)}" width="400" height="400">`
    : ''
  return page(
    p.name,
    `<p class="notice">Sin conexión. Esto es lo que se guardó de esta pieza; la descripción completa y la disponibilidad se ven al volver a conectarte.</p>
<article class="piece">${img}<h1>${esc(p.name)}</h1><p class="price">${esc(p.price)}</p>
<div class="actions"><button type="button" onclick="location.reload()">Reintentar</button><a href="/">Ir al inicio</a></div></article>`,
  )
}

function listHtml(products, isHome) {
  const intro = isHome
    ? 'Sin conexión. Estas son las piezas guardadas en tu dispositivo.'
    : 'Sin conexión. Esta colección no está guardada, pero estas piezas sí:'
  const cards = products
    .map(
      (p) =>
        `<a class="card" href="/products/${esc(p.id)}">${p.img ? `<img src="${esc(p.img)}" alt="${esc(p.alt || p.name)}" width="300" height="300" loading="lazy">` : ''}<div><b>${esc(p.name)}</b><span>${esc(p.price)}</span></div></a>`,
    )
    .join('')
  return page(
    'Piezas guardadas',
    `<p class="notice">${intro}</p><div class="grid">${cards}</div>
<div class="actions"><button type="button" onclick="location.reload()">Reintentar</button></div>`,
  )
}

//se crea una pagina con lo guardado porque no hay respuesta buena
async function offlineCatalogPage(url) {
  const products = Object.values(await readIndex())
  if (!products.length) return null

  const match = url.pathname.match(/^\/products\/([^/]+)\/?$/)
  const product = match ? products.find((p) => p.id === match[1]) : null

  return htmlResponse(
    product ? productHtml(product) : listHtml(products, url.pathname === '/'),
  )
}