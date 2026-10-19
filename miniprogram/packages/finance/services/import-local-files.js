const protocol = require('../domain/import-review/local-review-protocol')
const { sha256 } = require('../domain/import-review/portable-digest')
const snapshot = require('../domain/import-review/local-review-snapshot')
const failure = (code, message) => Object.assign(new Error(message), { code })
const parse = text => JSON.parse(text)
const DEFAULT_CHUNK_CONCURRENCY = 4
const MAX_CHUNK_CONCURRENCY = 8

async function runPool(items, limit, worker) {
  let next = 0, firstError = null
  async function run() {
    while (!firstError) {
      const index = next++
      if (index >= items.length) return
      try { await worker(items[index], index) } catch (error) { if (!firstError) firstError = error; return }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  if (firstError) throw firstError
}

// The fs adapter uses only Mini Program synchronous file APIs. Decision deltas
// are small and serialized by JS. Network callbacks must check the generation
// before invoking any write. A verified commit file is the visibility barrier.
function create({ fs, root, scope, updateId, alive = () => true, chunkConcurrency = DEFAULT_CHUNK_CONCURRENCY }) {
  const directory = root + '/' + sha256(scope) + '/' + updateId
  const concurrency = Number.isInteger(chunkConcurrency) && chunkConcurrency > 0
    ? Math.min(chunkConcurrency, MAX_CHUNK_CONCURRENCY) : DEFAULT_CHUNK_CONCURRENCY
  let epoch = 0, closed = false, revision = 0, previous = '', generation = null
  function guard(ticket = epoch) {
    if (closed || ticket !== epoch || !alive()) throw failure('SESSION_CHANGED', '登录状态已改变，原草稿已停止保存')
  }
  function exists(file) { try { fs.accessSync(file); return true } catch (_) { return false } }
  function mkdir(file) { if (!exists(file)) fs.mkdirSync(file, true) }
  function read(file) { return fs.readFileSync(file, 'utf8') }
  function verified(file, text) {
    guard(); fs.writeFileSync(file, text, 'utf8')
    if (read(file) !== text) throw failure('DRAFT_STORAGE_FAILED', '本机写入未完成，原有草稿已保留')
  }
  function atomic(file, value) {
    const text = JSON.stringify(value), temp = file + '.writing'
    verified(temp, text); guard(); fs.renameSync(temp, file)
    if (read(file) !== text) throw failure('DRAFT_STORAGE_FAILED', '本机草稿尚未确认保存，请重试')
  }
  function io(work) {
    try { return work() } catch (error) {
      if (error.code && ['SESSION_CHANGED','SNAPSHOT_INCOMPLETE','LOCAL_REVIEW_CAPACITY','DRAFT_CORRUPT'].includes(error.code)) throw error
      throw failure('DRAFT_STORAGE_FAILED', '本机草稿未保存，请检查存储空间后重试')
    }
  }
  function journalPath() { return directory + '/' + generation + '/decisions' }
  function* readParts(header, parts) {
    for (const part of parts) yield protocol.validatePart(header, part, { ...part, objectId: header.objectId,
      baseVersion: header.baseVersion, content: read(directory + '/' + header.objectId + '/part-' + part.index + '.json') })
  }
  function restore() {
    guard()
    if (!exists(directory)) return null
    const candidates = fs.readdirSync(directory).filter(name => /^complete-\d+-[a-f0-9-]+\.json$/.test(name)).sort().reverse()
    let damaged = false
    for (const filename of candidates) {
      try {
        const complete = parse(read(directory + '/' + filename)), { header, parts } = complete
        protocol.validateManifest(header, parts)
        const facts = snapshot.validateFacts(snapshot.decodeParts(readParts(header, parts)), header)
        if (facts.snapshotId !== header.objectId || facts.update.updateId !== updateId || facts.update.version !== header.baseVersion) throw new Error('Mismatch')
        generation = header.objectId; revision = 0; previous = ''
        const records = [], folder = journalPath()
        if (exists(folder)) {
          const commits = fs.readdirSync(folder).filter(name => /^commit-\d{9}\.json$/.test(name)).sort()
          for (const name of commits) {
            const commit = parse(read(folder + '/' + name)), text = read(folder + '/delta-' + commit.revision + '.json')
            if (commit.revision !== revision + 1 || sha256(text) !== commit.digest) throw failure('DRAFT_CORRUPT', '已保存的决定文件损坏，完整基础草稿仍保留，请恢复后继续')
            const delta = parse(text)
            if (delta.revision !== commit.revision || delta.previous !== previous || delta.snapshotId !== generation) throw failure('DRAFT_CORRUPT', '本机决定版本不完整，草稿仍保留')
            records.push(delta); revision = delta.revision; previous = commit.digest
          }
        }
        return { header, facts, records, recoveredPrevious: damaged }
      } catch (error) {
        if (error.code === 'DRAFT_CORRUPT') throw error
        damaged = true
      }
    }
    if (damaged) throw failure('DRAFT_CORRUPT', '完整草稿文件校验失败，已保留原文件；联网重新准备后继续')
    return null
  }
  async function download(header, call, onProgress = () => {}) {
    const ticket = epoch, descriptors = []; let offset = 0
    guard(ticket); io(() => { mkdir(directory); mkdir(directory + '/' + header.objectId) })
    do {
      const result = await call('financeUpdates.snapshotManifest', { objectId: header.objectId, offset })
      guard(ticket)
      if (result.header.objectId !== header.objectId || result.header.baseVersion !== header.baseVersion || result.header.digest !== header.digest) throw failure('SNAPSHOT_INCOMPLETE', '草稿版本不一致，请重新准备')
      descriptors.push(...result.parts); offset = result.nextOffset
      if (descriptors.length > header.chunkCount || offset != null && offset !== descriptors.length) throw failure('SNAPSHOT_INCOMPLETE', '草稿分块清单不完整')
    } while (offset != null)
    protocol.validateManifest(header, descriptors)
    const folder = directory + '/' + header.objectId
    const done = new Set()
    for (const descriptor of descriptors) {
      const file = folder + '/part-' + descriptor.index + '.json'
      if (!exists(file)) continue
      try {
        const content = read(file)
        protocol.validatePart(header, descriptor, { ...descriptor, objectId: header.objectId,
          baseVersion: header.baseVersion, content })
        done.add(descriptor.index)
      } catch (_) {
        // A corrupt or stale part is not evidence; it will be replaced below.
      }
    }
    const reused = done.size
    onProgress({ completed: done.size, total: header.chunkCount, bytes: header.bytes, reused })
    await runPool(descriptors.filter(descriptor => !done.has(descriptor.index)), concurrency, async descriptor => {
      guard(ticket)
      const part = await call('financeUpdates.snapshotChunk', { objectId: header.objectId, index: descriptor.index })
      guard(ticket)
      const content = protocol.validatePart(header, descriptor, part)
      io(() => verified(folder + '/part-' + descriptor.index + '.json', content))
      done.add(descriptor.index)
      onProgress({ completed: done.size, total: header.chunkCount, bytes: header.bytes, reused })
    })
    guard(ticket)
    const facts = header.kind === 'snapshot' ? snapshot.validateFacts(snapshot.decodeParts(readParts(header, descriptors)), header)
      : parse([...readParts(header, descriptors)].join('')); guard(ticket)
    if (header.kind === 'snapshot' && (facts.snapshotId !== header.objectId || facts.update.updateId !== updateId || facts.update.version !== header.baseVersion)) throw failure('SNAPSHOT_INCOMPLETE', '草稿身份不一致')
    if (header.kind !== 'snapshot') return facts
    io(() => {
      // No old generation is removed until this last durable visibility barrier.
      atomic(directory + '/complete-' + Date.now() + '-' + header.objectId + '.json', { header, parts: descriptors })
      generation = header.objectId; revision = 0; previous = ''; mkdir(journalPath())
    })
    return facts
  }
  function save(changes) {
    guard()
    if (!generation) throw failure('SNAPSHOT_INCOMPLETE', '请先完整准备草稿')
    return io(() => {
      mkdir(journalPath())
      const next = revision + 1, delta = { snapshotId: generation, revision: next, previous, changes }
      const text = JSON.stringify(delta), digest = sha256(text)
      verified(journalPath() + '/delta-' + next + '.json', text)
      atomic(journalPath() + '/commit-' + String(next).padStart(9, '0') + '.json', { revision: next, digest })
      revision = next; previous = digest
      return revision
    })
  }
  function clear() {
    closed = true; epoch++
    try { if (exists(directory)) fs.rmdirSync(directory, true); return true } catch (_) { return false }
  }
  return { restore, download, save, clear, close() { closed = true; epoch++ },
    get revision() { return revision }, get directory() { return directory } }
}
module.exports = { create }
