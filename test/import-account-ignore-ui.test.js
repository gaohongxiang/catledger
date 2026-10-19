const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture, runtime, flush } = require('./helpers/paged-workbench')
const { workbenchSummary } = require('../cloudfunctions/catledger-import/src/workbench-summary')
const tap = id => ({ currentTarget: { dataset: { id } } })
async function until(check) {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) await flush()
  assert.ok(check(), 'the expected account state was reached')
}
test('本次不计入从账户卡分区显示，并立即刷新待确认计数', async t => {
  const data = fixture(2, true)
  data.issues = data.events.map((event, index) => ({ issueId: 'ignore-' + index, issueType: 'account_mapping',
    status: 'open', version: 1, blocking: true, memberCount: 1, subject: event,
    accountContext: { recognized: true, sourceType: 'wechat', label: '合成钱包' + index, currency: 'CNY' } }))
  data.summary.workbench = workbenchSummary(data.events, [], [{ issueType: 'account_mapping', status: 'open', count: 2 }], 0, 0)
  const h = runtime(data), page = h.page
  t.after(() => page.onUnload())
  await until(() => page.data.accountMappings.length === 2)
  const issue = page.data.accountMappings[0]
  await page.openAccountChoice(tap(issue.issueId))
  page.selectAccountChoice({ currentTarget: { dataset: { value: 'ignore' } } })
  await flush()
  assert.equal(page.data.accountMappingsExcluded.length, 0)
  assert.equal(page.data.accountMappingsIncluded.length, 2)
  assert.equal(page.data.accountStepSummary.pending, 2)
  assert.equal(page.data.accountStepSummary.confirmed, 0)
  await page.completeAccountMapping(tap(issue.issueId))
  await flush()
  assert.equal(page.data.accountStepSummary.pending, 1)
  assert.equal(page.data.accountMappingsExcluded.length, 1)
  assert.equal(page.data.accountMappingsExcluded[0].issueId, issue.issueId)
  assert.equal(page.data.accountMappingsExcluded[0].needsConfirmation, false)
})
