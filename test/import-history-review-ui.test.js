const test = require('node:test')
const assert = require('node:assert/strict')
const model = require('../miniprogram/pages/import-workbench/model')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')
const tap = (id, direction) => ({ currentTarget: { dataset: { id, direction } } })

test('核对提示说明具体交易类型，历史候选不会展示本批合并按钮', () => {
  const type = model.issueView({ issueType: 'shared_fields', subject: { economicNature: 'unknown' } })
  assert.equal(type.label, '确认交易类型')
  assert.match(type.decisionText, /消费、收入、退款、还款还是转账/)
  const duplicate = model.issueView({ issueType: 'same_event', primaryReasonCode: 'historical_duplicate_candidate' })
  assert.equal(duplicate.label, '疑似已经入账')
  assert.equal(duplicate.canConfirmSame, false)
  assert.equal(duplicate.historicalDuplicate, true)
})

test('历史候选有界翻页、不预选，变更记录不能选择，明确选中后保存对应历史 ID', async () => {
  const data = fixture(1, true)
  Object.assign(data.issues[0], { primaryReasonCode: 'historical_duplicate_candidate', candidateCount: 11 })
  const h = runtime(data), page = h.page
  h.intercept = (action, input) => {
    if (action !== 'reviewIssues.members' || input.memberKind !== 'transaction') return
    const all = Array.from({ length: 11 }, (_, index) => ({ objectVersion: 1, objectId: 'history-' + index,
      transaction: { transactionId: 'history-' + index, version: index === 0 ? 2 : 1, note: '合成已入账',
        amountMinor: '123', localAt: '2026-09-01 12:00:00', sourceAccountName: '合成账户' } }))
    const start = Number(input.cursor || 0)
    return { protocolVersion: 2, viewVersion: h.summary.viewVersion, update: h.summary.update, total: 11,
      items: all.slice(start, start + input.pageSize), nextCursor: start + input.pageSize < 11 ? String(start + input.pageSize) : null }
  }
  await page.openIssue(tap('synthetic-issue'))
  assert.equal(page.data.historicalCandidates.length, 8)
  assert.equal(page.data.historicalCandidates[0].amountText, '¥1.23')
  assert.equal(page.data.historicalSelection, '')
  page.selectHistoricalTransaction(tap('history-0')); assert.equal(page.data.historicalSelection, '')
  page.selectHistoricalTransaction(tap('history-1')); assert.equal(page.data.historicalSelection, 'history-1')
  await page.changeHistoricalPage(tap(null, 1))
  assert.equal(page.data.historicalCandidates.length, 3); assert.equal(page.data.historicalSelection, '')
  page.selectHistoricalTransaction(tap('history-10'))
  await page.linkHistoricalTransaction()
  assert.equal(page._draftSession.state.entries[0].decision.transactionId, 'history-10')
  assert.equal(page._draftSession.state.entries[0].decision.decision, 'link_existing_transaction')
  assert.equal(page.data.currentIssue, null)
  page.onUnload()
})

test('正式入账发现新历史候选时保留草稿，复查后回到整理而非显示入账完成', async () => {
  const h = runtime(fixture(1)), page = h.page
  h.intercept = (action) => {
    if (action === 'financeUpdates.post') throw Object.assign(new Error('发现历史相似账目'), { code: 'HISTORY_REVIEW_REQUIRED' })
    if (action === 'financeUpdates.organize') {
      const next = fixture(1, true)
      next.summary.viewVersion = 'v2'; next.summary.update.version = 2
      h.summary = next.summary; h.issues = next.issues; h.events = next.events
      return { update: h.summary.update }
    }
  }
  await page.postUpdate(); await flush()
  assert.equal(page.data.phase, 'review')
  assert.equal(page.data.currentStep, 3)
  assert.ok(page._draftSession)
  assert.equal(page._draftSession.state.postFlight, null)
  assert.ok(h.calls.some(call => call.action === 'financeUpdates.organize'))
  page.onUnload()
})

test('历史候选读取失败明确显示原因，重新读取成功前不能确认没有重复', async () => {
  const data = fixture(1, true)
  Object.assign(data.issues[0], { primaryReasonCode: 'historical_duplicate_candidate', candidateCount: 1 })
  const h = runtime(data), page = h.page
  let failed = true
  h.intercept = (action, input) => {
    if (action !== 'reviewIssues.members' || input.memberKind !== 'transaction') return
    if (failed) throw new Error('网络读取失败，请重试')
    return { protocolVersion: 2, viewVersion: h.summary.viewVersion, update: h.summary.update, total: 1,
      items: [{ objectId: 'history', objectVersion: 1, transaction: { transactionId: 'history', version: 1, amountMinor: '100' } }], nextCursor: null }
  }
  await page.openIssue(tap('synthetic-issue'))
  assert.match(page.data.historicalError, /网络读取失败/)
  page.confirmDistinct()
  assert.equal(page._draftSession.state.entries.length, 0)
  failed = false; await page.changeHistoricalPage(tap(null, 'first'))
  assert.equal(page.data.historicalError, '')
  assert.equal(page.data.historicalCandidates.length, 1)
  page.onUnload()
})

test('与历史账对应的记录计入重复，和用户主动排除分开且总数守恒', () => {
  const events = [{ eventId: 'a', status: 'excluded', reasonCodes: ['linked_existing_transaction'] },
    { eventId: 'b', status: 'excluded', reasonCodes: ['manual_excluded'] },
    { eventId: 'c', status: 'ready', economicNature: 'expense', amountMinor: '100', duplicateEvidenceCount: 1 }]
  const counts = model.organizerRecordState(events, [], []).summary
  assert.deepEqual(counts, { activeCount: 1, excludedCount: 1, duplicateCount: 2, totalCount: 4 })
})
