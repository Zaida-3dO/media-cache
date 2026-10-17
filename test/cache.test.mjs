import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { createMediaCache } from '../src/server.mjs'

// ---- fake upstream -------------------------------------------------------------------------
const BODY = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251))
let upstream
let upstreamPort
let upstreamCalls // path -> count
let upstreamDelayMs
let evil // a second listener a redirect points at: must never be contacted
let evilPort
let evilHits = 0
let upstreamSeen // raw request headers of the last call

function startUpstream() {
  upstream = http.createServer((req, res) => {
    upstreamCalls[req.url] = (upstreamCalls[req.url] || 0) + 1
    upstreamSeen = req.headers
    const reply = () => {
      if (req.url === '/blocked/x.jpg') {
        res.writeHead(403, { 'content-type': 'text/plain' })
        return res.end('Your store is blocked')
      }
      if (req.url === '/missing.jpg') {
        res.writeHead(404)
        return res.end('nope')
      }
      if (req.url === '/redirect.jpg') {
        res.writeHead(302, { location: `http://127.0.0.1:${evilPort}/evil` })
        return res.end()
      }
      if (req.url === '/boom.jpg') {
        res.writeHead(500)
        return res.end('x')
      }
      if (req.url === '/nolen.bin' || req.url === '/nolen-big.bin') {
        // No Content-Length: Node sends it chunked.
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.write(Buffer.alloc(300, 7))
        return res.end(Buffer.alloc(req.url === '/nolen.bin' ? 0 : 4700, 7))
      }
      if (req.url === '/short.bin') {
        res.writeHead(200, { 'content-length': 1000 })
        res.write(Buffer.alloc(400))
        return setTimeout(() => res.socket.destroy(), 20)
      }
      if (req.url === '/slow1.jpg' || req.url === '/slow2.jpg') {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': 1000 })
        res.write(BODY.subarray(0, 500))
        return setTimeout(() => res.end(BODY.subarray(500)), 400)
      }
      if (req.url === '/big.bin') {
        res.writeHead(200, { 'content-length': 5000 })
        return res.end(Buffer.alloc(5000))
      }
      res.writeHead(200, {
        'content-type': req.url.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg',
        'content-length': BODY.length,
        etag: '"upstream-etag"',
      })
      res.end(BODY)
    }
    if (upstreamDelayMs) setTimeout(reply, upstreamDelayMs)
    else reply()
  })
  return new Promise((r) => upstream.listen(0, '127.0.0.1', () => ((upstreamPort = upstream.address().port), r())))
}

// ---- helpers -------------------------------------------------------------------------------
const dirs = []
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'media-cache-test-'))
  dirs.push(d)
  return d
}
async function start(dataDir, over = {}) {
  const cache = createMediaCache({
    port: 0,
    dataDir,
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    corsOrigins: ['https://admin.example.com', 'http://localhost:*'],
    prewarmToken: 'secret-token',
    negativeTtlMs: 60000,
    maxObjectBytes: 1024 ** 3,
    maxCacheBytes: 0,
    upstreamTimeoutMs: 5000,
    flushIntervalMs: 60000,
    ...over,
  })
  const addr = await cache.listen(0, '127.0.0.1')
  return { cache, base: `http://127.0.0.1:${addr.port}` }
}
// Raw request so the client does not normalise `..` out of the path before it is sent.
function raw(base, target, method = 'GET') {
  const { port } = new URL(base)
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(port), '127.0.0.1', () => s.write(`${method} ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`))
    let data = ''
    s.on('data', (c) => (data += c))
    s.on('end', () => resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)[1]), data }))
    s.on('error', reject)
  })
}

before(async () => {
  evil = http.createServer((req, res) => {
    evilHits++
    res.end('evil')
  })
  await new Promise((r) => evil.listen(0, '127.0.0.1', () => ((evilPort = evil.address().port), r())))
  await startUpstream()
})
after(() => {
  evil.closeAllConnections()
  evil.close()
  upstream.closeAllConnections()
  upstream.close()
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})
beforeEach(() => {
  upstreamCalls = {}
  upstreamDelayMs = 0
})

