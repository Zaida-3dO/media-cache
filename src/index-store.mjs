// Small JSON-lines index: one line per held object. Loaded into a Map at start,
// appended on new objects, rewritten atomically on flush (hit counters etc.).
import fs from 'node:fs'
import path from 'node:path'

export class IndexStore {
  constructor(file) {
    this.file = file
    this.map = new Map()
    this.dirty = false
    this.bytes = 0
  }

  load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    let text = ''
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line)
        if (e && typeof e.path === 'string' && Number.isFinite(e.size)) this.map.set(e.path, e)
      } catch {
        /* torn last line after a crash: ignore */
      }
    }
    this.#recount()
  }

  #recount() {
    this.bytes = 0
    for (const e of this.map.values()) this.bytes += e.size
  }

  get(p) {
    return this.map.get(p)
  }

  put(entry) {
    const old = this.map.get(entry.path)
    if (old) this.bytes -= old.size
    this.map.set(entry.path, entry)
    this.bytes += entry.size
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n')
  }

  delete(p) {
    const old = this.map.get(p)
    if (!old) return
    this.bytes -= old.size
    this.map.delete(p)
    this.dirty = true
  }

  touch(entry, now) {
    entry.lastServedAt = now
    entry.hits = (entry.hits || 0) + 1
    this.dirty = true
  }

  flush() {
    if (!this.dirty) return
    const tmp = this.file + '.tmp'
    const body = [...this.map.values()].map((e) => JSON.stringify(e)).join('\n')
    fs.writeFileSync(tmp, body ? body + '\n' : '')
    fs.renameSync(tmp, this.file)
    this.dirty = false
  }
}
