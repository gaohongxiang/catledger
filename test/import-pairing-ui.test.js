const test = require('node:test')
const assert = require('node:assert/strict')
const { setup, pair, tap, pageDirection } = require('./helpers/pairing-workbench')

test('真实 Page 立即打开骨架，范围未齐禁确认，原文自动有界补齐', async () => {
  const h = setup(100), page = h.page
  let release
  h.onPairingCall = action => action === 'reviewIssues.pairings' ? new Promise(resolve => { release = resolve }) : undefined
  const opening = page.openPairingReview()
  assert.equal(page.data.pairingSheet.title, '建议配对')
  assert.equal(page.data.pairingLoading, true); assert.equal(page.data.pairingCanConfirm, false)
  await page.confirmPairings(); assert.equal(page._draftSession.state.entries.length, 0)
  await h.flush(); release(undefined); await opening; await h.flush(); await h.flush()
  assert.equal(page.data.pairingRows.length, 4)
  assert.equal(page.data.pairingSelectedCount, 100)
  assert.equal(page.data.pairingCanConfirm, true)
  assert.match(page.data.pairingScopeText, /100.*200/)
  assert.equal(h.calls.filter(call => call.action === 'economicEvents.evidence').length, 8)
  assert.equal(h.calls.filter(call => call.action === 'economicEvents.detail').length, 16)
  assert.equal(h.calls.some(call => call.action === 'financeUpdates.options'), false)
  assert.equal(h.patches.every(size => size <= 64 * 1024), true)
  page.onUnload()
})

test('100 组建议一次确认，跨页取消例外在回页和重开后保留，最终只刷新一次摘要', async () => {
  const h = setup(100), page = h.page
  await page.openPairingReview()
  page.selectPairing(tap('pair-0'))
  await page.changePairingPage(pageDirection(1)); page.selectPairing(tap('pair-5'))
  await page.changePairingPage(pageDirection(-1))
  assert.equal(page.data.pairingRows[0].selected, false)
  page.closePairingReview(); await page.openPairingReview()
  assert.equal(page.data.pairingRows[0].selected, false); assert.equal(page.data.pairingSelectedCount, 98)
  const summaryReads = h.calls.filter(call => call.action === 'financeUpdates.summary').length
  await page.confirmPairings()
  const writes = h.calls.filter(call => call.action === 'reviewIssues.resolvePairings')
  assert.equal(writes.length, 1)
  assert.deepEqual([...writes[0].input.selection.excludedPairKeys].sort(), ['pair-0', 'pair-5'])
  assert.equal(h.calls.filter(call => call.action === 'financeUpdates.summary').length - summaryReads, 1)
  assert.match(page.data.pairingProgressText, /已保存 98 \/ 98 组.*结果已更新/)
  assert.equal(page.data.pairingSaved, true)
  assert.deepEqual(h.pairs.map(row => row.pairKey), ['pair-0', 'pair-5'])
  page.closePairingReview(); await page.openPairingReview()
  assert.equal(page.data.pairingSelectedCount, 2, '重新打开使用剩余范围，而非旧完成任务')
  assert.equal(page.data.pairingCanConfirm, true)
  page.onUnload()
})

test('全范围计数保留退款与全部有效来源，不从当前页猜选中部分的性质', async () => {
  const h = setup(6), page = h.page
  h.pairs[5].economicNature = 'refund'; h.pairs[5].platform.evidenceCount = 3
  await page.openPairingReview()
  assert.match(page.data.pairingScopeText, /14 条来源.*消费 5 组、退款 1 组/)
  page.selectPairing(tap('pair-0'))
  assert.doesNotMatch(page.data.pairingScopeText, /消费 5 组/)
  assert.match(page.data.pairingChoiceText, /5 笔待入账记录/)
  await page.changePairingPage(pageDirection(1))
  assert.equal(page.data.pairingRows[1].natureLabel, '退款')
  page.onUnload()
})

