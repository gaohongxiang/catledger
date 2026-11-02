const assert = require('node:assert/strict')
const test = require('node:test')
const { randomUUID } = require('node:crypto')
const { parseEvidenceFile } = require('../src/parsers')
const { buildSyntheticXlsx } = require('./helpers/xlsx')
const { buildOrganizePlan, accountReferences } = require('../src/organizer-planner')
const { confirmedBinding } = require('../src/account-binding')
const { paymentReferenceKey } = require('../src/payment-account')
const { createMappingIndex, indexForEvent, setMappingDecision, accountIdFromIndex } = require('../src/account-mapping-policy')
const { applyMappedAccount } = require('../src/review/account-mapping-policy')

const ALIPAY_HEADER = ['交易时间','交易分类','交易对方','商品说明','金额','收/支','收/付款方式','交易状态','备注','交易订单号','订单号','商家订单号']
const WECHAT_HEADER = ['交易时间','交易类型','交易对方','商品','收/支','金额(元)','支付方式','当前状态','交易单号','订单号','商户单号','备注']
const BANK = '合成银行储蓄卡(5564)'
const SAVINGS = ['2026-08-05 12:00:00','投资理财','余额宝','余额宝-自动转入','10.00','不计收支','账户余额','交易成功','','SYNTH-SAVINGS-IN','','']
const WITHDRAWAL = ['2026-08-06 12:00:00','零钱提现',BANK,'/','/','20.00',BANK,'提现已到账','SYNTH-WITHDRAWAL','','','']

async function parseRows(alipayRows = [SAVINGS], wechatRows = [WITHDRAWAL]) {
  const documents = []
  if (alipayRows.length) documents.push(await parseEvidenceFile({ extension: 'csv', timezoneOffsetMinutes: -480,
    content: Buffer.from([['支付宝交易记录明细列表'],ALIPAY_HEADER,...alipayRows].map(row => row.join(',')).join('\n')) }))
  if (wechatRows.length) documents.push(await parseEvidenceFile({ extension: 'xlsx', timezoneOffsetMinutes: -480,
    content: await buildSyntheticXlsx([['微信支付账单明细'],WECHAT_HEADER,...wechatRows]) }))
  const rows = documents.flatMap((document, sourceOrder) => {
    const batchId = randomUUID()
    return document.rows.map((row, index) => ({ ...row.normalized, rowId: randomUUID(), batchId, sourceOrder,
      rowNumber: index + 1, parseState: row.parseState, identityId: randomUUID(), identityState: 'new',
      sourceType: document.descriptor.sourceType, sourceFormat: document.descriptor.sourceFormat,
      paymentMethod: row.raw.paymentMethod, rawStatus: row.raw.status, rawTransactionType: row.raw.transactionType,
      semantic: row.semantic, sourceTransactionId: row.identifiers.transactionId,
      sourceOrderId: row.identifiers.orderId, sourceMerchantOrderId: row.identifiers.merchantOrderId }))
  })
  return { rows, documents, plan: buildOrganizePlan({ updateId: randomUUID(), rows }) }
}

function catalog(rows) {
  const byReference = new Map(accountReferences(rows).map(reference => [paymentReferenceKey(reference), {
    accountId: randomUUID(), name: reference.label, type: reference.expectedAccountType,
    nature: 'asset', currency: 'CNY', version: 1
  }]))
  return { byReference, accounts: [...byReference.values()] }
}
function mapping(reference, accountId, eventId) {
  return { sourceType: reference.sourceType, paymentMethodKey: reference.bindingKey || reference.paymentMethodKey,
    paymentMethodHint: reference.label, mappingAction: 'account', accountId, mappingScope: 'batch',
    binding: confirmedBinding(reference), ...(eventId ? { eventId } : {}) }
}

