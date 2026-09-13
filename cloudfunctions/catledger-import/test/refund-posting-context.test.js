const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRefundPostingContext } = require('../src/refund-posting-context')
test('退款批量上下文保持整数累计、已有退款和时间限制，查询按块而不按退款逐笔', async () => {
  const ids = Array.from({ length: 600 }, (_, n) => 'event-' + n), calls = []
  const connection = { async execute(sql, values) {
    calls.push({ sql, values }); assert.equal(values[0], 'user')
    if (sql.includes('FROM catledger_loan_payment_transactions')) return [[]]
    if (sql.includes('FROM catledger_economic_event_transactions WHERE')) return [[]]
    if (sql.includes('FROM catledger_economic_event_relations')) return [values.slice(2).map(eventId => ({ eventId, transactionId: 'original' }))]
    if (sql.includes('SUM(amount_minor)')) return [[{ transactionId: 'original', amount: '35000' }]]
    return [[{ transactionId: 'original', amountMinor: '100000', utcAt: '2026-09-01 12:00:00', categoryId: 'category' }]]
  } }
  const context = await loadRefundPostingContext(connection, 'user', 'update', ids)
  for (const eventId of ids) assert.equal(context.take({ eventId, amountMinor: '100', utcAt: '2026-09-02 00:00:00' }).categoryId, 'category')
  assert.throws(() => context.take({ eventId: ids[0], amountMinor: '5001', utcAt: '2026-09-02 00:00:00' }), { publicCode: 'UNRESOLVED_IMPORT' })
  assert.throws(() => context.take({ eventId: ids[0], amountMinor: '1', utcAt: '2026-08-01 00:00:00' }), { publicCode: 'UNRESOLVED_IMPORT' })
  assert.equal(calls.length, 15)
  assert.ok(calls.every(call => call.values.length <= 102))
})
