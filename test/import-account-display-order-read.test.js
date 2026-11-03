const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { facts } = require('./helpers/local-review')
const { syntheticBill } = require('./helpers/local-services')
const local = require('../miniprogram/packages/finance/services/import-local-model')
const readers = require('../miniprogram/packages/finance/services/import-local-read')

const label = '合成排序银行储蓄卡(5564)'
const bank = name => ({ accountId: randomUUID(), name, type: 'bank', nature: 'asset', currency: 'CNY', version: 1 })
const bill = (count, prefix, method = label) => Buffer.from([
  '支付宝(中国)网络技术有限公司 电子客户回单',
  '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
  ...Array.from({ length: count }, (_, index) => `2026-09-01 12:00:00,餐饮美食,合成商户,合成商品,1.00,支出,${method},交易成功,,${prefix}-${index},,`)
].join('\n'))
const list = (reader, data = {}) => reader.read('reviewIssues.list', { group: 'accounts', view: 'account_confirmations', ...data })
const confirm = (model, issue, account) => model.mapAccount({ issueId: issue.issueId || issue,
  decision: 'apply_fields', fields: { mappingAccountId: account.accountId } })
const selected = (issueId, account) => ({ issueId, mode: 'account', accountId: account.accountId, explicit: true, dirty: true })

async function splitFixture() {
  const accounts = [bank('合成排序账户一'), bank('合成排序账户二')]
  const value = await facts({ mapped: false, accounts, contents: [
    bill(4, 'SYNTHETIC-ORDER-GROUP-A'), syntheticBill(2, 'SYNTHETIC-ORDER-GROUP-B', label),
    bill(5, 'SYNTHETIC-ORDER-OTHER', '合成排序银行储蓄卡(7788)')]
  })
  const model = local.create(value), reader = readers.create(model), initial = list(reader)
  const joined = initial.items.find(issue => issue.accountConfirmationGroupId)
  const detail = reader.accountConfirmationDetails({ groupIds: [joined.accountConfirmationGroupId] })
  const group = { groupId: detail.groups[0].groupId, issueIds: detail.groups[0].issueIds, mode: 'separated' }
  const members = detail.issues.sort((left, right) => right.memberCount - left.memberCount)
  const other = initial.items.find(issue => !issue.accountConfirmationGroupId)
  return { model, reader, accounts, group, members, other }
}

test('整批按待确认、去重笔数降序、稳定身份排序，不依赖原问题或时间顺序', async () => {
  const account = bank('合成已确认账户'), value = await facts({ mapped: false, accounts: [account], contents: [
    bill(2, 'SYNTHETIC-ORDER-SMALL', '合成排序银行储蓄卡(1001)'),
    bill(8, 'SYNTHETIC-ORDER-LARGE', '合成排序银行储蓄卡(1002)'),
    bill(4, 'SYNTHETIC-ORDER-EQUAL-A', '合成排序银行储蓄卡(1003)'),
    bill(4, 'SYNTHETIC-ORDER-EQUAL-B', '合成排序银行储蓄卡(1004)'),
    bill(12, 'SYNTHETIC-ORDER-SAVED', '合成排序银行储蓄卡(1005)')]
  })
  const model = local.create(value), reader = readers.create(model)
  const saved = list(reader).items.find(issue => issue.memberCount === 12)
  confirm(model, saved, account)
  const first = list(reader)
  assert.deepEqual(first.items.map(issue => issue.memberCount), [8, 4, 4, 2, 12])
  assert.deepEqual(first.items.filter(issue => issue.memberCount === 4).map(issue => issue.issueId),
    first.items.filter(issue => issue.memberCount === 4).map(issue => issue.issueId).sort())
  model.issues = new Map([...model.issues].reverse())
  const reopened = list(readers.create(model))
  assert.deepEqual(reopened.items.map(issue => issue.issueId), first.items.map(issue => issue.issueId))
  const changed = list(reader, { accountSelections: [selected(saved.issueId, account)] })
  assert.equal(changed.items[0].issueId, saved.issueId, '已确认项有待保存改动时重新进入待确认区')
  assert.notEqual(changed.accountConfirmationVersion, first.accountConfirmationVersion)
})

