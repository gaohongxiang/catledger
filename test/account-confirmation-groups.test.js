const test = require('node:test')
const assert = require('node:assert/strict')
const { buildGroups } = require('../cloudfunctions/catledger-import/src/account-confirmation-groups')
const { scopeReference } = require('../cloudfunctions/catledger-import/src/account-binding')
const { ledgerAccountReference } = require('../cloudfunctions/catledger-import/src/account-reference')

const LABEL = '浙江农商联合银行储蓄卡(5564)'
const FULL_ONE = '9900000000005564'
const FULL_TWO = '8800000000005564'

function entry(issueId, sourceType, label = LABEL, options = {}) {
  const unit = options.currency || 'CNY', sourceId = options.sourceId || 'synthetic-' + sourceType
  const reference = scopeReference({ ...ledgerAccountReference(sourceType, label),
    ...(options.role ? { role: options.role } : {}) }, { sourceType, importId: sourceId, currency: unit })
  return { issueId, label: reference.label, status: options.accountId ? 'resolved' : 'open',
    decision: options.accountId ? 'account' : 'pending', accountId: options.accountId || null,
    currency: unit, allowedAccountTypes: [reference.expectedAccountType || 'bank'], canExternal: true,
    members: Array.from({ length: options.count || 1 }, (_, index) => ({
      eventId: issueId + '-event-' + index, actualSide: options.side || 'source', reference,
      sourceId, sourceType, fileName: sourceId + '.csv'
    })), ...options }
}

function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value) }
  return value
}

test('same institution/card kind/tail offers one confirmation while all source identities remain separate', () => {
  const a = entry('a', 'alipay', LABEL, { count: 3 }), b = entry('b', 'wechat', LABEL, { count: 2 })
  assert.notEqual(a.members[0].reference.bindingKey, b.members[0].reference.bindingKey)
  const original = JSON.stringify([a, b]), groups = buildGroups(frozen([a, b]))
  assert.equal(JSON.stringify([a, b]), original)
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].issueIds, ['a', 'b'])
  assert.equal(groups[0].candidate, true)
  assert.equal(groups[0].accountId, null)
  assert.equal(groups[0].memberCount, 5)
  assert.equal(groups[0].sourceCount, 2)
  assert.deepEqual(groups[0].sources.map(source => source.count), [3, 2])
  assert.deepEqual(groups[0].allowedAccountTypes, ['bank'])
})

test('group order and identifiers are independent of input order and display wording', () => {
  const a = entry('a', 'alipay'), b = entry('b', 'wechat'), c = entry('c', 'bank')
  const expected = buildGroups([a, b, c])
  assert.deepEqual(buildGroups([c, a, b]), expected)
  assert.equal(buildGroups([{ ...a, label: '新显示名' }, b, c])[0].groupId, expected[0].groupId)
})

test('incoming and outgoing observations of the same own source card may share confirmation', () => {
  const a = entry('a', 'alipay', LABEL, { side: 'source', role: 'payment_method' })
  const b = entry('b', 'wechat', LABEL, { side: 'destination', role: 'ledger_account' })
  assert.deepEqual(buildGroups([a, b])[0].issueIds, ['a', 'b'])
})

test('opposite or unknown ends of one event are never collapsed', () => {
  for (const side of ['destination', null]) {
    const a = entry('a', 'alipay'), b = entry('b', 'wechat')
    b.members[0].eventId = a.members[0].eventId
    b.members[0].actualSide = side
    assert.deepEqual(buildGroups([a, b]), [])
  }
  const a = entry('a', 'alipay', LABEL, { accountId: 'synthetic-account' })
  const b = entry('b', 'wechat', LABEL, { accountId: 'synthetic-account' })
  b.members[0].eventId = a.members[0].eventId
  b.members[0].actualSide = 'destination'
  assert.deepEqual(buildGroups([a, b]), [])
})