test('支付宝 CSV 自动转入和微信 XLSX 提现先识别为转账，再分别确认真实两端', async () => {
  const { documents, plan } = await parseRows()
  assert.deepEqual(documents.map(document => document.descriptor.sourceFormat), ['alipay_app_csv','wechat_xlsx'])
  assert.equal(plan.events.length, 2)
  assert.equal(plan.issues.length, 4)
  assert.ok(plan.issues.every(issue => issue.issueType === 'account_mapping' && issue.status === 'open'))
  for (const event of plan.events) {
    assert.equal(event.economicNature, 'internal_transfer')
    assert.equal(event.flowDirection, 'neutral')
    assert.deepEqual(plan.members.filter(member => member.objectId === event.eventId).map(member => member.memberRole).sort(),
      ['mapping_from','mapping_to'])
    assert.equal(event.fieldSources.paymentAccountReferences, undefined)
  }
  assert.deepEqual(plan.events.map(event => {
    const projection = event.fieldSources.fundsProjection
    return [projection.kind,projection.from.label,projection.to.label]
  }).sort(), [
    ['platform_savings_in','支付宝账户余额','支付宝余额宝'],
    ['withdrawal','微信零钱',BANK]
  ])
})

test('完整事件映射索引按任意端点顺序确认，两端选择和来源引用均保留', async () => {
  const { rows, plan } = await parseRows(), { accounts, byReference } = catalog(rows)
  for (const order of [['from','to'],['to','from']]) {
    const index = createMappingIndex([], { accounts })
    for (const original of plan.events) {
      let event = original
      for (const side of order) {
        const reference = event.fieldSources.fundsProjection[side]
        indexForEvent(index, event)
        setMappingDecision(index, reference, 'account', byReference.get(paymentReferenceKey(reference)).accountId, event.eventId)
        event = applyMappedAccount(event, 'mapping_' + side,
          byReference.get(paymentReferenceKey(reference)).accountId, indexForEvent(index, event))
      }
      assert.equal(event.ledgerAccountId, byReference.get(paymentReferenceKey(event.fieldSources.fundsProjection.from)).accountId)
      assert.equal(event.counterpartyLedgerAccountId, byReference.get(paymentReferenceKey(event.fieldSources.fundsProjection.to)).accountId)
      assert.deepEqual(event.fieldSources.fundsProjection, original.fieldSources.fundsProjection)
      const other = { ...event, eventId: randomUUID() }
      assert.equal(accountIdFromIndex(indexForEvent(index, other), event.fieldSources.fundsProjection.from), null,
        '当前事件的选择不能扩大到另一事件')
    }
  }
})

test('已有事件范围映射先恢复再改另一端，改选仍只影响所选端', async () => {
  const { rows, plan } = await parseRows(), { accounts, byReference } = catalog(rows)
  for (const original of plan.events) {
    const { from, to } = original.fieldSources.fundsProjection
    const fromId = byReference.get(paymentReferenceKey(from)).accountId, toId = byReference.get(paymentReferenceKey(to)).accountId
    const alternate = { ...byReference.get(paymentReferenceKey(to)), accountId: randomUUID(), name: '另一合成账户' }
    const index = createMappingIndex([mapping(from, fromId, original.eventId)], { accounts: accounts.concat(alternate) })
    let event = { ...original, ledgerAccountId: fromId }
    indexForEvent(index, event)
    for (const selected of [toId, alternate.accountId]) {
      setMappingDecision(index, to, 'account', selected, event.eventId)
      event = applyMappedAccount(event, 'mapping_to', selected, indexForEvent(index, event))
      assert.equal(event.ledgerAccountId, fromId)
      assert.equal(event.counterpartyLedgerAccountId, selected)
    }
  }
})

test('两端明确绑定后，首次规划直接形成就绪转账而不再新增账户待办', async () => {
  const { rows } = await parseRows(), { accounts, byReference } = catalog(rows)
  const plan = buildOrganizePlan({ updateId: randomUUID(), rows, accounts,
    paymentMappings: accountReferences(rows).map(reference => mapping(reference, byReference.get(paymentReferenceKey(reference)).accountId)) })
  assert.ok(plan.events.every(event => event.status === 'ready' && event.economicNature === 'internal_transfer' &&
    event.ledgerAccountId && event.counterpartyLedgerAccountId && event.ledgerAccountId !== event.counterpartyLedgerAccountId))
  assert.equal(plan.issues.length, 4)
  assert.ok(plan.issues.every(issue => issue.status === 'resolved' && issue.issueType === 'account_mapping'))
})