test('拆开的整组按总数排序，部分确认、不同账户、再次改选都不打散', async () => {
  const { model, reader, accounts, group, members, other } = await splitFixture()
  const options = { displayGroups: [group], separateIssueIds: group.issueIds }
  const expected = [...members.map(issue => issue.issueId), other.issueId]
  assert.deepEqual(list(reader, options).items.map(issue => issue.issueId), expected)
  confirm(model, members[0], accounts[0])
  assert.deepEqual(list(reader, options).items.map(issue => issue.issueId), expected)
  confirm(model, members[1], accounts[1])
  const done = list(reader, options)
  assert.deepEqual(done.items.map(issue => issue.issueId), [other.issueId, ...expected.slice(0, 2)])
  assert.ok(done.items.slice(1).every(issue => issue.accountSeparatedGroupId === group.groupId))
  const changed = list(reader, { ...options, accountSelections: [selected(members[1].issueId, accounts[0])] })
  assert.deepEqual(changed.items.map(issue => issue.issueId), expected)
  assert.equal(model.events.get(model.issues.get(members[1].issueId).subjectEventIds[0]).ledgerAccountId, accounts[1].accountId)
})

test('普通拆分组整体换页，过大组有界连续分页，完整成员只由本机详情读取', async () => {
  const { model, reader, group, members, other } = await splitFixture()
  // The separate group has 6 unique entries; make the unrelated row sort first.
  const event = model.issues.get(other.issueId).subjectEventIds[0]
  for (let index = 0; index < 3; index++) {
    const clone = { ...model.events.get(event), eventId: randomUUID() }
    model.events.set(clone.eventId, clone)
    model.issues.get(other.issueId).subjectEventIds.push(clone.eventId)
  }
  const current = readers.create(model), options = { displayGroups: [group], separateIssueIds: group.issueIds, pageSize: 2 }
  const first = list(current, options)
  assert.equal(first.items.length, 1)
  assert.equal(first.items[0].issueId, other.issueId)
  assert.equal(first.pageBoundary, true)
  const second = list(current, { ...options, cursor: first.nextCursor })
  assert.deepEqual(second.items.map(issue => issue.issueId), members.map(issue => issue.issueId))
  assert.equal(second.nextCursor, null)
  const one = list(reader, { displayGroups: [group], separateIssueIds: group.issueIds, pageSize: 1 })
  const detail = reader.accountConfirmationDetails({ displayGroups: [group], separateIssueIds: group.issueIds,
    groupIds: [group.groupId], accountConfirmationVersion: one.accountConfirmationVersion })
  assert.equal(detail.groups[0].displayMode, 'separated')
  assert.equal(detail.issues.length, 2)
  let cursor = null, ids = []
  do {
    const page = list(current, { ...options, pageSize: 1, cursor })
    assert.ok(page.items.length <= 1)
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 48 * 1024)
    ids.push(...page.items.map(issue => issue.issueId)); cursor = page.nextCursor
  } while (cursor)
  assert.deepEqual(ids, [other.issueId, ...members.map(issue => issue.issueId)])
})

test('合回不同已确认账户保留冲突和原决定，同一已确认账户只合展示', async () => {
  const { model, reader, accounts, group, members } = await splitFixture()
  confirm(model, members[0], accounts[0]); confirm(model, members[1], accounts[1])
  const before = JSON.stringify(model.finalState()), displayGroups = [{ ...group, mode: 'joined' }]
  const joined = list(reader, { displayGroups })
  const detail = reader.accountConfirmationDetails({ displayGroups, groupIds: [group.groupId] })
  assert.equal(joined.total, 2)
  assert.equal(detail.groups[0].groupReason, 'manual_join')
  assert.equal(detail.groups[0].candidate, true)
  assert.equal(detail.groups[0].needsConfirmation, true)
  assert.equal(detail.groups[0].accountId, null)
  assert.equal(detail.groups[0].selectedAccountId, null)
  assert.equal(detail.groups[0].conflictReason, 'different_account_choices')
  assert.equal(JSON.stringify(model.finalState()), before)
  const creating = reader.accountConfirmationDetails({ displayGroups, groupIds: [group.groupId],
    accountSelections: members.map(issue => ({ issueId: issue.issueId, mode: 'create', dirty: true })) }).groups[0]
  assert.equal(creating.candidate, true, '共同新建输入需要保留显示组，不能与原事项内部账户冲突混为一谈')
  assert.equal(creating.accountId, null)
  const accountSelections = members.map(issue => selected(issue.issueId, accounts[0]))
  const chosen = reader.accountConfirmationDetails({ displayGroups, accountSelections, groupIds: [group.groupId] }).groups[0]
  assert.equal(chosen.selectedAccountId, accounts[0].accountId)
  assert.equal(chosen.accountId, null)
  assert.equal(chosen.candidate, true)
  confirm(model, members[1], accounts[0])
  const confirmed = reader.accountConfirmationDetails({ displayGroups, groupIds: [group.groupId] }).groups[0]
  assert.equal(confirmed.candidate, false)
  assert.equal(confirmed.accountId, accounts[0].accountId)
})

