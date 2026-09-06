const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const model = require('../miniprogram/pages/import-workbench/model')

function pageFor(issue, accounts = [], importApi = {}) {
  let definition
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/import-workbench/index.js'), 'utf8'), {
    require: (name) => name === './model' ? model : name === '../../services/catledger-import' ? importApi : {},
    Page: (page) => { definition = page }
  })
  return Object.assign({}, definition, {
    _accountUiDrafts: new Map(),
    data: Object.assign({}, definition.data, {
      update: { updateId: 'synthetic-update' }, accountIssues: [issue], accounts
    }),
    setData(patch) {
      for (const [key, value] of Object.entries(patch)) {
        const parts = key.split('.')
        let target = this.data
        for (const part of parts.slice(0, -1)) target = target[part]
        target[parts[parts.length - 1]] = value
      }
    }
  })
}

function unknownIssue() {
  return { issueId: 'synthetic-issue', issueType: 'account_mapping', status: 'open',
    accountContext: { recognized: false, sourceType: 'wechat', label: '微信支付方式未标明' } }
}

test('未知账户默认待选择，不能提交为新建账户或排除决定', async () => {
  const page = pageFor(unknownIssue())
  const state = page.refreshAccountMappings()
  assert.equal(state.mappings[0].choiceValue, 'pending')
  assert.equal(state.summary.invalid, 1)
  assert.equal(state.summary.create, 0)
  await page.completeAccountMapping()
  assert.match(page.data.accountStepError, /请选择账户归属/u)
  assert.equal(page.data.accountStepBusy, false)
})

test('明确选择新建后才进入表单，填写有效名称才能确认', () => {
  const page = pageFor(unknownIssue())
  page.refreshAccountMappings()
  page.openAccountChoice({ currentTarget: { dataset: { id: 'synthetic-issue' } } })
  page.selectAccountChoice({ currentTarget: { dataset: { value: 'create' } } })
  assert.equal(page.data.accountMappings[0].choiceValue, 'create')
  assert.equal(page.data.accountStepSummary.invalid, 1)
  page.bindAccountDraftName({ currentTarget: { dataset: { id: 'synthetic-issue' } }, detail: { value: '测试钱包' } })
  assert.equal(page.data.accountStepSummary.invalid, 0)
})

test('未知来源允许人工选择已有账户，选择失效后恢复待选择', () => {
  const page = pageFor(unknownIssue(), [{ accountId: 'wallet', name: '测试钱包', type: 'wallet', currency: 'CNY' }])
  page.refreshAccountMappings()
  page.openAccountChoice({ currentTarget: { dataset: { id: 'synthetic-issue' } } })
  page.selectAccountChoice({ currentTarget: { dataset: { value: 'account:wallet' } } })
  assert.equal(page.data.accountStepSummary.ready, 1)
  page.data.accounts = []
  const state = page.refreshAccountMappings()
  assert.equal(state.mappings[0].choiceValue, 'pending')
  assert.equal(state.summary.invalid, 1)
})

test('刷新未知来源时保留服务端已经确认的人工归属', () => {
  const issue = unknownIssue()
  issue.status = 'resolved'
  issue.accountContext.accountId = 'wallet'
  const state = pageFor(issue, [{ accountId: 'wallet', name: '测试钱包' }]).refreshAccountMappings()
  assert.equal(state.mappings[0].choiceValue, 'account:wallet')
  assert.equal(state.summary.confirmed, 1)
  assert.equal(state.summary.invalid, 0)
})

test('稳定识别的微信零钱仍可推荐唯一已有账户', () => {
  const issue = unknownIssue()
  issue.accountContext = { recognized: true, sourceType: 'wechat', label: '微信零钱', currency: 'CNY' }
  const state = pageFor(issue, [{ accountId: 'wallet', name: '微信零钱', currency: 'CNY' }]).refreshAccountMappings()
  assert.equal(state.mappings[0].choiceValue, 'account:wallet')
  assert.equal(state.mappings[0].suggestedExisting, true)
})

test('多笔账户记录先显示 20 笔并能逐批看完，查看证据不提交账户决定', async () => {
  const calls = []
  const members = Array.from({ length: 45 }, (_, index) => ({ event: {
    eventId: String(index).padStart(2, '0'), localAt: '2026-08-01 12:00:00', amountMinor: '100', primaryEvidence: { item: '合成记录' }
  } }))
  const page = pageFor(unknownIssue(), [], { async callImport(action, data) { calls.push(action); return action === 'reviewIssues.get' ? { members } : { evidence: [{ evidenceId: data.eventId, rawFields: { '原始字段': '合成原文' } }] } } })
  page.refreshAccountMappings()
  await page.openAccountRecords({ currentTarget: { dataset: { id: 'synthetic-issue' } } })
  assert.equal(page.data.accountRecordsSheet.records.length, 20)
  assert.equal(page.data.accountRecordsSheet.count, 45)
  // 原生 setData 支持点路径，测试桩为下一步还原该路径。
  page.setData = function (patch) { Object.entries(patch).forEach(([key, value]) => {
    if (key.startsWith('accountRecordsSheet.')) this.data.accountRecordsSheet[key.split('.')[1]] = value
    else this.data[key] = value
  }) }
  await page.showMoreAccountRecords()
  assert.equal(page.data.accountRecordsSheet.records.length, 40)
  await page.showMoreAccountRecords()
  assert.equal(page.data.accountRecordsSheet.records.length, 45)
  assert.equal(page.data.accountRecordsSheet.hasMore, false)
  assert.equal(calls.filter((action) => action === 'reviewIssues.get').length, 1)
  assert.equal(calls.filter((action) => action === 'economicEvents.evidence').length, 45)
  assert.equal(page.data.accountRecordsSheet.records[0].evidence[0].fields[0].value, '合成原文')
  assert.equal(page.data.accountMappings[0].choiceValue, 'pending')
})


