const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { runAccountMappingBatch } = require('../src/review/account-mapping')
const { isEventInProjectionRefreshScope } = require('../src/review/reconciliation')

const projectRoot = path.resolve(__dirname, '../../..')
const workbenchModel = require(path.join(projectRoot, 'miniprogram/pages/import-workbench/model'))

test('账户批量确认只建立一次批次上下文并只收口一次', async function () {
  assert.equal(typeof runAccountMappingBatch, 'function')
  let beginCount = 0
  let finalizeCount = 0
  const applied = []

  const result = await runAccountMappingBatch({
    decisions: [
      { issueId: 'issue-a', operation: 'resolve' },
      { issueId: 'issue-b', operation: 'resolve' }
    ],
    begin: async function () {
      beginCount += 1
      return { updateVersion: 4 }
    },
    applyDecision: async function (decision, batch) {
      applied.push({ issueId: decision.issueId, updateVersion: batch.updateVersion })
    },
    finalize: async function (batch) {
      finalizeCount += 1
      return { update: { version: batch.updateVersion + 1, status: 'review' } }
    }
  })

  assert.equal(beginCount, 1)
  assert.equal(finalizeCount, 1)
  assert.deepEqual(applied, [
    { issueId: 'issue-a', updateVersion: 4 },
    { issueId: 'issue-b', updateVersion: 4 }
  ])
  assert.equal(result.update.version, 5)
})

test('账户归属排除写入独立原因码供审计视图分组', function () {
  const source = fs.readFileSync(path.join(projectRoot, 'cloudfunctions/catledger-import/src/review/event-decisions.js'), 'utf8')
  assert.match(source, /account_mapping_excluded/)
})

test('账户批量确认只重算直接受影响或引用同一支付方式的事件', function () {
  const scope = {
    eventIds: new Set(['event-direct']),
    paymentReferenceKeys: new Set(['alipay:支付宝账户余额'])
  }
  const unrelated = {
    eventId: 'event-unrelated',
    fieldSources: JSON.stringify({
      fundsProjection: {
        from: { sourceType: 'wechat', paymentMethodKey: '微信零钱' }
      }
    })
  }
  const related = {
    eventId: 'event-related',
    fieldSources: JSON.stringify({
      fundsProjection: {
        from: { sourceType: 'alipay', paymentMethodKey: '支付宝账户余额' }
      }
    })
  }

  assert.equal(isEventInProjectionRefreshScope({
    eventId: 'event-direct', fieldSources: '{}'
  }, scope), true)
  assert.equal(isEventInProjectionRefreshScope(related, scope), true)
  assert.equal(isEventInProjectionRefreshScope(unrelated, scope), false)
})

test('整理卡明确区分交易摘要和冻结的原始记录', function () {
  const markup = fs.readFileSync(path.join(projectRoot, 'miniprogram/pages/import-workbench/index.wxml'), 'utf8')
  assert.doesNotMatch(markup, />交易摘要<\/text>/)
  assert.match(markup, /template is="record-source-fields"/)
  assert.doesNotMatch(markup, />账单记录<\/text>/)
})

test('支付宝原始字段数组按字段名和值展示，不得出现 object Object', function () {
  const fields = workbenchModel.evidenceFields([
    { name: '交易类型', value: '提现-实时提现' },
    { name: '交易对方', value: '浙江农商联合银行' },
    { name: '金额', value: '498.57' }
  ])
  assert.deepEqual(fields, [
    { key: '交易类型', value: '提现-实时提现' },
    { key: '交易对方', value: '浙江农商联合银行' },
    { key: '金额', value: '498.57' }
  ])
  assert.equal(JSON.stringify(fields).includes('[object Object]'), false)
})

test('查看原始记录在当前处理弹层内钻取，不得叠加第二个底部弹层', function () {
  const markup = fs.readFileSync(path.join(projectRoot, 'miniprogram/pages/import-workbench/index.wxml'), 'utf8')
  assert.match(markup, /class="evidence-drilldown"/)
  assert.doesNotMatch(markup, /class="sheet-layer evidence-layer"/)
})