test('显示组模式或成员变化令列表、详情及凭据旧范围同时失效', async () => {
  const { reader, group } = await splitFixture()
  const separated = { displayGroups: [group], separateIssueIds: group.issueIds, pageSize: 1 }
  const first = list(reader, separated)
  const joined = { displayGroups: [{ ...group, mode: 'joined' }] }
  const next = list(reader, joined)
  assert.notEqual(first.accountConfirmationVersion, next.accountConfirmationVersion)
  assert.throws(() => list(reader, { ...joined, cursor: first.nextCursor }), { code: 'STALE_VIEW' })
  assert.throws(() => reader.accountConfirmationDetails({ ...joined, groupIds: [group.groupId],
    accountConfirmationVersion: first.accountConfirmationVersion }), { code: 'STALE_VIEW' })
  assert.throws(() => reader.read('reviewIssues.members', { ...joined, accountConfirmationGroupId: group.groupId,
    accountConfirmationVersion: first.accountConfirmationVersion }), { code: 'STALE_VIEW' })
  const reordered = list(reader, { displayGroups: [{ ...group, issueIds: [...group.issueIds].reverse() }],
    separateIssueIds: [...group.issueIds].reverse(), pageSize: 1 })
  assert.equal(reordered.accountConfirmationVersion, first.accountConfirmationVersion)
})

test('完整批次排序先于100项分页，后部大卡排到第一页，拆开组不吸入第三张卡', async () => {
  const contents = Array.from({ length: 101 }, (_, index) =>
    bill(1, 'SYNTHETIC-ORDER-PAGES-' + index, '合成排序银行储蓄卡(' + (2000 + index) + ')'))
  contents.push(bill(10, 'SYNTHETIC-ORDER-PAGES-LARGE', '合成排序银行储蓄卡(9000)'))
  const value = await facts({ mapped: false, contents }), model = local.create(value), reader = readers.create(model)
  const first = list(reader, { pageSize: 100 })
  assert.equal(first.total, 102)
  assert.equal(first.items[0].memberCount, 10)
  assert.ok(first.nextCursor)
  const all = [...first.items]
  let cursor = first.nextCursor
  while (cursor) {
    const page = list(reader, { pageSize: 100, cursor })
    all.push(...page.items); cursor = page.nextCursor
  }
  assert.equal(new Set(all.map(issue => issue.issueId)).size, 102)
  const group = { groupId: 'account-confirmation:synthetic-display-preference',
    issueIds: all.slice(1, 3).map(issue => issue.issueId), mode: 'joined' }
  const arranged = list(reader, { displayGroups: [group], pageSize: 100 })
  assert.equal(arranged.total, 101)
  assert.equal(arranged.items[1].accountConfirmationGroupId, group.groupId)
  assert.equal(arranged.items[1].memberCount, 2)
})

