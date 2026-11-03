const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { facts } = require('./helpers/local-review')
const { localWorkbench } = require('./helpers/local-workbench')
const sessions = require('../miniprogram/packages/finance/services/import-local-session')

const tap = id => ({ currentTarget: { dataset: { id } } })
const bank = '合成测试银行储蓄卡(5564)'
const otherBank = index => '合成测试银行储蓄卡(' + (6000 + index) + ')'

function transferStatements(expanded = false) {
  const alipay = Buffer.from([
    '支付宝(中国)网络技术有限公司 电子客户回单',
    '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
    '2026-09-01 12:00:00,投资理财,余额宝,余额宝-自动转入,1.00,不计收支,账户余额,交易成功,,SYNTHETIC-TRANSFER-PAGE-ALI,,',
    ...Array.from({ length: expanded ? 250 : 0 }, (_, index) =>
      `2026-09-03 12:00:00,餐饮美食,合成商户,合成商品,1.00,支出,${index % 6 === 0 ? bank : otherBank(index % 6)},交易成功,,SYNTHETIC-TRANSFER-PAGE-ALI-EXP-${index},,`)
  ].join('\n'))
  const wechat = Buffer.from([
    '微信支付账单明细,,,,,,,,,,,',
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
    `2026-09-02 12:00:00,零钱提现,${bank},/,不计收支,2.00,${bank},提现已到账,SYNTHETIC-TRANSFER-PAGE-WX,,,`,
    ...Array.from({ length: expanded ? 101 : 0 }, (_, index) =>
      `2026-09-04 12:00:00,商户消费,合成商户,合成商品,支出,1.00,${index % 2 === 0 ? bank : otherBank(6)},支付成功,SYNTHETIC-TRANSFER-PAGE-WX-EXP-${index},,,`)
  ].join('\n'))
  return [alipay, wechat]
}

async function setup(t, expanded = false) {
  const value = await facts({ contents: transferStatements(expanded), mapped: false, accounts: [] })
  const original = JSON.stringify(value)
  const h = await localWorkbench(t, value)
  await h.page.setStep({ currentStep: 2 })
  return { ...h, value, original }
}

async function reopen(t, h) {
  h.page.onUnload()
  const local = sessions.create({ files: h.files, restored: h.files.restore(), requestId: randomUUID,
    callNetwork() { assert.fail('账户确认与恢复必须只使用本机草稿') } })
  h.load(path.resolve(__dirname, '../miniprogram/services/import-local-router.js')).bind(local)
  h.summary = local.view
  const page = h.createPage({}, false)
  await page.applyUpdateView(local.view)
  await page.setStep({ currentStep: 2 })
  t.after(() => page.onUnload())
  return { ...h, local, page }
}

function assertCompleted(h, count, transferCount = 2) {
  const page = h.page
  assert.equal(page.data.pageError, '')
  assert.equal(page.data.accountStepError, '')
  assert.equal(page.data.accountMappings.length, count, '确认端点后不能新冒出无来源单笔账户卡')
  assert.equal(page.data.accountStepSummary.displayTotal, count)
  assert.equal(page.data.accountStepSummary.displayConfirmed, count)
  assert.equal(page.data.accountStepSummary.displayPending, 0)
  assert.equal(page.data.accountStepSummary.pending, 0)
  assert.ok(page.data.accountMappings.every(card => card.sourceLabel && !card.needsConfirmation))
  const transfers = [...h.local.model.events.values()].filter(event =>
    ['platform_savings_in', 'withdrawal'].includes(event.fieldSources.fundsProjection?.kind))
  assert.equal(transfers.length, transferCount)
  for (const event of transfers) {
    assert.equal(event.economicNature, 'internal_transfer')
    assert.equal(event.flowDirection, 'neutral')
    assert.equal(event.status, 'ready', event.reasonCodes.join(','))
    assert.ok(event.ledgerAccountId)
    assert.ok(event.counterpartyLedgerAccountId)
    assert.notEqual(event.ledgerAccountId, event.counterpartyLedgerAccountId)
    assert.equal(h.local.model.accounts.get(event.ledgerAccountId).name, event.fieldSources.fundsProjection.from.label)
    assert.equal(h.local.model.accounts.get(event.counterpartyLedgerAccountId).name, event.fieldSources.fundsProjection.to.label)
  }
  assert.equal([...h.local.model.issues.values()].filter(issue => issue.issueType === 'account_mapping' &&
    issue.status === 'open').length, 0, '不能只隐藏卡片，模型也必须已解决账户要求')
  assert.equal(JSON.stringify(h.value), h.original, '本机确认不能改写下载的原快照')
  assert.equal(h.network.length, 0)
}

function assertNativeCardsIsolated(h, expectedTypes) {
  const options = h.load(path.resolve(__dirname, '../miniprogram/packages/finance/pages/import-workbench/account-review.js')).ACCOUNT_TYPE_OPTIONS
  assert.equal(JSON.stringify(options), expectedTypes, '重排的叶路径更新不能改写共享账户类型表')
  const displayed = h.page.data.accountMappingsIncluded.concat(h.page.data.accountMappingsExcluded)
  for (const card of h.page.data.accountMappings) {
    const copy = displayed.find(row => row.issueId === card.issueId)
    assert.ok(copy)
    assert.notEqual(card, copy, '总列表与分区列表需要各自可变的原生卡片对象')
    assert.deepEqual(JSON.parse(JSON.stringify(card)), JSON.parse(JSON.stringify(copy)), '重排后各列表显示同一个决定')
    assert.notEqual(card.accountContext, copy.accountContext)
    for (const option of card.typeOptions) {
      assert.ok(options.every(shared => shared !== option), '原生叶更新不能持有类型常量的嵌套对象')
      assert.ok(copy.typeOptions.every(other => other !== option), '两个原生列表的选项不能共用可变对象')
    }
  }
}