test('flow directions do not prove ownership of counterparty or repayment target accounts', () => {
  for (const role of ['counterparty_account', 'repayment_target', 'unknown_role']) {
    for (const side of ['source', 'destination']) {
      assert.deepEqual(buildGroups([entry('a', 'alipay'), entry('b', 'wechat', LABEL, { role, side })]), [])
    }
  }
})

test('same name without an account locator never creates a pending candidate', () => {
  for (const label of ['合成人名', '合成银行储蓄卡', '微信零钱', '合成银行储蓄卡2026-09-01']) {
    assert.deepEqual(buildGroups([entry('a', 'alipay', label), entry('b', 'wechat', label)]), [])
  }
  assert.deepEqual(buildGroups([entry('a', 'bank', '银行卡(5564)'), entry('b', 'wechat', '银行卡(5564)')]), [])
})

test('institution, card kind, currency and actual allowed-type intersection all constrain candidates', () => {
  const a = entry('a', 'alipay')
  for (const b of [entry('b', 'wechat', '另一银行储蓄卡(5564)'),
    entry('b', 'wechat', '浙江农商联合银行信用卡(5564)'),
    entry('b', 'wechat', LABEL, { currency: 'USD' }),
    entry('b', 'wechat', LABEL, { allowedAccountTypes: ['credit'] })]) {
    assert.deepEqual(buildGroups([a, b]), [])
  }
  const b = entry('b', 'wechat')
  b.members[0].allowedAccountTypes = ['wallet']
  assert.deepEqual(buildGroups([a, b]), [])
})

test('full number matching takes priority over institution display aliases and source scope', () => {
  const a = entry('a', 'alipay', '合成银行储蓄卡' + FULL_ONE)
  const b = entry('b', 'wechat', '合成商业银行借记卡' + FULL_ONE)
  assert.notEqual(a.members[0].reference.bindingKey, b.members[0].reference.bindingKey)
  const [group] = buildGroups([a, b])
  assert.deepEqual(group.issueIds, ['a', 'b'])
  assert.equal(JSON.stringify(group).includes(FULL_ONE), false)
  assert.equal(group.label, '合成银行储蓄卡****5564')
})

test('one unambiguous full number can suggest a joint confirmation with a matching weak tail', () => {
  const a = entry('a', 'alipay', '合成银行储蓄卡' + FULL_ONE)
  const b = entry('b', 'wechat', '合成银行借记卡(5564)')
  assert.deepEqual(buildGroups([a, b])[0].issueIds, ['a', 'b'])
})

test('a shared weak tail cannot bridge distinct complete numbers regardless of input order', () => {
  const a = entry('a', 'alipay', '合成银行储蓄卡' + FULL_ONE)
  const b = entry('b', 'wechat', '合成银行储蓄卡' + FULL_TWO)
  const weak = entry('weak', 'bank', '合成银行储蓄卡(5564)')
  assert.deepEqual(buildGroups([a, weak, b]), [])
  assert.deepEqual(buildGroups([b, weak, a]), [])
  const a2 = entry('a2', 'wechat', '合成银行储蓄卡' + FULL_ONE)
  const b2 = entry('b2', 'alipay', '合成银行储蓄卡' + FULL_TWO)
  const groups = buildGroups([weak, b2, a2, b, a])
  assert.deepEqual(groups.map(group => group.issueIds), [['a', 'a2'], ['b', 'b2']])
  assert.equal(groups.every(group => group.conflictReason === 'distinct_full_numbers_share_tail'), true)
})

test('external and excluded full-number evidence is still considered when a tail is ambiguous', () => {
  for (const decision of ['external', 'excluded']) {
    const a = entry('a', 'alipay', '合成银行储蓄卡' + FULL_ONE)
    const b = entry('b', 'wechat', '合成银行储蓄卡' + FULL_TWO, { status: 'resolved', decision })
    const weak = entry('weak', 'bank', '合成银行储蓄卡(5564)')
    assert.deepEqual(buildGroups([a, b, weak]), [])
  }
})

