const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime, flush } = require('./helpers/paged-workbench')

const tap = id => ({ currentTarget: { dataset: { id } } })
const input = value => ({ detail: { value } })
const failure = code => Object.assign(new Error('合成失败'), { code })
const selected = (id, options = {}) => Object.assign({ clientId: id, name: '合成账单.csv', originalName: '合成账单.csv',
  displayName: '', size: 20, sizeText: '20 B', state: 'queued', progress: 0, importId: '', importVersion: 0 }, options)
const serverFile = (options = {}) => Object.assign({ importId: 'synthetic-import', fileName: '合成账单.csv',
  version: 2, state: 'parsed' }, options)
const receipt = (file) => ({ protocolVersion: 2, kind: 'file-receipt', receiptId: 'synthetic-receipt',
  action: 'imports.renameFile', import: file })
function setup(t, files = [selected('one')]) {
  const h = runtime(undefined, { initialView: false, pageOptions: { fresh: '1' } })
  h.page.setData({ files, phase: files.some(file => file.state === 'queued') ? 'selected' : 'files_ready' })
  for (const file of files) h.page._sourceFiles.set(file.clientId, { name: file.originalName, size: file.size, path: '/synthetic/' + file.clientId })
  h.page.syncUploadSummary()
  t.after(() => h.page.onUnload())
  return h
}
const uploaded = (id = 'one') => selected(id, { state: 'ready', importId: 'synthetic-import', importVersion: 2, batchId: 'synthetic-batch' })
const sourceTap = sourceId => ({ currentTarget: { dataset: { sourceId } } })
async function setupSources(t, files = []) {
  const h = setup(t, files)
  h.sourceFiles = new Map([['synthetic-import', serverFile()], ['second-import', serverFile({ importId: 'second-import', fileName: '第二份账单.xlsx' })]])
  h.summary = { ...h.summary, sources: [...h.sourceFiles.values()].map((file, index) => ({ sourceId: 'source-' + index,
    importId: file.importId, fileName: file.fileName, sourceType: 'wechat', summary: { total: 2, valid: 2, invalid: 0 } })) }
  h.renameSource = data => {
    const file = { ...h.sourceFiles.get(data.importId), displayName: data.displayName, version: data.version + 1 }
    h.sourceFiles.set(data.importId, file)
    h.summary = { ...h.summary, viewVersion: 'sources-' + file.version, update: { ...h.summary.update, version: h.summary.update.version + 1 },
      sources: h.summary.sources.map(source => source.importId === file.importId
        ? { ...source, fileName: file.displayName, originalFileName: file.fileName } : source) }
    return receipt(file)
  }
  h.intercept = async (action, data) => {
    if (h.onSourceCall) { const result = await h.onSourceCall(action, data); if (result !== undefined) return result }
    if (action === 'imports.getFile') return { import: h.sourceFiles.get(data.importId) }
    if (action === 'imports.renameFile') return h.renameSource(data)
  }
  await h.page.applyUpdateView(h.summary, false, true)
  return h
}

test('实际 Page 整理后的来源行可改名，刷新批次版本与名称，不重新整理或生成本机文件', async t => {
  const h = await setupSources(t), page = h.page
  const originalCounts = JSON.stringify(page.data.recordSummary)
  assert.equal(page.data.sources[0].importId, 'synthetic-import')
  await page.openFileRename(sourceTap('source-0'))
  assert.equal(page.data.fileNameEdit.sourceId, 'source-0')
  assert.equal(page.data.fileNameEdit.version, 2)
  assert.equal(page.data.fileNameEdit.suffix, '.csv')
  page.inputFileRename(input('整理后新名称'))
  await page.saveFileRename()
  const writes = h.calls.filter(call => call.action === 'imports.renameFile')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].input.importId, 'synthetic-import')
  assert.equal(writes[0].input.version, 2)
  assert.equal(writes[0].input.displayName, '整理后新名称.csv')
  assert.equal(page.data.sources[0].fileName, '整理后新名称.csv')
  assert.equal(page.data.sources[0].originalFileName, '合成账单.csv')
  assert.equal(page.data.sources[1].fileName, '第二份账单.xlsx')
  assert.equal(page.data.fileNameEdit, null)
  assert.equal(page.data.fileRenamePending, false)
  assert.equal(page.data.busy, false)
  assert.equal(page.data.currentStep, 1)
  assert.equal(page._viewSession.summary.viewVersion, h.summary.viewVersion)
  assert.equal(page._draftSession.view.update.version, h.summary.update.version)
  assert.equal(JSON.stringify(page.data.recordSummary), originalCounts)
  assert.equal(page.data.files.length, 0)
  assert.equal(page._sourceFiles.size, 0)
  assert.ok(h.calls.every(call => ['imports.getFile', 'imports.renameFile', 'financeUpdates.summary'].includes(call.action)))
})

