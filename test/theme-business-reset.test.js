const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { runtime: readRuntime } = require('./helpers/read-runtime')
const { runtime: workbenchRuntime, fixture } = require('./helpers/paged-workbench')

function recordThemes(page, presentation) {
  const keys = Object.keys(presentation), frames = [], setData = page.setData
  page.setData = function (patch, callback) {
    const result = setData.call(this, patch, callback)
    frames.push(Object.fromEntries(keys.map(key => [key, this.data[key]])))
    return result
  }
  return () => {
    assert.ok(frames.length, '场景必须实际发生业务重置')
    for (const frame of frames) assert.deepEqual(frame, { ...presentation }, '业务重置不能临时写回旧主题或清空外壳')
  }
}

test('工作台退出登录和切换用户只重置业务初值，主题始终保留最新选择', async t => {
  for (const mode of ['logout', 'new-owner']) await t.test(mode, async () => {
    const h = workbenchRuntime(fixture(0), { realTheme: true, initialView: false, pageOptions: { fresh: '1' } })
    const page = h.page, theme = h.load(path.resolve(__dirname, '../miniprogram/theme/service.js'))
    theme.selectTheme('ticket-proof')
    const presentation = theme.currentPresentation()
    page.setData({ files: [{ id: 'synthetic-old-file' }], currentStep: 3, errorMessage: '旧业务错误' })
    const verifyFrames = recordThemes(page, presentation)
    if (mode === 'logout') h.app.approved = false
    else h.app.globalData.uid = '2345678901'
    h.cache.reset()
    await page.onShow()
    assert.equal(page.data.files.length, 0)
    assert.equal(page.data.currentStep, 1)
    assert.equal(page.data.errorMessage, '')
    verifyFrames()
    page.onUnload()
  })
})

const loanPages = [
  ['loans', 'loadLoans', {}],
  ['loan-link', 'load', {}],
  ['loan-form', 'load', {}],
  ['loan-plan', 'load', { loanId: 'synthetic-loan' }],
  ['loan-payment', 'load', {}],
  ['repayment-entry', 'load', {}],
  ['installment-sources', 'load', {}],
  ['loan-detail', 'load', { loanId: 'synthetic-loan' }],
  ['loan-detail', 'load', { chargeId: 'synthetic-retained-charge' }, 'loan-detail retained charge']
]

test('贷款页面跨读会话重置只使用业务字段，失败重试不会覆盖后来选择的主题', async t => {
  for (const [name, load, query, label] of loanPages) await t.test(label || name, async () => {
    const h = readRuntime(undefined, { realTheme: true })
    const theme = h.load('theme/service')
    theme.selectTheme('red-editorial')
    // 网络失败使读取停在可重试状态；本测试关注真实 Page 与会话重置，不伪造财务响应。
    h.respond = async () => { throw new Error('synthetic offline') }
    const page = h.page(name)
    page.onLoad(query)
    await page[load]()
    assert.ok(page._readInitial, '应通过真实页面读取入口建立初始业务快照')
    assert.ok(Object.hasOwn(page._readInitial, 'errorMessage'))
    assert.equal(Object.keys(page._readInitial).some(key => key.startsWith('theme')), false,
      '业务快照不得拥有主题字段')
    const rowsField = ['accounts', 'items', 'assets'].find(key => Array.isArray(page._readInitial[key]))
    assert.ok(rowsField, '应有可观察的业务列表字段')
    page.setData({ [rowsField]: [{ id: 'synthetic-old-owner-row' }] })
    theme.selectTheme('ticket-proof')
    const presentation = theme.currentPresentation(), verifyFrames = recordThemes(page, presentation)
    h.cache.reset()
    await page[load]()
    assert.equal(page.data[rowsField].length, 0, '换会话后读取失败也必须清除旧业务列表')
    verifyFrames()
    assert.equal(page.data.themeId, 'ticket-proof')
    page.onUnload()
  })
})
