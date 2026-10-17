// Usage: PREWARM_TOKEN=... node prewarm-cli.mjs <cache-base-url> <file-with-one-pathname-per-line>
// Posts the list to the running cache's /_prewarm in batches of 200.
import fs from 'node:fs'

const [base, file] = process.argv.slice(2)
const token = process.env.PREWARM_TOKEN
if (!base || !file || !token) {
  console.error('usage: PREWARM_TOKEN=... node prewarm-cli.mjs <base-url> <pathnames.txt>')
  process.exit(2)
}
const paths = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .map((s) => s.trim().replace(/^\/+/, ''))
  .filter(Boolean)
let fetched = 0
let held = 0
const failed = []
for (let i = 0; i < paths.length; i += 200) {
  const res = await fetch(new URL('/_prewarm', base), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ paths: paths.slice(i, i + 200) }),
  })
  if (!res.ok) {
    console.error(`batch at ${i}: HTTP ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  const r = await res.json()
  fetched += r.fetched
  held += r.alreadyHeld
  failed.push(...r.failed)
  console.log(
    `${Math.min(i + 200, paths.length)}/${paths.length} fetched=${fetched} alreadyHeld=${held} failed=${failed.length}`,
  )
}
if (failed.length) console.error(JSON.stringify(failed.slice(0, 20), null, 1))
process.exit(failed.length ? 1 : 0)