test('实际 Page 来源改名同步同一已上传文件，取消只收起当前行', async t => {
  const h = await setupSources(t, [uploaded()]), page = h.page
  const originalUpload = page._sourceFiles.get('one')
  await page.openFileRename(sourceTap('source-0'))
  page.inputFileRename(input('取消的来源名'))
  page.closeFileRename()
  assert.equal(page.data.sources[0].fileName, '合成账单.csv')
  assert.equal(page.data.files[0].name, '合成账单.csv')
  await page.openFileRename(sourceTap('source-0'))
  page.inputFileRename(input('共同显示名'))
  await page.saveFileRename()
  assert.equal(page.data.sources[0].fileName, '共同显示名.csv')
  assert.equal(page.data.files[0].name, '共同显示名.csv')
  assert.equal(page.data.files[0].importVersion, 3)
  assert.equal(page._sourceFiles.get('one'), originalUpload)
  assert.equal(h.calls.filter(call => call.action === 'imports.renameFile').length, 1)
})

test('实际 Page 来源信息迟到保留已输入名称，未读取版本前不能保存', async t => {
  const h = await setupSources(t), page = h.page
  let release
  h.onSourceCall = action => action === 'imports.getFile' ? new Promise(resolve => { release = resolve }) : undefined
  const opening = page.openFileRename(sourceTap('source-0'))
  await flush()
  page.inputFileRename(input('读取期间输入'))
  await page.saveFileRename()
  assert.equal(h.calls.filter(call => call.action === 'imports.renameFile').length, 0)
  release({ import: serverFile({ version: 7, displayName: '其他设备已改.csv' }) })
  await opening
  assert.equal(page.data.fileNameEdit.value, '读取期间输入')
  assert.equal(page.data.fileNameEdit.version, 7)
  assert.equal(page.data.fileNameEdit.loading, false)
  await page.saveFileRename()
  assert.equal(h.calls.find(call => call.action === 'imports.renameFile').input.version, 7)
  assert.equal(page.data.sources[0].fileName, '读取期间输入.csv')
})

test('实际 Page 来源信息读取失败保留输入，确认重试先读版本再保存', async t => {
  const h = await setupSources(t), page = h.page
  let unavailable = true
  h.onSourceCall = action => { if (unavailable && action === 'imports.getFile') throw failure('CLOUD_TEMPORARY_UNAVAILABLE') }
  await page.openFileRename(sourceTap('source-0'))
  assert.ok(page.data.fileNameEdit.error)
  assert.equal(page.data.fileNameEdit.loading, false)
  page.inputFileRename(input('重试后的名字'))
  unavailable = false
  await page.saveFileRename()
  assert.equal(page.data.sources[0].fileName, '重试后的名字.csv')
  assert.equal(page.data.busy, false)
  assert.deepEqual(h.calls.map(call => call.action), ['imports.getFile', 'imports.getFile', 'imports.renameFile', 'financeUpdates.summary'])
})

test('实际 Page 来源改名丢响应后保留原请求，核实成功才刷新来源与版本', async t => {
  const h = await setupSources(t), page = h.page
  let saved
  h.onSourceCall = (action, data) => {
    if (action === 'imports.renameFile') { saved = h.renameSource(data); throw failure('REQUEST_TIMEOUT') }
    if (action === 'imports.commandResult') return saved
  }
  await page.openFileRename(sourceTap('source-0'))
  page.inputFileRename(input('已发送来源名'))
  await page.saveFileRename()
  assert.equal(page.data.fileNameEdit.pending, true)
  assert.equal(page.data.sources[0].fileName, '合成账单.csv')
  page.closeFileRename()
  await page.goToStep({ currentTarget: { dataset: { step: 2 } } })
  assert.equal(page.data.currentStep, 1)
  await page.resumeFileRename()
  assert.equal(page.data.fileNameEdit.sourceId, 'source-0')
  assert.equal(page.data.fileNameEdit.value, '已发送来源名')
  await page.saveFileRename()
  assert.equal(page.data.sources[0].fileName, '已发送来源名.csv')
  assert.equal(page.data.fileRenamePending, false)
  assert.equal(page._viewSession.summary.viewVersion, h.summary.viewVersion)
  assert.equal(h.calls.filter(call => call.action === 'imports.renameFile').length, 1)
  assert.equal(h.calls.find(call => call.action === 'imports.commandResult').input.requestId,
    h.calls.find(call => call.action === 'imports.renameFile').input.requestId)
})

