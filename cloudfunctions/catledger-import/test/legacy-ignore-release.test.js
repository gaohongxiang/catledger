const test = require('node:test')
const assert = require('node:assert/strict')
const { releaseLegacyIgnore } = require('../src/legacy-ignore-release')

function excluded(reasons = ['source_account_ignored_default'], extra = {}) {
  return { eventId: 'event-1', status: 'excluded', reasonCodes: reasons,
    existingTransactionIds: [], fieldSources: {}, ...extra }
}

test('只有旧版永久忽略一个理由的排除恢复成待确认', () => {
  const next = releaseLegacyIgnore(excluded())
  assert.equal(next.status, 'needs_action')
  assert.deepEqual(next.reasonCodes, [])
  assert.equal(next.eventId, 'event-1')
})

test('人工排除、已入账、失败关闭、非资金和分期对行保持排除', () => {
  for (const reasons of [
    ['source_account_ignored_default', 'manual_exclusion'],
    ['source_account_ignored_default', 'account_mapping_excluded'],
    ['source_account_ignored_default', 'already_posted'],
    ['source_account_ignored_default', 'transaction_failed'],
    ['source_account_ignored_default', 'transaction_closed'],
    ['source_account_ignored_default', 'source_non_financial'],
    ['source_account_ignored_default', 'installment_offset_pair']
  ]) assert.equal(releaseLegacyIgnore(excluded(reasons)), null, reasons.join(','))
  assert.equal(releaseLegacyIgnore(excluded(['source_account_ignored_default'], {
    existingTransactionIds: ['transaction-1']
  })), null)
})

test('待核对、已入账或没有旧规则理由的事件不动', () => {
  assert.equal(releaseLegacyIgnore(null), null)
  assert.equal(releaseLegacyIgnore({ status: 'needs_action', reasonCodes: ['source_account_ignored_default'] }), null)
  assert.equal(releaseLegacyIgnore({ status: 'posted', reasonCodes: ['source_account_ignored_default'] }), null)
  assert.equal(releaseLegacyIgnore(excluded(['ledger_account_required'])), null)
})