test('拆开组总数按事件并集，重新合并仍校验币种', async () => {
  const { model, reader, group, members } = await splitFixture()
  const firstMember = model.members.get(members[0].issueId)[0]
  model.members.get(members[1].issueId).push({ ...firstMember, memberId: randomUUID(), issueId: members[1].issueId })
  model.issues.get(members[1].issueId).subjectEventIds.push(firstMember.objectId)
  const fresh = readers.create(model), displayGroups = [group]
  const descriptor = fresh.accountConfirmationDetails({ displayGroups, groupIds: [group.groupId] }).groups[0]
  assert.equal(descriptor.memberCount, 6, '共享一笔原始事件不能计成7笔')
  assert.equal(list(fresh, { displayGroups }).items[0].accountSeparatedGroupId, group.groupId)
  const otherCurrency = model.issues.get(members[1].issueId)
  otherCurrency.accountContext.currency = 'USD'
  const incompatible = readers.create(model)
  assert.equal(list(incompatible, { displayGroups: [{ ...group, mode: 'joined' }] }).items
    .some(issue => issue.accountConfirmationGroupId === group.groupId), false)
  assert.equal(list(incompatible, { displayGroups }).items.filter(issue => issue.accountSeparatedGroupId === group.groupId).length, 2,
    '分别确认的邻接关系不表示共同账户决定')
  assert.equal(reader.read('reviewIssues.list', { group: 'accounts' }).total, 3)
})

test('整组重新合并后可吸收新手选的同账户卡，冲突组不能只吸走其中一张', async () => {
  const account = bank('合成同账户扩展'), value = await facts({ mapped: false, accounts: [account], contents: [
    bill(4, 'SYNTHETIC-ORDER-EXPAND-A', label),
    bill(2, 'SYNTHETIC-ORDER-EXPAND-B', '合成排序银行储蓄卡(7788)'),
    bill(1, 'SYNTHETIC-ORDER-EXPAND-C', '合成排序银行储蓄卡(9900)')]
  })
  const model = local.create(value), reader = readers.create(model), original = list(reader).items
  const group = { groupId: 'account-confirmation:synthetic-explicit-pair',
    issueIds: original.slice(0, 2).map(issue => issue.issueId), mode: 'joined' }
  const partial = list(reader, { displayGroups: [group], accountSelections: [
    selected(original[0].issueId, account), selected(original[2].issueId, account)] })
  assert.equal(partial.total, 2)
  const partialDetails = reader.accountConfirmationDetails({ displayGroups: [group], accountSelections: [
    selected(original[0].issueId, account), selected(original[2].issueId, account)], groupIds: [group.groupId] })
  assert.deepEqual(new Set(partialDetails.groups[0].issueIds), new Set(group.issueIds))
  for (const issue of original.slice(0, 2)) confirm(model, issue, account)
  const stable = list(reader, { displayGroups: [group] })
  assert.ok(stable.items.some(issue => issue.accountConfirmationGroupId === group.groupId), '相同成员仍沿用显式组身份')
  const options = { displayGroups: [group], accountSelections: [selected(original[2].issueId, account)] }
  const expanded = list(reader, options)
  assert.equal(expanded.total, 1)
  assert.equal(expanded.items[0].memberCount, 7)
  const detail = reader.accountConfirmationDetails({ ...options, groupIds: [expanded.items[0].accountConfirmationGroupId] })
  assert.equal(detail.groups[0].issueIds.length, 3)
  assert.equal(detail.groups[0].selectedAccountId, account.accountId)
  assert.equal(detail.groups[0].candidate, true)
  assert.equal(model.issues.get(original[2].issueId).status, 'open')
  const preview = reader.accountConfirmationDetails({ ...options, containingIssueIds: group.issueIds })
  assert.equal(preview.groups[0].groupId, expanded.items[0].accountConfirmationGroupId)
  assert.equal(preview.issues.length, 3, '重新合并预览返回实际扩大组的完整事项，不静默漏掉第三项')
  assert.throws(() => reader.accountConfirmationDetails({ ...options, groupIds: [group.groupId] }), { code: 'STALE_VIEW' },
    '旧groupId不可静默转为新的扩大组')
  assert.throws(() => reader.accountConfirmationDetails({ ...options, containingIssueIds: group.issueIds,
    accountConfirmationVersion: stable.accountConfirmationVersion }), { code: 'STALE_VIEW' })
  assert.throws(() => reader.accountConfirmationDetails({ ...options, containingIssueIds: [group.issueIds[0], randomUUID()] }), { code: 'STALE_VIEW' })
  assert.throws(() => reader.accountConfirmationDetails({ ...options, containingIssueIds: group.issueIds,
    groupIds: [expanded.items[0].accountConfirmationGroupId] }), { code: 'STALE_VIEW' })
})