test('实际 Page 在其他步骤恢复来源改名，直接核实且不打开不可见的行编辑器', async t => {
  const h = await setupSources(t), page = h.page
  let saved
  h.onSourceCall = (action, data) => {
    if (action === 'imports.renameFile') { saved = h.renameSource(data); throw failure('REQUEST_TIMEOUT') }
    if (action === 'imports.commandResult') return saved
  }
  await page.openFileRename(sourceTap('source-0'))
  page.inputFileRename(input('重新打开后确认'))
  await page.saveFileRename()
  page.onUnload()
  const reopened = h.createPage({ fresh: '1' }, false)
  t.after(() => reopened.onUnload())
  await reopened.applyUpdateView(h.summary, false, true)
  await reopened.setStep({ currentStep: 2 })
  await reopened.resumeFileRename()
  assert.equal(reopened.data.currentStep, 2)
  assert.equal(reopened.data.fileNameEdit, null)
  assert.equal(reopened.data.fileRenamePending, false)
  assert.equal(reopened.data.sources[0].fileName, '重新打开后确认.csv')
  assert.equal(h.calls.filter(call => call.action === 'imports.renameFile').length, 1)
})

test('实际 Page 来源名称已保存但摘要失败，只补读且不重写，刷新完成前不继续或放弃', async t => {
  const h = await setupSources(t), page = h.page
  let unavailable = true
  h.onSourceCall = action => { if (unavailable && action === 'financeUpdates.summary') throw failure('CLOUD_TEMPORARY_UNAVAILABLE') }
  await page.openFileRename(sourceTap('source-0'))
  page.inputFileRename(input('名称已保存'))
  await page.saveFileRename()
  assert.equal(page.data.sources[0].fileName, '名称已保存.csv')
  assert.equal(page.data.fileNameEdit, null)
  assert.equal(page.data.busy, false)
  assert.equal(page.data.fileRenamePending, true)
  assert.match(page.data.errorMessage, /名称已保存/)
  await page.goToStep({ currentTarget: { dataset: { step: 2 } } })
  page.abandonUpdate()
  await page.performAbandonUpdate()
  assert.equal(page.data.currentStep, 1)
  assert.equal(h.modal, undefined)
  unavailable = false
  await page.resumeFileRename()
  assert.equal(page.data.fileRenamePending, false)
  assert.equal(page._viewSession.summary.viewVersion, h.summary.viewVersion)
  assert.equal(h.calls.filter(call => call.action === 'imports.renameFile').length, 1)
  assert.equal(h.calls.some(call => call.action === 'financeUpdates.abandon'), false)
})

test('实际 Page 来源未保存输入保留，背景摘要在取消后应用', async t => {
  const h = await setupSources(t), page = h.page
  await page.openFileRename(sourceTap('source-0'))
  page.inputFileRename(input('我的未保存输入'))
  const fresh = { ...h.summary, viewVersion: 'background-source-view', update: { ...h.summary.update, version: 3 },
    sources: h.summary.sources.map(source => ({ ...source, fileName: '背景修改.csv' })) }
  page.applyUpdateView(fresh, true)
  await page.goToStep({ currentTarget: { dataset: { step: 2 } } })
  page.abandonUpdate()
  assert.equal(page.data.currentStep, 1)
  assert.equal(page.data.fileNameEdit.value, '我的未保存输入')
  assert.equal(page.data.sources[0].fileName, '合成账单.csv')
  assert.equal(h.modal, undefined)
  page.closeFileRename()
  assert.equal(page.data.sources[0].fileName, '背景修改.csv')
  assert.equal(page._viewSession.summary.viewVersion, fresh.viewVersion)
  assert.equal(h.calls.some(call => call.action === 'imports.renameFile'), false)
})

test('实际 Page 来源改名隐藏后成功，返回核实更新来源且不重复改名', async t => {
  const h = await setupSources(t), page = h.page
  let release, saved
  h.onSourceCall = (action, data) => {
    if (action === 'imports.renameFile') {
      saved = h.renameSource(data)
      return new Promise(resolve => { release = resolve })
    }
    if (action === 'financeUpdates.organize') return h.summary
  }
  await page.openFileRename(sourceTap('source-0'))
  page.inputFileRename(input('来源后台完成'))
  const saving = page.saveFileRename()
  await flush()
  page.onHide()
  release(saved)
  await saving
  assert.equal(page.data.sources[0].fileName, '合成账单.csv')
  assert.equal(page.data.fileNameEdit, null)
  await page.onShow()
  assert.equal(page.data.fileRenamePending, true)
  await page.resumeFileRename()
  assert.equal(page.data.sources[0].fileName, '来源后台完成.csv')
  assert.equal(page.data.fileRenamePending, false)
  assert.equal(page.data.busy, false)
  assert.equal(h.calls.filter(call => call.action === 'imports.renameFile').length, 1)
})

