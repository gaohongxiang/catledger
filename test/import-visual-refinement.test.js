const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const model = require('../miniprogram/pages/import-workbench/model')
const root = path.join(__dirname, '..')
const markup = fs.readFileSync(path.join(root, 'miniprogram/pages/import-workbench/index.wxml'), 'utf8')
const styles = fs.readFileSync(path.join(root, 'miniprogram/pages/import-workbench/index.wxss'), 'utf8')
const script = fs.readFileSync(path.join(root, 'miniprogram/pages/import-workbench/index.js'), 'utf8')

function page() {
  let definition
  const calls = []
  vm.runInNewContext(script, {
    require: name => name === './model' ? model : { callImport: (...args) => { calls.push(args); throw new Error('展示操作不得调用接口') } },
    Page: value => { definition = value }
  })
  return { calls, instance: Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch) }
  }) }
}

function conditionForClass(name) {
  const tags = [...markup.matchAll(/<(?:view|block|button)\b(?:"[^"]*"|'[^']*'|[^'">])*>/g)].map(match => match[0])
  const tag = tags.find(value => new RegExp('class="' + name + '"').test(value))
  assert.ok(tag, name)
  const expression = tag.match(/wx:if="\{\{([\s\S]*?)\}\}"/)
  assert.ok(expression, name + ' 必须有明确显示条件')
  // 只执行仓库内受信 WXML 表达式，测试不读取真实账单。
  return data => Boolean(vm.runInNewContext(expression[1], data))
}

function setPayment(instance, patch = {}) {
  Object.assign(instance.data, {
    currentIssue: { paymentNeedsReview: true, paymentAccountsOnly: false },
    paymentRows: [
      { componentIndex: 0, accountId: 'asset-a', label: '合成账户甲', amountInput: '6.00' },
      { componentIndex: 1, accountId: 'asset-b', label: '合成账户乙', amountInput: '4.00' }
    ],
    paymentNatureIndex: 1,
    paymentTargetChoices: [{ accountId: '', name: '请选择' }, { accountId: 'debt', name: '合成负债' }],
    paymentTargetIndex: 0,
    paymentEvidenceNote: '合成支付详情核对',
    issueEvents: [{ amountMinor: '1000' }]
  }, patch)
}

test('空文件只显示选择入口；加载恢复时不出现空态选择区', () => {
  const visible = conditionForClass('file-empty-state')
  for (const phase of ['idle', 'selected', 'files_ready']) assert.equal(visible({ files: [], phase }), true)
  for (const phase of ['loading', 'uploading', 'organizing']) assert.equal(visible({ files: [], phase }), false)
  assert.equal(visible({ files: [{}], phase: 'selected' }), false)
})

test('仅排队或正在上传时显示开始解析区，完成后旧按钮消失', () => {
  const visible = conditionForClass('file-picker-action')
  for (const phase of ['selected', 'files_ready', 'organizing']) {
    assert.equal(visible({ phase, uploadSummary: { queued: 0 } }), false)
  }
  assert.equal(visible({ phase: 'selected', uploadSummary: { queued: 1 } }), true)
  assert.equal(visible({ phase: 'uploading', uploadSummary: { queued: 0 } }), true)
  assert.doesNotMatch(markup, /添加后可开始|账单识别完成。/)
})

test('移除最后一份待解析文件后仍能继续已成功文件，不必重复解析', () => {
  const visible = conditionForClass('step-section parse-stage')
  assert.equal(visible({ phase: 'selected', uploadSummary: { queued: 0 }, files: [{}] }), true)
  assert.equal(visible({ phase: 'selected', uploadSummary: { queued: 1 }, files: [{}] }), false)
  assert.equal(visible({ phase: 'uploading', uploadSummary: { queued: 0 }, files: [{}] }), false)
})

test('继续按钮仍要求成功文件，失败或已入账文件不能冒充成功', () => {
  const tag = markup.match(/<button[^>]*bindtap="createFinanceUpdate"[^>]*>/)[0]
  assert.match(tag, /disabled="\{\{busy \|\| uploadSummary.ready === 0\}\}"/)
  assert.match(markup, /未成功文件不会计入本次整理/)
  assert.match(markup, /已入账文件不会重复记账/)
  assert.match(markup, /bindtap="retryFile"/)
  assert.match(markup, /bindtap="removeFile"/)
})

test('查看数量明细和原始证据只改变展示，不产生请求和账户决定', () => {
  const { calls, instance } = page()
  const before = JSON.stringify(instance.data.accountMappings)
  instance.toggleRecordSummary()
  instance.toggleIssueSource()
  assert.equal(instance.data.recordSummaryExpanded, true)
  assert.equal(instance.data.issueSourceExpanded, true)
  instance.toggleRecordSummary()
  instance.toggleIssueSource()
  assert.equal(instance.data.recordSummaryExpanded, false)
  assert.equal(instance.data.issueSourceExpanded, false)
  assert.equal(JSON.stringify(instance.data.accountMappings), before)
  assert.equal(calls.length, 0)
})

test('已匹配不冒充已确认；账户草稿保留名称、类型和原始记录入口', () => {
  assert.match(markup, /建议账户 · 待确认/)
  assert.match(markup, /item.status === 'resolved'/)
  assert.match(markup, /accountStepSummary.ready \+ ' \/ ' \+ accountStepSummary.total/)
  assert.match(markup, /新增账户在整批入账后生效/)
  assert.match(markup, /class="account-edit-field"[\s\S]*bindinput="bindAccountDraftName"/)
  assert.match(markup, /bindchange="changeAccountDraftType"/)
  assert.match(markup, /bindtap="openAccountRecords"/)
  assert.match(styles, /\.account-decision-new \{[^}]*flex-direction: column/)
})

