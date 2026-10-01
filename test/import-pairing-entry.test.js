const test = require('node:test')
const assert = require('node:assert/strict')
const { setup } = require('./helpers/pairing-workbench')
const { fixture } = require('./helpers/paged-workbench')

function mixed(count = 29) {
  const data = fixture(2, true)
  data.summary.sources = [{ sourceId: 'synthetic-bank', sourceType: 'bank' }, { sourceId: 'synthetic-wechat', sourceType: 'wechat' }]
  return setup(count, data)
}
async function until(h, check) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await h.flush()
  assert.ok(check())
}

test('入口显示服务端完整29组，首页4组预读与弹层共用一次请求，不提前读原文', async t => {
  const h = mixed(), page = h.page
  t.after(() => page.onUnload())
  await until(h, () => page.data.pairingEntry && !page.data.pairingEntry.loading)
  assert.equal(page.data.pairingEntry.total, 29)
  assert.equal(h.calls.filter(call => call.action === 'reviewIssues.pairings').length, 1)
  assert.equal(h.calls.some(call => call.action === 'economicEvents.evidence'), false)
  await page.openPairingEntry()
  assert.equal(page.data.pairingRows.length, 4)
  assert.equal(page.data.pairingSelectedCount, 29)
  assert.equal(h.calls.filter(call => call.action === 'reviewIssues.pairings').length, 1)
  page.closePairingReview(); await page.loadActivePage(true)
  await page.openPairingEntry()
  assert.equal(h.calls.filter(call => call.action === 'reviewIssues.pairings').length, 1)
})

test('数量未返回即可打开骨架，共用在途读取而不再查询同一范围', async t => {
  const h = mixed(), page = h.page
  t.after(() => page.onUnload())
  let release
  h.onPairingCall = action => action === 'reviewIssues.pairings' ? new Promise(resolve => { release = resolve }) : undefined
  await until(h, () => Boolean(release))
  const opening = page.openPairingEntry()
  assert.equal(page.data.pairingSheet.title, '建议配对')
  assert.equal(page.data.pairingEntry.total, null)
  assert.equal(page.data.pairingCanConfirm, false)
  await h.flush()
  assert.equal(h.calls.filter(call => call.action === 'reviewIssues.pairings').length, 1)
  release(undefined); await opening; await h.flush()
  assert.equal(page.data.pairingEntry.total, 29)
  assert.equal(page.data.pairingCanConfirm, true)
})

test('新版本重新核验入口组数，较早版本的迟到总数不覆盖当前结果', async t => {
  const h = mixed(), page = h.page
  t.after(() => page.onUnload())
  let release
  h.onPairingCall = (action, input) => action === 'reviewIssues.pairings' && input.viewVersion === 'v1'
    ? new Promise(resolve => { release = resolve }) : undefined
  await until(h, () => Boolean(release))
  h.pairs = h.pairs.slice(0, 7)
  h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
  await page.applyUpdateView(h.summary)
  await until(h, () => page.data.pairingEntry && page.data.pairingEntry.total === 7)
  release({ protocolVersion: 2, viewVersion: 'v1', total: 29, items: [] })
  await h.flush(); await h.flush()
  assert.equal(page.data.pairingEntry.total, 7)
  assert.equal(page._viewSession.active, true)
})

for (const leave of ['hide', 'unload', 'owner', 'step']) test('入口计数迟到时' + leave + '，不恢复旧批次或旧用户卡片', async () => {
  const h = mixed(), page = h.page
  let release
  h.onPairingCall = action => action === 'reviewIssues.pairings' ? new Promise(resolve => { release = resolve }) : undefined
  await until(h, () => Boolean(release))
  if (leave === 'hide') page.onHide()
  else if (leave === 'unload') page.onUnload()
  else if (leave === 'owner') { h.cache.reset(); h.app.globalData.uid = 'synthetic-other-user'; page.onShow() }
  else await page.setStep({ currentStep: 2 })
  release(undefined); await h.flush(); await h.flush()
  assert.equal(page.data.pairingEntry, null)
  if (leave !== 'unload') page.onUnload()
})

test('数量失败不伪报0组；点击后只重试读取，成功恢复卡片和弹层', async t => {
  const h = mixed(), page = h.page
  t.after(() => page.onUnload())
  h.onPairingCall = action => { if (action === 'reviewIssues.pairings') throw new Error('synthetic unavailable') }
  await until(h, () => page.data.pairingEntry && page.data.pairingEntry.error)
  assert.equal(page.data.pairingEntry.total, null)
  h.onPairingCall = null
  await page.openPairingEntry()
  assert.equal(page.data.pairingEntry.total, 29)
  assert.equal(page.data.pairingEntry.error, false)
  assert.equal(page.data.pairingSelectedCount, 29)
  assert.equal(h.calls.filter(call => call.action === 'reviewIssues.pairings').length, 2)
  assert.equal(h.calls.some(call => call.action === 'reviewIssues.resolvePairings'), false)
})

test('确认配对后卡片重新读取剩余范围，不把原29组继续显示为待核对', async t => {
  const h = mixed(), page = h.page
  t.after(() => page.onUnload())
  await page.openPairingEntry()
  await page.confirmPairings(); page.closePairingReview()
  await until(h, () => page.data.pairingEntry && page.data.pairingEntry.total === 0)
  assert.equal(h.calls.filter(call => call.action === 'reviewIssues.resolvePairings').length, 1)
  assert.equal(h.calls.filter(call => call.action === 'reviewIssues.pairings').length, 2)
})

test('关闭弹层时入口卡片已被清空的，按当前资格兜底重拉恢复', async t => {
  const h = mixed(), page = h.page
  t.after(() => page.onUnload())
  await until(h, () => page.data.pairingEntry && !page.data.pairingEntry.loading)
  await page.openPairingEntry()
  page.cancelPairingEntry()
  assert.equal(page.data.pairingEntry, null)
  page.closePairingReview()
  await until(h, () => page.data.pairingEntry && !page.data.pairingEntry.loading)
  assert.equal(page.data.pairingEntry.total, 29)
  assert.equal(page.data.pairingEntry.error, false)
})

test('兜底重拉不改变资格门控：分类 tab 下关闭弹层不显示配对卡片', async t => {
  const h = mixed(), page = h.page
  t.after(() => page.onUnload())
  await until(h, () => page.data.pairingEntry && !page.data.pairingEntry.loading)
  await page.switchReviewTab({ currentTarget: { dataset: { tab: 'category' } } })
  assert.equal(page.data.pairingEntry, null)
  const reads = h.calls.filter(call => call.action === 'reviewIssues.pairings').length
  page.closePairingReview()
  await h.flush(); await h.flush()
  assert.equal(page.data.pairingEntry, null)
  assert.equal(h.calls.filter(call => call.action === 'reviewIssues.pairings').length, reads)
})

test('没有混合银行与平台来源时不显示建议卡片，也不增加范围查询', async t => {
  const h = setup(29), page = h.page
  t.after(() => page.onUnload())
  await h.flush(); await h.flush()
  assert.equal(page.data.pairingEntry, null)
  assert.equal(h.calls.some(call => call.action === 'reviewIssues.pairings'), false)
})