test('实际 Page 来源信息读取中隐藏再返回，恢复原输入并重新核验版本', async t => {
  const h = await setupSources(t), page = h.page
  let release, first = true
  h.onSourceCall = action => {
    if (action === 'imports.getFile' && first) { first = false; return new Promise(resolve => { release = resolve }) }
    if (action === 'financeUpdates.organize') return h.summary
  }
  const opening = page.openFileRename(sourceTap('source-0'))
  await flush()
  page.inputFileRename(input('返回继续编辑'))
  page.onHide()
  release({ import: serverFile({ version: 99 }) })
  await opening
  await page.onShow()
  await flush()
  assert.equal(page.data.fileNameEdit.value, '返回继续编辑')
  assert.equal(page.data.fileNameEdit.loading, false)
  assert.equal(page.data.fileNameEdit.version, 2)
  await page.saveFileRename()
  assert.equal(page.data.sources[0].fileName, '返回继续编辑.csv')
  assert.equal(h.calls.find(call => call.action === 'imports.renameFile').input.version, 2)
})

for (const leaving of ['close', 'switch', 'owner', 'update']) {
  test('实际 Page 来源读取迟到不能覆盖新入口：' + leaving, async t => {
    const h = await setupSources(t), page = h.page
    let release
    h.onSourceCall = (action, data) => action === 'imports.getFile' && data.importId === 'synthetic-import'
      ? new Promise(resolve => { release = resolve }) : undefined
    const opening = page.openFileRename(sourceTap('source-0'))
    await flush()
    if (['close', 'switch'].includes(leaving)) page.closeFileRename()
    if (leaving === 'switch') await page.openFileRename(sourceTap('source-1'))
    if (leaving === 'owner') { h.app.globalData.uid = '0987654321'; h.cache.reset(); await page.onShow() }
    if (leaving === 'update') {
      await page.applyUpdateView({ ...h.summary, update: { ...h.summary.update, updateId: 'other-update', status: 'abandoned' } }, false, true)
    }
    release({ import: serverFile({ displayName: '不能串页.csv', version: 9 }) })
    await opening
    if (leaving === 'switch') {
      assert.equal(page.data.fileNameEdit.sourceId, 'source-1')
      assert.equal(page.data.fileNameEdit.value, '第二份账单')
    } else assert.equal(page.data.fileNameEdit, null)
    assert.ok(page.data.sources.every(source => source.fileName !== '不能串页.csv'))
    assert.equal(h.calls.some(call => call.action === 'imports.renameFile'), false)
  })
}

test('实际 Page 改名取消不改文件，未上传别名只改显示并沿原始名准备上传', async t => {
  const h = setup(t), page = h.page, source = page._sourceFiles.get('one')
  page.openFileRename(tap('one'))
  assert.equal(page.data.fileNameEdit.suffix, '.csv')
  assert.equal(page.data.fileNameEdit.value, '合成账单')
  page.inputFileRename(input('取消的名称'))
  page.closeFileRename()
  assert.equal(page.data.files[0].name, '合成账单.csv')
  assert.equal(h.calls.length, 0)
  page.openFileRename(tap('one'))
  page.inputFileRename(input('　工资Ａ　'))
  await page.saveFileRename()
  assert.equal(page.data.files[0].name, '工资A.csv')
  assert.equal(page.data.files[0].originalName, '合成账单.csv')
  assert.equal(page.data.files[0].displayName, '工资A.csv')
  assert.equal(page._sourceFiles.get('one'), source)
  assert.equal(source.name, '合成账单.csv')
  assert.equal(h.calls.length, 0)
  h.intercept = (action, data) => {
    if (action === 'imports.prepareMany') return { files: [serverFile({ version: 1, displayName: data.files[0].displayName, cloudPath: 'synthetic/path' })] }
    if (action === 'imports.parseFile') return { import: serverFile({ displayName: '工资A.csv' }), batch: { batchId: 'synthetic-batch' } }
  }
  page.uploadObject = async () => ({ fileID: 'synthetic-cloud-file' })
  await page.startUpload()
  assert.deepEqual(h.calls.find(call => call.action === 'imports.prepareMany').input.files,
    [{ fileName: '合成账单.csv', size: 20, displayName: '工资A.csv' }])
  assert.equal(page.data.files[0].name, '工资A.csv')
  assert.equal(page.data.files[0].state, 'ready')
  assert.equal(page._sourceFiles.get('one'), source)
})