test('真实 Page：余额宝自动转入和零钱提现的四个端点一次确认后仍是四张卡', async t => {
  const h = await setup(t), page = h.page
  assert.equal(page.data.accountMappings.length, 4)
  assert.equal(h.value.issues.filter(issue => issue.issueType === 'transfer_accounts').length, 0)
  assert.ok([...h.local.model.events.values()].every(event => event.economicNature === 'internal_transfer'),
    '转账账户已由 account_mapping 承接，transfer_accounts 为零不表示性质未识别')
  h.wx.showModal = options => options.success({ confirm: true })
  await page.confirmAllAccountMappings()
  assertCompleted(h, 4)
})

test('真实 Page：353笔、11原事项折叠为10卡，批量后保持10/10，重开不出现两张空来源卡', async t => {
  let h = await setup(t, true)
  const page = h.page
  assert.equal(h.value.events.length, 353)
  assert.equal(h.value.issues.filter(issue => issue.issueType === 'account_mapping').length, 11)
  assert.equal(page.data.accountMappings.length, 10)
  assert.equal(page.data.accountStepSummary.batchable, 10)
  assert.equal(page.data.accountStepSummary.displayPending, 10)
  const before = h.files.restore().records.length
  let modal
  h.wx.showModal = options => { modal = options; options.success({ confirm: true }) }
  await page.confirmAllAccountMappings()
  assert.equal(modal.content, '将确认 10 项账户，其中新建 10 个账户。')
  assert.equal(h.files.restore().records.length, before + 1, '批量决定仍然一次保存')
  assert.equal(h.local.model.choices.accounts.size, 11)
  assert.equal([...h.local.model.accounts.values()].filter(account => account.isDraft).length, 10)
  assertCompleted(h, 10)
  h = await reopen(t, h)
  assert.equal(h.local.model.invalid.size, 0)
  assertCompleted(h, 10)
})

test('真实 Page：快照已有仅本事件的转出绑定，确认转入端和冷恢复都不能丢失该绑定', async t => {
  const account = { accountId: randomUUID(), name: '支付宝账户余额', type: 'wallet',
    nature: 'asset', currency: 'CNY', version: 1 }
  const value = await facts({ content: transferStatements()[0], mapped: true, accounts: [account] })
  assert.equal(value.paymentMappings.length, 1)
  assert.equal(value.events[0].ledgerAccountId, account.accountId)
  // 这份账单只有这一笔资金流转；把其已确认来源收窄为真实事件范围，
  // 事件/事项仍是解析器和规划器产物，不预填本机 choices 来掩盖基础索引缺口。
  value.paymentMappings = value.paymentMappings.map(mapping => ({ ...mapping, mappingScope: 'event',
    eventId: value.events[0].eventId, rowIds: value.rows.map(row => row.rowId) }))
  const original = JSON.stringify(value)
  let h = { ...await localWorkbench(t, value), value, original }
  await h.page.setStep({ currentStep: 2 })
  assert.equal(h.page.data.accountMappings.length, 2)
  assert.equal(h.page.data.accountStepSummary.displayConfirmed, 1)
  assert.equal(h.local.model.choices.accounts.size, 0)
  const event = [...h.local.model.events.values()][0]
  assert.equal(h.local.model.facts.paymentMappings[0].eventId, event.eventId)
  const target = h.page.mappingState().rawMappings.find(mapping => mapping.accountContext.fundsSide === 'to')
  await h.page.completeAccountMapping(tap(target.issueId))
  assert.equal(h.local.model.choices.accounts.size, 1, '来源来自下载快照，无需重新确认')
  assert.equal(h.local.model.events.get(event.eventId).ledgerAccountId, account.accountId)
  assertCompleted(h, 2, 1)
  h = await reopen(t, h)
  assert.equal(h.local.model.invalid.size, 0)
  assertCompleted(h, 2, 1)
})

for (const first of ['from', 'to']) {
  test(`真实 Page：先确认${first === 'from' ? '转出' : '转入'}端，重开后确认另一端仍保留两端归属`, async t => {
    let h = await setup(t)
    const expectedTypes = JSON.stringify(h.load(path.resolve(__dirname,
      '../miniprogram/packages/finance/pages/import-workbench/account-review.js')).ACCOUNT_TYPE_OPTIONS)
    assertNativeCardsIsolated(h, expectedTypes)
    const ordered = [first, first === 'from' ? 'to' : 'from'].map(side => h.page.mappingState().rawMappings
      .filter(mapping => mapping.accountContext.fundsSide === side).map(mapping => mapping.issueId))
    assert.deepEqual(ordered.map(ids => ids.length), [2, 2])
    for (const id of ordered[0]) {
      await h.page.completeAccountMapping(tap(id))
      assert.equal(h.page.data.accountStepError, '')
      assertNativeCardsIsolated(h, expectedTypes)
    }
    assert.equal(h.page.data.accountMappings.length, 4)
    assert.equal(h.page.data.accountStepSummary.displayConfirmed, 2)
    h = await reopen(t, h)
    assert.equal(h.page.data.accountMappings.length, 4)
    assert.equal(h.page.data.accountStepSummary.displayConfirmed, 2)
    for (const id of ordered[1]) {
      await h.page.completeAccountMapping(tap(id))
      assertNativeCardsIsolated(h, expectedTypes)
    }
    assertCompleted(h, 4)
    h = await reopen(t, h)
    assertCompleted(h, 4)
  })
}
