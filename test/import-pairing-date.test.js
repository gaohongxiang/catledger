const test = require('node:test')
const assert = require('node:assert/strict')
const { setup } = require('./helpers/pairing-workbench')
const { parseLocalDateTime } = require('../cloudfunctions/catledger-import/src/parsers/normalize')
const { evidencePartFields } = require('../miniprogram/pages/import-workbench/presentation')

const serial = '46236.5809'
const normalizedTime = '2026-08-02 13:56:30.000'
const readableTime = '2026-08-02 13:56:30'
const rawFields = [
  { name: '交易时间', value: serial },
  { name: '交易日期', value: 46236 },
  { name: '交易时间', value: readableTime },
  { name: '交易金额', value: serial },
  { name: '交易流水号', value: '46236' },
  { name: '备注', value: '' },
  { name: '金额', value: 0 }
]
const expectedValues = [readableTime, '2026-08-02 00:00:00', readableTime, serial, '46236', '', '0']
const plain = value => JSON.parse(JSON.stringify(value))

test('原始字段只格式化日期列，重复列、金额、流水号、空值与零值保留，源数据不变', () => {
  const part = JSON.stringify(rawFields)
  const fields = evidencePartFields(part, { index: 0, hasNext: false })
  assert.deepEqual(fields.map(field => field.value), expectedValues)
  assert.deepEqual(fields.map(field => field.name), rawFields.map(field => field.name))
  assert.equal(new Set(fields.map(field => field.key)).size, rawFields.length)
  assert.equal(JSON.stringify(rawFields), part)
})

for (const mode of ['suggested', 'ambiguous']) test(mode + ' 配对使用规范时间，内联原文与完整原文均显示可读日期', async () => {
  const h = setup(1), page = h.page
  const normalized = parseLocalDateTime(serial, -480)
  assert.equal(normalized.localAt, normalizedTime)
  h.pairs[0].bank.localAt = normalized.localAt
  h.pairs[0].platform.localAt = '2026-08-02 13:56:42.000'
  const source = JSON.stringify(rawFields), pairsBefore = JSON.stringify(h.pairs)
  h.onPairingCall = (action, input) => {
    if (action === 'economicEvents.evidence') return { protocolVersion: 2, viewVersion: h.summary.viewVersion,
      items: [{ evidenceId: 'synthetic-date-' + input.eventId, fileName: '合成日期账单.xlsx', rowNumber: 2 }],
      total: 1, nextCursor: null }
    if (action === 'economicEvents.detail') return { protocolVersion: 2, viewVersion: h.summary.viewVersion,
      part: source, nextCursor: null }
  }
  try {
    if (mode === 'suggested') await page.openPairingReview()
    else await page.openAmbiguousPairingReview({ currentTarget: { dataset: { issueId: 'synthetic-issue' } } })
    await h.flush()
    const row = page.data.pairingRows[0]
    assert.equal(row.bank.localAt, normalizedTime)
    assert.equal(row.platform.localAt, '2026-08-02 13:56:42.000')
    for (const side of ['bank', 'platform']) {
      assert.equal(row[side].evidenceLoading, false)
      assert.deepEqual(plain(row[side].evidence[0].fields).map(field => field.value), expectedValues)
    }
    await page.openEvidence({ currentTarget: { dataset: { id: row.bank.eventId, evidenceId: 'synthetic-date-' + row.bank.eventId } } })
    assert.deepEqual(plain(page.data.evidenceSheet.partFields).map(field => field.value), expectedValues)
    assert.equal(page.data.evidenceSheet.part, source, '完整原文仍保留源值')
    assert.equal(JSON.stringify(h.pairs), pairsBefore)
    assert.equal(JSON.stringify(rawFields), source)
    assert.equal(h.calls.some(call => /resolve|post|organize/.test(call.action)), false)
  } finally { page.onUnload() }
})