test('两条银行两条平台选择两对，每条记录不能重复分配；不同笔只拒绝指定边', async () => {
  const h = setup(0), page = h.page
  h.pairs = [pair('aa'), pair('ab'), pair('ba'), pair('bb')]
  h.pairs.forEach((row, index) => { row.bank.eventId = index < 2 ? 'bank-a' : 'bank-b'; row.platform.eventId = index % 2 ? 'platform-b' : 'platform-a' })
  await page.openAmbiguousPairingReview({ currentTarget: { dataset: { issueId: 'synthetic-issue' } } })
  page.selectPairing(tap('pair-aa', 'same'))
  assert.equal(page.data.pairingRows[1].occupied, true); assert.equal(page.data.pairingRows[2].occupied, true)
  page.selectPairing(tap('pair-ab', 'same'))
  assert.equal(page.data.pairingSelectedCount, 1)
  page.selectPairing(tap('pair-bb', 'same'))
  assert.equal(page.data.pairingSelectedCount, 2)
  await page.confirmPairings()
  const command = h.calls.find(call => call.action === 'reviewIssues.resolvePairings')
  assert.deepEqual(command.input.selection.pairs, [{ pairKey: 'pair-aa', decision: 'same' }, { pairKey: 'pair-bb', decision: 'same' }])
  assert.equal('primaryEventId' in command.input, false)
  page.closePairingReview(); await page.openAmbiguousPairingReview({ currentTarget: { dataset: { issueId: 'synthetic-issue' } } })
  page.selectPairing(tap('pair-ab', 'distinct')); await page.confirmPairings()
  const last = h.calls.filter(call => call.action === 'reviewIssues.resolvePairings').at(-1)
  assert.deepEqual(last.input.selection.pairs, [{ pairKey: 'pair-ab', decision: 'distinct' }])
  assert.deepEqual(h.pairs.map(row => row.pairKey), ['pair-ba'])
  page.onUnload()
})

test('原文失败和局部重试不会覆盖已选配对，不重读整个范围', async () => {
  const h = setup(5), page = h.page
  let fail = true
  h.onPairingCall = action => { if (fail && action === 'economicEvents.detail') throw new Error('synthetic detail failure') }
  await page.openPairingReview(); page.selectPairing(tap('pair-1')); await h.flush()
  assert.match(page.data.pairingRows[0].bank.evidenceError, /读取失败/)
  const reads = h.calls.filter(call => call.action === 'reviewIssues.pairings').length
  fail = false
  await page.changePairingEvidence({ currentTarget: { dataset: { id: 'bank-0' } } })
  assert.equal(page.data.pairingRows[0].bank.evidenceError, '')
  assert.equal(page.data.pairingRows[1].selected, false)
  assert.equal(h.calls.filter(call => call.action === 'reviewIssues.pairings').length, reads)
  page.onUnload()
})

test('关闭、隐藏、换用户与快速 A/B 的迟到读取不能重开或串配对范围', async () => {
  for (const action of ['close', 'hide', 'owner', 'switch']) {
    const h = setup(4), page = h.page
    let release
    h.onPairingCall = (method, input) => method === 'reviewIssues.pairings' && input.issueId === 'a'
      ? new Promise(resolve => { release = resolve }) : undefined
    const opening = page.openAmbiguousPairingReview({ currentTarget: { dataset: { issueId: 'a' } } })
    await h.flush()
    if (action === 'close') page.closePairingReview()
    if (action === 'hide') page.onHide()
    if (action === 'owner') { h.cache.reset(); h.app.globalData.uid = '1234567891'; page.onShow() }
    if (action === 'switch') await page.openAmbiguousPairingReview({ currentTarget: { dataset: { issueId: 'b' } } })
    release(undefined); await opening; await h.flush()
    if (action === 'switch') assert.equal(page.data.pairingSheet.issueId, 'b')
    else assert.equal(page.data.pairingSheet, null)
    assert.equal(page._draftSession && page._draftSession.state.entries.length || 0, 0)
    page.onUnload()
  }
})

