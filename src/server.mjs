// Media cache: a long-term, read-through cache of Vercel Blob objects, keyed by Blob pathname.
// Blob pathnames are immutable (every upload gets a unique path), so nothing is ever invalidated.
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { IndexStore } from './index-store.mjs'
import { diskPath, parsePathname, upstreamUrl, validatePathname } from './paths.mjs'

const META_DIR = '.cache-meta'
const CT_OK = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(;[\x20-\x7e]*)?$/
const ETAG_OK = /^(W\/)?"[\x21\x23-\x7e]*"$/
const CACHE_CONTROL = 'public, max-age=31536000, immutable'

class UpstreamError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function createMediaCache(config) {
  const dataDir = path.resolve(config.dataDir)
  const metaDir = path.join(dataDir, META_DIR)
  const tmpDir = path.join(metaDir, 'tmp')
  // Fail fast on a malformed origin; also the ONLY host we will ever contact.
  const upstreamOrigin = new URL(config.upstreamOrigin).origin

  fs.mkdirSync(dataDir, { recursive: true })
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.mkdirSync(tmpDir, { recursive: true })
  const index = new IndexStore(path.join(metaDir, 'index.jsonl'))
  index.load()

  const stats = {
    startedAt: new Date().toISOString(),
    hits: 0,
    upstreamFetches: 0, // upstream 200s that were stored
    upstreamPassthroughs: 0, // upstream 403/404 passed through
    negativeHits: 0,
    upstreamErrors: 0,
    lastError: null,
  }
  const inflight = new Map() // pathname -> Promise<entry>
  const negative = new Map() // pathname -> { status, body, until }
  let reservedBytes = 0

  const log = (obj) => console.log(JSON.stringify({ t: new Date().toISOString(), ...obj }))
  const recordError = (where, message) => {
    stats.lastError = { at: new Date().toISOString(), path: where, message: String(message).slice(0, 300) }
  }

  /** Does something already on disk block `dest`: a directory AT it, or a file where a parent directory must go? (Error codes differ per OS; asking the disk does not.) */
  async function collides(dest) {
    try {
      if ((await fsp.stat(dest)).isDirectory()) return true
    } catch {
      /* not there */
    }
    for (let dir = path.dirname(dest); dir.length > dataDir.length; dir = path.dirname(dir)) {
      try {
        if (!(await fsp.stat(dir)).isDirectory()) return true
      } catch {
        /* not there: fine */
      }
    }
    return false
  }

  // ---- fetch-once -------------------------------------------------------------------------------
  async function fetchAndStore(pathname) {
    const url = upstreamUrl(upstreamOrigin, pathname)
    if (url.origin !== upstreamOrigin) throw new Error('refusing non-configured origin')
    let res
    try {
      res = await fetch(url, {
        redirect: 'manual', // a redirect could point anywhere: never follow
        headers: { 'user-agent': 'media-cache', 'accept-encoding': 'identity' },
        signal: AbortSignal.timeout(config.upstreamTimeoutMs),
      })
    } catch (e) {
      throw new UpstreamError(502, `upstream unreachable: ${e.cause?.code || e.message}`)
    }
    if (res.status !== 200) {
      let body = ''
      try {
        body = (await res.text()).slice(0, 512)
      } catch {
        /* ignore */
      }
      // 3xx / 5xx are not relayed faithfully: 502. 4xx passes through.
      const status = res.status >= 400 && res.status < 500 ? res.status : 502
      throw new UpstreamError(status, body || `upstream status ${res.status}`)
    }

    const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(declared) && declared > config.maxObjectBytes) {
      res.body?.cancel?.().catch(() => {})
      throw new UpstreamError(413, 'object exceeds MAX_OBJECT_BYTES')
    }
    const reserve = Number.isFinite(declared) ? declared : 0
    if (config.maxCacheBytes && index.bytes + reservedBytes + reserve > config.maxCacheBytes) {
      res.body?.cancel?.().catch(() => {})
      throw new UpstreamError(507, 'cache is full (MAX_CACHE_BYTES)')
    }
    if (!res.body) throw new UpstreamError(502, 'upstream returned no body')

