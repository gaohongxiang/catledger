const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { facts } = require('./helpers/local-review')
const { syntheticBill } = require('./helpers/local-services')
const local = require('../miniprogram/packages/finance/services/import-local-model')
const readers = require('../miniprogram/packages/finance/services/import-local-read')

const label = '合成测试银行储蓄卡(5564)'
const alipay = (count, prefix = 'SYNTHETIC-JOINT-ALIPAY', method = label) => Buffer.from([
  '支付宝(中国)网络技术有限公司 电子客户回单',
  '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
  ...Array.from({ length: count }, (_, index) => `2026-09-01 12:00:00,餐饮美食,合成商户,合成商品,1.00,支出,${method},交易成功,,${prefix}-${index},,`)
].join('\n'))
const grouped = (reader, data = {}) => reader.read('reviewIssues.list', { group: 'accounts', view: 'account_confirmations', ...data })

test('账户显示组：支付宝3笔与微信2笔为一张待确认卡，原事项和引用身份不改写', async () => {
  const value = await facts({ contents: [alipay(3), syntheticBill(2, 'SYNTHETIC-JOINT-WECHAT', label)], mapped: false })
  const model = local.create(value), reader = readers.create(model)
  const before = JSON.stringify({ issues: [...model.issues.values()], members: [...model.members], events: [...model.events.values()] })
  const original = reader.read('reviewIssues.list', { group: 'accounts' })
  assert.equal(original.total, 2)
  const references = original.items.map(issue => {
    const member = model.members.get(issue.issueId)[0]
    return require('../cloudfunctions/catledger-import/src/account-reference-context').memberReference(model.events.get(member.objectId), member)
  })
  assert.equal(new Set(references.map(reference => reference.accountIdentityKey)).size, 2)
  const page = grouped(reader)
  assert.equal(page.total, 1)
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].memberCount, 5)
  assert.ok(page.items[0].accountConfirmationGroupId)
  assert.equal(page.items[0].issueIds, undefined, '分页摘要不能携带整组成员清单')
  const detail = reader.accountConfirmationDetails({ groupIds: [page.items[0].accountConfirmationGroupId], viewVersion: page.viewVersion })
  assert.equal(detail.issues.length, 2)
  assert.equal(detail.groups[0].candidate, true)
  assert.equal(detail.groups[0].sourceCount, 2)
  assert.equal(detail.groups[0].memberCount, 5)
  assert.deepEqual(detail.groups[0].sources.map(source => source.count).sort(), [2, 3])
  assert.equal(before, JSON.stringify({ issues: [...model.issues.values()], members: [...model.members], events: [...model.events.values()] }))
  assert.equal(model.choices.accounts.size, 0)
  assert.deepEqual(reader.read('reviewIssues.list', { group: 'accounts' }), original)
})

test('联合卡来源明细按全组事件去重并分页，代表来源不截断另一份账单', async () => {
  const value = await facts({ contents: [alipay(3), syntheticBill(2, 'SYNTHETIC-JOINT-DETAIL', label)], mapped: false })
  const model = local.create(value), reader = readers.create(model), page = grouped(reader)
  const accountConfirmationGroupId = page.items[0].accountConfirmationGroupId, ids = [], batches = new Set()
  let cursor = null
  do {
    const response = reader.read('reviewIssues.members', { accountConfirmationGroupId, memberKind: 'event', pageSize: 2, cursor })
    assert.equal(response.total, 5)
    assert.ok(response.items.length <= 2)
    for (const member of response.items) {
      ids.push(member.objectId)
      for (const link of model.evidenceFor(member.objectId)) batches.add(model.rows.get(link.rowId).batchId)
    }
    cursor = response.nextCursor
  } while (cursor)
  assert.equal(ids.length, 5)
  assert.equal(new Set(ids).size, 5)
  assert.equal(batches.size, 2)
})

