const alipayApp = require('./alipay-app')
const alipayWeb = require('./alipay-web')
const wechatCsv = require('./wechat-csv')
const wechatXlsx = require('./wechat-xlsx')

const PROFILES = Object.freeze([wechatCsv, wechatXlsx, alipayApp, alipayWeb])
const BY_FORMAT = new Map(PROFILES.map((profile) => [profile.sourceFormat, profile]))

function profilesForContainer(container) {
  return PROFILES.filter((profile) => profile.container === container)
}

function profileForFormat(sourceFormat) {
  return BY_FORMAT.get(sourceFormat) || null
}

function profileForRow(row) {
  const exact = profileForFormat(row && (row.sourceFormat || row.profileId))
  if (exact) return exact
  if (row && (row.sourceFormat || row.profileId)) return null
  const candidates = PROFILES.filter((profile) => profile.sourceType === (row && row.sourceType))
  if (candidates.length === 0) return null
  return candidates.find((profile) => profile.container === 'csv') || candidates[0]
}

module.exports = {
  PROFILES,
  profileForFormat,
  profileForRow,
  profilesForContainer
}
