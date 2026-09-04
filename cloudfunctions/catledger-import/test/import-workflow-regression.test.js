const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const repository = require('../src/finance-update-repository')
const reviewIssues = require('../src/review-issue-service')
const organizerPlanner = require('../src/organizer-planner')

const projectRoot = path.resolve(__dirname, '../../..')
const workbenchModel = require(path.join(projectRoot, 'miniprogram/pages/import-workbench/model'))

test('账户批量确认只建立一次批次上下文并只收口一次', async function () {
  assert.equal(typeof reviewIssues.runAccountMappingBatch, 'function')
  let beginCount = 0
  let finalizeCount = 0
  const applied = []

  const result = await reviewIssues.runAccountMappingBatch({
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
  const source = fs.readFileSync(path.join(projectRoot, 'cloudfunctions/catledger-import/src/review-issue-service.js'), 'utf8')
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

  assert.equal(reviewIssues.isEventInProjectionRefreshScope({
    eventId: 'event-direct', fieldSources: '{}'
  }, scope), true)
  assert.equal(reviewIssues.isEventInProjectionRefreshScope(related, scope), true)
  assert.equal(reviewIssues.isEventInProjectionRefreshScope(unrelated, scope), false)
})

test('原始证据查询不使用 MySQL 8 保留字 row 作为表别名', async function () {
  const connection = {
    execute: async function (sql) {
      if (/catledger_import_rows\s+row\b/i.test(sql)) {
        const error = new Error('You have an error in your SQL syntax near row')
        error.code = 'ER_PARSE_ERROR'
        throw error
      }
      if (/FROM catledger_economic_events/.test(sql)) {
        return [[{ eventId: 'event-1', updateId: 'update-1' }]]
      }
      return [[{
        evidenceId: 'evidence-1', evidenceRole: 'primary', rowId: 'row-1', rowNumber: 7,
        sourceLocator: 'csv:7', rawFields: '{"交易类型":"提现"}', rawSnapshotVersion: 'raw-v1',
        parserVersion: 'alipay-v1', sourceType: 'alipay', fileName: '支付宝.csv'
      }]]
    }
  }

  const result = await repository.selectEventEvidence(connection, 'user-1', 'event-1')
  assert.equal(result.evidence[0].rawFields.交易类型, '提现')
})

test('账户页只向服务端提交一个批量动作，解析页已有更新时直接恢复', function () {
  const source = fs.readFileSync(path.join(projectRoot, 'miniprogram/pages/import-workbench/index.js'), 'utf8')
  const contract = require(path.join(projectRoot, 'shared/catledger-import.json'))
  assert.ok(contract.actions['reviewIssues.resolveAccountMappings'])
  assert.match(source, /callImport\('reviewIssues\.resolveAccountMappings'/)
  assert.match(source, /if \(this\.data\.update && this\.data\.update\.updateId\)[\s\S]*loadUpdate\(this\.data\.update\.updateId\)/)
})

test('首次进入账户步骤只调用一个原子 prepare 动作', function () {
  const source = fs.readFileSync(path.join(projectRoot, 'miniprogram/pages/import-workbench/index.js'), 'utf8')
  const contract = require(path.join(projectRoot, 'shared/catledger-import.json'))
  const start = source.indexOf('createFinanceUpdate: async function')
  const end = source.indexOf('\n  loadUpdate:', start)
  const method = source.slice(start, end)
  assert.ok(contract.actions['financeUpdates.prepare'])
  assert.match(method, /callImport\('financeUpdates\.prepare'/)
  assert.doesNotMatch(method, /callImport\('financeUpdates\.(?:create|organize)'/)
})

test('整理卡明确区分交易摘要和冻结的原始记录', function () {
  const markup = fs.readFileSync(path.join(projectRoot, 'miniprogram/pages/import-workbench/index.wxml'), 'utf8')
  assert.doesNotMatch(markup, />交易摘要<\/text>/)
  assert.match(markup, />原始交易 \{\{item\.evidenceCount\}\} ›<\/text>/)
  assert.doesNotMatch(markup, />账单记录<\/text>/)
})

test('旧版未入账批次由服务端声明是否需要重整，客户端不再复制规划版本', function () {
  const pageSource = fs.readFileSync(path.join(projectRoot, 'miniprogram/pages/import-workbench/index.js'), 'utf8')
  assert.equal(organizerPlanner.PLAN_VERSION, 'organizer-plan-v22')
  assert.doesNotMatch(pageSource, /CURRENT_PLAN_VERSION/)
  assert.match(pageSource, /view\.update\.requiresReorganization[\s\S]*financeUpdates\.organize/)
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
