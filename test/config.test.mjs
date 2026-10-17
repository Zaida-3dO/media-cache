import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { configFromEnv } from '../src/config.mjs'

const STORE = 'https://store.example.com'

describe('config', () => {
  it('requires UPSTREAM_ORIGIN: there is no default store', () => {
    assert.throws(() => configFromEnv({}), /UPSTREAM_ORIGIN is required/)
    assert.throws(() => configFromEnv({ UPSTREAM_ORIGIN: '' }), /UPSTREAM_ORIGIN is required/)
    assert.equal(configFromEnv({ UPSTREAM_ORIGIN: STORE }).upstreamOrigin, STORE)
  })

  it('CORS defaults to localhost dev ports only', () => {
    assert.deepEqual(configFromEnv({ UPSTREAM_ORIGIN: STORE }).corsOrigins, ['http://localhost:*', 'http://127.0.0.1:*'])
  })

  it('CORS_ORIGINS replaces the default; an empty value allows no origin', () => {
    const c = configFromEnv({ UPSTREAM_ORIGIN: STORE, CORS_ORIGINS: ' https://admin.example.com , http://localhost:* ' })
    assert.deepEqual(c.corsOrigins, ['https://admin.example.com', 'http://localhost:*'])
    assert.deepEqual(configFromEnv({ UPSTREAM_ORIGIN: STORE, CORS_ORIGINS: '' }).corsOrigins, [])
  })
})