describe('media cache', () => {
  it('miss -> fetch -> store -> serve, with correct headers', async () => {
    const dir = tmpDir()
    const { cache, base } = await start(dir)
    try {
      const r = await fetch(`${base}/admin/a.jpg`)
      assert.equal(r.status, 200)
      assert.equal(r.headers.get('content-type'), 'image/jpeg')
      assert.equal(r.headers.get('content-length'), String(BODY.length))
      assert.equal(r.headers.get('etag'), '"upstream-etag"')
      assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable')
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), BODY)
      assert.equal(upstreamCalls['/admin/a.jpg'], 1)
      assert.deepEqual(fs.readFileSync(path.join(dir, 'admin', 'a.jpg')), BODY)
      // only the one configured upstream, with no client headers forwarded
      assert.equal(upstreamSeen.cookie, undefined)
    } finally {
      await cache.close()
    }
  })

  it('hit is served without calling the upstream; HEAD works; If-None-Match gives 304', async () => {
    const { cache, base } = await start(tmpDir())
    try {
      await (await fetch(`${base}/admin/a.jpg`)).arrayBuffer()
      const r = await fetch(`${base}/admin/a.jpg`)
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), BODY)
      const h = await fetch(`${base}/admin/a.jpg`, { method: 'HEAD' })
      assert.equal(h.status, 200)
      assert.equal(h.headers.get('content-length'), String(BODY.length))
      const nm = await fetch(`${base}/admin/a.jpg`, { headers: { 'if-none-match': '"upstream-etag"' } })
      assert.equal(nm.status, 304)
      assert.equal(upstreamCalls['/admin/a.jpg'], 1)
    } finally {
      await cache.close()
    }
  })

  it('concurrent misses coalesce into ONE upstream fetch', async () => {
    upstreamDelayMs = 150
    const { cache, base } = await start(tmpDir())
    try {
      const rs = await Promise.all(Array.from({ length: 8 }, () => fetch(`${base}/vid/c.mp4`)))
      for (const r of rs) {
        assert.equal(r.status, 200)
        assert.deepEqual(Buffer.from(await r.arrayBuffer()), BODY)
      }
      assert.equal(upstreamCalls['/vid/c.mp4'], 1)
      const s = await (await fetch(`${base}/_stats`)).json()
      assert.equal(s.upstreamFetches, 1)
    } finally {
      await cache.close()
    }
  })

  it('serves Range requests from disk (206, suffix, open-ended) and 416 when unsatisfiable', async () => {
    const { cache, base } = await start(tmpDir())
    try {
      // first request is a RANGE on a miss: must still fetch whole file once, never forward the range
      const r1 = await fetch(`${base}/vid/r.mp4`, { headers: { range: 'bytes=10-19' } })
      assert.equal(r1.status, 206)
      assert.equal(r1.headers.get('content-range'), `bytes 10-19/${BODY.length}`)
      assert.equal(r1.headers.get('content-length'), '10')
      assert.deepEqual(Buffer.from(await r1.arrayBuffer()), BODY.subarray(10, 20))
      assert.equal(upstreamSeen.range, undefined)

      const r2 = await fetch(`${base}/vid/r.mp4`, { headers: { range: 'bytes=990-' } })
      assert.equal(r2.status, 206)
      assert.deepEqual(Buffer.from(await r2.arrayBuffer()), BODY.subarray(990))
      const r3 = await fetch(`${base}/vid/r.mp4`, { headers: { range: 'bytes=-5' } })
      assert.deepEqual(Buffer.from(await r3.arrayBuffer()), BODY.subarray(995))
      const r4 = await fetch(`${base}/vid/r.mp4`, { headers: { range: 'bytes=5000-6000' } })
      assert.equal(r4.status, 416)
      assert.equal(r4.headers.get('content-range'), `bytes */${BODY.length}`)
      assert.equal(upstreamCalls['/vid/r.mp4'], 1)
    } finally {
      await cache.close()
    }
  })

  it('passes upstream 403 and 404 through and never caches them (short negative cache only)', async () => {
    const dir = tmpDir()
    const { cache, base } = await start(dir)
    try {
      const a = await fetch(`${base}/blocked/x.jpg`)
      assert.equal(a.status, 403)
      assert.match(await a.text(), /store is blocked/)
      const b = await fetch(`${base}/blocked/x.jpg`)
      assert.equal(b.status, 403)
      assert.equal(upstreamCalls['/blocked/x.jpg'], 1, 'negative cache avoids hammering')
      const c = await fetch(`${base}/missing.jpg`)
      assert.equal(c.status, 404)
      assert.equal(fs.existsSync(path.join(dir, 'blocked')), false)
      assert.equal(fs.existsSync(path.join(dir, 'missing.jpg')), false)
      const s = await (await fetch(`${base}/_stats`)).json()
      assert.equal(s.files, 0)
      assert.equal(s.bytes, 0)
      assert.equal(s.upstreamFetches, 0)
      assert.equal(s.upstreamPassthroughs, 2)
      assert.equal(s.negativeCacheHits, 1)
    } finally {
      await cache.close()
    }
  })

  it('negative cache expires: a later request retries the upstream and then caches a 200', async () => {
    const { cache, base } = await start(tmpDir(), { negativeTtlMs: 1 })
    try {
      await fetch(`${base}/blocked/x.jpg`)
      await new Promise((r) => setTimeout(r, 20))
      await fetch(`${base}/blocked/x.jpg`)
      assert.equal(upstreamCalls['/blocked/x.jpg'], 2)
    } finally {
      await cache.close()
    }
  })

  it('does not follow upstream redirects and maps 5xx to 502', async () => {
    const { cache, base } = await start(tmpDir())
    try {
      assert.equal((await fetch(`${base}/redirect.jpg`)).status, 502)
      assert.equal(evilHits, 0)
      assert.equal((await fetch(`${base}/boom.jpg`)).status, 502)
    } finally {
      await cache.close()
    }
  })

  it('rejects path traversal and other unsafe paths without touching upstream or disk', async () => {
    const dir = tmpDir()
    const { cache, base } = await start(dir)
    try {
      const bad = [
        '/../etc/passwd',
        '/a/../../etc/passwd',
        '/%2e%2e/etc/passwd',
        '/a/%2e%2e/%2e%2e/x',
        '/a%2f..%2f..%2fx',
        '/a//b.jpg',
        '/a/./b.jpg',
        '/a%00.jpg',
        '/a%5c..%5cb.jpg',
        '/%',
        '/.cache-meta/index.jsonl',
        '/_secret',
        '/',
      ]
      for (const t of bad) {
        const r = await raw(base, t)
        assert.equal(r.status, 400, `${t} -> ${r.status}`)
      }
      assert.deepEqual(upstreamCalls, {})
    } finally {
      await cache.close()
    }
  })

  it('never contacts any host but the configured upstream (absolute-URL request targets)', async () => {
    const { cache, base } = await start(tmpDir())
    try {
      const r = await raw(base, 'http://evil.example/x.jpg')
      assert.equal(r.status, 400)
      const r2 = await raw(base, '//evil.example/x.jpg')
      assert.equal(r2.status, 400)
      assert.deepEqual(upstreamCalls, {})
    } finally {
      await cache.close()
    }
  })

  it('restart keeps the index and the files: still a hit, no upstream call, hit counter persisted', async () => {
    const dir = tmpDir()
    let { cache, base } = await start(dir)
    await (await fetch(`${base}/admin/p.jpg`)).arrayBuffer()
    await (await fetch(`${base}/admin/p.jpg`)).arrayBuffer()
    await cache.close()
    assert.equal(upstreamCalls['/admin/p.jpg'], 1)
    ;({ cache, base } = await start(dir))
    try {
      const s0 = await (await fetch(`${base}/_stats`)).json()
      assert.equal(s0.files, 1)
      assert.equal(s0.bytes, BODY.length)
      const r = await fetch(`${base}/admin/p.jpg`)
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), BODY)
      assert.equal(r.headers.get('etag'), '"upstream-etag"')
      assert.equal(upstreamCalls['/admin/p.jpg'], 1)
      await cache.close()
      const lines = fs.readFileSync(path.join(dir, '.cache-meta', 'index.jsonl'), 'utf8').trim().split('\n')
      assert.equal(lines.length, 1)
      assert.equal(JSON.parse(lines[0]).hits, 2) // 1 before restart + 1 after
    } finally {
      await cache.close().catch(() => {})
    }
  })

  it('refetches when the held file has vanished from disk (index repair)', async () => {
    const dir = tmpDir()
    const { cache, base } = await start(dir)
    try {
      await (await fetch(`${base}/admin/g.jpg`)).arrayBuffer()
      fs.rmSync(path.join(dir, 'admin', 'g.jpg'))
      const r = await fetch(`${base}/admin/g.jpg`)
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), BODY)
      assert.equal(upstreamCalls['/admin/g.jpg'], 2)
    } finally {
      await cache.close()
    }
  })

  it('stats count hits vs upstream fetches; health is ok', async () => {
    const { cache, base } = await start(tmpDir())
    try {
      assert.deepEqual(await (await fetch(`${base}/_health`)).json(), { ok: true })
      await (await fetch(`${base}/admin/s.jpg`)).arrayBuffer()
      await (await fetch(`${base}/admin/s.jpg`)).arrayBuffer()
      const s = await (await fetch(`${base}/_stats`)).json()
      assert.equal(s.upstreamFetches, 1)
      assert.equal(s.hits, 1)
      assert.equal(s.files, 1)
    } finally {
      await cache.close()
    }
  })

  it('enforces MAX_OBJECT_BYTES and MAX_CACHE_BYTES without leaving partial files', async () => {
    const dir = tmpDir()
    const { cache, base } = await start(dir, { maxObjectBytes: 2000 })
    try {
      assert.equal((await fetch(`${base}/big.bin`)).status, 413)
    } finally {
      await cache.close()
    }
    const dir2 = tmpDir()
    const s2 = await start(dir2, { maxCacheBytes: 1500 })
    try {
      assert.equal((await fetch(`${s2.base}/one.jpg`)).status, 200) // 1000
      assert.equal((await fetch(`${s2.base}/two.jpg`)).status, 507) // would exceed 1500
      assert.equal(fs.existsSync(path.join(dir2, 'two.jpg')), false)
      assert.deepEqual(fs.readdirSync(path.join(dir2, '.cache-meta', 'tmp')), [])
    } finally {
      await s2.cache.close()
    }
  })

  it('stores an upstream body that has no Content-Length, serving it with the true length', async () => {
    const dir = tmpDir()
    const { cache, base } = await start(dir)
    try {
      const r = await fetch(`${base}/nolen.bin`)
      assert.equal(r.status, 200)
      assert.equal((await r.arrayBuffer()).byteLength, 300)
      const again = await fetch(`${base}/nolen.bin`)
      assert.equal(again.headers.get('content-length'), '300')
      assert.equal(upstreamCalls['/nolen.bin'], 1)
    } finally {
      await cache.close()
    }
    // With no declared length the limiter is the only guard: it must still stop the body.
    const dir2 = tmpDir()
    const s2 = await start(dir2, { maxObjectBytes: 2000 })
    try {
      assert.equal((await fetch(`${s2.base}/nolen-big.bin`)).status, 413)
      assert.equal(fs.existsSync(path.join(dir2, 'nolen-big.bin')), false)
      assert.deepEqual(fs.readdirSync(path.join(dir2, '.cache-meta', 'tmp')), [])
    } finally {
      await s2.cache.close()
    }
  })

  it('a truncated upstream body gives 502, stores nothing and leaves no temp file', async () => {
    const dir = tmpDir()
    const { cache, base } = await start(dir)
    try {
      assert.equal((await fetch(`${base}/short.bin`)).status, 502)
      assert.equal(fs.existsSync(path.join(dir, 'short.bin')), false)
      assert.deepEqual(fs.readdirSync(path.join(dir, '.cache-meta', 'tmp')), [])
      assert.equal((await (await fetch(`${base}/_stats`)).json()).files, 0)
    } finally {
      await cache.close()
    }
  })

  it('MAX_CACHE_BYTES counts bytes of downloads still in flight', async () => {
    const { cache, base } = await start(tmpDir(), { maxCacheBytes: 1500 })
    try {
      const first = fetch(`${base}/slow1.jpg`)
      await new Promise((r) => setTimeout(r, 150)) // first has its headers: 1000 bytes reserved
      assert.equal((await fetch(`${base}/slow2.jpg`)).status, 507)
      assert.equal((await first).status, 200)
      // the reservation is released when the download ends: it is the stored 1000 that counts now
      assert.equal((await fetch(`${base}/after.jpg`)).status, 507)
      assert.equal((await (await fetch(`${base}/_stats`)).json()).files, 1)
    } finally {
      await cache.close()
    }
  })

  it('a file and a directory cannot share a name: the second gets 409, not a 500, and nothing is lost', async () => {
    const dir = tmpDir()
    const { cache, base } = await start(dir)
    try {
      assert.equal((await fetch(`${base}/col/x`)).status, 200)
      assert.equal((await fetch(`${base}/col/x/y.jpg`)).status, 409)
      assert.equal((await fetch(`${base}/col2/x/y.jpg`)).status, 200)
      assert.equal((await fetch(`${base}/col2/x`)).status, 409)
      // both survivors are still served from disk
      assert.equal((await fetch(`${base}/col/x`)).status, 200)
      assert.equal((await fetch(`${base}/col2/x/y.jpg`)).status, 200)
      assert.deepEqual(fs.readdirSync(path.join(dir, '.cache-meta', 'tmp')), [])
      assert.equal((await (await fetch(`${base}/_stats`)).json()).files, 2)
    } finally {
      await cache.close()
    }
  })

  it('CORS port wildcard needs a 1-5 digit port', async () => {
    const { cache, base } = await start(tmpDir())
    try {
      const acao = async (origin) =>
        (await fetch(`${base}/admin/o.jpg`, { headers: { origin } })).headers.get('access-control-allow-origin')
      assert.equal(await acao('http://localhost:65535'), 'http://localhost:65535')
      assert.equal(await acao('http://localhost:'), null)
      assert.equal(await acao('http://localhost:123456'), null)
      assert.equal(await acao('http://localhost:80a'), null)
      assert.equal(await acao('http://localhost:80/x'), null)
      assert.equal(await acao('https://localhost:3000'), null) // scheme is part of the match
    } finally {
      await cache.close()
    }
  })

  it('/_stats requires the bearer token when STATS_TOKEN is set; /_health never does', async () => {
    const { cache, base } = await start(tmpDir(), { statsToken: 'stats-secret' })
    try {
      assert.equal((await fetch(`${base}/_stats`)).status, 401)
      assert.equal((await fetch(`${base}/_stats`, { headers: { authorization: 'Bearer wrong' } })).status, 401)
      assert.equal((await fetch(`${base}/_stats`, { headers: { authorization: 'Bearer stats-secret' } })).status, 200)
      assert.equal((await fetch(`${base}/_health`)).status, 200)
    } finally {
      await cache.close()
    }
  })

  it('CORS: allows the admin origin and localhost dev ports, not others; OPTIONS preflight', async () => {
    const { cache, base } = await start(tmpDir())
    try {
      const ok = await fetch(`${base}/admin/o.jpg`, { headers: { origin: 'https://admin.example.com' } })
      assert.equal(ok.headers.get('access-control-allow-origin'), 'https://admin.example.com')
      const dev = await fetch(`${base}/admin/o.jpg`, { headers: { origin: 'http://localhost:3011' } })
      assert.equal(dev.headers.get('access-control-allow-origin'), 'http://localhost:3011')
      const evil = await fetch(`${base}/admin/o.jpg`, { headers: { origin: 'http://localhost.evil.com' } })
      assert.equal(evil.headers.get('access-control-allow-origin'), null)
      const evil2 = await fetch(`${base}/admin/o.jpg`, { headers: { origin: 'https://evil.com' } })
      assert.equal(evil2.headers.get('access-control-allow-origin'), null)
      const pre = await fetch(`${base}/admin/o.jpg`, { method: 'OPTIONS', headers: { origin: 'https://admin.example.com' } })
      assert.equal(pre.status, 204)
      assert.match(pre.headers.get('access-control-allow-headers'), /Range/)
    } finally {
      await cache.close()
    }
  })

  it('prewarm requires the token, validates paths, fetches once, reports held', async () => {
    const { cache, base } = await start(tmpDir())
    try {
      const body = JSON.stringify({ paths: ['w/1.jpg', 'w/2.jpg', '../bad', 'blocked/x.jpg'] })
      const noAuth = await fetch(`${base}/_prewarm`, { method: 'POST', body })
      assert.equal(noAuth.status, 401)
      const wrong = await fetch(`${base}/_prewarm`, { method: 'POST', body, headers: { authorization: 'Bearer nope' } })
      assert.equal(wrong.status, 401)
      assert.deepEqual(upstreamCalls, {})
      const h = { authorization: 'Bearer secret-token' }
      const ok = await (await fetch(`${base}/_prewarm`, { method: 'POST', body, headers: h })).json()
      assert.equal(ok.fetched, 2)
      assert.equal(ok.failed.length, 2)
      const again = await (await fetch(`${base}/_prewarm`, { method: 'POST', body, headers: h })).json()
      assert.equal(again.alreadyHeld, 2)
      assert.equal(again.fetched, 0)
      assert.equal(upstreamCalls['/w/1.jpg'], 1)
    } finally {
      await cache.close()
    }
  })

  it('prewarm is disabled (404) when no token is configured', async () => {
    const { cache, base } = await start(tmpDir(), { prewarmToken: '' })
    try {
      const r = await fetch(`${base}/_prewarm`, { method: 'POST', body: '{}', headers: { authorization: 'Bearer ' } })
      assert.equal(r.status, 404)
    } finally {
      await cache.close()
    }
  })

  it('rejects methods other than GET/HEAD/OPTIONS on object paths', async () => {
    const { cache, base } = await start(tmpDir())
    try {
      const r = await fetch(`${base}/admin/a.jpg`, { method: 'POST', body: 'x' })
      assert.equal(r.status, 405)
      assert.deepEqual(upstreamCalls, {})
    } finally {
      await cache.close()
    }
  })
})