test('a rejected or contradictory full number never regains reliable identity through its display label', () => {
  const a = entry('a', 'alipay', '合成银行储蓄卡' + FULL_ONE)
  const weak = entry('weak', 'wechat', '合成银行储蓄卡(5564)')
  a.members[0].reference.binding.identityKind = 'source_label'
  assert.deepEqual(buildGroups([a, weak]), [])
  const b = entry('b', 'alipay', '合成银行储蓄卡' + FULL_TWO)
  b.members[0].reference.value = '合成银行储蓄卡' + FULL_ONE
  assert.deepEqual(buildGroups([b, weak]), [])
})

test('masked read models can use reliable full-number digests without revealing the number', () => {
  const a = entry('a', 'alipay', '合成银行储蓄卡' + FULL_ONE)
  const b = entry('b', 'wechat', '合成银行储蓄卡' + FULL_ONE)
  a.members[0].reference.value = a.members[0].reference.label
  b.members[0].reference.value = b.members[0].reference.label
  assert.deepEqual(buildGroups([a, b])[0].issueIds, ['a', 'b'])
})

test('existing different explicit choices block a joint candidate even when labels or full numbers match', () => {
  for (const label of [LABEL, '合成银行储蓄卡' + FULL_ONE]) {
    const a = entry('a', 'alipay', label, { accountId: 'synthetic-account-a' })
    const b = entry('b', 'wechat', label, { accountId: 'synthetic-account-b' })
    const pending = entry('pending', 'bank', label)
    assert.deepEqual(buildGroups([a, pending, b]), [])
  }
})

test('one confirmed choice and matching pending source references remain an explicit candidate', () => {
  const a = entry('a', 'alipay', LABEL, { accountId: 'synthetic-account' })
  const b = entry('b', 'wechat')
  const [group] = buildGroups([a, b])
  assert.equal(group.candidate, true)
  assert.equal(group.accountId, 'synthetic-account')
  assert.deepEqual(group.issueIds, ['a', 'b'])
})

test('explicitly confirmed same account can be folded without relying on names or source roles', () => {
  const a = entry('a', 'alipay', '账户余额', { accountId: 'synthetic-wallet', allowedAccountTypes: ['wallet'] })
  const b = entry('b', 'wechat', '微信零钱', { accountId: 'synthetic-wallet', allowedAccountTypes: ['wallet'], role: 'counterparty_account' })
  const [group] = buildGroups([a, b])
  assert.equal(group.candidate, false)
  assert.equal(group.accountId, 'synthetic-wallet')
  assert.deepEqual(group.issueIds, ['a', 'b'])
  assert.deepEqual(buildGroups([{ ...a, accountId: 'another-wallet' }, b]), [])
})

test('external/excluded states are not folded or silently replaced by nearby pending choices', () => {
  for (const decision of ['external', 'excluded']) {
    const a = entry('a', 'alipay'), b = entry('b', 'wechat', LABEL, { decision, status: 'resolved' })
    assert.deepEqual(buildGroups([a, b]), [])
    const c = entry('c', 'bank')
    assert.deepEqual(buildGroups([a, b, c])[0].issueIds, ['a', 'c'])
  }
})

test('a single blocked or contradictory member prevents grouping the whole original issue', () => {
  const a = entry('a', 'alipay'), b = entry('b', 'wechat', LABEL, { count: 2 })
  for (const patch of [{ decision: 'excluded' }, { currency: 'USD' },
    { decision: 'account', accountId: 'synthetic-other' }]) {
    const copy = JSON.parse(JSON.stringify(b))
    Object.assign(copy.members[1], patch)
    assert.deepEqual(buildGroups([a, copy]), [])
  }
  const copy = JSON.parse(JSON.stringify(b))
  copy.members[1].reference.role = 'counterparty_account'
  assert.deepEqual(buildGroups([a, copy]), [])
})

