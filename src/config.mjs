export const DEFAULT_CORS_ORIGINS = 'http://localhost:*,http://127.0.0.1:*'

function int(v, d) {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : d
}

// Returns the normalised origin, or throws an Error naming UPSTREAM_ORIGIN and the problem.
function parseUpstreamOrigin(v) {
  let u
  try {
    u = new URL(v)
  } catch {
    throw new Error('UPSTREAM_ORIGIN is not a valid URL (expected e.g. https://<store-id>.public.blob.vercel-storage.com)')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('UPSTREAM_ORIGIN must use http: or https:')
  if (u.username || u.password) throw new Error('UPSTREAM_ORIGIN must not contain a username or password')
  if (u.pathname !== '/' || u.search || u.hash) throw new Error('UPSTREAM_ORIGIN must be an origin only: no path, query or hash')
  return u.origin
}

export function configFromEnv(env = process.env) {
  // Required: the public base URL of the one Blob store to mirror. No default: every store's differs.
  if (!env.UPSTREAM_ORIGIN) {
    throw new Error('UPSTREAM_ORIGIN is required (e.g. https://<store-id>.public.blob.vercel-storage.com)')
  }
  return {
    port: int(env.PORT, 8080),
    dataDir: env.DATA_DIR || '/data',
    upstreamOrigin: parseUpstreamOrigin(env.UPSTREAM_ORIGIN),
    corsOrigins: (env.CORS_ORIGINS ?? DEFAULT_CORS_ORIGINS)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    prewarmToken: env.PREWARM_TOKEN || '',
    // When set, GET /_stats requires `Authorization: Bearer <token>`. Unset = open.
    statsToken: env.STATS_TOKEN || '',
    negativeTtlMs: int(env.NEGATIVE_TTL_SECONDS, 60) * 1000,
    maxObjectBytes: int(env.MAX_OBJECT_BYTES, 2 * 1024 ** 3),
    // 0 = unlimited. When set, NEW objects are refused (507) once full; nothing is evicted.
    maxCacheBytes: int(env.MAX_CACHE_BYTES, 0),
    upstreamTimeoutMs: int(env.UPSTREAM_TIMEOUT_SECONDS, 600) * 1000,
    flushIntervalMs: int(env.INDEX_FLUSH_SECONDS, 30) * 1000,
  }
}