test('关闭查看面板后停止后续原始记录加载，晚到的响应不重开面板', async () => {
  const pending = []
  let evidenceCalls = 0
  const members = Array.from({ length: 30 }, (_, index) => ({ event: { eventId: String(index), amountMinor: '100' } }))
  const page = pageFor(unknownIssue(), [], { callImport(action) {
    if (action === 'reviewIssues.get') return Promise.resolve({ members })
    evidenceCalls++
    return new Promise((resolve) => pending.push(resolve))
  } })
  page.refreshAccountMappings()
  const opening = page.openAccountRecords({ currentTarget: { dataset: { id: 'synthetic-issue' } } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(evidenceCalls, 4)
  page.closeAccountRecords()
  pending.forEach((resolve) => resolve({ evidence: [] }))
  await opening
  assert.equal(page.data.accountRecordsSheet, null)
  assert.equal(evidenceCalls, 4)
})

test('原始记录加载失败保留摘要，可在同一面板重试而不改变账户决定', async () => {
  let attempts = 0
  const page = pageFor(unknownIssue(), [], { async callImport(action) {
    if (action === 'reviewIssues.get') return { members: [{ event: { eventId: 'synthetic-event', amountMinor: '100' } }] }
    if (++attempts === 1) throw new Error('synthetic failure')
    return { evidence: [{ evidenceId: 'source', rawFields: { '支付方式': '合成账户' } }] }
  } })
  page.refreshAccountMappings()
  await page.openAccountRecords({ currentTarget: { dataset: { id: 'synthetic-issue' } } })
  assert.ok(page.data.accountRecordsSheet.records[0].evidenceError)
  await page.retryAccountRecordEvidence({ currentTarget: { dataset: { id: 'synthetic-event' } } })
  assert.equal(page.data.accountRecordsSheet.records[0].evidenceError, '')
  assert.equal(page.data.accountRecordsSheet.records[0].evidence[0].fields[0].value, '合成账户')
  assert.equal(page.data.accountMappings[0].choiceValue, 'pending')
})


function syntheticIssueDetails(count = 1, issueType = 'category_assignment') {
  return { update: { status: 'review' }, issue: { issueId: 'synthetic-issue', issueType, status: 'open' },
    accounts: [], accountDrafts: [], categories: [], members: Array.from({ length: count }, (_, index) => ({ event: {
      eventId: 'event-' + index, amountMinor: '100', economicNature: 'expense', flowDirection: 'outflow',
      localAt: '2026-08-01 12:00:00', primaryEvidence: { item: '合成记录' }
    } })) }
}

test('待整理详情自动同层加载原文，多笔分页不丢失完整裁决集合', async () => {
  let reads = 0
  const details = syntheticIssueDetails(25, 'same_event')
  const page = pageFor(unknownIssue(), [], { async callImport(action, data) {
    if (action === 'reviewIssues.get') return details
    reads++
    return { evidence: [{ evidenceId: data.eventId, rawFields: { '账单原文': '合成值' } }] }
  } })
  await page.openIssue({ currentTarget: { dataset: { id: 'synthetic-issue' } } })
  assert.equal(page.data.issueEvents.length, 25)
  assert.equal(page.data.issueVisibleEvents.length, 20)
  assert.equal(reads, 20)
  assert.equal(page.data.issueVisibleEvents[0].evidence[0].fields[0].value, '合成值')
  assert.equal(page.data.evidenceSheet, null)
  page.selectPrimaryEvent({ currentTarget: { dataset: { id: 'event-3' } } })
  await page.showMoreIssueRecords()
  assert.equal(page.data.issueVisibleEvents.length, 25)
  assert.equal(page.data.issueEvents.length, 25)
  assert.equal(page.data.issueDraft.primaryEventId, 'event-3')
  assert.equal(reads, 25)
})

test('关闭待整理详情后，未完成的原文响应不会污染下次打开的面板', async () => {
  let finish
  const page = pageFor(unknownIssue(), [], { callImport(action) {
    if (action === 'reviewIssues.get') return Promise.resolve(syntheticIssueDetails())
    return new Promise((resolve) => { finish = resolve })
  } })
  const opening = page.openIssue({ currentTarget: { dataset: { id: 'synthetic-issue' } } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(page.data.currentIssue)
  page.closeIssue()
  finish({ evidence: [{ evidenceId: 'old-source', rawFields: { '字段': '旧值' } }] })
  await opening
  assert.equal(page.data.currentIssue, null)
  assert.equal(page.data.issueVisibleEvents.length, 0)
})


test('退款候选也直接显示原文，但不混入待处理事件集合', async () => {
  const details = syntheticIssueDetails(1, 'refund_relation')
  const target = { eventId: 'refund-target', amountMinor: '100', economicNature: 'expense', localAt: '2026-07-31 12:00:00' }
  details.members.push({ relation: { relationId: 'relation', targetEventId: target.eventId, targetEvent: target } })
  const page = pageFor(unknownIssue(), [], { async callImport(action, data) {
    return action === 'reviewIssues.get' ? details : { evidence: [{ evidenceId: data.eventId, rawFields: { '字段': '合成证据' } }] }
  } })
  await page.openIssue({ currentTarget: { dataset: { id: 'synthetic-issue' } } })
  assert.equal(page.data.issueEvents.length, 1)
  assert.equal(page.data.issueEvidenceTotal, 2)
  assert.equal(page.data.issueVisibleEvents[1].recordRole, '候选原消费')
  assert.equal(page.data.issueVisibleEvents[1].evidence.length, 1)
  assert.equal(page.data.issueDraft.targetEventId, 'refund-target')
})

function bankDetails(id, version = 1) {
  const event = { eventId: id + '-event', economicNature: 'repayment', amountMinor: '100',
    ledgerAccountId: 'wallet', primaryEvidence: { item: '/', counterparty: '平安银行信用卡还款' },
    fundsProjection: { from: { label: '微信零钱' }, to: { label: '平安银行信用卡', referenceKind: 'atomic' } } }
  return { update: { updateId: 'synthetic-update', version: 5, status: 'review' },
    issue: { issueId: id, version, issueType: 'transfer_accounts', status: 'open', subject: event },
    accounts: [{ accountId: 'card', name: '平安银行信用卡(1234)', type: 'credit' }], accountDrafts: [], categories: [],
    members: [{ event }] }
}

function bankPage(onCall) {
  const page = pageFor(bankDetails('one').issue, [], { createRequestId: () => 'synthetic-request', async callImport(action, payload) {
    if (onCall) { const result = await onCall(action, payload); if (result !== undefined) return result }
    if (action === 'reviewIssues.get') return bankDetails(payload.issueId)
    if (action === 'economicEvents.evidence') return { evidence: [{ evidenceId: payload.eventId, rawFields: { '交易对方': '平安银行信用卡还款' } }] }
    throw new Error('unexpected action')
  } })
  page.data.issues = ['one', 'two', 'three'].map(id => bankDetails(id).issue)
  page.loadUpdate = async function () { this.setData({ busy: false, currentIssue: null }) }
  return page
}

test('唯一银行候选仍未选中，多张不预选；确认候选只改变本地表单', async () => {
  let writes = 0
  const page = bankPage((action) => { if (action === 'reviewIssues.resolve') writes++ })
  await page.openIssue({ currentTarget: { dataset: { id: 'one' } } })
  assert.equal(page.data.issueDraft.accountIndex, 0)
  assert.equal(page.data.bankSuggestion.candidates.length, 1)
  assert.equal(page.data.currentIssue.subjectTitle, '平安银行信用卡还款')
  page.selectBankSuggestion({ currentTarget: { dataset: { id: 'card' } } })
  assert.equal(page.data.accountChoices[page.data.issueDraft.accountIndex].accountId, 'card')
  assert.equal(writes, 0)
})

test('批量默认不选、原文同时可见、取消勾选不提交；保存只覆盖选中问题且版本递进', async () => {
  const writes = []
  const page = bankPage((action, payload) => {
    if (action === 'reviewIssues.resolve') { writes.push(payload); return { update: { version: 5 + writes.length } } }
  })
  await page.openIssue({ currentTarget: { dataset: { id: 'one' } } })
  page.selectBankSuggestion({ currentTarget: { dataset: { id: 'card' } } })
  await page.expandBankBatch()
  assert.equal(page.data.bankBatchSelectedCount, 0)
  assert.equal(page.data.bankBatchRecords.length, 2)
  assert.ok(page.data.bankBatchRecords.every(row => row.readable && row.records[0].evidence.length === 1))
  page.toggleBankBatch({ currentTarget: { dataset: { id: 'two' } } })
  page.toggleBankBatch({ currentTarget: { dataset: { id: 'three' } } })
  page.toggleBankBatch({ currentTarget: { dataset: { id: 'three' } } })
  await page.resolveWithFields()
  assert.deepEqual(writes.map(x => x.issueId), ['one', 'two'])
  assert.deepEqual(writes.map(x => x.updateVersion), [5, 6])
  assert.ok(writes.every(x => x.fields.counterpartyLedgerAccountId === 'card' && !x.fields.ledgerAccountId))
})

test('批量预检有过期版本时零写入，执行中冲突报告部分完成而不继续', async () => {
  for (const preflightConflict of [true, false]) {
    let verifying = false
    const writes = []
    const page = bankPage((action, payload) => {
      if (preflightConflict && verifying && action === 'reviewIssues.get' && payload.issueId === 'two') return bankDetails('two', 2)
      if (action === 'reviewIssues.resolve') {
        writes.push(payload)
        if (writes.length === 2) throw new Error('CONFLICT')
        return { update: { version: 6 } }
      }
    })
    await page.openIssue({ currentTarget: { dataset: { id: 'one' } } })
    page.selectBankSuggestion({ currentTarget: { dataset: { id: 'card' } } })
    await page.expandBankBatch()
    page.toggleBankBatch({ currentTarget: { dataset: { id: 'two' } } })
    page.toggleBankBatch({ currentTarget: { dataset: { id: 'three' } } })
    verifying = true
    await page.resolveWithFields()
    assert.equal(writes.length, preflightConflict ? 0 : 2)
    assert.match(page.data.errorMessage, preflightConflict ? /已确认 0 项/ : /已确认 1 项/)
  }
})

test('换卡或收起批量范围清空勾选；关闭后晚到的批量响应不回写', async () => {
  let resolvePending
  let delay = false
  const page = bankPage((action, payload) => {
    if (delay && action === 'reviewIssues.get') return new Promise(resolve => { resolvePending = () => resolve(bankDetails(payload.issueId)) })
  })
  await page.openIssue({ currentTarget: { dataset: { id: 'one' } } })
  page.selectBankSuggestion({ currentTarget: { dataset: { id: 'card' } } })
  await page.expandBankBatch()
  page.toggleBankBatch({ currentTarget: { dataset: { id: 'two' } } })
  page.changeIssueAccount({ detail: { value: 0 } })
  assert.equal(page.data.bankBatchSelectedCount, 0)
  await page.expandBankBatch()
  delay = true
  const loading = page.expandBankBatch()
  await new Promise(resolve => setImmediate(resolve))
  page.closeIssue()
  resolvePending()
  await loading
  assert.equal(page.data.currentIssue, null)
  assert.equal(page.data.bankBatchRecords.length, 0)
})

test('整理阶段组合支付表单完整后才提交', async () => {
  const details = syntheticIssueDetails(1, 'shared_fields')
  details.members[0].event.reasonCodes = ['payment_components_ambiguous', 'row_transaction_type_unknown']
  details.members[0].event.paymentComponents = [{ componentKind: 'financial', label: '测试银行卡' }, { componentKind: 'financial', label: '测试余额' }]
  details.members[0].event.amountMinor = '1000'
  details.issue.subject = details.members[0].event
  details.accounts = [{ accountId: 'one', name: '测试银行卡', type: 'bank' }, { accountId: 'two', name: '测试余额', type: 'wallet' }]
  const page = pageFor(details.issue, details.accounts, { async callImport(action) {
    if (action === 'reviewIssues.get') return details
    return { evidence: [] }
  } })
  page.data.issues = [model.issueView(details.issue)]
  await page.openIssue({ currentTarget: { dataset: { id: details.issue.issueId } } })
  assert.equal(page.data.currentIssue.paymentNeedsReview, true)
  assert.equal(page.data.paymentRows.length, 2)
  assert.equal(page.data.paymentCanSave, false)
  page.changePaymentNature({ detail: { value: 1 } })
  for (const [index, amount] of [[0, '6.00'], [1, '4.00']]) {
    page.changePaymentRow({ currentTarget: { dataset: { index, field: 'account' } }, detail: { value: index + 1 } })
    page.changePaymentRow({ currentTarget: { dataset: { index, field: 'amount' } }, detail: { value: amount } })
  }
  assert.equal(page.data.paymentCanSave, false)
  page.changePaymentNote({ detail: { value: '已核对合成支付详情' } })
  assert.equal(page.data.paymentCanSave, true)
  let submission
  page.resolveIssue = (decision, extra) => { submission = { decision, ...extra } }
  page.resolveWithFields()
  assert.equal(submission.fields.paymentResolution.allocations.length, 2)
  assert.equal(submission.fields.paymentResolution.nature, 'expense')
  assert.equal(submission.fields.ledgerAccountId, undefined)
  page.changePaymentRow({ currentTarget: { dataset: { index: 1, field: 'amount' } }, detail: { value: '4.01' } })
  assert.equal(page.data.paymentRows[0].amountInput, '5.99')
  assert.equal(page.data.paymentCanSave, true)
  page.fillPaymentAmount({ currentTarget: { dataset: { index: 1 } } })
  assert.deepEqual(Array.from(page.data.paymentRows, row => row.amountInput), ['0.00', '10.00'])
  assert.equal(page.data.paymentCanSave, true)
  page.resolveWithFields()
  assert.equal(submission.fields.paymentResolution.version, 'payment-resolution-v2')
  assert.deepEqual(Array.from(submission.fields.paymentResolution.allocations, row => row.amountMinor), ['0', '1000'])
  for (const value of ['', '10.01', '1.001', '-1']) {
    page.changePaymentRow({ currentTarget: { dataset: { index: 1, field: 'amount' } }, detail: { value } })
    assert.equal(page.data.paymentRows[0].amountInput, '')
    assert.equal(page.data.paymentCanSave, false)
  }
})


test('组合支付预填唯一来源账户和明确还款性质，歧义与未知保持未选', () => {
  const accounts = [
    { accountId: 'bank', name: '测试银行储蓄卡(1234)', currency: 'CNY' },
    { accountId: 'wallet', name: '支付宝账户余额', currency: 'CNY' }
  ]
  const event = { currency: 'CNY', economicNature: 'unknown',
    primaryEvidence: { sourceType: 'alipay', item: '先采后付账单付款' },
    paymentComponents: [{ componentKind: 'financial', label: '测试银行储蓄卡(1234)' }, { componentKind: 'financial', label: '账户余额' }] }
  const initial = model.paymentResolutionDefaults(event, accounts)
  assert.equal(initial.natureIndex, 0)
  assert.equal(model.paymentResolutionDefaults({ ...event, economicNature: 'repayment' }, accounts).natureIndex, 2)
  assert.deepEqual(initial.rows.map(row => row.accountId), ['bank', 'wallet'])
  assert.ok(initial.rows.every(row => row.amountInput === ''))
  const ambiguous = model.paymentResolutionDefaults(event, accounts.concat([{ ...accounts[0], accountId: 'other' }]))
  assert.equal(ambiguous.rows[0].accountId, '')
  assert.equal(model.paymentResolutionDefaults({ ...event, primaryEvidence: { item: '普通商品' } }, accounts).natureIndex, 0)
  assert.equal(model.paymentResolutionDefaults({ ...event, primaryEvidence: { item: '信用卡还款' } }, accounts).natureIndex, 0)
})


test('账户阶段组合支付只保存账户，不要求金额性质目标；整理沿用已保存账户', async () => {
  const details = syntheticIssueDetails(1, 'account_mapping')
  const event = details.members[0].event
  event.reasonCodes = ['payment_components_ambiguous']
  event.paymentComponents = [{ componentKind: 'financial', label: '测试银行' }, { componentKind: 'financial', label: '测试余额' }]
  details.issue.subject = event
  details.accounts = [{ accountId: 'one', name: '测试银行', currency: 'CNY' }, { accountId: 'two', name: '测试余额', currency: 'CNY' }]
  const page = pageFor(details.issue, details.accounts, { async callImport(action) { return action === 'reviewIssues.get' ? details : { evidence: [] } } })
  page.data.issues = [model.issueView(details.issue)]
  await page.openIssue({ currentTarget: { dataset: { id: details.issue.issueId } } })
  assert.equal(page.data.currentIssue.paymentAccountsOnly, true)
  assert.equal(page.data.paymentCanSave, true)
  assert.ok(page.data.paymentRows.every(row => row.amountInput === ''))
  let submission
  page.resolveIssue = (decision, extra) => { submission = extra.fields }
  page.resolveWithFields()
  assert.deepEqual(Object.keys(submission), ['paymentAccounts'])
  const defaults = model.paymentResolutionDefaults({ ...event, paymentAccounts: submission.paymentAccounts.map((part, i) => ({ ...part, accountId: i ? 'one' : 'two' })) }, details.accounts)
  assert.deepEqual(defaults.rows.map(row => row.accountId), ['two', 'one'])
})


test('来源账户组不显示组合支付入口，普通选择器仍按账户归属；整理保留组合核对', () => {
  const issue = { issueType: 'account_mapping', status: 'open', reasonCodes: ['payment_components_ambiguous'],
    subject: { eventId: 'synthetic', economicNature: 'unknown' },
    accountContext: { label: '测试账户', fundsSide: 'payment_component_0', recognized: true } }
  const grouped = model.issueView(issue)
  assert.equal(grouped.label, '测试账户')
  assert.equal(grouped.paymentNeedsReview, false)
  assert.equal(model.issueView({ ...issue, accountContext: { ...issue.accountContext, fundsSide: 'payment_target' } }).paymentNeedsReview, false)
  assert.equal(model.issueView({ ...issue, issueType: 'shared_fields' }).paymentNeedsReview, true)
})


test('补充还款账户只改变本地草稿；全部、删除和新建均重新校验金额', () => {
  const page = pageFor(unknownIssue())
  page.data.issueEvents = [{ amountMinor: '10000' }]
  page.data.repaymentAccountOptions = [{ accountId: 'history', name: '历史花呗', type: 'credit' }]
  page.refreshRepaymentChoices([{ accountId: 'candidate', name: '本批信用购', amountInput: '' }])
  assert.equal(page.data.repaymentAllocationCanSave, false)
  page.addRepaymentAccount({ detail: { value: 1 } })
  assert.equal(page.data.repaymentAllocationChoices.length, 2)
  assert.equal(page.data.repaymentAllocationCanSave, false)
  page.fillRepaymentAllocation({ currentTarget: { dataset: { index: 1 } } })
  assert.equal(page.data.repaymentAllocationCanSave, true)
  page.removeRepaymentAccount({ currentTarget: { dataset: { index: 1 } } })
  assert.equal(page.data.repaymentAllocationCanSave, false)
  page.addRepaymentAccount({ detail: { value: 2 } })
  page.fillRepaymentAllocation({ currentTarget: { dataset: { index: 1 } } })
  assert.equal(page.data.repaymentAllocationCanSave, false)
  page.changeRepaymentAccountName({ currentTarget: { dataset: { index: 1 } }, detail: { value: '新花呗' } })
  assert.equal(page.data.repaymentAllocationCanSave, true)
  assert.equal(page.data.repaymentAdditionalIndex, 0)
})


test('分类保存只提交分类，隐藏的预选账户不覆盖原账户', () => {
  const page = pageFor(unknownIssue())
  page.data.currentIssue = { issueType: 'category_assignment' }
  page.data.accountChoices = [{ accountId: 'must-not-be-written' }]
  page.data.issueCategories = [{ categoryId: 'category-expense' }]
  let saved
  page.resolveIssue = (decision, extra) => { saved = { decision, extra } }
  page.resolveWithFields()
  assert.equal(saved.decision, 'apply_fields')
  assert.equal(JSON.stringify(saved.extra.fields), JSON.stringify({ categoryId: 'category-expense' }))
})

test('性质可以先确认，分类留给后续分类问题而非写空值', () => {
  const page = pageFor(unknownIssue())
  page.data.currentIssue = { issueType: 'shared_fields' }
  page.data.accountChoices = [{ accountId: 'known-account' }]
  page.data.issueCategories = [{ categoryId: '', isPlaceholder: true }]
  let saved
  page.resolveIssue = (_, extra) => { saved = extra.fields }
  page.resolveWithFields()
  assert.equal(saved.economicNature, 'expense')
  assert.equal(Object.hasOwn(saved, 'categoryId'), false)
})

test('分类单独展示且不阻止入账，核对数量不包含分类', () => {
  const page = pageFor(unknownIssue())
  const events = ['a', 'b'].map(eventId => ({ eventId, status: 'needs_action', economicNature: 'expense', primaryEvidence: { counterparty: '合成商户' } }))
  page.applyUpdateView({ update: { updateId: 'synthetic', status: 'review', counts: {} },
    issues: [{ issueId: 'cat', issueType: 'category_assignment', status: 'open', blocking: true,
      subjectEventIds: ['a', 'b'], subject: events[0] }], events })
  assert.equal(page.data.categoryEventCount, 2)
  assert.equal(page.data.reviewIssues.length, 1)
  assert.equal(page.data.verificationIssues.length, 0)
  assert.equal(page.data.openIssueCount, 0)
  assert.equal(page.data.currentStep, 3)
  assert.equal(page.data.unlockedStep, 4)
  assert.equal(page.data.activeReviewTab, 'review')
  assert.equal(page.data.activeReviewStatus, 'pending')
  assert.equal(page.data.reviewStatusTabs[1].count, 2)
})

test('重复记录只展示明确 duplicate 证据，关联证据不误算重复', async () => {
  const page = pageFor(unknownIssue(), [], { callImport: async (_, args) => ({ evidence: [
    { evidenceRole: 'primary' }, { evidenceRole: args.eventId === 'dup' ? 'duplicate' : 'supporting' }
  ] }) })
  page.data.duplicateReviewCandidates = [{ eventId: 'dup' }, { eventId: 'support' }]
  await page.loadDuplicateRecords()
  assert.equal(page.data.duplicateReviewEvents.length, 1)
  assert.equal(page.data.duplicateReviewEvents[0].eventId, 'dup')
  assert.equal(page.data.duplicateReviewLoaded, true)
  assert.equal(page.data.duplicateReviewLoading, false)
})

test('重复证据读取失败保留重试入口，重新加载视图后不接收旧请求', async () => {
  let fail = true
  const page = pageFor(unknownIssue(), [], { callImport: async () => {
    if (fail) throw new Error('合成读取失败')
    page._duplicateLoadToken = null
    return { evidence: [{ evidenceRole: 'duplicate' }] }
  } })
  page.data.duplicateReviewCandidates = [{ eventId: 'synthetic' }]
  await page.loadDuplicateRecords()
  assert.match(page.data.duplicateReviewError, /读取失败/)
  assert.equal(page.data.duplicateReviewLoaded, false)
  fail = false
  await page.loadDuplicateRecords()
  assert.equal(page.data.duplicateReviewEvents.length, 0)
})


test('分类重读后从未分类移入已分类，搜索不改计数，最后一组不强制跳页', () => {
  const page = pageFor(unknownIssue())
  const event = { eventId: 'classified-event', status: 'needs_action', economicNature: 'expense', amountMinor: '2800',
    localAt: '2026-09-05 10:00:00', primaryEvidence: { item: '布局样例' } }
  const issue = { issueId: 'category-issue', issueType: 'category_assignment', status: 'open', blocking: true, subjectCount: 1, subject: event }
  const update = { updateId: 'synthetic-update', status: 'review', counts: {} }
  const categories = [{ categoryId: 'food', name: '餐饮' }]
  page.applyUpdateView({ update, issues: [issue], events: [event], categories })
  assert.equal(page.data.categoryEventCount, 1)
  assert.equal(page.data.categorizedEventCount, 0)
  assert.equal(page.data.activeCategoryStatus, 'pending')
  page.applyUpdateView({ update, issues: [{ ...issue, status: 'resolved', blocking: false }],
    events: [{ ...event, status: 'ready', categoryId: 'food' }], categories })
  assert.equal(page.data.categoryEventCount, 0)
  assert.equal(page.data.categorizedEventCount, 1)
  assert.equal(page.data.categorizedEvents[0].categoryName, '餐饮')
  assert.equal(page.data.currentStep, 3)
  assert.equal(page.data.unlockedStep, 4)
  assert.equal(page.data.openIssueCount, 0)
  page.switchCategoryStatus({ currentTarget: { dataset: { status: 'completed' } } })
  assert.equal(page.data.activeCategoryStatus, 'completed')
  page.searchCategoryIssues({ detail: { value: '不存在' } })
  assert.equal(page.data.categorizedEvents.length, 0)
  assert.equal(page.data.categorizedEventCount, 1)
  assert.deepEqual(Array.from(page.data.categoryStatusTabs, tab => tab.count), [0, 1, 0])
  page.switchCategoryStatus({ currentTarget: { dataset: { status: 'invalid' } } })
  assert.equal(page.data.activeCategoryStatus, 'completed')
  page._sourceFiles = new Map()
  page.startAnother()
  assert.equal(page.data.activeCategoryStatus, 'pending')
  assert.equal(page.data.categorizedEventCount, 0)
  assert.equal(page.data.categorizedEvents.length, 0)
})

test('未选转入账户时保存禁用，选定后启用，清空后再次禁用且直接调用不写入', async () => {
  const page = bankPage()
  let writes = 0
  page.resolveIssue = () => { writes++ }
  await page.openIssue({ currentTarget: { dataset: { id: 'one' } } })
  assert.equal(page.data.issueFieldsCanSave, false)
  page.resolveWithFields()
  assert.equal(writes, 0)
  page.selectBankSuggestion({ currentTarget: { dataset: { id: 'card' } } })
  assert.equal(page.data.issueFieldsCanSave, true)
  page.resolveWithFields()
  assert.equal(writes, 1)
  for (const index of [0, -1, 999]) {
    page.changeIssueAccount({ detail: { value: index } })
    assert.equal(page.data.issueFieldsCanSave, false)
    page.resolveWithFields()
    assert.equal(writes, 1)
  }
})

test('单端账户不能选成已知另一端，双端都选好且不相同才允许保存', () => {
  const page = pageFor(unknownIssue())
  page.data.accountChoices = [{ isPlaceholder: true }, { accountId: 'from' }, { accountId: 'to' }]
  page.data.counterpartyAccountChoices = page.data.accountChoices
  page.data.issueEvents = [{ ledgerAccountId: 'from' }]
  page.data.currentIssue = { issueType: 'transfer_accounts', missingFundsSide: 'to' }
  page.changeIssueAccount({ detail: { value: 1 } })
  assert.equal(page.data.issueFieldsCanSave, false)
  page.changeIssueAccount({ detail: { value: 2 } })
  assert.equal(page.data.issueFieldsCanSave, true)
  assert.deepEqual(model.buildIssueFieldsDraft(page.data).fields, { counterpartyLedgerAccountId: 'to' })
  page.data.currentIssue.missingFundsSide = 'from'
  page.data.issueEvents = [{ counterpartyLedgerAccountId: 'to' }]
  page.changeIssueAccount({ detail: { value: 2 } })
  assert.equal(page.data.issueFieldsCanSave, false)
  page.changeIssueAccount({ detail: { value: 1 } })
  assert.equal(page.data.issueFieldsCanSave, true)
  page.data.currentIssue.missingFundsSide = 'both'
  page.changeCounterpartyAccount({ detail: { value: 0 } })
  assert.equal(page.data.issueFieldsCanSave, false)
  page.changeCounterpartyAccount({ detail: { value: 1 } })
  assert.equal(page.data.issueFieldsCanSave, false)
  page.changeCounterpartyAccount({ detail: { value: 2 } })
  assert.equal(page.data.issueFieldsCanSave, true)
  assert.deepEqual(model.buildIssueFieldsDraft(page.data).fields, { ledgerAccountId: 'from', counterpartyLedgerAccountId: 'to' })
})

test('新账户名称与性质实时校验，保存分类仍须选定分类', () => {
  const page = pageFor(unknownIssue())
  page.data.currentIssue = { issueType: 'shared_fields' }
  page.data.accountChoices = [{ isCreate: true }]
  for (const name of ['', '   ', '名'.repeat(33)]) {
    page.changeDraftAccountName({ detail: { value: name } })
    assert.equal(page.data.issueFieldsCanSave, false)
  }
  page.changeDraftAccountName({ detail: { value: '测试钱包' } })
  assert.equal(page.data.issueFieldsCanSave, true)
  page.changeDraftAccountType({ detail: { value: 999 } })
  assert.equal(page.data.issueFieldsCanSave, false)
  page.changeDraftAccountType({ detail: { value: 2 } })
  assert.equal(page.data.issueFieldsCanSave, true)
  page.changeIssueNature({ detail: { value: page.data.natureOptions.findIndex(item => item.value === 'unknown') } })
  assert.equal(page.data.issueFieldsCanSave, false)
  page.changeIssueNature({ detail: { value: 0 } })
  assert.equal(page.data.issueFieldsCanSave, true)
  assert.equal(Object.hasOwn(model.buildIssueFieldsDraft(page.data).fields, 'categoryId'), false)
  page.data.currentIssue = { issueType: 'category_assignment' }
  page.data.issueCategories = [{ categoryId: '', isPlaceholder: true }, { categoryId: 'category' }]
  page.changeIssueCategory({ detail: { value: 0 } })
  assert.equal(page.data.issueFieldsCanSave, false)
  page.changeIssueCategory({ detail: { value: 1 } })
  assert.equal(page.data.issueFieldsCanSave, true)
  page.changeIssueCategory({ detail: { value: 0 } })
  assert.equal(page.data.issueFieldsCanSave, false)
})

test('组合支付资金卡复用账户路线样式，目标选择和保存门槛仍连接真实草稿', () => {
  const markup = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/import-workbench/index.wxml'), 'utf8')
  assert.match(markup, /class="funds-route-card payment-funds-route"/)
  assert.match(markup, /wx:for="\{\{paymentRows\}\}" wx:key="componentIndex" class="funds-route-name"/)
  const paymentForm = markup.slice(markup.indexOf('class="payment-resolution-form"'), markup.indexOf('class="mapping-fields"'))
  assert.equal((paymentForm.match(/bindchange="changePaymentTarget"/g) || []).length, 1)
  assert.match(paymentForm, /class="funds-route-picker"[^>]*value="\{\{paymentTargetIndex\}\}"/)
  assert.match(markup, /wx:elif="\{\{currentIssue.missingFundsSide === 'both'\}\}"[^>]*bindchange="changeCounterpartyAccount"/)
  const save = markup.match(/<button[^>]+bindtap="resolveWithFields"[^>]*>/)[0]
  assert.match(save, /!issueFieldsCanSave/)
  assert.match(save, /!paymentCanSave/)
  assert.match(save, /!repaymentAllocationCanSave/)
})


test('组合金额使用整数差额，多账户仅全部动作分配，空白不能冒充已确认零', () => {
  const rows = [{ componentIndex: 0, accountId: 'a', amountInput: '' }, { componentIndex: 1, accountId: 'b', amountInput: '' }]
  const updated = model.updatePaymentAmounts(rows, 0, '0.10', '30')
  assert.deepEqual(updated.map(row => row.amountInput), ['0.10', '0.20'])
  assert.equal(rows[0].amountInput, '')
  assert.equal(model.updatePaymentAmounts(rows, 1, '999999999999.98', '99999999999999')[0].amountInput, '0.01')
  assert.equal(model.buildPaymentResolutionDraft([{ ...rows[0], amountInput: '0' }, { ...rows[1], amountInput: '0.30' }], 'expense', null, '核对', '30').valid, true)
  assert.equal(model.buildPaymentResolutionDraft([rows[0], { ...rows[1], amountInput: '0.30' }], 'expense', null, '核对', '30').valid, false)
  const many = [...rows, { componentIndex: 2, accountId: 'c', amountInput: '' }]
  assert.deepEqual(model.updatePaymentAmounts(many, 1, '0.10', '30').map(row => row.amountInput), ['', '0.10', ''])
  const all = model.updatePaymentAmounts(many, 2, '', '30', true)
  assert.deepEqual(all.map(row => row.amountInput), ['0.00', '0.00', '0.30'])
  assert.equal(model.buildPaymentResolutionDraft(all, 'expense', null, '核对', '30').valid, true)
})