test('完整集合先分组：超过100个来源事项仍为一张卡，读取和显示摘要有界', async () => {
  const contents = Array.from({ length: 121 }, (_, index) => syntheticBill(1, 'SYNTHETIC-JOINT-PAGE-' + index, label))
  const value = await facts({ contents, mapped: false }), model = local.create(value), reader = readers.create(model)
  assert.equal(reader.read('reviewIssues.list', { group: 'accounts', pageSize: 100 }).total, 121)
  const page = grouped(reader, { pageSize: 100 })
  assert.equal(page.total, 1)
  assert.equal(page.nextCursor, null)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 48 * 1024)
  const detail = reader.accountConfirmationDetails({ groupIds: [page.items[0].accountConfirmationGroupId] })
  assert.equal(detail.issues.length, 121)
  assert.equal(detail.groups[0].sourceCount, 121)
  assert.equal(detail.groups[0].memberCount, 121)
})

test('拆分是本批显示偏好：分页范围改变，原选择、事项和引用均保持', async () => {
  const value = await facts({ contents: [alipay(1), syntheticBill(1, 'SYNTHETIC-JOINT-SPLIT', label)], mapped: false })
  const model = local.create(value), reader = readers.create(model), joint = grouped(reader)
  const original = JSON.stringify(model.finalState())
  const detail = reader.accountConfirmationDetails({ groupIds: [joint.items[0].accountConfirmationGroupId] })
  const separateIssueIds = detail.groups[0].issueIds
  const first = grouped(reader, { separateIssueIds, pageSize: 1 })
  assert.equal(first.total, 2)
  assert.ok(first.nextCursor)
  assert.equal(first.items[0].accountConfirmationGroupId, undefined)
  assert.equal(grouped(reader, { separateIssueIds, pageSize: 1, cursor: first.nextCursor }).items.length, 1)
  assert.throws(() => grouped(reader, { cursor: first.nextCursor }), { code: 'STALE_VIEW' })
  assert.throws(() => reader.accountConfirmationDetails({ groupIds: [joint.items[0].accountConfirmationGroupId], separateIssueIds }), { code: 'STALE_VIEW' })
  assert.equal(JSON.stringify(model.finalState()), original)
  assert.equal(grouped(reader).total, 1)
})

test('已有明确绑定到同一账本账户可折叠，只读打开旧批次不会补写决定', async () => {
  const accountId = randomUUID(), value = await facts({ contents: [alipay(1), syntheticBill(1, 'SYNTHETIC-JOINT-CONFIRMED', label)],
    accounts: [{ accountId, name: label, type: 'bank', nature: 'asset', currency: 'CNY', version: 1 }] })
  const model = local.create(value), reader = readers.create(model), page = grouped(reader)
  assert.equal(reader.read('reviewIssues.list', { group: 'accounts' }).total, 2)
  assert.equal(page.total, 1)
  const { groups } = reader.accountConfirmationDetails({ groupIds: [page.items[0].accountConfirmationGroupId] })
  assert.equal(groups[0].candidate, false)
  assert.equal(groups[0].accountId, accountId)
  assert.equal(model.choices.accounts.size, 0)
})