test('外部范围变化保留例外并禁确认；显式重核以完整图查失效键，确认移出前不能提交', async () => {
  const h = setup(7), page = h.page
  await page.openPairingReview(); page.selectPairing(tap('pair-0')); page.selectPairing(tap('pair-1'))
  h.pairs = h.pairs.filter(row => row.pairKey !== 'pair-1')
  h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
  page.applyUpdateView(h.summary, true)
  assert.equal(page.data.pairingCanConfirm, false); assert.equal(page.data.pairingNeedsRecheck, true)
  await page.recheckPairings()
  const recheck = h.calls.filter(call => call.action === 'reviewIssues.pairings').at(-1)
  assert.deepEqual([...recheck.input.recheckPairKeys], ['pair-0', 'pair-1'])
  assert.equal(page.data.pairingMissingCount, 1); assert.equal(page.data.pairingCanConfirm, false)
  assert.equal(page.data.pairingRows[0].selected, false)
  page.acknowledgeMissingPairings(); assert.equal(page.data.pairingCanConfirm, true)
  assert.equal(page._draftSession.state.pairingDrafts['suggested:all'].excludedPairKeys.includes('pair-1'), true)
  await page.confirmPairings()
  const command = h.calls.find(call => call.action === 'reviewIssues.resolvePairings')
  assert.deepEqual(command.input.selection.excludedPairKeys, ['pair-0'])
  page.onUnload()
})

test('失败结果可用原请求恢复，已保存但摘要失败准确提示并只补读摘要', async () => {
  const h = setup(100), page = h.page
  let timeout = true, failSummary = false
  h.onPairingCall = (action) => {
    if (action === 'reviewIssues.resolvePairings' && timeout || action === 'financeUpdates.summary' && failSummary) throw Object.assign(new Error('synthetic timeout'), { code: 'CLOUD_TEMPORARY_UNAVAILABLE' })
  }
  await page.openPairingReview(); await page.confirmPairings()
  const first = h.calls.find(call => call.action === 'reviewIssues.resolvePairings')
  assert.equal(page.data.pairingCanResume, true)
  timeout = false; failSummary = true; await page.resumePairings()
  const retry = h.calls.filter(call => call.action === 'reviewIssues.resolvePairings').at(-1)
  assert.deepEqual(retry.input, first.input)
  assert.match(page.data.pairingProgressText, /已保存 100 \/ 100 组.*结果待刷新/)
  assert.match(page.data.pairingError, /选择已同步，明细待刷新/)
  failSummary = false; await page.resumePairings()
  assert.equal(h.calls.filter(call => call.action === 'reviewIssues.resolvePairings').length, 2)
  assert.match(page.data.pairingProgressText, /结果已更新/)
  page.onUnload()
})

test('局部原文发现版本失效立即禁确认并结束等待，仍可重核恢复原选择', async () => {
  const h = setup(5), page = h.page
  const releases = []
  h.onPairingCall = action => action === 'economicEvents.evidence' ? new Promise((resolve, reject) => { releases.push(reject) }) : undefined
  await page.openPairingReview(); page.selectPairing(tap('pair-0')); await h.flush()
  releases.forEach(reject => reject(Object.assign(new Error('synthetic changed'), { code: 'STALE_VIEW' }))); await h.flush()
  assert.equal(page._viewSession.active, false)
  assert.equal(page.data.pairingNeedsRecheck, true)
  assert.equal(page.data.pairingLoading, false); assert.equal(page.data.pairingCanConfirm, false)
  h.onPairingCall = null
  h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
  await page.recheckPairings()
  assert.equal(page._viewSession.active, true)
  assert.equal(page.data.pairingRows[0].selected, false)
  assert.equal(page.data.pairingCanConfirm, true)
  page.onUnload()
})

test('配对可见、内容、可确认及保存指标在真实数据桥回调后记录且不含业务原文', async () => {
  const h = setup(100), page = h.page, callbacks = []
  await h.flush(); h.observer.enable(true)
  const original = page.setData.bind(page)
  page.setData = (patch, callback) => original(patch, callback && (() => {
    if (patch.pairingSheet) callbacks.push(callback)
    else callback()
  }))
  const opening = page.openPairingReview()
  assert.equal(h.observer.snapshot().some(row => row.phase === 'pairing_feedback'), false)
  callbacks.shift()(); await opening; await page.confirmPairings()
  const phases = h.observer.snapshot().filter(row => row.event === 'interactive').map(row => row.phase)
  for (const phase of ['pairing_feedback', 'pairing_content', 'pairing_ready', 'pairing_submit']) assert.ok(phases.includes(phase), phase)
  const metrics = JSON.stringify(h.observer.snapshot())
  assert.doesNotMatch(metrics, /pair-0|signed-scope|合成商户|合成商品/)
  h.observer.enable(false); page.onUnload()
})