    reservedBytes += reserve
    const tmp = path.join(tmpDir, crypto.randomUUID())
    try {
      let written = 0
      const limiter = async function* (source) {
        for await (const chunk of source) {
          written += chunk.length
          if (written > config.maxObjectBytes) throw new UpstreamError(413, 'object exceeds MAX_OBJECT_BYTES')
          yield chunk
        }
      }
      try {
        await pipeline(Readable.fromWeb(res.body), limiter, fs.createWriteStream(tmp, { mode: 0o644 }))
      } catch (e) {
        // A body that dies mid-stream (upstream closed early) is an upstream failure, not ours.
        if (e instanceof UpstreamError) throw e
        throw new UpstreamError(502, `upstream body failed: ${e.cause?.code || e.message}`)
      }
      if (Number.isFinite(declared) && written !== declared) {
        throw new UpstreamError(502, `short upstream body: ${written} of ${declared}`)
      }
      const dest = diskPath(dataDir, pathname)
      try {
        await fsp.mkdir(path.dirname(dest), { recursive: true })
        await fsp.rename(tmp, dest) // atomic: readers see all of the file or none of it
      } catch (e) {
        // `x` and `x/y.jpg` cannot both live on disk (a file is not a directory).
        // Blob pathnames are unique per upload so this is not expected, but if it
        // happens answer a clear 409 rather than a 500 on every request.
        if (await collides(dest)) {
          throw new UpstreamError(409, 'path conflicts with another cached object (file vs directory)')
        }
        throw e
      }

      let contentType = res.headers.get('content-type') || ''
      if (contentType.length > 200 || !CT_OK.test(contentType)) contentType = 'application/octet-stream'
      let etag = res.headers.get('etag') || ''
      if (!ETAG_OK.test(etag)) etag = `"${written.toString(16)}-${crypto.randomBytes(6).toString('hex')}"`
      const entry = {
        path: pathname,
        size: written,
        contentType,
        etag,
        fetchedAt: new Date().toISOString(),
        lastServedAt: null,
        hits: 0,
      }
      index.put(entry)
      stats.upstreamFetches++
      log({ ev: 'fetched', path: pathname, bytes: written })
      return entry
    } finally {
      reservedBytes -= reserve
      await fsp.rm(tmp, { force: true }).catch(() => {})
    }
  }

  /** Return the index entry for `pathname`, fetching it from upstream if we do not hold it. */
  async function ensureHeld(pathname) {
    const held = index.get(pathname)
    if (held) {
      let st = null
      try {
        st = await fsp.stat(diskPath(dataDir, pathname))
      } catch {
        /* missing */
      }
      if (st && st.isFile() && st.size === held.size) return { entry: held, fetched: false }
      index.delete(pathname) // file vanished or was truncated: treat as a miss
      log({ ev: 'index-repair', path: pathname })
    }
    const neg = negative.get(pathname)
    if (neg) {
      if (neg.until > Date.now()) {
        stats.negativeHits++
        throw new UpstreamError(neg.status, neg.body)
      }
      negative.delete(pathname)
    }
    let p = inflight.get(pathname)
    const creator = !p
    if (!p) {
      p = fetchAndStore(pathname)
        .catch((e) => {
          if (e instanceof UpstreamError && (e.status === 403 || e.status === 404)) {
            if (negative.size > 10000) negative.clear()
            negative.set(pathname, { status: e.status, body: e.message, until: Date.now() + config.negativeTtlMs })
            stats.upstreamPassthroughs++
          } else {
            stats.upstreamErrors++
          }
          recordError(pathname, e.message)
          log({ ev: 'upstream-fail', path: pathname, status: e.status ?? 500, message: String(e.message).slice(0, 200) })
          throw e
        })
        .finally(() => inflight.delete(pathname))
      inflight.set(pathname, p)
    }
    return { entry: await p, fetched: creator }
  }

  // ---- HTTP -------------------------------------------------------------------------------------
  function corsAllows(origin) {
    if (!origin) return false
    return config.corsOrigins.some((allowed) => {
      if (allowed === '*') return true
      if (allowed.endsWith(':*')) {
        const prefix = allowed.slice(0, -1) // "http://localhost:"
        return origin.startsWith(prefix) && /^\d{1,5}$/.test(origin.slice(prefix.length))
      }
      return origin === allowed
    })
  }

  function baseHeaders(req) {
    const h = {
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      vary: 'Origin',
    }
    const origin = req.headers.origin
    if (corsAllows(origin)) {
      h['access-control-allow-origin'] = origin
      h['access-control-expose-headers'] = 'Content-Length, Content-Range, Accept-Ranges, ETag'
    }
    return h
  }

  function send(req, res, status, body, extra = {}) {
    const buf = Buffer.from(body)
    res.writeHead(status, {
      ...baseHeaders(req),
      'content-type': 'text/plain; charset=utf-8',
      'content-length': buf.length,
      ...extra,
    })
    res.end(req.method === 'HEAD' ? undefined : buf)
  }
  function sendJson(req, res, status, obj) {
    send(req, res, status, JSON.stringify(obj), { 'content-type': 'application/json' })
  }

  /** Parse a single `bytes=` range. Returns {start,end} | 'unsatisfiable' | null (ignore header). */
  function parseRange(header, size) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
    if (!m) return null // multi-range / garbage: serve the whole thing
    const [, a, b] = m
    if (a === '' && b === '') return null
    let start
    let end
    if (a === '') {
      const n = Number.parseInt(b, 10)
      if (n === 0) return 'unsatisfiable'
      start = Math.max(0, size - n)
      end = size - 1
    } else {
      start = Number.parseInt(a, 10)
      end = b === '' ? size - 1 : Math.min(Number.parseInt(b, 10), size - 1)
      if (start >= size || end < start) return 'unsatisfiable'
    }
    return { start, end }
  }

  async function serveHeld(req, res, entry, countHit) {
    const file = diskPath(dataDir, entry.path)
    const headers = {
      ...baseHeaders(req),
      'content-type': entry.contentType,
      etag: entry.etag,
      'cache-control': CACHE_CONTROL,
      'accept-ranges': 'bytes',
      'last-modified': new Date(entry.fetchedAt).toUTCString(),
    }
    const inm = req.headers['if-none-match']
    if (inm && inm.split(',').some((t) => t.trim() === entry.etag || t.trim() === '*')) {
      res.writeHead(304, headers)
      return res.end()
    }
    let range = null
    const rh = req.headers.range
    const ifRange = req.headers['if-range']
    if (rh && (!ifRange || ifRange === entry.etag)) range = parseRange(rh, entry.size)
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${entry.size}`, 'content-length': 0 })
      return res.end()
    }
    if (countHit) {
      index.touch(entry, new Date().toISOString())
      stats.hits++
    }
    if (range) {
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${range.start}-${range.end}/${entry.size}`,
        'content-length': range.end - range.start + 1,
      })
    } else {
      res.writeHead(200, { ...headers, 'content-length': entry.size })
    }
    if (req.method === 'HEAD') return res.end()
    const stream = fs.createReadStream(file, range ? { start: range.start, end: range.end } : {})
    try {
      await pipeline(stream, res)
    } catch {
      /* client went away mid-stream: nothing to do */
    }
  }

  async function handleGet(req, res, pathname) {
    try {
      const { entry, fetched } = await ensureHeld(pathname)
      // The request that triggered the upstream fetch is a miss, not a hit.
      return await serveHeld(req, res, entry, !fetched)
    } catch (e) {
      if (res.headersSent) return res.destroy()
      if (e instanceof UpstreamError) {
        return send(req, res, e.status, e.message, { 'cache-control': 'no-store' })
      }
      recordError(pathname, e.message)
      log({ ev: 'error', path: pathname, message: e.message })
      return send(req, res, 500, 'internal error', { 'cache-control': 'no-store' })
    }
  }

  function bearerOk(req, token) {
    if (!token) return false
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '')
    if (!m) return false
    const a = crypto.createHash('sha256').update(m[1]).digest()
    const b = crypto.createHash('sha256').update(token).digest()
    return crypto.timingSafeEqual(a, b)
  }
  const tokenOk = (req) => bearerOk(req, config.prewarmToken)

  async function readBody(req, limit) {
    let size = 0
    const chunks = []
    for await (const c of req) {
      size += c.length
      if (size > limit) throw new Error('body too large')
      chunks.push(c)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  async function handlePrewarm(req, res) {
    if (!config.prewarmToken) return send(req, res, 404, 'prewarm disabled')
    if (!tokenOk(req)) return send(req, res, 401, 'unauthorized', { 'www-authenticate': 'Bearer' })
    let paths
    try {
      paths = JSON.parse(await readBody(req, 2 * 1024 * 1024)).paths
      if (!Array.isArray(paths) || paths.length > 10000) throw new Error('paths must be an array of <= 10000')
    } catch (e) {
      return send(req, res, 400, `bad request: ${e.message}`)
    }
    const results = { total: paths.length, fetched: 0, alreadyHeld: 0, failed: [] }
    let next = 0
    const worker = async () => {
      while (next < paths.length) {
        const raw = paths[next++]
        const p = validatePathname(typeof raw === 'string' ? raw : '')
        if (!p) {
          results.failed.push({ path: String(raw).slice(0, 200), status: 400 })
          continue
        }
        try {
          const { fetched } = await ensureHeld(p)
          if (fetched) results.fetched++
          else results.alreadyHeld++
        } catch (e) {
          results.failed.push({ path: p, status: e.status ?? 500, message: String(e.message).slice(0, 120) })
        }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()])
    sendJson(req, res, 200, results)
  }

  async function handle(req, res) {
    const target = req.url || '/'
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...baseHeaders(req),
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        'access-control-allow-headers': 'Range, If-None-Match, If-Range',
        'access-control-max-age': '86400',
      })
      return res.end()
    }
    const bare = target.split('?')[0]
    if (bare === '/_health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'method not allowed', { allow: 'GET, HEAD' })
      return sendJson(req, res, 200, { ok: true })
    }
    if (bare === '/_stats') {
      if (config.statsToken && !bearerOk(req, config.statsToken)) {
        return send(req, res, 401, 'unauthorized', { 'www-authenticate': 'Bearer' })
      }
      return sendJson(req, res, 200, {
        files: index.map.size,
        bytes: index.bytes,
        hits: stats.hits,
        upstreamFetches: stats.upstreamFetches,
        upstreamPassthroughs: stats.upstreamPassthroughs,
        negativeCacheHits: stats.negativeHits,
        upstreamErrors: stats.upstreamErrors,
        inflight: inflight.size,
        lastError: stats.lastError,
        startedAt: stats.startedAt,
        upstreamOrigin,
      })
    }
    if (bare === '/_prewarm') {
      if (req.method !== 'POST') return send(req, res, 405, 'method not allowed', { allow: 'POST' })
      return handlePrewarm(req, res)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(req, res, 405, 'method not allowed', { allow: 'GET, HEAD, OPTIONS' })
    }
    const pathname = parsePathname(target)
    if (!pathname) return send(req, res, 400, 'invalid path')
    return handleGet(req, res, pathname)
  }

  const server = http.createServer((req, res) => {
    const started = Date.now()
    res.on('finish', () =>
      log({ ev: 'req', m: req.method, url: (req.url || '').slice(0, 200), status: res.statusCode, ms: Date.now() - started }),
    )
    handle(req, res).catch((e) => {
      recordError(req.url, e.message)
      if (!res.headersSent) send(req, res, 500, 'internal error')
      else res.destroy()
    })
  })
  server.requestTimeout = 0 // long video streams; LAN-only service
  server.headersTimeout = 30000

  const flushTimer = setInterval(() => {
    try {
      index.flush()
    } catch (e) {
      recordError('index', e.message)
    }
  }, config.flushIntervalMs)
  flushTimer.unref()

  return {
    server,
    stats,
    listen: (port = config.port, host = '0.0.0.0') =>
      new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))),
    close: () =>
      new Promise((resolve) => {
        clearInterval(flushTimer)
        server.closeAllConnections?.()
        server.close(() => {
          index.flush()
          resolve()
        })
      }),
  }
}
