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
function create({ fs, root, scope, updateId, alive = () => true, chunkConcurrency = DEFAULT_CHUNK_CONCURRENCY, now = () => Date.now() }) {
  const directory = root + '/' + sha256(scope) + '/' + updateId
  const concurrency = Number.isInteger(chunkConcurrency) && chunkConcurrency > 0
    ? Math.min(chunkConcurrency, MAX_CHUNK_CONCURRENCY) : DEFAULT_CHUNK_CONCURRENCY
  let epoch = 0, closed = false, revision = 0, previous = '', generation = null
  function guard(ticket = epoch) {
    if (closed || ticket !== epoch || !alive()) throw failure('SESSION_CHANGED', '登录状态已改变，原草稿已停止保存')
  }
  function exists(file) {
    try { fs.accessSync(file); return true } catch (error) {
      if (error.code === 'ENOENT' || /no such file|not exist/i.test(error.errMsg || error.message || '')) return false
      throw error
    }
  }
  function mkdir(file) { if (!exists(file)) fs.mkdirSync(file, true) }
  function read(file) { return fs.readFileSync(file, 'utf8') }
  function activityPath() { return directory + '/activity.json' }
  function parseActivity(text) {
    try {
      const value = parse(text)
      return value && Number.isFinite(Number(value.lastActiveAt)) ? value : null
    } catch (_) { return null }
  }
  function completeMarkers() {
    if (!exists(directory)) return []
    return fs.readdirSync(directory).filter(name => /^complete-\d+-[a-f0-9-]+\.json$/.test(name)).sort().reverse()
  }
  // The activity file is the mutable clock. A legacy draft falls back to the
  // durable complete marker (including the epoch in its filename) so an old
  // snapshot is not treated as freshly active after an upgrade.
  function activity() {
    if (exists(activityPath())) {
      try { const stored = parseActivity(read(activityPath())); if (stored) return stored } catch (_) { /* fall back to the marker */ }
    }
    for (const filename of completeMarkers()) {
      try {
        const complete = parse(read(directory + '/' + filename))
        const recorded = complete && Number(complete.lastActiveAt)
        return { schema: 1, lastActiveAt: Number.isFinite(recorded) ? recorded : Number(filename.split('-')[1]),
          snapshotId: complete && complete.header && complete.header.objectId || null }
      } catch (_) { /* try the next candidate */ }
    }
    return null
  }
  function touch(value = {}) {
    guard()
    const prior = activity() || {}
    const at = Number.isFinite(Number(value.lastActiveAt)) ? Number(value.lastActiveAt) : Number(now())
    const next = { schema: 1, lastActiveAt: at,
      snapshotId: value.snapshotId || prior.snapshotId || generation || null }
    if (value.serverTouchedAt != null) next.serverTouchedAt = Number(value.serverTouchedAt)
    else if (prior.serverTouchedAt != null) next.serverTouchedAt = prior.serverTouchedAt
    io(() => { mkdir(directory); atomic(activityPath(), next) })
    return next
  }
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
    return io(restoreComplete)
  }
  function restoreComplete() {
    guard()
    if (!exists(directory)) return null
    const candidates = fs.readdirSync(directory).filter(name => /^complete-\d+-[a-f0-9-]+\.json$/.test(name)).sort().reverse()
    let damaged = false
    for (const filename of candidates) {
      // A committed journal may contain an unknown posting request. Never
      // fall back past it, even when its base snapshot cannot be decoded.
      const objectId = filename.replace(/^complete-\d+-/, '').replace(/\.json$/, '')
      const folder = directory + '/' + objectId + '/decisions'
      const commits = exists(folder) ? fs.readdirSync(folder).filter(name => /^commit-\d{9}\.json$/.test(name)).sort() : []
      try {
        const complete = parse(read(directory + '/' + filename)), { header, parts } = complete
        protocol.validateManifest(header, parts)
        const facts = snapshot.validateFacts(snapshot.decodeParts(readParts(header, parts)), header)
        if (facts.snapshotId !== header.objectId || facts.update.updateId !== updateId || facts.update.version !== header.baseVersion) throw new Error('Mismatch')
        generation = header.objectId; revision = 0; previous = ''
        const records = []
        if (commits.length) {
          for (const name of commits) {
            const commit = parse(read(folder + '/' + name)), text = read(folder + '/delta-' + commit.revision + '.json')
            if (commit.revision !== revision + 1 || sha256(text) !== commit.digest) throw failure('DRAFT_CORRUPT', '已保存的决定文件损坏，完整基础草稿仍保留，请恢复后继续')
            const delta = parse(text)
            if (delta.revision !== commit.revision || delta.previous !== previous || delta.snapshotId !== generation) throw failure('DRAFT_CORRUPT', '本机决定版本不完整，草稿仍保留')
            records.push(delta); revision = delta.revision; previous = commit.digest
          }
        }
        const recorded = Number(complete.lastActiveAt)
        const fallback = Number(filename.split('-')[1])
        return { header, facts, records, recoveredPrevious: damaged,
          lastActiveAt: Number.isFinite(recorded) ? recorded : Number.isFinite(fallback) ? fallback : null,
          activity: activity() }
      } catch (error) {
        if (error.code === 'DRAFT_CORRUPT') throw error
        if (commits.length) throw failure('DRAFT_CORRUPT', '本机草稿或已保存的决定无法读取，原文件已保留，请重试恢复')
        if (error.code && !['SNAPSHOT_INCOMPLETE', 'LOCAL_REVIEW_CAPACITY'].includes(error.code)) throw error
        damaged = true
      }
    }
    if (damaged) throw failure('DRAFT_CORRUPT', '完整草稿文件校验失败，已保留原文件；联网重新准备后继续')
    return null
  }
  async function download(header, call, onProgress = () => {}, inline = null, initialize = () => []) {
    const ticket = epoch, descriptors = []; let offset = 0
    const startedAt = Date.now()
    let manifestMs = 0, chunkMs = 0, decodeMs = 0, chunkCalls = 0, inlineUsed = false
    guard(ticket); io(() => { mkdir(directory); mkdir(directory + '/' + header.objectId) })
    const manifestStartedAt = Date.now()
    do {
      const result = await call('financeUpdates.snapshotManifest', { objectId: header.objectId, offset })
      guard(ticket)
      if (result.header.objectId !== header.objectId || result.header.baseVersion !== header.baseVersion || result.header.digest !== header.digest) throw failure('SNAPSHOT_INCOMPLETE', '草稿版本不一致，请重新准备')
      descriptors.push(...result.parts); offset = result.nextOffset
      if (descriptors.length > header.chunkCount || offset != null && offset !== descriptors.length) throw failure('SNAPSHOT_INCOMPLETE', '草稿分块清单不完整')
    } while (offset != null)
    manifestMs = Date.now() - manifestStartedAt
    protocol.validateManifest(header, descriptors)
    const folder = directory + '/' + header.objectId
    const done = new Set()
    if (inline && header.kind === 'snapshot' && descriptors.length === 1) {
      const descriptor = descriptors[0], content = inline.content
      try {
        if (typeof content !== 'string' || inline.objectId !== header.objectId ||
            Number(inline.baseVersion) !== Number(header.baseVersion) || inline.index !== descriptor.index ||
            Number(inline.bytes) !== descriptor.bytes || inline.digest !== descriptor.digest) {
          throw failure('SNAPSHOT_INCOMPLETE', '内联快照描述不一致')
        }
        protocol.validatePart(header, descriptor, { ...descriptor, objectId: header.objectId,
          baseVersion: header.baseVersion, content })
        io(() => verified(folder + '/part-' + descriptor.index + '.json', content))
        inlineUsed = true
      } catch (error) {
        if (error.code === 'DRAFT_STORAGE_FAILED' || error.code === 'SESSION_CHANGED') throw error
        // An invalid inline payload is ignored; the normal chunk path below remains authoritative.
      }
    }
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
    const reused = Math.max(0, done.size - (inlineUsed ? 1 : 0))
    onProgress({ completed: done.size, total: header.chunkCount, bytes: header.bytes, reused })
    const chunkStartedAt = Date.now()
    await runPool(descriptors.filter(descriptor => !done.has(descriptor.index)), concurrency, async descriptor => {
      guard(ticket)
      chunkCalls += 1
      const part = await call('financeUpdates.snapshotChunk', { objectId: header.objectId, index: descriptor.index })
      guard(ticket)
      const content = protocol.validatePart(header, descriptor, part)
      io(() => verified(folder + '/part-' + descriptor.index + '.json', content))
      done.add(descriptor.index)
      onProgress({ completed: done.size, total: header.chunkCount, bytes: header.bytes, reused })
    })
    chunkMs = Date.now() - chunkStartedAt
    if (done.size !== descriptors.length) throw failure('SNAPSHOT_INCOMPLETE', '草稿分块不完整，请重试')
    guard(ticket)
    const decodeStartedAt = Date.now()
    const facts = header.kind === 'snapshot' ? snapshot.validateFacts(snapshot.decodeParts(readParts(header, descriptors)), header)
      : parse([...readParts(header, descriptors)].join('')); guard(ticket)
    decodeMs = Date.now() - decodeStartedAt
    if (header.kind === 'snapshot' && (facts.snapshotId !== header.objectId || facts.update.updateId !== updateId || facts.update.version !== header.baseVersion)) throw failure('SNAPSHOT_INCOMPLETE', '草稿身份不一致')
    if (header.kind !== 'snapshot') return facts
    io(() => {
      const published = completeMarkers().some(name => name.endsWith('-' + header.objectId + '.json'))
      if (published) {
        const current = restoreComplete()
        if (!current || current.header.objectId !== header.objectId) throw failure('SNAPSHOT_INCOMPLETE', '草稿版本已变化，请重新准备')
        return
      }
      const changes = initialize(facts) || []
      generation = header.objectId; revision = 0; previous = ''
      // Only unpublished work can be replaced after an interrupted download.
      if (exists(journalPath())) fs.rmdirSync(journalPath(), true)
      mkdir(journalPath())
      if (changes.length) save(changes, false)
      // No old generation is removed until this last durable visibility barrier.
      const lastActiveAt = Number(now())
      // Generation ordering must survive a clock rollback or two publishes
      // within one millisecond; the activity timestamp keeps its real meaning.
      const markerAt = Math.max(lastActiveAt, ...completeMarkers().map(name => Number(name.split('-')[1]) + 1))
      atomic(directory + '/complete-' + markerAt + '-' + header.objectId + '.json',
        { header, parts: descriptors, lastActiveAt })
    })
    try { touch({ lastActiveAt: Number(now()), snapshotId: header.objectId }) } catch (_) { /* marker timestamp remains the fallback */ }
    onProgress({ completed: descriptors.length, total: header.chunkCount, bytes: header.bytes, reused, inline: inlineUsed,
      stats: { manifestMs, chunkMs, decodeMs, totalMs: Date.now() - startedAt, chunkCalls, reused, inline: inlineUsed,
        bytes: header.bytes, chunkCount: header.chunkCount } })
    return facts
  }
  function save(changes, touchActivity = true) {
    guard()
    if (!generation) throw failure('SNAPSHOT_INCOMPLETE', '请先完整准备草稿')
    return io(() => {
      mkdir(journalPath())
      const next = revision + 1, delta = { snapshotId: generation, revision: next, previous, changes }
      const text = JSON.stringify(delta), digest = sha256(text)
      verified(journalPath() + '/delta-' + next + '.json', text)
      atomic(journalPath() + '/commit-' + String(next).padStart(9, '0') + '.json', { revision: next, digest })
      revision = next; previous = digest
      if (touchActivity) try { touch() } catch (_) { /* the decision commit remains durable; the marker keeps restoration bounded */ }
      return revision
    })
  }
  function clear() {
    closed = true; epoch++
    try { if (exists(directory)) fs.rmdirSync(directory, true); return true } catch (_) { return false }
  }
  return { restore, download, save, clear, activity, touch, close() { closed = true; epoch++ },
    get revision() { return revision }, get directory() { return directory } }
}
module.exports = { create }