test('missing types, unconfirmed account IDs and duplicate issue IDs fail closed', () => {
  const a = entry('a', 'alipay'), b = entry('b', 'wechat')
  for (const invalid of [{ ...b, allowedAccountTypes: [] }, { ...b, accountId: 'suggestion-only' },
    { ...b, status: 'resolved' }, { ...b, status: undefined }, { ...b, members: [] }]) {
    assert.deepEqual(buildGroups([a, invalid]), [])
  }
  assert.deepEqual(buildGroups([a, { ...b, issueId: 'a' }]), [])
  assert.deepEqual(buildGroups(null), [])
})

test('group-wide external permission is the intersection of original permissions', () => {
  const a = entry('a', 'alipay'), b = entry('b', 'wechat', LABEL, { canExternal: false })
  assert.equal(buildGroups([a, b])[0].canExternal, false)
})

test('full-number aliases cannot select one of several conflicting manual choices by iteration order', () => {
  const a = entry('a', 'alipay', '合成银行储蓄卡' + FULL_ONE)
  const b = entry('b', 'wechat', '合成商业银行储蓄卡' + FULL_ONE)
  const weakOne = entry('w1', 'bank', '合成银行储蓄卡(5564)', { accountId: 'synthetic-one' })
  const weakTwo = entry('w2', 'bank', '合成商业银行储蓄卡(5564)', { accountId: 'synthetic-two' })
  const groups = buildGroups([a, weakOne, b, weakTwo])
  assert.deepEqual(groups.map(group => group.issueIds), [['a', 'b']])
  assert.equal(groups[0].accountId, null)
  assert.deepEqual(buildGroups([weakTwo, b, weakOne, a]), groups)
})

test('all observations of one event participate in the two-end conflict check', () => {
  const a = entry('a', 'alipay', LABEL, { count: 2 }), b = entry('b', 'wechat')
  a.members[1].eventId = a.members[0].eventId
  a.members[0].actualSide = null
  b.members[0].eventId = a.members[0].eventId
  assert.deepEqual(buildGroups([a, b]), [])
  a.members.reverse()
  assert.deepEqual(buildGroups([a, b]), [])
})

test('missing unresolved references do not interrupt other safe groups', () => {
  const a = entry('a', 'alipay'), b = entry('b', 'wechat')
  assert.deepEqual(buildGroups([null, { issueId: 'empty' }, { issueId: 'missing', members: [null] }, a, b]), buildGroups([a, b]))
})

test('explicit card kinds still constrain reliable full numbers when callers provide broad type options', () => {
  const a = entry('a', 'alipay', '合成银行储蓄卡' + FULL_ONE, { allowedAccountTypes: ['bank', 'credit'] })
  const b = entry('b', 'wechat', '合成银行信用卡' + FULL_ONE, { allowedAccountTypes: ['bank', 'credit'] })
  a.members[0].reference.expectedAccountType = null
  b.members[0].reference.expectedAccountType = null
  assert.deepEqual(buildGroups([a, b]), [])
})

test('one explicit existing-account choice joins another default while both saved states stay pending', () => {
  const options = { selectedAccountId: 'synthetic-credit', allowedAccountTypes: ['credit'] }
  const a = entry('a', 'alipay', '合成银行信用卡(6106)', options)
  const b = entry('b', 'bank', '主卡6106', options)
  assert.deepEqual(buildGroups([a, b]), [], 'two untouched defaults are not an account-ID confirmation')
  b.selectionExplicit = true
  b.selectionDirty = true
  const original = JSON.stringify([a, b]), [group] = buildGroups(frozen([a, b]))
  assert.equal(group.groupReason, 'selected_account')
  assert.equal(group.selectedAccountId, 'synthetic-credit')
  assert.equal(group.accountId, null)
  assert.equal(group.candidate, true)
  assert.deepEqual(group.issueIds, ['a', 'b'])
  assert.equal(JSON.stringify([a, b]), original)
})

