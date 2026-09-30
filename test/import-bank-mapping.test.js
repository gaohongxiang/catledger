const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const mapping = require('../miniprogram/pages/import-workbench/bank-mapping')
const model = require('../miniprogram/pages/import-workbench/model')

const preview = { schemaVersion: 1, sheetIndex: 0, headerRow: 2, headerToken: 'synthetic-header-token',
  sheets: [{ index: 0, name: '明细' }], headers: ['交易日期', '交易金额', '借贷', '摘要'].map((name, index) => ({ name, index })),
  samples: [['2026-09-01', '10', 'DR', '合成项目']],
  suggested: { columns: { transactionTime: 0, amount: 1, direction: 2, item: 3 }, amountMode: 'direction',
    positiveDirection: '', debitDirection: '', currency: 'CNY' } }

test('银行列确认展示样例，借贷和正负必须明确，切换格式不发送无关列', () => {
  let sheet = mapping.view('file', '合成.xls', preview)
  assert.match(sheet.fields.find(field => field.key === 'amount').example, /10/)
  assert.match(mapping.payload(sheet).error, /借方/)
  sheet = mapping.view('file', '合成.xls', preview, { ...sheet.draft, debitDirection: 'expense' })
  assert.equal(mapping.payload(sheet).value.debitDirection, 'expense')
  sheet = mapping.view('file', '合成.xls', preview, { ...sheet.draft, amountMode: 'signed', positiveDirection: '' })
  assert.match(mapping.payload(sheet).error, /正数/)
  sheet = mapping.view('file', '合成.xls', preview, { ...sheet.draft, positiveDirection: 'expense' })
  const payload = mapping.payload(sheet).value
  assert.equal(payload.columns.direction, undefined)
  assert.equal(payload.columns.item, 3)
  const collision = mapping.view('file', '合成.xls', preview, { ...sheet.draft, columns: { transactionTime: 0, amount: 0 } })
  assert.match(mapping.payload(collision).error, /一列/)
})

function workbench(request) {
  const { page } = require('./helpers/paged-workbench').runtime()
  page.request = request
  page.data.files = [{ clientId: 'file', name: '合成.xls', importId: 'synthetic-import', fileID: 'synthetic-upload', state: 'queued' }]
  return page
}

test('解析返回待映射后可修改并确认，失败保留编辑和上传结果，成功继续账户步骤', async () => {
  const requests = []
  const page = workbench(async (action, data) => {
    requests.push({ action, data })
    if (!data.bankMapping) return { import: { version: 2, state: 'failed' }, mappingRequired: true, bankPreview: preview }
    if (requests.length === 2) throw new Error('合成网络中断')
    return { import: { importId: 'synthetic-import', version: 3, state: 'review_ready' }, batch: { batchId: 'synthetic-batch', sourceType: 'bank', summary: { total: 1, valid: 1 } } }
  })
  await page.parsePreparedFile('file', 'synthetic-upload')
  assert.equal(page.data.files[0].state, 'mapping')
  assert.equal(model.uploadSummary(page.data.files).attention, 1)
  page.openBankMapping({ currentTarget: { dataset: { id: 'file' } } })
  page.changeBankMapping({ currentTarget: { dataset: { key: 'debitDirection' } }, detail: { value: 2 } })
  await page.confirmBankMapping()
  assert.equal(page.data.files[0].state, 'failed')
  assert.match(page.data.bankMappingSheet.error, /网络中断/)
  assert.equal(page.data.files[0].fileID, 'synthetic-upload')
  await page.confirmBankMapping()
  assert.equal(page.data.files[0].state, 'ready')
  assert.equal(page.data.bankMappingSheet, null)
  assert.equal(page.data.uploadSummary.ready, 1)
  assert.equal(requests[2].data.bankMapping.debitDirection, 'expense')
  assert.equal(requests.every(request => request.action === 'imports.parseFile'), true)
})