test('实际 Page 名称验证不发请求，原名可恢复且后缀固定', async t => {
  const h = setup(t, [selected('one', { name: '现有别名.XLSX', originalName: '合成账单.XLSX', displayName: '现有别名.XLSX' })]), page = h.page
  page.openFileRename(tap('one'))
  for (const value of ['', ' ... ', '路径/账单', '路径\\账单', '控制\u0001字符', '\n首尾控制符\t', '字'.repeat(251)]) {
    page.inputFileRename(input(value))
    await page.saveFileRename()
    assert.ok(page.data.fileNameEdit.error)
    assert.equal(page.data.files[0].name, '现有别名.XLSX')
  }
  assert.equal(page.data.fileNameEdit.suffix, '.XLSX')
  page.inputFileRename(input('合成账单'))
  await page.saveFileRename()
  assert.equal(page.data.files[0].name, '合成账单.XLSX')
  assert.equal(page.data.files[0].displayName, '')
  assert.equal(h.calls.length, 0)
})

test('实际 Page 已解析文件用专用回执更新名称与版本，不触发账目整理', async t => {
  const h = setup(t, [uploaded()]), page = h.page, source = page._sourceFiles.get('one')
  h.intercept = (action, data) => {
    if (action === 'imports.renameFile') return receipt(serverFile({ version: 3, displayName: data.displayName }))
  }
  page.openFileRename(tap('one'))
  page.inputFileRename(input('工资账单'))
  await page.saveFileRename()
  const command = h.calls.find(call => call.action === 'imports.renameFile')
  assert.equal(command.input.version, 2)
  assert.equal(command.input.displayName, '工资账单.csv')
  assert.ok(command.input.requestId)
  assert.equal(page.data.files[0].name, '工资账单.csv')
  assert.equal(page.data.files[0].originalName, '合成账单.csv')
  assert.equal(page.data.files[0].importVersion, 3)
  assert.equal(page._sourceFiles.get('one'), source)
  assert.equal(page.data.fileNameEdit, null)
  assert.equal(page.data.busy, false)
  assert.equal(page.data.fileRenamePending, false)
  assert.equal(h.calls.length, 1)
})

test('实际 Page 明确失败保留输入，修改后可用新请求重试', async t => {
  const h = setup(t, [uploaded()]), page = h.page
  let first = true
  h.intercept = (action, data) => {
    if (action === 'imports.renameFile') {
      if (first) { first = false; throw failure('VALIDATION_ERROR') }
      return receipt(serverFile({ version: 3, displayName: data.displayName }))
    }
  }
  page.openFileRename(tap('one'))
  page.inputFileRename(input('第一次名称'))
  await page.saveFileRename()
  assert.equal(page.data.fileNameEdit.value, '第一次名称')
  assert.equal(page.data.fileNameEdit.pending, false)
  assert.equal(page.data.busy, false)
  assert.ok(page.data.fileNameEdit.error)
  page.inputFileRename(input('重新命名'))
  await page.saveFileRename()
  const commands = h.calls.filter(call => call.action === 'imports.renameFile')
  assert.equal(commands.length, 2)
  assert.notEqual(commands[0].input.requestId, commands[1].input.requestId)
  assert.equal(page.data.files[0].name, '重新命名.csv')
})

test('实际 Page 版本冲突刷新当前名称和版本但保留输入，用户再次保存才覆盖', async t => {
  const h = setup(t, [uploaded()]), page = h.page
  let first = true
  h.intercept = (action, data) => {
    if (action === 'imports.renameFile') {
      if (first) { first = false; throw failure('CONFLICT') }
      return receipt(serverFile({ version: 5, displayName: data.displayName }))
    }
    if (action === 'imports.getFile') return { import: serverFile({ version: 4, displayName: '其他设备的名称.csv' }) }
  }
  page.openFileRename(tap('one'))
  page.inputFileRename(input('我的新名称'))
  await page.saveFileRename()
  assert.equal(page.data.fileNameEdit.value, '我的新名称')
  assert.equal(page.data.fileNameEdit.version, 4)
  assert.match(page.data.fileNameEdit.error, /再次保存/)
  assert.equal(page.data.files[0].name, '其他设备的名称.csv')
  assert.equal(h.calls.filter(call => call.action === 'imports.renameFile').length, 1)
  assert.deepEqual(h.calls.find(call => call.action === 'imports.getFile').input,
    { importId: 'synthetic-import', includeOptions: false, pageSize: 1 })
  await page.saveFileRename()
  assert.equal(h.calls.filter(call => call.action === 'imports.renameFile')[1].input.version, 4)
  assert.equal(page.data.files[0].name, '我的新名称.csv')
})

