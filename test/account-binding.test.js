const test = require('node:test')
const assert = require('node:assert/strict')
const binding = require('../cloudfunctions/catledger-import/src/account-binding')
const { ledgerAccountReference } = require('../cloudfunctions/catledger-import/src/account-reference')
const { buildSourceProfile } = require('../cloudfunctions/catledger-import/src/identity')

function reference(label, context = {}) {
  return binding.scopeReference(ledgerAccountReference('alipay', label), {
    sourceType: 'alipay', importId: 'synthetic-file-one', currency: 'CNY', ...context
  })
}

test('different full card numbers sharing a tail remain different account references', () => {
  const first = reference('合成银行信用卡9900000000001122')
  const second = reference('合成银行信用卡9900000000011122')
  assert.equal(first.label, second.label)
  assert.notEqual(first.bindingKey, second.bindingKey)
  assert.notEqual(first.accountIdentityKey, second.accountIdentityKey)
  assert.equal(first.binding.reusable, true)
  assert.equal(JSON.stringify(first.binding).includes('9900000000001122'), false)
})

test('unknown source holders do not share wallet bindings across files', () => {
  const profile = buildSourceProfile({ sourceType: 'alipay', candidate: { kind: 'missing' } })
  const first = reference('账户余额', { sourceProfileKey: profile.profileKey })
  const second = reference('账户余额', { sourceProfileKey: profile.profileKey, importId: 'synthetic-file-two' })
  assert.notEqual(first.bindingKey, second.bindingKey)
  assert.equal(first.binding.scopeKind, 'file')
  assert.equal(first.binding.reusable, false)
  assert.equal(first.bindingKey, reference('账户余额', { sourceProfileKey: profile.profileKey }).bindingKey)
})

test('an identified source holder can reuse a confirmed platform wallet without crossing holders', () => {
  const subject = identifier => buildSourceProfile({ sourceType: 'alipay', candidate: { kind: 'stable_identifier', identifier } }).profileKey
  const first = reference('账户余额', { sourceProfileKey: subject('synthetic-one') })
  const next = reference('账户余额', { sourceProfileKey: subject('synthetic-one'), importId: 'synthetic-file-two' })
  const other = reference('账户余额', { sourceProfileKey: subject('synthetic-two') })
  const mapping = { binding: binding.confirmedBinding(first) }
  assert.equal(first.bindingKey, next.bindingKey)
  assert.equal(binding.bindingMatches(mapping, next, { reusable: true }), true)
  assert.equal(binding.bindingMatches(mapping, other, { reusable: true }), false)
  assert.equal(binding.bindingMatches({ binding: first.binding }, next), false)
  assert.equal(binding.bindingMatches({}, next), false)
})

test('masked card and named sub-wallet confirmations stay within their source scope', () => {
  const sourceProfileKey = buildSourceProfile({ sourceType: 'alipay', candidate: { kind: 'stable_identifier', identifier: 'synthetic-holder' } }).profileKey
  for (const label of ['合成银行信用卡(1122)', '小荷包(合成家庭)']) {
    const ref = reference(label, { sourceProfileKey })
    assert.equal(ref.binding.reusable, false)
    assert.equal(binding.bindingMatches({ binding: binding.confirmedBinding(ref) }, ref, { reusable: true }), false)
  }
})

test('every selected wallet binding checks account type, currency and availability', () => {
  const ref = reference('账户余额')
  const account = { accountId: 'synthetic-account', type: 'wallet', currency: 'CNY' }
  assert.equal(binding.compatibleAccount(ref, account), true)
  assert.equal(binding.compatibleAccount(ref, { ...account, type: 'cash' }), false)
  assert.equal(binding.compatibleAccount(ref, { ...account, currency: 'USD' }), false)
  assert.equal(binding.compatibleAccount(ref, { ...account, archivedAt: '2026-01-01' }), false)
  assert.equal(binding.compatibleAccount(ref, null), false)
})

test('only a scoped confirmed binding auto-selects a compatible ledger account', () => {
  const { resolveAccountMappings } = require('../cloudfunctions/catledger-import/src/account-mapping-policy')
  const sourceProfileKey = buildSourceProfile({ sourceType: 'alipay', candidate: { kind: 'stable_identifier', identifier: 'synthetic-holder' } }).profileKey
  const ref = reference('账户余额', { sourceProfileKey })
  const accounts = [{ accountId: 'synthetic-wallet', type: 'wallet', currency: 'CNY', name: '支付宝账户余额' }]
  const saved = { sourceType: 'alipay', paymentMethodKey: ref.bindingKey, mappingAction: 'account',
    mappingScope: 'history', accountId: accounts[0].accountId, binding: binding.confirmedBinding(ref) }
  const resolve = mappings => resolveAccountMappings({ references: [ref], accounts, mappings })
  assert.equal(resolve([saved]).mappings[0].accountId, accounts[0].accountId)
  assert.equal(resolve([{ ...saved, binding: null, paymentMethodKey: ref.paymentMethodKey }]).mappings.length, 0)
  assert.equal(resolve([{ ...saved, mappingScope: 'inferred' }]).mappings.length, 0)
  assert.equal(resolveAccountMappings({ references: [ref], mappings: [saved], accounts: [{ ...accounts[0], type: 'cash' }] }).mappings.length, 0)
})

test('equal-priority account conflicts stay unresolved regardless of input order', () => {
  const { createMappingIndex, resolutionFromIndex } = require('../cloudfunctions/catledger-import/src/account-mapping-policy')
  const ref = reference('账户余额')
  const mappings = ['one', 'two', 'one'].map(accountId => ({ sourceType: 'alipay', paymentMethodKey: ref.bindingKey,
    mappingScope: 'batch', mappingAction: 'account', accountId, accountType: 'wallet', accountCurrency: 'CNY',
    binding: binding.confirmedBinding(ref) }))
  assert.equal(resolutionFromIndex(createMappingIndex(mappings), ref).kind, 'conflict')
  assert.equal(resolutionFromIndex(createMappingIndex(mappings.reverse()), ref).kind, 'conflict')
})