test('待确认列和读取失败可分别操作，已经入账的重复文件不再计为待处理', async () => {
  const page = workbench(async () => ({ import: { version: 2, state: 'failed' }, mappingRequired: true, bankPreview: preview }))
  await page.parsePreparedFile('file', 'synthetic-upload')
  page.data.files.push({ clientId: 'failed', name: '失败.xls', state: 'failed', errorMessage: '合成的具体失败原因' },
    { clientId: 'duplicate', state: 'duplicate' })
  page.syncUploadSummary()
  assert.deepEqual({ ...page.data.uploadSummary }, { total: 3, queued: 0, ready: 0, failed: 1, mapping: 1, duplicate: 1, attention: 2 })
  await page.openFileAttention({ currentTarget: { dataset: { state: 'mapping' } } })
  assert.equal(page.data.bankMappingSheet.clientId, 'file')
  page.closeBankMapping()
  page.openFileAttention({ currentTarget: { dataset: { state: 'failed' } } })
  assert.equal(page.data.fileAttentionSheet.clientId, 'failed')
  assert.equal(page.data.fileAttentionSheet.reason, '合成的具体失败原因')
})

test('确认入口丢失内存预览时重新读取已上传文件，不再点击无响应', async () => {
  let calls = 0
  const page = workbench(async (action, data) => {
    calls += 1
    assert.equal(data.fileID, 'synthetic-upload')
    assert.equal(data.bankMapping, undefined)
    return { import: { version: 2, state: 'failed' }, mappingRequired: true, bankPreview: preview }
  })
  page.data.files[0].state = 'mapping'
  page.data.files[0].bankMapping = { stale: true }
  await page.openBankMapping({ currentTarget: { dataset: { id: 'file' } } })
  assert.equal(calls, 1)
  assert.equal(page.data.bankMappingSheet.clientId, 'file')
  assert.equal(page.data.busy, false)
})

test('读取失败说明保留到重试成功；预览恢复失败会显示原因', async () => {
  let ready = false
  const page = workbench(async () => {
    if (!ready) throw Object.assign(new Error('synthetic'), { code: 'FILE_FORMAT_UNSUPPORTED' })
    return { import: { importId: 'synthetic-import', version: 3, state: 'review_ready' }, batch: { batchId: 'synthetic-batch' } }
  })
  await page.openBankMapping({ currentTarget: { dataset: { id: 'file' } } })
  assert.match(page.data.fileAttentionSheet.reason, /尚未识别这份表格/)
  assert.equal(page.data.files[0].fileID, 'synthetic-upload')
  ready = true
  await page.retryFileAttention()
  assert.equal(page.data.fileAttentionSheet, null)
  assert.equal(page.data.files[0].state, 'ready')
})

function editableBank() {
  const h = require('./helpers/paged-workbench').runtime()
  h.page.data.files = [{ clientId: 'file', name: '合成.xls', importId: 'synthetic-import', fileID: 'synthetic-upload', state: 'mapping' }]
  h.page.data.bankMappingSheet = mapping.view('file', '合成.xls', preview, {
    ...preview.suggested, statementKind: 'credit', positiveDirection: 'expense', debitDirection: 'expense'
  })
  return h
}
const headerInput = value => ({ detail: { value } })
const previewResult = row => ({ import: { version: 3, state: 'failed' }, mappingRequired: true,
  bankPreview: { ...preview, headerRow: row, headerToken: 'synthetic-header-' + row } })

test('真实Page行号输入停止后自动识别一次，保留信用卡和方向选择，失焦不重复请求', async () => {
  const h = editableBank(), page = h.page
  h.intercept = (action, input) => { assert.equal(action, 'imports.parseFile'); return previewResult(input.bankPreview.headerRow) }
  page.inputBankHeader(headerInput('1'))
  page.inputBankHeader(headerInput('12'))
  assert.equal(page.data.bankMappingSheet.previewPending, true)
  await new Promise(resolve => setTimeout(resolve, 450))
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].input.bankPreview.headerRow, 12)
  assert.equal(page.data.bankMappingSheet.preview.headerRow, 12)
  assert.equal(page.data.bankMappingSheet.draft.statementKind, 'credit')
  assert.equal(page.data.bankMappingSheet.draft.debitDirection, 'expense')
  assert.equal(page.data.bankMappingSheet.previewPending, false)
  await page.refreshBankPreview()
  assert.equal(h.calls.length, 1)
  page.onUnload()
})

