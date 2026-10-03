const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')

const tap = id => ({ currentTarget: { dataset: { id } } })
const target = value => ({ currentTarget: { dataset: { target: value } } })
const child = { categoryId: 'synthetic-drink', name: '饮品', parentName: '餐饮', kind: 'expense' }
const write = 'financeUpdates.setCategory'
function editor() {
  const h = runtime(fixture(2)), page = h.page
  page.setData({ currentStep: 3, activeReviewTab: 'category', activeCategoryStatus: 'completed' })
  h.events[0].categoryName = '餐饮 / 美食'
  h.options = [{ categoryId: 'synthetic-food', name: '餐饮', kind: 'expense' }, child]
  h.intercept = (action, input) => {
    if (action === 'financeUpdates.options' && input.kind === 'categories') return {
      protocolVersion: 2, viewVersion: h.summary.viewVersion, items: input.id ? h.options.filter(item => item.categoryId === input.id) : h.options,
      total: h.options.length, nextCursor: null }
    return h.command && h.command(action, input)
  }
  h.saved = input => {
    const row = h.events.find(event => event.eventId === input.eventId)
    row.categoryId = input.categoryId; row.categoryName = '餐饮 / 饮品'; row.version++
    h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
    return { protocolVersion: 2, kind: 'operation-receipt', action: write, update: h.summary.update }
  }
  h.choose = async () => {
    await page.openDirectory(target('categoryEdit'))
    page.selectDirectory({ currentTarget: { dataset: { index: 1 } } })
  }
  h.open = async () => { await page.loadActivePage(true); await page.openCategoryEdit(tap(h.events[0].eventId)) }
  return h
}

test('已分类可从完整同类目录改到二级分类，只提交当前笔并刷新具体名称', async () => {
  const h = editor(), page = h.page
  await h.open()
  assert.equal(page.data.categoryEditSheet.selectedName, '餐饮 / 美食')
  assert.equal(page.data.categoryEditSheet.canSave, false)
  await h.choose()
  assert.equal(page.data.categoryEditSheet.selectedName, '餐饮 / 饮品')
  assert.equal(page.data.directorySheet, null)
  const options = h.calls.filter(c => c.action === 'financeUpdates.options').at(-1)
  assert.equal(options.input.categoryKind, 'expense')
  h.command = (action, input) => action === write ? h.saved(input) : undefined
  await page.saveCategoryEdit()
  const writes = h.calls.filter(c => c.action === write)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].input.eventId, h.events[0].eventId)
  assert.equal(writes[0].input.eventVersion, 1)
  assert.equal(writes[0].input.updateVersion, 1)
  assert.equal(writes[0].input.categoryId, child.categoryId)
  assert.equal(page.data.categorizedEvents[0].categoryName, '餐饮 / 饮品')
  assert.equal(h.events[1].categoryId, 'synthetic-category')
  assert.equal(page.data.categoryEditSheet, null)
  assert.equal(page.data.activeCategoryStatus, 'completed')
  page.onUnload()
})

test('关闭不保存；目录迟到、隐藏、卸载和换会话不回填也不提交', async () => {
  for (const leave of ['closeCategoryEdit', 'onHide', 'onUnload', 'session']) {
    const h = editor(), page = h.page
    await h.open()
    let release
    h.intercept = action => action === 'financeUpdates.options' ? new Promise(resolve => { release = resolve }) : undefined
    const reading = page.openDirectory(target('categoryEdit'))
    await flush()
    if (leave === 'session') h.cache.reset()
    else page[leave]()
    const patches = h.patches.length
    release({ protocolVersion: 2, viewVersion: 'v1', items: [child], total: 1, nextCursor: null })
    await reading
    await page.saveCategoryEdit()
    assert.equal(h.patches.length, patches)
    assert.equal(h.calls.filter(c => c.action === write).length, 0)
    page.onUnload()
  }
})