test('显式确认另一端属于外部后，资金动作按归属成为收支并保留本人端', async () => {
  const { rows, plan } = await parseRows(), { accounts, byReference } = catalog(rows)
  for (const original of plan.events) for (const externalSide of ['from','to']) for (const order of [['from','to'],['to','from']]) {
    const index = createMappingIndex([], { accounts })
    let event = original, ownId = null
    for (const side of order) {
      const reference = event.fieldSources.fundsProjection[side], external = side === externalSide
      const accountId = external ? null : byReference.get(paymentReferenceKey(reference)).accountId
      if (!external) ownId = accountId
      indexForEvent(index, event)
      setMappingDecision(index, reference, external ? 'external' : 'account', accountId, event.eventId)
      event = applyMappedAccount(event, 'mapping_' + side, accountId, indexForEvent(index, event), external ? 'external' : 'account')
    }
    const ownership = require('../src/account-ownership').read(event)
    assert.equal(event.economicNature, externalSide === 'from' ? 'income' : 'expense')
    assert.equal(ownership[externalSide === 'from' ? 'source' : 'destination'].kind, 'external')
    assert.equal(ownership[externalSide === 'from' ? 'destination' : 'source'].accountId, ownId)
  }
})

test('提现银行没有卡号线索时，先确认零钱，再保留明确的转账补端事项', async () => {
  const unknown = WITHDRAWAL.map((value, index) => [2,6].includes(index) ? '合成银行' : value)
  const { rows, plan } = await parseRows([], [unknown]), { accounts, byReference } = catalog(rows)
  assert.equal(plan.events[0].economicNature, 'internal_transfer')
  assert.equal(plan.issues.length, 1)
  assert.equal(plan.members[0].memberRole, 'mapping_from')
  const knownReference = plan.events[0].fieldSources.fundsProjection.from
  const confirmed = buildOrganizePlan({ updateId: randomUUID(), rows, accounts,
    paymentMappings: [mapping(knownReference, byReference.get(paymentReferenceKey(knownReference)).accountId)] })
  assert.equal(confirmed.events[0].counterpartyLedgerAccountId, null)
  assert.deepEqual(confirmed.issues.filter(issue => issue.status === 'open').map(issue => issue.issueType), ['transfer_accounts'])
})

test('余额宝转出、明确手续费和带银行卡对方的普通转账仍各守原性质', async () => {
  const savingsOut = SAVINGS.map((value, index) => index === 3 ? '余额宝-转出到余额' : value)
  const fee = ['2026-08-06 12:00:01','手续费','合成提现服务','提现服务费','支出','0.01','零钱','支付成功','SYNTH-FEE','','','']
  const transfer = ['2026-08-07 12:00:00','转账',BANK,'合成转账','支出','5.00','零钱','支付成功','SYNTH-TRANSFER','','','']
  const purchase = SAVINGS.map((value, index) => index === 1 ? '购物' : index === 3 ? '余额宝-自动转入优惠券' : index === 5 ? '支出' : index === 9 ? 'SYNTH-PURCHASE' : value)
  const { plan } = await parseRows([savingsOut, purchase], [fee, transfer])
  const movement = plan.events.find(event => event.fieldSources.fundsProjection)
  assert.equal(movement.economicNature, 'internal_transfer')
  assert.equal(movement.fieldSources.fundsProjection.from.label, '支付宝余额宝')
  assert.equal(movement.fieldSources.fundsProjection.to.label, '支付宝账户余额')
  assert.deepEqual(plan.events.filter(event => !event.fieldSources.fundsProjection).map(event => event.economicNature).sort(),
    ['expense','expense','fee'])
  assert.equal(plan.events.find(event => event.economicNature === 'fee').amountMinor, '1')
})
