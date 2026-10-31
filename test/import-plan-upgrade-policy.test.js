const test = require('node:test')
const assert = require('node:assert/strict')

const { upgradeablePlan } = require('../cloudfunctions/catledger-import/src/finance-update-core')
const { PLAN_VERSION } = require('../cloudfunctions/catledger-import/src/domain-versions')

test('整理规则升级在原计划上进行，不因为版本号变化重建整份计划', () => {
  // 每个已发布的版本都必须能原地升级：重建会丢掉重复合并、同笔判断和核对状态。
  for (let version = 26; version <= Number(/v(\d+)$/.exec(PLAN_VERSION)[1]); version += 1) {
    assert.equal(upgradeablePlan('organizer-plan-v' + version), true, 'organizer-plan-v' + version)
  }
  assert.equal(upgradeablePlan(PLAN_VERSION), true)
  // 更早的计划没有可保留的决定，仍走整份重建。
  assert.equal(upgradeablePlan('organizer-plan-v25'), false)
  assert.equal(upgradeablePlan(''), false)
  assert.equal(upgradeablePlan(null), false)
  assert.equal(upgradeablePlan('organizer-plan'), false)
})
