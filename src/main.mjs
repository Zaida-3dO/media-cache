import { configFromEnv } from './config.mjs'
import { createMediaCache } from './server.mjs'

let config
try {
  config = configFromEnv()
} catch (e) {
  console.error(JSON.stringify({ ev: 'config-error', message: e.message }))
  process.exit(1)
}
const cache = createMediaCache(config)
const addr = await cache.listen(config.port)
console.log(
  JSON.stringify({ ev: 'listening', port: addr.port, dataDir: config.dataDir, upstream: config.upstreamOrigin }),
)

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await cache.close()
    process.exit(0)
  })
}