test('核对和分类继续采用各自计数，排除及重复数量始终可见', () => {
  assert.match(markup, /reviewStatusTabs\[0\].count \+ ' 笔账目待核对'/)
  assert.match(markup, /待分类 \{\{categoryStatusTabs\[0\].count\}\} 笔/)
  assert.doesNotMatch(markup, /reviewStatusTabs\[0\].count\s*\+\s*categoryStatusTabs\[0\].count/)
  assert.match(markup, /已排除 \{\{recordSummary.excludedCount\}\} · 重复 \{\{recordSummary.duplicateCount\}\}/)
  assert.match(markup, /wx:if="\{\{recordSummaryExpanded\}\}" class="record-count-breakdown"/)
})

test('金额分配有效时显示完成且沿用现有领域校验', () => {
  const { instance } = page()
  setPayment(instance)
  const state = instance.refreshPaymentDraft()
  assert.equal(state.valid, true)
  assert.equal(instance.data.paymentCanSave, true)
  assert.equal(instance.data.paymentValidationHint, '')
  assert.equal(instance.data.paymentDifferenceText, '已分配完成')
})

test('金额相等但缺核对说明依旧禁用，不把提示作为放行依据', () => {
  const { instance } = page()
  setPayment(instance, { paymentEvidenceNote: '' })
  assert.equal(instance.refreshPaymentDraft().valid, false)
  assert.equal(instance.data.paymentCanSave, false)
  assert.match(instance.data.paymentValidationHint, /核对说明/)
})

test('金额超额或来源账户重复时保持禁止保存', () => {
  const { instance } = page()
  setPayment(instance)
  instance.data.paymentRows[0].amountInput = '7.00'
  assert.equal(instance.refreshPaymentDraft().valid, false)
  assert.match(instance.data.paymentDifferenceText, /超出/)
  setPayment(instance)
  instance.data.paymentRows[1].accountId = 'asset-a'
  assert.equal(instance.refreshPaymentDraft().valid, false)
  assert.equal(instance.data.paymentCanSave, false)
})

test('只确认组合账户仍需至少两个不同账户，不能转换成付款金额确认', () => {
  const { instance } = page()
  setPayment(instance, { currentIssue: { paymentNeedsReview: true, paymentAccountsOnly: true } })
  assert.equal(instance.refreshPaymentDraft().valid, true)
  instance.data.paymentRows[1].accountId = 'asset-a'
  assert.equal(instance.refreshPaymentDraft().valid, false)
  assert.match(instance.data.paymentValidationHint, /不同/)
})

test('全部分配继续设置总额并置零其他项，文案不误写为填入剩余', () => {
  const { instance } = page()
  setPayment(instance)
  instance.fillPaymentAmount({ currentTarget: { dataset: { index: 1 } } })
  assert.deepEqual(instance.data.paymentRows.map(row => row.amountInput), ['0.00', '10.00'])
  assert.equal(instance.data.paymentCanSave, true)
  assert.match(markup, /bindtap="fillPaymentAmount"[^>]*>全部分配<\/button>/)
  assert.match(markup, /bindtap="fillRepaymentAllocation"[^>]*>全部分配<\/button>/)
  assert.doesNotMatch(markup, /填入剩余/)
})

test('两账户输入继续通过原有整数算法自动补齐差额', () => {
  const { instance } = page()
  setPayment(instance)
  instance.changePaymentRow({ currentTarget: { dataset: { index: 0, field: 'amount' } }, detail: { value: '0.10' } })
  assert.deepEqual(instance.data.paymentRows.map(row => row.amountInput), ['0.10', '9.90'])
  assert.equal(instance.data.paymentCanSave, true)
})

test('付款证据可原位展开，其他问题保持同层证据、分页与重试', () => {
  assert.match(markup, /bindtap="toggleIssueSource"/)
  assert.match(markup, /!currentIssue.paymentNeedsReview \|\| issueSourceExpanded/)
  assert.match(markup, /template is="record-source-fields"/)
  assert.match(markup, /bindtap="retryIssueRecordEvidence"/)
  assert.match(markup, /bindtap="showMoreIssueRecords"/)
})

test('保存门禁仍包含必需事实、付款与聚合还款校验', () => {
  const tag = markup.match(/<button[^>]*bindtap="resolveWithFields"[^>]*>/)[0]
  for (const pattern of [/busy/, /!issueFieldsCanSave/, /!paymentCanSave/, /!repaymentAllocationCanSave/]) assert.match(tag, pattern)
  assert.match(markup, /class="save-requirement"/)
  assert.match(markup, /disabled="\{\{busy \|\| openIssueCount \|\| !coverage.selectedEventsReadyToPost\}\}"/)
})

test('暖橘表面覆盖限定在导入页，金额字体舒展且不增加外部依赖', () => {
  assert.match(styles, /\.import-page\.theme-warm-ledger\s*\{/)
  assert.match(styles, /--theme-surface-muted: #f3f0eb !important;/)
  assert.match(styles, /\.import-page \.money-number[^}]*font-variant-numeric: tabular-nums/)
  assert.doesNotMatch(styles, /@font-face|https?:\/\//)
  assert.match(styles, /prefers-reduced-motion/)
})
