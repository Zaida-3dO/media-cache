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

  it('UPSTREAM_ORIGIN accepts a bare origin, with or without a trailing slash', () => {
    assert.equal(configFromEnv({ UPSTREAM_ORIGIN: STORE }).upstreamOrigin, STORE)
    assert.equal(configFromEnv({ UPSTREAM_ORIGIN: `${STORE}/` }).upstreamOrigin, STORE)
  })

  it('UPSTREAM_ORIGIN rejects anything that is not a bare http(s) origin, naming the variable', () => {
    for (const bad of [
      'store.example.com',
      'ftp://store.example.com',
      'https://user:pw@store.example.com',
      'https://user@store.example.com',
      'https://store.example.com/foo',
      'https://store.example.com?x=1',
      'https://store.example.com/#frag',
    ]) {
      assert.throws(() => configFromEnv({ UPSTREAM_ORIGIN: bad }), /UPSTREAM_ORIGIN/, bad)
    }
  })
})