test('翻页游标失效进入重新核对而非拿死游标重试，显式重核后恢复', async () => {
  const h = setup(6), page = h.page
  await page.openPairingReview()
  assert.equal(page.data.pairingRows.length, 4)
  assert.equal(page.data.pairingCanConfirm, true)
  h.onPairingCall = (action, input) => {
    if (action === 'reviewIssues.pairings' && input.cursor) throw Object.assign(new Error('分页位置无效，请重新读取'), { code: 'INVALID_CURSOR' })
  }
  await page.changePairingPage(pageDirection(1))
  assert.equal(page.data.pairingNeedsRecheck, true)
  assert.equal(page.data.pairingLoading, false)
  assert.equal(page.data.pairingCanConfirm, false)
  await page.retryPairingPage()
  assert.equal(page.data.pairingNeedsRecheck, true)
  assert.equal(page.data.pairingCanConfirm, false)
  assert.equal(page._draftSession.state.entries.length, 0)
  h.onPairingCall = null
  await page.recheckPairings()
  assert.equal(page.data.pairingNeedsRecheck, false)
  assert.equal(page.data.pairingRows.length, 4)
  assert.equal(page.data.pairingCanConfirm, true)
  page.onUnload()
})

test('不同笔也占用本次记录，不能把同一记录分配给第二条决定；取消自身后释放', async () => {
  const h = setup(2), page = h.page
  h.pairs[1].bank.eventId = h.pairs[0].bank.eventId
  await page.openAmbiguousPairingReview({ currentTarget: { dataset: {} } })
  page.selectPairing(tap('pair-0', 'distinct'))
  assert.equal(page.data.pairingRows[1].occupied, true)
  page.selectPairing(tap('pair-1', 'distinct'))
  assert.equal(page.data.pairingSelectedCount, 1)
  assert.match(page.data.pairingError, /已有另一条决定/)
  page.selectPairing(tap('pair-0', 'distinct'))
  assert.equal(page.data.pairingRows[1].occupied, false)
  page.selectPairing(tap('pair-1', 'same'))
  assert.equal(page.data.pairingSelectedCount, 1)
  assert.equal(page.data.pairingRows[1].decision, 'same')
  page.onUnload()
})

test('超过100条具体决定或500个例外会显式拒绝且原选择不截断', async () => {
  for (const [mode, count] of [['ambiguous', 100], ['suggested', 500]]) {
    const h = setup(count + 1), page = h.page
    if (mode === 'suggested') await page.openPairingReview()
    else await page.openAmbiguousPairingReview({ currentTarget: { dataset: {} } })
    const key = mode + ':all', original = page._draftSession.state.pairingDrafts[key]
    const draft = { ...original, revision: 1,
      excludedPairKeys: mode === 'suggested' ? h.pairs.slice(1).map(row => row.pairKey) : [],
      pairs: mode === 'ambiguous' ? h.pairs.slice(1).map(row => ({ pairKey: row.pairKey, bankEventId: row.bank.eventId, platformEventId: row.platform.eventId, decision: 'same' })) : [] }
    page._draftSession.savePairingDraft(key, draft)
    page.selectPairing(tap('pair-0', 'same'))
    assert.match(page.data.pairingError, mode === 'suggested' ? /500/ : /100/)
    const saved = page._draftSession.state.pairingDrafts[key]
    assert.equal(mode === 'suggested' ? saved.excludedPairKeys.length : saved.pairs.length, count)
    assert.equal(page.data.pairingRows[0].decision, mode === 'suggested' ? 'same' : '')
    assert.equal(page._draftSession.state.entries.length, 0)
    page.onUnload()
  }
})
