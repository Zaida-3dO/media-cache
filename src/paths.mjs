// Path handling for the media cache. Everything here is about ONE question:
// "is this request path a safe Blob pathname, and where does it live on disk?"
import path from 'node:path'

export const MAX_PATHNAME_LENGTH = 1024

/**
 * Turn a raw request target (`/admin/a%20b.jpg?x=1`) into a Blob pathname
 * (`admin/a b.jpg`), or return `null` if it is not safe.
 *
 * Rejected: bad percent-encoding, NUL / control characters, backslashes, empty,
 * `.` or `..` segments (also when percent-encoded, because we decode first),
 * empty segments (`//`), dot-prefixed or underscore-prefixed FIRST segments
 * (`.cache-meta` is our own metadata dir, `_stats`/`_health` are endpoints).
 */
export function parsePathname(rawTarget) {
  if (typeof rawTarget !== 'string' || rawTarget[0] !== '/') return null
  const q = rawTarget.search(/[?#]/)
  const rawPath = q === -1 ? rawTarget : rawTarget.slice(0, q)
  let decoded
  try {
    decoded = decodeURIComponent(rawPath.slice(1))
  } catch {
    return null
  }
  return validatePathname(decoded)
}

export function validatePathname(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATHNAME_LENGTH) return null
  if (/[\u0000-\u001f\u007f\\]/.test(p)) return null
  if (p.startsWith('/')) return null
  const segments = p.split('/')
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..') return null
    if (s.length > 255) return null
  }
  const first = segments[0]
  if (first.startsWith('.') || first.startsWith('_')) return null
  // Windows-style drive letters / absolute-ish forms.
  if (/^[a-zA-Z]:/.test(first)) return null
  return p
}

/** Absolute on-disk path for a validated pathname, guaranteed inside dataDir. */
export function diskPath(dataDir, pathname) {
  const root = path.resolve(dataDir)
  const full = path.resolve(root, ...pathname.split('/'))
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('path escapes data dir')
  }
  return full
}

/** The upstream URL for a validated pathname. Always `<origin>/<encoded path>`. */
export function upstreamUrl(origin, pathname) {
  const url = new URL(origin.replace(/\/+$/, '') + '/' + pathname.split('/').map(encodeURIComponent).join('/'))
  if (url.origin !== new URL(origin).origin) throw new Error('upstream origin mismatch')
  return url
}