test('混合排除拆分组整组留主列表，全部已确认排除才进入不计入区', async () => {
  const { model, reader, group, members } = await splitFixture()
  const options = { displayGroups: [group], separateIssueIds: group.issueIds }
  model.mapAccount({ issueId: members[0].issueId, decision: 'exclude_events', fields: {} })
  assert.ok(list(reader, options).items.filter(issue => issue.accountSeparatedGroupId).every(issue =>
    issue.accountSeparatedGroupExcluded === false))
  model.mapAccount({ issueId: members[1].issueId, decision: 'exclude_events', fields: {} })
  assert.ok(list(reader, options).items.filter(issue => issue.accountSeparatedGroupId).every(issue =>
    issue.accountSeparatedGroupExcluded === true))
  const dirty = { ...options, accountSelections: [{ issueId: members[0].issueId, mode: 'pending', dirty: true }] }
  assert.ok(list(reader, dirty).items.filter(issue => issue.accountSeparatedGroupId).every(issue =>
    issue.accountSeparatedGroupExcluded === false))
})

test('超过100来源的拆分组只传有界卡片摘要，续页不漏不重且仍可读取整组', async () => {
  const value = await facts({ mapped: false, contents: Array.from({ length: 121 }, (_, index) =>
    syntheticBill(1, 'SYNTHETIC-ORDER-LARGE-SPLIT-' + index, label)) })
  const model = local.create(value), reader = readers.create(model), initial = list(reader)
  const original = reader.accountConfirmationDetails({ groupIds: [initial.items[0].accountConfirmationGroupId] }).groups[0]
  const group = { groupId: original.groupId, issueIds: original.issueIds, mode: 'separated' }
  const options = { displayGroups: [group], separateIssueIds: group.issueIds, pageSize: 100 }
  let cursor = null, ids = [], pageCount = 0
  do {
    const page = list(reader, { ...options, cursor })
    assert.equal(page.total, 121)
    assert.ok(page.items.length > 0 && page.items.length <= 100)
    assert.ok(Buffer.byteLength(JSON.stringify(page.items)) <= 48 * 1024)
    assert.ok(page.items.every(issue => issue.accountSeparatedGroupId === group.groupId && !issue.issueIds))
    ids.push(...page.items.map(issue => issue.issueId)); cursor = page.nextCursor; pageCount++
  } while (cursor)
  assert.ok(pageCount > 1)
  assert.equal(ids.length, 121)
  assert.equal(new Set(ids).size, 121)
  const detail = reader.accountConfirmationDetails({ ...options, groupIds: [group.groupId] })
  assert.equal(detail.issues.length, 121)
  assert.equal(detail.groups[0].memberCount, 121)
})

test('手动显示组仍不能把不兼容类型或同笔资金两端变成共同账户卡', async () => {
  const value = await facts({ mapped: false, contents: [bill(1, 'SYNTHETIC-ORDER-TYPE-BANK', label),
    bill(1, 'SYNTHETIC-ORDER-TYPE-CREDIT', '合成排序银行信用卡(6106)')] })
  const model = local.create(value), reader = readers.create(model), original = list(reader).items
  const preference = { groupId: 'account-confirmation:synthetic-incompatible', issueIds: original.map(issue => issue.issueId), mode: 'joined' }
  assert.ok(list(reader, { displayGroups: [preference] }).items.every(issue => !issue.accountConfirmationGroupId))
  const sourceIssue = original.find(issue => issue.accountContext.label === label), cloneId = randomUUID()
  const sourceMember = model.members.get(sourceIssue.issueId)[0]
  model.issues.set(cloneId, { ...model.issues.get(sourceIssue.issueId), issueId: cloneId })
  model.members.set(cloneId, [{ ...sourceMember, issueId: cloneId, memberId: randomUUID(), memberRole: 'mapping_to' }])
  const opposing = { groupId: 'account-confirmation:synthetic-opposite-ends', issueIds: [sourceIssue.issueId, cloneId], mode: 'joined' }
  const fresh = readers.create(model)
  assert.ok(list(fresh, { displayGroups: [opposing] }).items.every(issue => issue.accountConfirmationGroupId !== opposing.groupId))
  assert.throws(() => fresh.accountConfirmationDetails({ displayGroups: [opposing], groupIds: [opposing.groupId] }), { code: 'STALE_VIEW' })
})