test('无效行号不请求；输入途中改方向不丢行号，确认必须使用新表头和令牌', async () => {
  const h = editableBank(), page = h.page
  h.intercept = (action, input) => input.bankPreview ? previewResult(input.bankPreview.headerRow) : {
    import: { version: 4 }, batch: { batchId: 'synthetic-batch' }
  }
  page.inputBankHeader(headerInput('121'))
  await page.confirmBankMapping()
  assert.equal(h.calls.length, 0)
  assert.match(page.data.bankMappingSheet.error, /1 到 120/)
  page.inputBankHeader(headerInput('12'))
  page.changeBankMapping({ currentTarget: { dataset: { key: 'debitDirection' } }, detail: { value: 2 } })
  assert.equal(page.data.bankMappingSheet.headerRowInput, '12')
  await page.confirmBankMapping()
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].input.bankMapping.headerRow, 12)
  assert.equal(h.calls[1].input.bankMapping.headerToken, 'synthetic-header-12')
  assert.equal(page.data.files[0].state, 'ready')
  page.onUnload()
})

test('自动识别失败保留输入及解释选择，确认会先重试识别而不提交旧表头', async () => {
  const h = editableBank(), page = h.page
  let fails = true
  h.intercept = (action, input) => {
    if (fails) throw new Error('合成断网')
    return input.bankPreview ? previewResult(12) : { import: { version: 4 }, batch: { batchId: 'synthetic-batch' } }
  }
  page.inputBankHeader(headerInput('12'))
  await page.refreshBankPreview()
  assert.equal(page.data.busy, false)
  assert.equal(page.data.bankMappingSheet.headerRowInput, '12')
  assert.equal(page.data.bankMappingSheet.previewPending, true)
  assert.equal(page.data.bankMappingSheet.draft.statementKind, 'credit')
  assert.match(page.data.bankMappingSheet.error, /断网/)
  fails = false
  await page.confirmBankMapping()
  assert.equal(h.calls.filter(call => call.input.bankMapping).length, 1)
  assert.equal(h.calls.at(-1).input.bankMapping.headerRow, 12)
  page.onUnload()
})

for (const leave of ['hide', 'unload', 'owner', 'scope']) test('表头预览迟到响应在 ' + leave + ' 后不回填', async () => {
  const h = editableBank(), page = h.page
  let finish
  h.intercept = () => new Promise(resolve => { finish = resolve })
  page.inputBankHeader(headerInput('12'))
  const pending = page.refreshBankPreview()
  await h.flush()
  if (leave === 'hide') page.onHide()
  if (leave === 'unload') page.onUnload()
  if (leave === 'owner') h.app.globalData.uid = 'synthetic-other-owner'
  if (leave === 'scope') h.cache.reset()
  if (leave === 'hide' || leave === 'unload') assert.equal(page.data.files[0].state, 'mapping')
  const state = JSON.stringify(page.data)
  finish(previewResult(12))
  await pending
  assert.equal(JSON.stringify(page.data), state)
  assert.equal(page._bankPreviews && page._bankPreviews.has('file'), undefined)
  page.onUnload()
})

test('关闭弹层或输入后换用户取消自动识别，不发送旧文件', async () => {
  for (const leave of ['close', 'owner']) {
    const h = editableBank(), page = h.page
    page.inputBankHeader(headerInput('12'))
    if (leave === 'close') page.closeBankMapping()
    else h.app.globalData.uid = 'synthetic-other-owner'
    await new Promise(resolve => setTimeout(resolve, 450))
    assert.equal(h.calls.length, 0)
    page.onUnload()
  }
})
