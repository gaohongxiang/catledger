const test = require('node:test')
const assert = require('node:assert/strict')
const { isTimerEvent, isScheduledMaintenance } = require('../cloudfunctions/catledger-import/src/maintenance')

test('定时事件只识别明确的 Timer 触发，不把业务动作当维护调用', () => {
  assert.equal(isTimerEvent({ Type: 'Timer', TriggerName: 'cleanup-expired-import-files' }), true)
  assert.equal(isTimerEvent({ type: 'timer' }), true)
  assert.equal(isTimerEvent({ TriggerName: 'cleanup-expired-import-files' }), false)
  assert.equal(isScheduledMaintenance({ Type: 'Timer' }, {}), true)
  assert.equal(isScheduledMaintenance({ Type: 'Timer' }, { OPENID: 'forged-client' }), false)
  assert.equal(isScheduledMaintenance({ action: 'imports.prepareMany' }, {}), false)
  assert.equal(isTimerEvent({ action: 'imports.prepareMany', data: {} }), false)
  assert.equal(isTimerEvent(null), false)
})

test('部署配置只为导入函数挂载每日清理触发器', () => {
  const config = require('../cloudbaserc.json')
  const importer = config.functions.find(item => item.name === 'catledger-import')
  const api = config.functions.find(item => item.name === 'catledger-api')
  assert.ok(importer && Array.isArray(importer.triggers) && importer.triggers.length === 1)
  assert.deepEqual(importer.triggers[0], { name: 'cleanup-expired-import-files', type: 'timer', config: '0 0 3 * * * *' })
  assert.equal(api.triggers, undefined)
})