test('一个原事项内部已有账户分歧时，手动合回不能用整卡共同选择覆盖该分歧', async () => {
  const accounts = [bank('合成成员账户甲'), bank('合成成员账户乙')]
  const value = await facts({ mapped: false, accounts, contents: [
    bill(2, 'SYNTHETIC-ORDER-MEMBER-CONFLICT-A'), syntheticBill(1, 'SYNTHETIC-ORDER-MEMBER-CONFLICT-B', label)] })
  const model = local.create(value), reader = readers.create(model)
  const originals = reader.read('reviewIssues.list', { group: 'accounts' }).items
  const first = originals.find(issue => issue.memberCount === 2), second = originals.find(issue => issue.memberCount === 1)
  const eventIds = model.issues.get(first.issueId).subjectEventIds
  confirm(model, second, accounts[1])
  model.edit({ eventId: eventIds[0], editorVersion: 1, fields: { ledgerAccountId: accounts[0].accountId } })
  const group = { groupId: 'account-confirmation:synthetic-member-conflict',
    issueIds: [first.issueId, second.issueId], mode: 'joined' }
  const options = { displayGroups: [group], accountSelections: originals.map(issue => selected(issue.issueId, accounts[1])) }
  const before = JSON.stringify(model.finalState())
  assert.equal(list(reader, options).total, 2)
  assert.ok(list(reader, options).items.every(issue => !issue.accountConfirmationGroupId))
  assert.throws(() => reader.accountConfirmationDetails({ ...options, containingIssueIds: group.issueIds }), { code: 'STALE_VIEW' })
  assert.equal(JSON.stringify(model.finalState()), before)
  model.edit({ eventId: eventIds[1], editorVersion: 1, fields: { ledgerAccountId: accounts[1].accountId } })
  // Even when both individual members have a ledger account, they do not form
  // one saved account ID that a display preference may choose arbitrarily.
  model.issues.get(first.issueId).status = 'resolved'
  const fresh = readers.create(model)
  assert.equal(list(fresh, options).total, 2)
  assert.ok(list(fresh, options).items.every(issue => !issue.accountConfirmationGroupId))
  const separated = fresh.accountConfirmationDetails({ displayGroups: [{ ...group, mode: 'separated' }], groupIds: [group.groupId] })
  assert.equal(separated.groups[0].accountId, null)
  assert.equal(separated.groups[0].needsConfirmation, true)
})