test('拆开一张完整卡后，其同尾号反证仍在，弱尾号不能被另一张完整卡吸收', async () => {
  const fullA = '合成测试银行储蓄卡9900000000015564', fullB = '合成测试银行储蓄卡9900000000025564'
  const value = await facts({ contents: [alipay(1, 'SYNTHETIC-FULL-A-ALI', fullA), syntheticBill(1, 'SYNTHETIC-FULL-A-WX', fullA),
    alipay(1, 'SYNTHETIC-FULL-B-ALI', fullB), syntheticBill(1, 'SYNTHETIC-FULL-B-WX', fullB),
    syntheticBill(1, 'SYNTHETIC-TAIL-ONLY', label)], mapped: false })
  const model = local.create(value), reader = readers.create(model), page = grouped(reader)
  assert.equal(page.total, 3)
  const before = reader.accountConfirmationDetails({ groupIds: page.items.map(issue => issue.accountConfirmationGroupId).filter(Boolean) })
  assert.equal(before.groups.length, 2)
  assert.ok(before.groups.every(group => group.issueIds.length === 2))
  const separateIssueIds = before.groups[0].issueIds, separated = grouped(reader, { separateIssueIds })
  assert.equal(separated.total, 4)
  const after = reader.accountConfirmationDetails({ separateIssueIds,
    groupIds: separated.items.map(issue => issue.accountConfirmationGroupId).filter(Boolean) })
  assert.equal(after.groups.length, 1)
  assert.equal(after.groups[0].issueIds.length, 2, '弱尾号不能被合入剩下的完整号码组')
  assert.equal(after.groups[0].memberCount, 2)
})

test('原事项部分成员已单独选账户，不能因丢掉该决定而合入另一已确认账户', async () => {
  const accountA = randomUUID(), accountB = randomUUID()
  const value = await facts({ contents: [alipay(2), syntheticBill(1, 'SYNTHETIC-PARTIAL-MANUAL', label)], mapped: false,
    accounts: [accountA, accountB].map((accountId, index) => ({ accountId, name: '合成独立账户' + index,
      type: 'bank', nature: 'asset', currency: 'CNY', version: 1 })) })
  const model = local.create(value), reader = readers.create(model)
  const original = reader.read('reviewIssues.list', { group: 'accounts' }).items
  const first = original.find(issue => issue.memberCount === 2), second = original.find(issue => issue.memberCount === 1)
  model.mapAccount({ issueId: second.issueId, decision: 'apply_fields', fields: { mappingAccountId: accountB } })
  model.edit({ eventId: model.issues.get(first.issueId).subjectEventIds[0], editorVersion: 1, fields: { ledgerAccountId: accountA } })
  const result = grouped(reader)
  assert.equal(result.total, 2)
  assert.ok(result.items.every(issue => !issue.accountConfirmationGroupId))
  assert.equal(model.events.get(model.issues.get(first.issueId).subjectEventIds[0]).ledgerAccountId, accountA)
})

test('保留拆分偏好后，其他同账户子组的来源详情沿用同一显示范围', async () => {
  const accountId = randomUUID(), other = '合成测试银行储蓄卡(7788)'
  const value = await facts({ contents: [alipay(1), syntheticBill(1, 'SYNTHETIC-DETAIL-SPLIT-A', label),
    alipay(1, 'SYNTHETIC-DETAIL-SPLIT-B-ALI', other), syntheticBill(1, 'SYNTHETIC-DETAIL-SPLIT-B-WX', other)], mapped: false,
    accounts: [{ accountId, name: '合成共同账本账户', type: 'bank', nature: 'asset', currency: 'CNY', version: 1 }] })
  const model = local.create(value), reader = readers.create(model), initial = grouped(reader)
  assert.equal(initial.total, 2)
  const detail = reader.accountConfirmationDetails({ groupIds: initial.items.map(issue => issue.accountConfirmationGroupId) })
  const separateIssueIds = detail.groups.find(group => group.label.includes('5564')).issueIds
  for (const issue of detail.issues) model.mapAccount({ issueId: issue.issueId, decision: 'apply_fields', fields: { mappingAccountId: accountId } })
  const page = grouped(reader, { separateIssueIds })
  assert.equal(page.total, 3)
  const remaining = page.items.find(issue => issue.accountConfirmationGroupId)
  const members = reader.read('reviewIssues.members', { accountConfirmationGroupId: remaining.accountConfirmationGroupId,
    separateIssueIds, memberKind: 'event', pageSize: 8 })
  assert.equal(members.total, 2)
  assert.equal(new Set(members.items.map(member => member.objectId)).size, 2)
})
