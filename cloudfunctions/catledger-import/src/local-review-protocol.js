const { sha256, byteLength } = require('./portable-digest')
const VERSION = 3
const LIMITS = Object.freeze({ sourceFiles: 5, sourceRows: 25000, candidatePairs: 10000,
  snapshotBytes: 256 * 1024 * 1024, decisionBytes: 64 * 1024 * 1024,
  snapshotChunkChars: 128 * 1024, decisionChunkChars: 60 * 1024,
  snapshotChunkWireBytes: 240 * 1024, decisionChunkWireBytes: 60 * 1024, chunks: 16384, manifestPage: 128 })
const failure = code => { throw Object.assign(new Error(code), { code, publicCode: code }) }
function rootDigest(parts) { return sha256(parts.map(part => part.digest).join(':')) }
function split(text, kind = 'snapshot') {
  const max = kind === 'snapshot' ? LIMITS.snapshotChunkChars : LIMITS.decisionChunkChars
  const limit = kind === 'snapshot' ? LIMITS.snapshotBytes : LIMITS.decisionBytes
  const wireLimit = kind === 'snapshot' ? LIMITS.snapshotChunkWireBytes : LIMITS.decisionChunkWireBytes
  const parts = []; let bytes = 0
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + max)
    // Budget the actual JSON-escaped UTF-8 string. Ordinary identifiers can use
    // the whole request budget without making CJK/control characters overflow.
    if (byteLength(JSON.stringify(text.slice(start,end))) > wireLimit) {
      let low=start+1,high=end
      while(low<high){const mid=Math.ceil((low+high)/2);if(byteLength(JSON.stringify(text.slice(start,mid)))<=wireLimit)low=mid;else high=mid-1}
      end=low
    }
    // Never split a UTF-16 surrogate pair between files or requests.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
    const content = text.slice(start, end), size = byteLength(content)
    bytes += size
    if (bytes > limit || parts.length >= LIMITS.chunks) failure('LOCAL_REVIEW_CAPACITY')
    parts.push({ index: parts.length, bytes: size, digest: sha256(content), content }); start = end
  }
  if (!parts.length) failure('SNAPSHOT_INCOMPLETE')
  return { parts, bytes, digest: rootDigest(parts), chunkCount: parts.length }
}
function validatePart(header, descriptor, part) {
  if (!header || header.protocolVersion !== VERSION || !descriptor || !part ||
    part.objectId !== header.objectId || part.baseVersion !== header.baseVersion ||
    part.index !== descriptor.index || typeof part.content !== 'string' || part.digest !== descriptor.digest ||
    byteLength(part.content) !== descriptor.bytes || sha256(part.content) !== descriptor.digest) failure('SNAPSHOT_INCOMPLETE')
  return part.content
}
function validateManifest(header, parts) {
  if (!header || header.protocolVersion !== VERSION || !Number.isSafeInteger(header.chunkCount) || header.chunkCount < 1 ||
    header.chunkCount > LIMITS.chunks || !Array.isArray(parts) || parts.length !== header.chunkCount ||
    parts.some((part, index) => part.index !== index || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || !/^[a-f0-9]{64}$/.test(part.digest)) ||
    parts.reduce((sum, part) => sum + part.bytes, 0) !== header.bytes || rootDigest(parts) !== header.digest) failure('SNAPSHOT_INCOMPLETE')
  return true
}
function validateState(value) {
  if (!value || value.protocolVersion !== VERSION || !Number.isSafeInteger(value.baseVersion) || value.baseVersion < 1 ||
    typeof value.snapshotId !== 'string' || typeof value.updateId !== 'string' || typeof value.ruleVersion !== 'string' ||
    Object.keys(value).some(key => !['protocolVersion','snapshotId','updateId','baseVersion','ruleVersion','decisions'].includes(key))) failure('VALIDATION_ERROR')
  const decisions = value.decisions
  const kinds = ['accounts','events','pairings','reviews','duplicates']
  if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions) || Object.keys(decisions).some(key => !kinds.includes(key))) failure('VALIDATION_ERROR')
  for (const kind of kinds) {
    if (!Array.isArray(decisions[kind]) || decisions[kind].length > LIMITS.sourceRows * 2) failure('LOCAL_REVIEW_CAPACITY')
    const ids = new Set()
    for (const decision of decisions[kind]) {
      if (!decision || typeof decision !== 'object' || Array.isArray(decision) || typeof decision.key !== 'string' ||
        decision.key.length > 160 || ids.has(decision.key) || !Array.isArray(decision.sourceIds) || !decision.sourceIds.length ||
        decision.sourceIds.length > LIMITS.sourceRows || decision.sourceIds.some(id => typeof id !== 'string')) failure('VALIDATION_ERROR')
      ids.add(decision.key)
    }
  }
  const queue = [{ value, depth: 0 }]; let count = 0
  while (queue.length) {
    const item = queue.pop(), data = item.value
    if (data == null || typeof data !== 'object') continue
    if (++count > 1000000 || item.depth > 24 || Object.keys(data).some(key => ['uid','openid','openId','OPENID','__proto__','constructor','prototype'].includes(key))) failure('INVALID_REQUEST')
    for (const child of Object.values(data)) queue.push({ value: child, depth: item.depth + 1 })
  }
  return value
}
module.exports = { VERSION, LIMITS, split, rootDigest, validateManifest, validatePart, validateState }
