const API_ORIGIN = (() => {
  try {
    return new URL(import.meta.env.PUBLIC_API_URL).origin
  } catch {
    return ''
  }
})()

//imagenes en backend
export function imageUrl(url = '') {
  try {
    const parsed = new URL(url)
    if (API_ORIGIN && parsed.pathname.startsWith('/images/')) {
      return API_ORIGIN + parsed.pathname
    }
  } catch {
    //no vale esa url
  }
  return url
}

export function thumbUrl(url = '') {
  const full = imageUrl(url)
  return full.endsWith('.webp') ? full.replace(/\.webp$/, '-400.webp') : full
}