test('背景更新保留编辑选择并禁止旧版本保存；错误类型分类不可选', async () => {
  const h = editor(), page = h.page
  await h.open(); await h.choose()
  assert.equal(page.selectEditedCategory({ ...child, kind: 'income' }), false)
  page.applyUpdateView({ ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }, true)
  assert.equal(page.data.categoryEditSheet.selectedId, child.categoryId)
  assert.equal(page.data.categoryEditSheet.stale, true)
  await page.saveCategoryEdit()
  assert.equal(h.calls.filter(c => c.action === write).length, 0)
  page.onUnload()
})

test('保存结果未知冻结原选择；重开和入账入口可恢复原请求，不重发已成功决定', async () => {
  const h = editor(), page = h.page
  await h.open(); await h.choose()
  let receipt
  h.command = (action, input) => {
    if (action === write) { receipt = h.saved(input); throw new Error('synthetic lost response') }
    if (action === 'imports.commandResult') return receipt
  }
  await page.saveCategoryEdit()
  assert.equal(page.data.categoryEditSheet.pending, true)
  const packet = page.pendingCategoryEdit()
  assert.equal(page.selectEditedCategory({ ...child, categoryId: 'synthetic-other' }), false)
  page.closeCategoryEdit()
  await page.postUpdate()
  assert.equal(page.data.categoryEditSheet.pending, true)
  assert.equal(h.calls.filter(c => c.action === 'financeUpdates.post').length, 0)
  assert.deepEqual(page.pendingCategoryEdit().payload, packet.payload)
  await page.saveCategoryEdit()
  assert.equal(h.calls.filter(c => c.action === write).length, 1)
  assert.equal(page.pendingCategoryEdit(), null)
  assert.equal(page.data.categorizedEvents[0].categoryName, '餐饮 / 饮品')
  page.onUnload()
})

test('保存成功但摘要失败保留成功事实，刷新不再次写入', async () => {
  const h = editor(), page = h.page
  await h.open(); await h.choose()
  let failed = false
  h.command = (action, input) => {
    if (action === write) { const result = h.saved(input); failed = true; return result }
    if (action === 'financeUpdates.summary' && failed) throw new Error('synthetic summary unavailable')
  }
  await page.saveCategoryEdit()
  assert.equal(page.data.categoryEditSheet.saved, true)
  assert.match(page.data.categoryEditSheet.error, /已保存/)
  await page.saveCategoryEdit()
  failed = false
  await page.refreshCategoryEdit()
  assert.equal(page.data.categoryEditSheet, null)
  assert.equal(h.calls.filter(c => c.action === write).length, 1)
  page.onUnload()
})

test('双击只保存一次，离开后迟到结果不覆盖页面，后台已保存不重复恢复', async () => {
  const h = editor(), page = h.page
  await h.open(); await h.choose()
  let release
  h.command = (action, input) => action === write ? new Promise(resolve => { release = () => resolve(h.saved(input)) }) : undefined
  const saving = page.saveCategoryEdit()
  await flush(); await page.saveCategoryEdit()
  assert.equal(h.calls.filter(c => c.action === write).length, 1)
  page.onHide()
  const patches = h.patches.length
  release(); await saving
  assert.equal(h.patches.length, patches)
  assert.equal(page.pendingCategoryEdit(), null)
  page.onUnload()
})

test('旧事件版本冲突不改选项或自动重发；同步期间离开不发送分类命令', async () => {
  const h = editor(), page = h.page
  await h.open(); await h.choose()
  h.command = action => { if (action === write) throw Object.assign(new Error('synthetic conflict'), { code: 'CONFLICT' }) }
  await page.saveCategoryEdit()
  assert.equal(page.data.categoryEditSheet.stale, true)
  assert.equal(page.data.categoryEditSheet.selectedId, child.categoryId)
  assert.equal(page.pendingCategoryEdit(), null)
  await page.saveCategoryEdit()
  assert.equal(h.calls.filter(c => c.action === write).length, 1)
  page.onUnload()
  const next = editor()
  await next.open(); await next.choose()
  let release
  next.page._draftSession.flush = () => new Promise(resolve => { release = resolve })
  const saving = next.page.saveCategoryEdit()
  await flush(); next.page.onUnload(); release(); await saving
  assert.equal(next.calls.filter(c => c.action === write).length, 0)
})