test('真实字节截断可补足100张逻辑页，临界拆分组仍整体换页且不返回空块', async () => {
  const { create } = require('../miniprogram/packages/finance/services/import-view-session')
  const contents = Array.from({ length: 101 }, (_, index) =>
    bill(3, 'SYNTHETIC-ORDER-BYTE-PAGES-' + index, '合成排序银行储蓄卡(' + (3000 + index) + ')'))
  contents.push(bill(1, 'SYNTHETIC-ORDER-BYTE-SPLIT-A'), syntheticBill(1, 'SYNTHETIC-ORDER-BYTE-SPLIT-B', label))
  const value = await facts({ mapped: false, contents }), model = local.create(value), reader = readers.create(model)
  const initial = list(reader, { pageSize: 100 })
  assert.ok(initial.items.length < 100, '真实公开事项摘要应触发48KiB读取上限')
  assert.ok(initial.nextCursor)
  assert.equal(initial.pageBoundary, undefined, '字节短块不应提前结束逻辑页')
  const calls = [], session = create((action, input) => {
    const response = reader.read(action, input)
    calls.push(response)
    assert.ok(response.items.length > 0)
    assert.ok(Buffer.byteLength(JSON.stringify(response.items)) <= 48 * 1024)
    return response
  }, reader.read('financeUpdates.summary'))
  const pager = session.pager('reviewIssues.list', { group: 'accounts', view: 'account_confirmations', pageSize: 100 }, { fillPage: true })
  const full = await pager.load('first')
  assert.equal(full.items.length, 100)
  assert.ok(calls.length > 1)
  assert.equal(full.page.end, 100)
  const remaining = await pager.load(1)
  assert.equal(remaining.items.length, 2)
  assert.equal(remaining.page.start, 101)
  session.close()

  // Remove two unrelated cards so the two-member split group starts at 99.
  const remove = [...model.issues.values()].filter(issue => issue.issueType === 'account_mapping' &&
    issue.accountContext?.label !== label).slice(0, 2)
  for (const issue of remove) model.issues.delete(issue.issueId)
  const fresh = readers.create(model), issues = [...model.issues.values()].filter(issue => issue.issueType === 'account_mapping' &&
    issue.accountContext?.label === label)
  const group = { groupId: 'account-confirmation:synthetic-byte-boundary', issueIds: issues.map(issue => issue.issueId), mode: 'separated' }
  const splitCalls = [], splitSession = create((action, input) => {
    const response = fresh.read(action, input)
    splitCalls.push(response)
    assert.ok(response.items.length > 0, '跨字节块到达拆分组边界时不能返回空块')
    return response
  }, fresh.read('financeUpdates.summary'))
  const splitPager = splitSession.pager('reviewIssues.list', { group: 'accounts', view: 'account_confirmations',
    displayGroups: [group], separateIssueIds: group.issueIds, pageSize: 100 }, { fillPage: true })
  const first = await splitPager.load('first')
  assert.equal(first.items.length, 99)
  assert.equal(first.pageBoundary, true)
  assert.ok(first.items.every(issue => !issue.accountSeparatedGroupId))
  assert.ok(splitCalls.length > 1)
  const second = await splitPager.load(1)
  assert.equal(second.items.length, 2)
  assert.ok(second.items.every(issue => issue.accountSeparatedGroupId === group.groupId))
  assert.deepEqual([second.page.start, second.page.end, second.page.hasNext], [100, 101, false])
  assert.equal((await splitPager.load(-1)).items.length, 99)
  splitSession.close()
})

test('旧版仅原事项拆分标记仍按全批同来源名与币种相邻，详情可取跨页完整成员', async () => {
  const { model, reader, group, members, other } = await splitFixture()
  const options = { separateIssueIds: group.issueIds, pageSize: 1 }
  const first = list(reader, options), legacyId = 'legacy:' + label + '|CNY'
  assert.equal(first.items[0].accountSeparatedGroupId, legacyId)
  assert.equal(first.items[0].issueId, members[0].issueId)
  const second = list(reader, { ...options, cursor: first.nextCursor })
  assert.equal(second.items[0].accountSeparatedGroupId, legacyId)
  assert.equal(second.items[0].issueId, members[1].issueId)
  const third = list(reader, { ...options, cursor: second.nextCursor })
  assert.equal(third.items[0].issueId, other.issueId)
  const detail = reader.accountConfirmationDetails({ ...options, groupIds: [legacyId],
    accountConfirmationVersion: first.accountConfirmationVersion })
  assert.equal(detail.groups[0].displayMode, 'separated')
  assert.equal(detail.groups[0].memberCount, 6)
  assert.deepEqual(new Set(detail.issues.map(issue => issue.issueId)), new Set(group.issueIds))
  const explicit = list(reader, { ...options, displayGroups: [group] })
  assert.equal(explicit.items[0].accountSeparatedGroupId, group.groupId,
    '已有完整显示组关系时不再按旧来源名重新分组')
  for (const [index, id] of group.issueIds.entries()) model.issues.get(id).accountContext.label = index ? '  ' : ''
  const unnamed = list(readers.create(model), { separateIssueIds: group.issueIds })
  assert.ok(unnamed.items.every(issue => !issue.accountSeparatedGroupId),
    '没有原账户名的独立事项不能凑成一个可重新合并的旧版组')
})
