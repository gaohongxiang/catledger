const test = require('node:test')
const assert = require('node:assert/strict')
const { testConfig, validRuntimePrivileges } = require('../scripts/isolated-mysql')
test('本机角色夹具拒绝云地址、非测试库和超出白名单的权限语句', () => {
  for (const host of ['cloud.example','192.0.2.1']) assert.throws(() => testConfig({ CATLEDGER_TEST_DB_HOST: host, CATLEDGER_TEST_DB_NAME:'synthetic_test' }), /仅允许本机/)
  assert.throws(() => testConfig({ CATLEDGER_TEST_DB_HOST:'127.0.0.1',CATLEDGER_TEST_DB_NAME:'production' }), /仅允许本机/)
  for (const privilege of ['ALL PRIVILEGES','GRANT OPTION','UPDATE(secret)','SELECT; DROP DATABASE anything','UPDATE(version,,status)']) assert.equal(validRuntimePrivileges(privilege),false)
  assert.equal(validRuntimePrivileges('SELECT, INSERT, UPDATE(version,current_action_id)'),true)
})