test('saved and newly selected accounts are distinct when a resolved card changes its target', () => {
  const a = entry('a', 'alipay', '合成银行信用卡(6106)', {
    accountId: 'synthetic-a', allowedAccountTypes: ['credit'] })
  const pending = entry('pending', 'bank', '主卡6106', { selectedAccountId: 'synthetic-a',
    selectionExplicit: true, allowedAccountTypes: ['credit'] })
  const [mixed] = buildGroups([a, pending])
  assert.equal(mixed.candidate, true)
  assert.equal(mixed.accountId, 'synthetic-a')
  assert.equal(mixed.selectedAccountId, 'synthetic-a')
  const changed = entry('changed', 'bank', '主卡6106', { accountId: 'synthetic-b',
    selectedAccountId: 'synthetic-a', selectionExplicit: true, selectionDirty: true,
    allowedAccountTypes: ['credit'] })
  const [group] = buildGroups([a, changed])
  assert.equal(group.candidate, true)
  assert.equal(group.accountId, null, 'two saved IDs cannot be silently reduced to one')
  assert.equal(group.selectedAccountId, 'synthetic-a')
  assert.equal(changed.accountId, 'synthetic-b')
})

test('different manual selections block identity grouping, while default disagreements stay reviewable', () => {
  const a = entry('a', 'alipay', LABEL, { selectedAccountId: 'synthetic-a' })
  const b = entry('b', 'wechat', LABEL, { selectedAccountId: 'synthetic-b' })
  assert.equal(buildGroups([a, b])[0].candidate, true, 'original same-card suggestions remain a pending candidate')
  a.selectionExplicit = true
  b.selectionExplicit = true
  assert.deepEqual(buildGroups([a, b]), [])
  b.selectionExplicit = false
  b.selectionDirty = true
  assert.deepEqual(buildGroups([a, b]), [], 'a legacy dirty choice must not be discarded as a default')
})

test('selected-account groups still reject incompatible currency/types, blocked decisions and two ends', () => {
  const options = { selectedAccountId: 'synthetic-target', selectionExplicit: true }
  const a = entry('a', 'alipay', '合成来源甲', options)
  const b = entry('b', 'bank', '合成来源乙', options)
  assert.equal(buildGroups([a, b]).length, 1)
  for (const patch of [{ currency: 'USD' }, { allowedAccountTypes: ['credit'] },
    { decision: 'external', status: 'resolved' }, { decision: 'excluded', status: 'resolved' },
    { decision: 'separate' }, { decision: 'conflict' }]) {
    assert.deepEqual(buildGroups([a, { ...b, ...patch }]), [])
  }
  b.members[0].eventId = a.members[0].eventId
  b.members[0].actualSide = 'destination'
  assert.deepEqual(buildGroups([a, b]), [])
})

test('an explicit choice does not absorb contradictory complete numbers from default suggestions', () => {
  const a = entry('a', 'alipay', '合成银行储蓄卡' + FULL_ONE, {
    selectedAccountId: 'synthetic-target', selectionExplicit: true })
  const b = entry('b', 'wechat', '合成银行储蓄卡' + FULL_TWO, { selectedAccountId: 'synthetic-target' })
  assert.deepEqual(buildGroups([a, b]), [])
  b.selectionExplicit = true
  const [group] = buildGroups([a, b])
  assert.equal(group.groupReason, 'selected_account')
  assert.equal(group.candidate, true)
  assert.equal(group.selectedAccountId, 'synthetic-target')
})

test('a default suggestion for a counterparty needs its own explicit ownership choice', () => {
  const a = entry('a', 'alipay', LABEL, { selectedAccountId: 'synthetic-target', selectionExplicit: true })
  const b = entry('b', 'wechat', LABEL, { selectedAccountId: 'synthetic-target', role: 'counterparty_account' })
  assert.deepEqual(buildGroups([a, b]), [])
  b.selectionExplicit = true
  const [group] = buildGroups([a, b])
  assert.equal(group.groupReason, 'selected_account')
  assert.equal(group.selectedAccountId, 'synthetic-target')
  assert.equal(group.candidate, true)
})