test('实际 Page 旧服务明确不支持改名时释放原请求，保留输入并允许取消继续整理', async t => {
  const h = setup(t, [uploaded()]), page = h.page
  h.intercept = action => {
    if (action === 'imports.renameFile') throw failure('UNSUPPORTED_ACTION')
    if (action === 'imports.discardFile') return { importId: 'synthetic-import', state: 'discarded', version: 3 }
  }
  page.openFileRename(tap('one'))
  page.inputFileRename(input('等待服务升级'))
  await page.saveFileRename()
  assert.equal(page.data.fileNameEdit.value, '等待服务升级')
  assert.equal(page.data.fileNameEdit.pending, false)
  assert.equal(page.data.fileRenamePending, false)
  assert.equal(page.data.busy, false)
  page.closeFileRename()
  assert.equal(page.data.files[0].name, '合成账单.csv')
  await page.removeFile(tap('one'))
  assert.equal(page.data.files.length, 0)
  assert.equal(h.calls.filter(call => call.action === 'imports.commandResult').length, 0)
})

test('实际 Page 响应丢失冻结原输入并阻止后续处理，关闭重开后核实原回执', async t => {
  const h = setup(t, [uploaded(), selected('two')]), page = h.page
  let saved
  h.intercept = (action, data) => {
    if (action === 'imports.renameFile') { saved = receipt(serverFile({ version: 3, displayName: data.displayName })); throw failure('REQUEST_TIMEOUT') }
    if (action === 'imports.commandResult') return saved
  }
  page.openFileRename(tap('one'))
  page.inputFileRename(input('已发送名称'))
  await page.saveFileRename()
  assert.equal(page.data.fileNameEdit.pending, true)
  assert.equal(page.data.fileRenamePending, true)
  page.inputFileRename(input('不能覆盖原请求'))
  assert.equal(page.data.fileNameEdit.value, '已发送名称')
  page.closeFileRename()
  page.openFileRename(tap('two'))
  assert.equal(page.data.fileNameEdit, null)
  await page.removeFile(tap('one'))
  await page.startUpload()
  await page.createFinanceUpdate()
  assert.equal(h.calls.length, 1)
  assert.equal(page.data.files.length, 2)
  await page.resumeFileRename()
  assert.equal(page.data.fileNameEdit.value, '已发送名称')
  await page.saveFileRename()
  assert.equal(page.data.files[0].name, '已发送名称.csv')
  assert.equal(page.data.fileRenamePending, false)
  assert.equal(h.calls.filter(call => call.action === 'imports.renameFile').length, 1)
  assert.equal(h.calls.find(call => call.action === 'imports.commandResult').input.requestId, h.calls[0].input.requestId)
})

test('实际 Page 查无回执只重发冻结的同一个改名请求', async t => {
  const h = setup(t, [uploaded()]), page = h.page
  let first = true
  h.intercept = (action, data) => {
    if (action === 'imports.renameFile') {
      if (first) { first = false; throw failure('REQUEST_TIMEOUT') }
      return receipt(serverFile({ version: 3, displayName: data.displayName }))
    }
    if (action === 'imports.commandResult') throw failure('OPERATION_UNCONFIRMED')
  }
  page.openFileRename(tap('one'))
  page.inputFileRename(input('冻结名称'))
  await page.saveFileRename()
  page.inputFileRename(input('被忽略的新名称'))
  await page.saveFileRename()
  const commands = h.calls.filter(call => call.action === 'imports.renameFile')
  assert.equal(commands.length, 2)
  assert.deepEqual(commands[0].input, commands[1].input)
  assert.equal(page.data.files[0].name, '冻结名称.csv')
})

test('实际 Page 隐藏后迟到的成功不覆盖页面，返回后可读回已保存名称', async t => {
  const h = setup(t, [uploaded(), selected('two')]), page = h.page
  let resolveRename
  const saved = receipt(serverFile({ version: 3, displayName: '后台完成.csv' }))
  h.intercept = (action) => {
    if (action === 'imports.renameFile') return new Promise(resolve => { resolveRename = resolve })
    if (action === 'imports.getFile') return { import: saved.import }
  }
  page.openFileRename(tap('one'))
  page.inputFileRename(input('后台完成'))
  const saving = page.saveFileRename()
  await flush()
  page.openFileRename(tap('two'))
  assert.equal(page.data.fileNameEdit.clientId, 'one')
  page.onHide()
  resolveRename(saved)
  await saving
  assert.equal(page.data.fileNameEdit, null)
  assert.equal(page.data.files[0].name, '合成账单.csv')
  await page.onShow()
  assert.equal(page.data.fileRenamePending, true)
  await page.resumeFileRename()
  assert.equal(page.data.files[0].name, '后台完成.csv')
  assert.equal(page.data.fileRenamePending, false)
  assert.equal(page.data.busy, false)
})

