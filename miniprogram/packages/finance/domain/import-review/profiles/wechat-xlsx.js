const csv = require('./wechat-csv')

module.exports = Object.freeze({
  ...csv,
  profileId: 'wechat_xlsx',
  profileVersion: 'wechat-xlsx-profile-v2',
  adapterVersion: 'wechat-xlsx-adapter-v4',
  sourceFormat: 'wechat_xlsx',
  container: 'xlsx',
  parserName: 'wechat-pay-xlsx-evidence',
  parserVersion: 'wechat-xlsx-parser-v4'
})
