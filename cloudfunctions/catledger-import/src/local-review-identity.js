const { digestParts } = require('./portable-digest')
function stableId(...parts) {
  const hex = digestParts('local-review-v3', ...parts)
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
}
// 新创建的身份由原账户组决定，与显示名称分离；旧冻结请求仍保留原计算方式。
const accountId = (snapshotId, name, type, creationKey) => creationKey
  ? stableId('account-creation', snapshotId, creationKey)
  : stableId('account', snapshotId, name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN'), type)
function accountCreationKey(members, events) {
  const byId = events instanceof Map ? events : new Map((events || []).map(event => [event.eventId, event]))
  const { memberReference } = require('./account-reference-context'), { paymentReferenceKey } = require('./payment-account')
  return digestParts('account-creation-v1', ...[...new Set((members || [])
    .filter(member => member.objectType === 'event' && member.memberRole !== 'candidate')
    .map(member => member.objectId + ':' + member.memberRole + ':' +
      paymentReferenceKey(memberReference(byId.get(member.objectId) || {}, member))))].sort())
}
const splitEventId = (updateId, rows) => stableId('split', updateId, ...[...rows].sort())
module.exports = { stableId, accountId, accountCreationKey, splitEventId }
