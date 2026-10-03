const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')
const tap = id => ({ currentTarget: { dataset: { id } } })

function setup() {
  const data = fixture(1)
  data.events[0].evidenceCount = 3
  const h = runtime(data)
  h.original = id => JSON.stringify([{ name: '来源', value: id }, { name: '备注', value: '' }, { name: '金额', value: 0 }])
  h.intercept = async (action, input) => {
    if (h.custom) { const result = await h.custom(action, input); if (result !== undefined) return result }
    if (action === 'economicEvents.evidence') {
      const start = Number(input.cursor || 0), rows = [0, 1, 2].map(index => ({ evidenceId: 'source-' + index,
        fileName: '合成账单.csv', sourceType: index ? 'bank' : 'wechat', rowNumber: index + 1 }))
      return { viewVersion: h.summary.viewVersion, items: rows.slice(start, start + 2), total: 3, nextCursor: start ? null : '2' }
    }
    if (action === 'economicEvents.detail') return { viewVersion: h.summary.viewVersion, part: h.original(input.evidenceId), nextCursor: null }
    if (action === 'economicEvents.duplicateReview') return { viewVersion: h.summary.viewVersion, update: h.summary.update,
      eventVersion: 1, kind: h.kind || 'same', canSplit: !h.kind, canMerge: h.kind === 'distinct', count: 2,
      records: [], pairs: [{ pairKey: 'synthetic-pair', otherEventId: 'other', otherEventVersion: 1, records: [] }] }
  }
  return h
}

test('详情自动展开全部来源和原始字段；服务端分批读取不变成用户翻页，查看不写入', async () => {
  const h = setup(), page = h.page
  await page.openReviewDetails(tap(h.events[0].eventId))
  assert.equal(page.data.reviewDetailSheet.sources.length, 3)
  assert.equal(page.data.reviewDetailSheet.loading, false)
  assert.deepEqual(Array.from(page.data.reviewDetailSheet.sources, source => source.fields.map(field => field.value).join('|')),
    ['source-0||0', 'source-1||0', 'source-2||0'])
  assert.equal(h.calls.filter(row => row.action === 'economicEvents.evidence').length, 2)
  assert.equal(h.calls.some(row => /revise|resolve|\.post$/.test(row.action)), false)
  page.onUnload()
})

test('重复和已核对详情均可打开同笔判断；取消修改保留展开原文，成功保存返回最新列表', async () => {
  for (const kind of ['same', 'distinct']) {
    const h = setup(), page = h.page
    if (kind === 'distinct') { h.kind = kind; h.events[0].pairingDecision = kind; h.events[0].evidenceCount = 1 }
    await page.setStep({ currentStep: 3, activeReviewStatus: 'completed' })
    await page.openReviewDetails(tap(h.events[0].eventId))
    await page.openReviewJudgment()
    assert.equal(page.data.duplicateEditSheet.kind, kind)
    page.closeDuplicateEdit()
    assert.equal(page.data.reviewDetailSheet.sources.length, 3)
    h.custom = action => {
      if (action !== 'financeUpdates.reviseDuplicate') return
      h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
      return { protocolVersion: 2, kind: 'operation-receipt', action, update: h.summary.update }
    }
    await page.openReviewJudgment()
    await page.saveDuplicateEdit()
    assert.equal(h.calls.filter(row => row.action === 'financeUpdates.reviseDuplicate').length, 1)
    assert.equal(page.data.reviewDetailSheet, null)
    assert.equal(page.data.duplicateEditSheet, null)
    page.onUnload()
  }
})

test('一份原文失败只在本卡重试；长原文仍可查看完整内容再返回多来源详情', async () => {
  const h = setup(), page = h.page
  let failed = true
  h.custom = (action, input) => {
    if (action === 'economicEvents.detail' && input.evidenceId === 'source-1' && failed) throw Error('合成失败')
  }
  await page.openReviewDetails(tap(h.events[0].eventId))
  assert.match(page.data.reviewDetailSheet.sources[1].error, /合成失败/)
  const sourceReads = h.calls.filter(row => row.action === 'economicEvents.evidence').length
  failed = false
  await page.retryReviewSource({ currentTarget: { dataset: { index: 1 } } })
  assert.equal(page.data.reviewDetailSheet.sources[1].fields[0].value, 'source-1')
  assert.equal(h.calls.filter(row => row.action === 'economicEvents.evidence').length, sourceReads)
  await page.openReviewSource({ currentTarget: { dataset: { id: h.events[0].eventId, evidenceId: 'source-1' } } })
  assert.equal(page.data.evidenceSheet.evidence[0].evidenceId, 'source-1')
  page.closeEvidence()
  assert.equal(page.data.reviewDetailSheet.hidden, false)
  assert.equal(page.data.reviewDetailSheet.sources.length, 3)
  page.onUnload()
})

test('关闭、隐藏、卸载、换会话和版本变化后，迟到原文不能回填或开启修改', async () => {
  for (const leave of ['closeReviewDetails', 'onHide', 'onUnload', 'session', 'version']) {
    const h = setup(), page = h.page
    const releases = []
    h.custom = (action, input) => action === 'economicEvents.detail' ? new Promise(resolve => releases.push(() =>
      resolve({ viewVersion: 'v1', part: h.original(input.evidenceId), nextCursor: null }))) : undefined
    const loading = page.openReviewDetails(tap(h.events[0].eventId))
    await flush()
    if (leave === 'session') h.cache.reset()
    else if (leave === 'version') await page.applyUpdateView({ ...h.summary, viewVersion: 'v2' }, true)
    else page[leave]()
    const patches = h.patches.length
    releases.forEach(release => release())
    await loading
    await page.openReviewJudgment()
    assert.equal(h.patches.length, patches, leave)
    assert.equal(page.data.duplicateEditSheet, null)
    page.onUnload()
  }
})
