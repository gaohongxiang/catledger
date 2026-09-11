const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
const markup = read('miniprogram/pages/import-workbench/index.wxml')
const style = read('miniprogram/pages/import-workbench/index.wxss')
function attrs(id) {
  const tags = markup.match(/<\w[\w-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/g) || []
  const tag = tags.find(t => t.includes('data-ui="' + id + '"'))
  assert.ok(tag, '缺少可验收的控件：' + id)
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]))
}
function evaluate(id, key, data) {
  const value = attrs(id)[key]
  assert.ok(value && value.startsWith('{{'), id + ':' + key)
  return Boolean(vm.runInNewContext(value.slice(2, -2), data, { timeout: 200 }))
}
const state = (phase, queued, ready, failed = 0, busy = false) => ({ phase, busy, restoreUpdateId: '', maxFiles: 5,
  files: Array(queued + ready + failed).fill({}), uploadSummary: { queued, ready, failed, attention: failed } })

test('空文件只显示选择入口；不摆出不可用的开始解析', () => {
  const s = state('idle', 0, 0)
  assert.equal(evaluate('empty-picker', 'wx:if', s), true)
  assert.equal(evaluate('parse-action', 'wx:if', s), false)
})
test('队列有文件才开始解析；正在解析仍显示原位进度且禁用', () => {
  assert.equal(evaluate('parse-action', 'wx:if', state('selected', 2, 0)), true)
  const active = state('uploading', 0, 1, 0, true)
  assert.equal(evaluate('parse-action', 'wx:if', active), true)
  assert.equal(evaluate('parse-action', 'disabled', active), true)
})
test('解析完成不再显示旧解析按钮，同时保留下一步', () => {
  const done = state('files_ready', 0, 2)
  assert.equal(evaluate('parse-action', 'wx:if', done), false)
  assert.equal(evaluate('next-accounts', 'disabled', done), false)
  assert.doesNotMatch(markup, /添加后可开始/)
})
test('部分失败允许已成功文件继续；全部失败或重复不允许继续', () => {
  assert.equal(evaluate('next-accounts', 'disabled', state('files_ready', 0, 1, 1)), false)
  assert.equal(evaluate('next-accounts', 'disabled', state('files_ready', 0, 0, 2)), true)
  assert.equal(evaluate('next-accounts', 'disabled', state('files_ready', 0, 0)), true)
  assert.match(markup, /bindtap="retryFile"/)
})
test('准备账户期间不能重复提交，继续添加不伪装成已解析', () => {
  assert.equal(evaluate('next-accounts', 'disabled', state('organizing', 0, 2, 0, true)), true)
  assert.equal(evaluate('parse-action', 'wx:if', state('selected', 1, 2)), true)
})
test('账户进度使用 confirmed，而不是把 ready 或建议冒充确认', () => {
  assert.match(markup, /已确认 {{accountStepSummary.confirmed}}/)
  assert.match(markup, /建议 · 待确认/)
  assert.match(markup, /account-decision-create/)
  for (const handler of ['openAccountChoice', 'bindAccountDraftName', 'changeAccountDraftType', 'completeAccountMapping', 'openAccountRecords']) {
    assert.ok(markup.includes('="' + handler + '"'), handler)
  }
})
test('分类与核对维度独立，整理、确认和完成页均常驻两条公式', () => {
  assert.equal((markup.match(/class="record-count-equation"/g) || []).length, 6)
  assert.doesNotMatch(markup, /<record-summary /)
  const formulas = markup.slice(markup.indexOf('class="review-count-formulas"'), markup.indexOf('class="review-main-tabs"'))
  assert.equal((formulas.match(/class="record-count-equation"/g) || []).length, 2)
  assert.ok(!formulas.includes('wx:if'))
  assert.match(markup, /activeReviewTab === 'category'/)
  assert.match(markup, /categoryStatusTabs\[0\]\.count/)
  assert.match(markup, /recordSummary.excludedCount/)
  assert.match(markup, /recordSummary.duplicateCount/)
})
test('付款总额保持模型金额；全部分配按钮不改成含义不同的剩余金额', () => {
  assert.match(markup, /class="payment-total-amount money-number">{{issueEvents\[0\].amountText}}/)
  assert.match(markup, /bindtap="fillPaymentAmount"[^>]*>全部分配/)
  assert.match(markup, /bindinput="changePaymentRow"/)
  assert.match(markup, /maxlength="300"/)
})
test('正式提交及全部分配/聚合校验条件保持完整', () => {
  assert.ok(markup.includes('disabled="{{busy || openIssueCount || accountStepSummary.pending > 0 || !coverage.selectedEventsReadyToPost}}"'))
  assert.ok(markup.includes('(currentIssue.paymentNeedsReview && !paymentCanSave)'))
  assert.ok(markup.includes('(currentIssue.aggregateRepayment && !repaymentAllocationCanSave)'))
  assert.match(markup, /bindtap="resolveWithFields"/)
  assert.match(markup, /bindtap="confirmDistinct"/)
  assert.match(markup, /bindtap="linkRefund"/)
  assert.match(markup, /template is="record-source-fields"/)
})
test('暖橘局部令牌不改其他主题；标题正常字距与常规正文', () => {
  assert.match(style, /\.import-page\.theme-warm-ledger/)
  assert.match(style, /--ui-surface-muted:\s*#f1eee9/i)
  assert.match(style, /\.import-page \.serif-title[^}]*letter-spacing:\s*0/)
  assert.doesNotMatch(style, /@font-face|https?:\/\//)
})


test('恢复失败但仍可放弃时不同时显示新的选择文件入口', () => {
  const s = state('error', 0, 0); s.restoreUpdateId = 'synthetic-batch'
  assert.equal(evaluate('empty-picker', 'wx:if', s), false)
})
