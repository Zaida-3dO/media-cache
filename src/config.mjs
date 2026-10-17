export const DEFAULT_CORS_ORIGINS = 'http://localhost:*,http://127.0.0.1:*'

function int(v, d) {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : d
}

export function configFromEnv(env = process.env) {
  // Required: the public base URL of the one Blob store to mirror. No default: every store's differs.
  if (!env.UPSTREAM_ORIGIN) {
    throw new Error('UPSTREAM_ORIGIN is required (e.g. https://<store-id>.public.blob.vercel-storage.com)')
  }
  return {
    port: int(env.PORT, 8080),
    dataDir: env.DATA_DIR || '/data',
    upstreamOrigin: env.UPSTREAM_ORIGIN,
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