test('实际 Page 退出后未知请求可在新页面恢复，未上传文件不需伪造恢复', async t => {
  const h = setup(t, [uploaded()]), page = h.page
  const saved = receipt(serverFile({ version: 3, displayName: '重新打开.csv' }))
  h.intercept = action => {
    if (action === 'imports.renameFile') throw failure('REQUEST_TIMEOUT')
    if (action === 'imports.getFile') return { import: saved.import }
    if (action === 'imports.commandResult') return saved
  }
  page.openFileRename(tap('one'))
  page.inputFileRename(input('重新打开'))
  await page.saveFileRename()
  page.onUnload()
  const reopened = h.createPage({ fresh: '1' }, false)
  t.after(() => reopened.onUnload())
  assert.equal(reopened.data.fileRenamePending, true)
  assert.equal(reopened.data.files.length, 0)
  await reopened.resumeFileRename()
  assert.equal(reopened.data.fileRenamePending, false)
  assert.equal(reopened.data.fileNameEdit, null)
  assert.equal(reopened.data.busy, false)
  assert.equal(reopened.data.files.length, 0)
  assert.equal(h.calls.filter(call => call.action === 'imports.renameFile').length, 1)
})

test('实际 Page 无文件行的恢复入口仍只重发冻结请求，不新增输入弹层或文件', async t => {
  const h = setup(t, [uploaded()]), page = h.page
  let first = true
  h.intercept = (action, data) => {
    if (action === 'imports.renameFile') {
      if (first) { first = false; throw failure('REQUEST_TIMEOUT') }
      return receipt(serverFile({ version: 3, displayName: data.displayName }))
    }
    if (action === 'imports.commandResult') throw failure('OPERATION_UNCONFIRMED')
  }
  page.openFileRename(tap('one'))
  page.inputFileRename(input('冻结的原位改名'))
  await page.saveFileRename()
  page.onUnload()
  const reopened = h.createPage({ fresh: '1' }, false)
  t.after(() => reopened.onUnload())
  await reopened.resumeFileRename()
  const commands = h.calls.filter(call => call.action === 'imports.renameFile')
  assert.equal(commands.length, 2)
  assert.deepEqual(commands[0].input, commands[1].input)
  assert.equal(reopened.data.fileNameEdit, null)
  assert.equal(reopened.data.fileRenamePending, false)
  assert.equal(reopened.data.files.length, 0)
})

test('实际 Page 原位编辑重复点本行或切换其他行不重置输入，取消后才能切行', async t => {
  const h = setup(t, [selected('one'), selected('two', { name: '第二份账单.csv', originalName: '第二份账单.csv' })]), page = h.page
  page.openFileRename(tap('one'))
  page.inputFileRename(input('未保存的名称'))
  page.openFileRename(tap('one'))
  assert.equal(page.data.fileNameEdit.value, '未保存的名称')
  page.openFileRename(tap('two'))
  assert.equal(page.data.fileNameEdit.clientId, 'one')
  assert.equal(page.data.fileNameEdit.value, '未保存的名称')
  assert.match(page.data.fileNameEdit.error, /先保存或取消/)
  assert.equal(page.data.files[0].name, '合成账单.csv')
  page.closeFileRename()
  page.openFileRename(tap('two'))
  assert.equal(page.data.fileNameEdit.clientId, 'two')
  assert.equal(page.data.fileNameEdit.value, '第二份账单')
  page.inputFileRename(input('第二份已修改'))
  await page.saveFileRename()
  assert.equal(page.data.files[0].name, '合成账单.csv')
  assert.equal(page.data.files[1].name, '第二份已修改.csv')
  assert.equal(page.data.fileNameEdit, null)
  assert.equal(h.calls.length, 0)
})

test('实际 Page 原位输入未保存时拦截解析整理、银行映射、移除和选择文件', async t => {
  const h = setup(t, [selected('one'), uploaded('two'), selected('three', { state: 'mapping', hasBankMapping: true })]), page = h.page
  let picks = 0
  h.wx.chooseMessageFile = () => { picks++ }
  page.openFileRename(tap('two'))
  page.inputFileRename(input('不能丢失的输入'))
  for (const action of [() => page.chooseFiles(), () => page.startUpload(), () => page.createFinanceUpdate(),
    () => page.openBankMapping(tap('three')), () => page.tapFileRow(tap('three')),
    () => page.retryFile(tap('three')), () => page.removeFile(tap('two')), () => page.startAnother()]) {
    await action()
    assert.equal(page.data.fileNameEdit.value, '不能丢失的输入')
    assert.match(page.data.fileNameEdit.error, /先保存或取消/)
  }
  page.setData({ unlockedStep: 2 })
  await page.goToStep({ currentTarget: { dataset: { step: 2 } } })
  assert.equal(page.data.currentStep, 1)
  assert.equal(page.data.bankMappingSheet, null)
  assert.equal(page.data.fileAttentionSheet, null)
  assert.equal(page.data.files.length, 3)
  assert.equal(h.calls.length, 0)
  assert.equal(picks, 0)
  page.closeFileRename()
  page.chooseFiles()
  assert.equal(picks, 1)
})

