const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime, flush } = require('./helpers/paged-workbench')

const selected = id => ({ clientId: id, name: id + '.csv', size: 20, state: 'queued', progress: 0 })

test('实际 Page 选择账单限制剩余份数，拒绝超限文件并保留已经选择的文件', async () => {
  const h = runtime(), page = h.page
  page.data.files = [selected('one'), selected('two'), selected('three')]
  let picker
  h.wx.chooseMessageFile = options => { picker = options }
  page.chooseFiles()
  assert.equal(picker.count, 2)
  await picker.success({ tempFiles: [{ name: 'too-large.csv', size: 5 * 1024 * 1024 + 1 }] })
  assert.equal(page.data.files.length, 3)
  assert.match(page.data.errorMessage, /5 MB/)
  page._sourceFiles.set('one', { name: 'one.csv', size: 20, path: '/synthetic/one.csv' })
  await picker.success({ tempFiles: [{ name: 'one.csv', size: 20, path: '/synthetic/one.csv' },
    { name: 'new.csv', size: 30, path: '/synthetic/new.csv' }] })
  assert.equal(page.data.files.length, 4)
  assert.equal(page.data.files[3].name, 'new.csv')
  assert.equal(page.data.uploadSummary.queued, 4)
  page.onUnload()
})

test('实际 Page 五文件并行上传，单份失败不污染成功文件，重试只处理失败项', async () => {
  const h = runtime(), page = h.page
  page.data.files = Array.from({ length: 5 }, (_, i) => selected('file' + i))
  for (const file of page.data.files) page._sourceFiles.set(file.clientId, { path: '/synthetic/' + file.name })
  let active = 0, peak = 0, first = true
  const uploads = []
  page.uploadObject = async file => {
    uploads.push(file.clientId); peak = Math.max(peak, ++active)
    await flush(); active--
    if (file.clientId === 'file2' && first) { first = false; throw new Error('合成单文件中断') }
    return { fileID: 'synthetic-' + file.clientId }
  }
  h.intercept = (action, input) => {
    if (action === 'imports.prepareMany') return { files: input.files.map((_, i) => ({ importId: 'import' + i, version: 1, cloudPath: 'synthetic/' + i })) }
    if (action === 'imports.parseFile') return { import: { importId: input.importId, version: 2 },
      batch: { batchId: 'batch-' + input.importId, sourceType: 'wechat', summary: { valid: 1 } } }
  }
  await page.startUpload()
  assert.equal(peak, 5)
  assert.equal(page.data.busy, false)
  assert.equal(page.data.uploadSummary.ready, 4)
  assert.equal(page.data.uploadSummary.failed, 1)
  const completed = JSON.stringify(page.data.files.filter(file => file.clientId !== 'file2'))
  await page.retryFile({ currentTarget: { dataset: { id: 'file2' } } })
  assert.equal(page.data.uploadSummary.ready, 5)
  assert.equal(page.data.uploadSummary.failed, 0)
  assert.equal(JSON.stringify(page.data.files.filter(file => file.clientId !== 'file2')), completed)
  assert.deepEqual(uploads.slice(5), ['file2'])
  assert.equal(h.calls.filter(call => call.action === 'imports.prepareMany').length, 1)
  page.onUnload()
})
