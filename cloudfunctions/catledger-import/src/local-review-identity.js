const { digestParts } = require('./portable-digest')
function stableId(...parts) {
  const hex = digestParts('local-review-v3', ...parts)
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
}
const accountId = (snapshotId, name, type) => stableId('account', snapshotId,
  name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN'), type)
const splitEventId = (updateId, rows) => stableId('split', updateId, ...[...rows].sort())
module.exports = { stableId, accountId, splitEventId }