test('实际 Page 原位未保存输入在隐藏返回后仍可继续，后台事件不改旧输入', async t => {
  const h = setup(t), page = h.page
  page.openFileRename(tap('one'))
  page.inputFileRename(input('稍后继续修改'))
  page.onHide()
  page.inputFileRename(input('后台事件'))
  assert.equal(page.data.fileNameEdit.value, '稍后继续修改')
  await page.onShow()
  assert.equal(page.data.fileNameEdit.value, '稍后继续修改')
  await page.saveFileRename()
  assert.equal(page.data.files[0].name, '稍后继续修改.csv')
  assert.equal(page.data.fileNameEdit, null)
})

test('实际 Page 核实期间更换身份，旧用户的改名请求不重发也不覆盖新页面', async t => {
  const h = setup(t, [uploaded()]), page = h.page
  let rejectVerification
  h.intercept = action => {
    if (action === 'imports.renameFile') throw failure('REQUEST_TIMEOUT')
    if (action === 'imports.commandResult') return new Promise((_resolve, reject) => { rejectVerification = reject })
  }
  page.openFileRename(tap('one'))
  page.inputFileRename(input('属于原账本'))
  await page.saveFileRename()
  const recovery = page.saveFileRename()
  await flush()
  h.app.globalData.uid = '0987654321'
  h.cache.reset()
  await page.onShow()
  rejectVerification(failure('OPERATION_UNCONFIRMED'))
  await recovery
  assert.equal(page.data.files.length, 0)
  assert.equal(page.data.fileNameEdit, null)
  assert.equal(page.data.fileRenamePending, false)
  assert.equal(page.data.busy, false)
  assert.equal(h.calls.filter(call => call.action === 'imports.renameFile').length, 1)
  h.app.globalData.uid = '1234567890'
  h.cache.reset()
  await page.onShow()
  assert.equal(page.data.fileRenamePending, true)
})

test('实际 Page 忙碌、解析中或未授权页面不可改名', async t => {
  const h = setup(t), page = h.page
  page.setData({ busy: true })
  page.openFileRename(tap('one'))
  assert.equal(page.data.fileNameEdit, null)
  page.setData({ busy: false, files: [selected('one', { state: 'parsing' })] })
  page.openFileRename(tap('one'))
  assert.equal(page.data.fileNameEdit, null)
  page.setData({ files: [selected('one')] })
  h.app.approved = false
  page.openFileRename(tap('one'))
  assert.equal(page.data.fileNameEdit, null)
  assert.equal(h.calls.length, 0)
})

test('实际 Page 冷启动登录回调绑定首次身份后可以改名，无需退出页面重进', async t => {
  const h = runtime(undefined, { approved: false, initialView: false, pageOptions: { fresh: '1' } }), page = h.page
  t.after(() => page.onUnload())
  page.onShow()
  await flush()
  h.app.approved = true
  h.cache.reset()
  await h.loginOptions.afterLogin()
  page.setData({ files: [selected('one')], phase: 'selected' })
  page.openFileRename(tap('one'))
  assert.equal(page.data.fileNameEdit.clientId, 'one')
  page.inputFileRename(input('登录后的名称'))
  await page.saveFileRename()
  assert.equal(page.data.files[0].name, '登录后的名称.csv')
  assert.equal(h.calls.length, 0)
})

test('实际 Page 内容去重复用既有导入时，同步其原始名、别名与版本', async t => {
  const h = setup(t, [selected('one', { name: '本地别名.csv', displayName: '本地别名.csv', importId: 'new-import', importVersion: 1 })]), page = h.page
  h.intercept = action => {
    if (action === 'imports.parseFile') return { import: serverFile({ importId: 'existing-import', fileName: '既有原始名.csv',
      displayName: '既有别名.csv', version: 9 }), batch: { batchId: 'existing-batch' } }
  }
  await page.parsePreparedFile('one', 'synthetic-file')
  assert.equal(page.data.files[0].importId, 'existing-import')
  assert.equal(page.data.files[0].importVersion, 9)
  assert.equal(page.data.files[0].originalName, '既有原始名.csv')
  assert.equal(page.data.files[0].displayName, '既有别名.csv')
  assert.equal(page.data.files[0].name, '既有别名.csv')
  h.intercept = action => {
    if (action === 'imports.parseFile') return { import: serverFile({ importId: 'existing-import', fileName: '既有原始名.csv', version: 10 }),
      duplicateImportId: 'posted-import' }
  }
  await page.parsePreparedFile('one', 'synthetic-file')
  assert.equal(page.data.files[0].state, 'duplicate')
  assert.equal(page.data.files[0].displayName, '')
  assert.equal(page.data.files[0].name, '既有原始名.csv')
})
