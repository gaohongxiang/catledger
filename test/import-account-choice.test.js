const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const model = require('../miniprogram/pages/import-workbench/model')

function pageFor(issue, accounts = [], importApi = {}, draftService = {}) {
  let definition
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/import-workbench/index.js'), 'utf8'), {
    require: (name) => name === '../../services/view-patch' ? require('../miniprogram/services/view-patch') : name === './final-detail' ? require('../miniprogram/pages/import-workbench/final-detail') : name === './model' ? model : name === '../../services/catledger-import' ? importApi : name === '../../services/import-draft-session' ? draftService : { bindPage() {} },
    getApp: () => ({ globalData: {} }),
    Page: (page) => { definition = page }
  })
  return Object.assign({}, definition, {
    _accountUiDrafts: new Map(),
    data: Object.assign({}, definition.data, {
      update: { updateId: 'synthetic-update' }, accountIssues: [issue], accounts
    }),
    setData(patch) {
      for (const [key, value] of Object.entries(patch)) {
        const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
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

test('重复摘要列表使用明确duplicate计数，进入tab不逐条请求证据', async () => {
  let calls = 0
  const page = pageFor(unknownIssue(), [], { callImport: async () => { calls++; return { evidence: [{ evidenceRole: 'duplicate' }] } } })
  page.data.duplicateReviewCandidates = [{ eventId: 'dup', duplicateEvidenceCount: 2 }, { eventId: 'support', evidenceCount: 3, duplicateEvidenceCount: 0 }]
  await page.loadDuplicateRecords()
  assert.equal(calls, 0)
  assert.equal(page.data.duplicateReviewEvents.length, 1)
  assert.equal(page.data.duplicateReviewEvents[0].duplicateCount, 2)
  assert.equal(page.data.duplicateReviewLoaded, true)
  await page.openEvidence({ currentTarget: { dataset: { id: 'dup' } } })
  assert.equal(calls, 1)
  assert.equal(page.data.evidenceSheet.eventId, 'dup')
})

test('单条证据失败可再次打开重试，关闭后旧结果不得回填', async () => {
  let fail = true, release
  const page = pageFor(unknownIssue(), [], { callImport: async () => {
    if (fail) throw new Error('合成读取失败')
    return new Promise(resolve => { release = resolve })
  } })
  const event = { currentTarget: { dataset: { id: 'synthetic' } } }
  await page.openEvidence(event)
  assert.match(page.data.errorMessage, /读取失败/)
  fail = false
  const pending = page.openEvidence(event)
  page.closeEvidence()
  release({ evidence: [{ evidenceRole: 'duplicate' }] }); await pending
  assert.equal(page.data.evidenceSheet, null)
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

function accountView(issues, accounts = []) {
  return { update: { updateId: 'synthetic-update', status: 'review', counts: {} },
    issues, accounts, events: [], sources: [], categories: [], accountDrafts: [] }
}
const accountTap = (id) => ({ currentTarget: { dataset: { id } } })
const stepTap = (step) => ({ currentTarget: { dataset: { step } } })

test('单项确认零请求，不受其他未填写项阻止，立即显示真实名称摘要', async () => {
  const target = { ...unknownIssue(), issueId: 'ready', blocking: true,
    accountContext: { recognized: true, label: '测试信用账户', sourceType: 'alipay' } }
  const other = { ...unknownIssue(), issueId: 'other', blocking: true }
  let calls = 0
  const page = pageFor(target, [], { async callImport() { calls += 1 } })
  page.setData({ currentStep: 2, accountIssues: [target, other] })
  page.refreshAccountMappings()
  page.completeAccountMapping(accountTap('ready'))
  assert.equal(calls, 0)
  assert.equal(page.data.busy, false)
  assert.equal(page.data.accountMappings[0].needsConfirmation, false)
  assert.match(page.data.accountMappings[0].summaryText, /测试信用账户/)
  assert.equal(page.data.accountStepSummary.pending, 1)
  assert.equal(page.data.accountStepSummary.confirmed, 1)
  await page.goToStep(stepTap(3))
  assert.equal(calls, 0)
  assert.equal(page.data.currentStep, 2)
})

test('全部本地确认后，下一步一个请求提交新增、改选与忽略，成功才进入整理', async () => {
  const issues = [
    { ...unknownIssue(), issueId: 'create', blocking: true, accountContext: { recognized: true, label: '测试钱包' } },
    { ...unknownIssue(), issueId: 'revise', status: 'resolved', accountContext: { recognized: true, accountId: 'wallet', label: '既有钱包' } },
    { ...unknownIssue(), issueId: 'ignore', blocking: true },
    { ...unknownIssue(), issueId: 'saved', status: 'resolved', accountContext: { accountId: 'wallet' } }
  ]
  const accounts = [{ accountId: 'wallet', name: '既有钱包', type: 'wallet' }]
  const calls = []
  const page = pageFor(issues[0], accounts, { createRequestId: () => 'request', async callImport(action, input) {
    calls.push({ action, input })
    assert.equal(page.data.currentStep, 2)
    assert.equal(page.data.busy, true)
    return accountView(issues.map(issue => ({ ...issue, status: 'resolved', accountContext: { ...issue.accountContext, accountId: 'wallet' } })), accounts)
  } })
  page.setData({ currentStep: 2, unlockedStep: 2, accountIssues: issues })
  page.refreshAccountMappings()
  page.openAccountChoice(accountTap('revise'))
  page.selectAccountChoice({ currentTarget: { dataset: { value: 'ignore_future' } } })
  page.openAccountChoice(accountTap('ignore'))
  page.selectAccountChoice({ currentTarget: { dataset: { value: 'ignore' } } })
  for (const id of ['create', 'revise', 'ignore']) page.completeAccountMapping(accountTap(id))
  assert.equal(calls.length, 0)
  assert.equal(page.data.accountStepSummary.pending, 0)
  assert.equal(page.data.currentStep, 2)
  await page.goToStep(stepTap(3))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'reviewIssues.resolveAccountMappings')
  const decisions = calls[0].input.decisions
  assert.equal(decisions.length, 3)
  assert.equal(decisions[0].fields.mappingAccountDraft.name, '测试钱包')
  assert.equal(decisions[1].operation, 'revise')
  assert.equal(decisions[1].paymentRuleAction, 'ignore')
  assert.equal(decisions[2].decision, 'exclude_events')
  assert.equal(page.data.currentStep, 3)
  assert.equal(page.data.busy, false)
  await page.goToStep(stepTap(2))
  await page.goToStep(stepTap(3))
  assert.equal(calls.length, 1)
})

test('改选、名称和类型变化撤销本地确认，返回与服务端重读保留当前草稿确认', async () => {
  const issue = { ...unknownIssue(), status: 'resolved', accountContext: { recognized: true, accountId: 'wallet', label: '测试钱包' } }
  const accounts = [{ accountId: 'wallet', name: '测试钱包', type: 'wallet' }]
  const page = pageFor(issue, accounts)
  page.setData({ currentStep: 2, unlockedStep: 4 })
  page.refreshAccountMappings()
  page.openAccountChoice(accountTap(issue.issueId))
  page.selectAccountChoice({ currentTarget: { dataset: { value: 'create' } } })
  assert.equal(page.data.accountStepSummary.pending, 1)
  page.completeAccountMapping(accountTap(issue.issueId))
  page.bindAccountDraftName({ ...accountTap(issue.issueId), detail: { value: '修改后的钱包' } })
  assert.equal(page.data.accountStepSummary.pending, 1)
  page.completeAccountMapping(accountTap(issue.issueId))
  page.changeAccountDraftType({ ...accountTap(issue.issueId), detail: { value: '1' } })
  assert.equal(page.data.accountStepSummary.pending, 1)
  page.completeAccountMapping(accountTap(issue.issueId))
  await page.goToStep(stepTap(1))
  await page.goToStep(stepTap(2))
  page.applyUpdateView(accountView([issue], accounts))
  assert.equal(page.data.accountMappings[0].draftName, '修改后的钱包')
  assert.equal(page.data.accountMappings[0].needsConfirmation, false)
  assert.equal(page.data.accountStepSummary.dirty, 1)
  await page.postUpdate()
  assert.equal(page.data.busy, false)
  page.changeAccountDraftType({ ...accountTap(issue.issueId), detail: { value: '999' } })
  assert.equal(page.data.accountStepSummary.pending, 1)
  page.completeAccountMapping(accountTap(issue.issueId))
  assert.match(page.data.accountStepError, /补全账户名称/)
  await page.goToStep(stepTap(4))
  assert.equal(page.data.currentStep, 2)
})

test('下一步失败保留本地确认并复用幂等请求，编辑后生成新请求', async () => {
  const issue = { ...unknownIssue(), blocking: true, accountContext: { recognized: true, label: '测试钱包' } }
  const payloads = []; let request = 0
  const page = pageFor(issue, [], { createRequestId: () => 'request-' + (++request), async callImport(action, input) {
    payloads.push(input)
    throw new Error('模拟保存失败')
  } })
  page.setData({ currentStep: 2 })
  page.refreshAccountMappings()
  page.bindAccountDraftName({ ...accountTap(issue.issueId), detail: { value: '保留输入' } })
  page.completeAccountMapping(accountTap(issue.issueId))
  await page.goToStep(stepTap(3))
  assert.match(page.data.accountStepError, /模拟保存失败/)
  assert.equal(page.data.accountMappings[0].draftName, '保留输入')
  assert.equal(page.data.accountStepSummary.pending, 0)
  assert.equal(page.data.accountMappings[0].needsConfirmation, false)
  assert.equal(page.data.currentStep, 2)
  await page.goToStep(stepTap(3))
  assert.equal(payloads.length, 2)
  assert.equal(payloads[0].requestId, payloads[1].requestId)
  page.bindAccountDraftName({ ...accountTap(issue.issueId), detail: { value: '修改输入' } })
  await page.goToStep(stepTap(3))
  assert.equal(payloads.length, 2)
  page.completeAccountMapping(accountTap(issue.issueId))
  await page.goToStep(stepTap(3))
  assert.notEqual(payloads[2].requestId, payloads[1].requestId)
})

test('下一步请求期间重复点击与编辑均不改变正在提交的决定', async () => {
  const issue = { ...unknownIssue(), blocking: true, accountContext: { recognized: true, label: '测试钱包' } }
  let finish; let calls = 0
  const page = pageFor(issue, [], { createRequestId: () => 'request', callImport() {
    calls += 1
    return new Promise(resolve => { finish = resolve })
  } })
  page.setData({ currentStep: 2 })
  page.completeAccountMapping(accountTap(issue.issueId))
  const save = page.goToStep(stepTap(3))
  assert.equal(page.data.accountStepBusy, true)
  await page.goToStep(stepTap(3))
  await page.goToStep(stepTap(1))
  page.bindAccountDraftName({ ...accountTap(issue.issueId), detail: { value: '不得改变' } })
  assert.equal(page.data.accountMappings[0].draftName, '测试钱包')
  assert.equal(calls, 1)
  finish(accountView([{ ...issue, status: 'resolved', accountContext: { ...issue.accountContext, accountId: 'wallet' } }],
    [{ accountId: 'wallet', name: '测试钱包', type: 'wallet' }]))
  await save
  assert.equal(page.data.currentStep, 3)
})

test('超过50项在下一步顺序处理，后批失败保留前批结果且只重试剩余部分', async () => {
  let issues = Array.from({ length: 51 }, (_, i) => ({ ...unknownIssue(), issueId: 'issue-' + i, blocking: true,
    accountContext: { recognized: true, label: '测试账户' + i } }))
  const accounts = [{ accountId: 'wallet', name: '测试钱包', type: 'wallet' }]
  const payloads = []; let fail = true; let request = 0
  const page = pageFor(issues[0], [], { createRequestId: () => 'request-' + (++request), async callImport(action, input) {
    payloads.push(input)
    if (payloads.length === 2 && fail) throw new Error('后批失败')
    const ids = new Set(input.decisions.map(item => item.issueId))
    issues = issues.map(issue => ids.has(issue.issueId) ? { ...issue, status: 'resolved', accountContext: { ...issue.accountContext, accountId: 'wallet' } } : issue)
    return accountView(issues, accounts)
  } })
  page.setData({ currentStep: 2, accountIssues: issues })
  for (const issue of issues) page.completeAccountMapping(accountTap(issue.issueId))
  await page.goToStep(stepTap(3))
  assert.equal(payloads.length, 2)
  assert.equal(payloads[0].decisions.length, 50)
  assert.equal(payloads[1].decisions.length, 1)
  assert.equal(page.data.currentStep, 2)
  assert.equal(page.data.accountStepSummary.open, 1)
  assert.equal(page.data.accountStepSummary.pending, 0)
  assert.equal(page.data.accountMappings[50].needsConfirmation, false)
  fail = false
  await page.goToStep(stepTap(3))
  assert.equal(payloads[2].decisions.length, 1)
  assert.equal(payloads[2].requestId, payloads[1].requestId)
  assert.equal(page.data.currentStep, 3)
})

function draftPage(view, call) {
  const service = require('../miniprogram/services/import-draft-session')
  const storage = new Map()
  const session = service.create({ scope: 'page-test', view, autoSync: false,
    read: () => null, write: (key, data) => storage.set(key, data), remove: key => storage.delete(key),
    requestId: () => 'request', call })
  const page = pageFor(view.issues[0], view.accounts, {}, { open: () => session, project: service.project })
  page._draftEnabled = true
  page.applyUpdateView(view)
  return { page, session }
}

test('真实Page接入队列：账户确认即时收起，后台返回不覆盖另一项编辑', async () => {
  const a = { ...unknownIssue(), issueId: 'a', blocking: true, accountContext: { recognized: true, label: '账户甲' } }
  const b = { ...unknownIssue(), issueId: 'b', blocking: true, accountContext: { recognized: true, label: '账户乙' } }
  const initial = accountView([a, b]); initial.update.version = 1
  const saved = accountView([{ ...a, status: 'resolved', accountContext: { ...a.accountContext, accountId: 'wallet' } }, b], [{ accountId: 'wallet', name: '账户甲', type: 'wallet' }]); saved.update.version = 2
  let calls = 0
  const { page, session } = draftPage(initial, async action => { calls += 1; return saved })
  page.completeAccountMapping(accountTap('a'))
  assert.equal(calls, 0)
  assert.equal(page.data.accountMappings[0].needsConfirmation, false)
  page.bindAccountDraftName({ ...accountTap('b'), detail: { value: '继续输入的账户乙' } })
  await session.flush()
  assert.equal(page.data.accountMappings[1].draftName, '继续输入的账户乙')
  assert.equal(page.data.accountMappings[0].status, 'resolved')
  assert.equal(page.data.issues[0].status, 'resolved')
})

test('真实Page接入队列：核对即时更新数量，下一步等待服务端权威结果', async () => {
  const issue = { issueId: 'review', issueType: 'shared_fields', status: 'open', blocking: true, version: 1, subjectEventIds: ['event'] }
  const initial = accountView([issue]); initial.update.version = 1
  initial.events = [{ eventId: 'event', status: 'needs_action', economicNature: 'expense', amountMinor: '100' }]
  initial.coverage = { selectedEventsReadyToPost: false }
  let finish
  const saved = { ...initial, update: { ...initial.update, version: 2 }, issues: [{ ...issue, status: 'resolved', blocking: false }],
    events: [{ ...initial.events[0], status: 'ready' }], coverage: { selectedEventsReadyToPost: true } }
  const { page } = draftPage(initial, (action) => action === 'financeUpdates.get' ? Promise.resolve(saved) : new Promise(resolve => { finish = resolve }))
  page.setData({ currentStep: 3, currentIssue: issue, issueEvents: initial.events })
  await page.resolveIssue('apply_fields', { fields: { ledgerAccountId: 'wallet' } })
  assert.equal(page.data.currentIssue, null)
  assert.equal(page.data.busy, false)
  assert.equal(page.data.reviewStatusTabs[0].count, 0)
  assert.equal(page.data.coverage.selectedEventsReadyToPost, false)
  const next = page.finishDraftStep(4)
  assert.equal(page.data.currentStep, 3)
  finish({ update: saved.update }); await next
  assert.equal(page.data.currentStep, 4)
  assert.equal(page.data.coverage.selectedEventsReadyToPost, true)
})

test('真实Page接入队列：后台重读不关闭另一个正在填写的核对弹层', async () => {
  const issue = { issueId: 'a', issueType: 'shared_fields', status: 'open', blocking: true, version: 1, subjectEventIds: ['a-event'] }
  const other = { ...issue, issueId: 'b', subjectEventIds: ['b-event'] }
  const view = accountView([issue, other]); view.update.version = 1
  const saved = { ...view, update: { ...view.update, version: 2 }, issues: [{ ...issue, status: 'resolved', blocking: false }, other] }
  const { page, session } = draftPage(view, async action => action === 'financeUpdates.get' ? saved : { update: saved.update })
  page.setData({ currentStep: 3, currentIssue: issue, issueEvents: [] })
  await page.resolveIssue('apply_fields', { fields: { ledgerAccountId: 'wallet' } })
  page.setData({ currentIssue: other, 'issueDraft.newAccountName': '正在填写的名称' })
  await session.flush()
  assert.equal(page.data.currentIssue.issueId, 'b')
  assert.equal(page.data.issueDraft.newAccountName, '正在填写的名称')
  assert.equal(page.data.issues[0].status, 'resolved')
})


test('第二步到第三步：同步期间不提前解锁按钮或渲染其他步骤', async () => {
  const issue = { ...unknownIssue(), issueId: 'a', blocking: true, accountContext: { recognized: true, label: '账户甲' } }
  const initial = accountView([issue]); initial.update.version = 1
  const saved = accountView([{ ...issue, status: 'resolved', accountContext: { ...issue.accountContext, accountId: 'wallet' } }], [{ accountId: 'wallet', name: '账户甲', type: 'wallet' }])
  saved.update.version = 2
  const { page } = draftPage(initial, async () => saved)
  page.completeAccountMapping(accountTap('a'))
  const frames = []
  const setData = page.setData
  page.setData = function (patch) {
    setData.call(this, patch)
    frames.push({ step: this.data.currentStep, busy: this.data.busy })
  }
  await page.goToStep({ currentTarget: { dataset: { step: 3 } } })
  assert.equal(page.data.currentStep, 3)
  assert.equal(page.data.busy, false)
  assert.ok(frames.length > 1)
  assert.ok(frames.slice(0, -1).every(frame => frame.busy), '请求完成并切换之前按钮始终保持忙碌')
  const transitions = frames.map(frame => frame.step).filter((step, index, steps) => !index || step !== steps[index - 1])
  assert.deepEqual(transitions, [2, 3], '只从账户切到整理，不出现中间步骤')
})


test('重入自动恢复全部内容但首帧落在第一步，后台同步不跳走', () => {
  const issue = { ...unknownIssue(), issueId: 'restore', blocking: true }
  const view = accountView([issue]); view.sources = [{ sourceId: 's', fileName: '合成.csv' }]
  const { page, session } = draftPage(view, async () => view)
  const frames = [], setData = page.setData
  page.setData = function (patch) { setData.call(this, patch); frames.push(this.data.currentStep) }
  page.applyUpdateView(view, false, true)
  assert.deepEqual(frames, [1])
  assert.equal(page.data.sources[0].fileName, '合成.csv')
  assert.equal(page.data.accountIssues[0].issueId, 'restore')
  assert.equal(page._draftSession, session)
  page.applyUpdateView(view, true)
  assert.equal(page.data.currentStep, 1)
  assert.ok(page.data.unlockedStep >= 2)
})

test('返回已有导入页面自动回第一步，不暂停会话或清除已选内容', () => {
  const view = accountView([unknownIssue()]); const { page, session } = draftPage(view, async () => view)
  page.setData({ currentStep: 3, currentIssue: { issueId: 'open' } })
  page.onHide(); page.onShow()
  assert.equal(page.data.currentStep, 1); assert.equal(page.data.currentIssue, null)
  assert.equal(page._draftSession, session); assert.equal(page.data.accountIssues.length, 1)
})

test('已入账结果不因重入标记退回第一步', () => {
  const view = accountView([]); view.update.status = 'posted'
  const page = pageFor(unknownIssue()); page.applyUpdateView(view, false, true)
  assert.equal(page.data.currentStep, 4)
})


test('恢复读取中可以放弃，不再整理或应用迟到视图', async () => {
  const calls = [], cleared = []; let release
  const view = accountView([unknownIssue()]); view.update.version = 3; view.update.requiresReorganization = true
  const page = pageFor(unknownIssue(), [], { createRequestId: () => 'abandon-request', callImport(action) {
    calls.push(action)
    if (calls.length === 1) return new Promise(resolve => { release = resolve })
    return Promise.resolve(view)
  } }, { async pauseUpdate() {}, clearUpdate(id) { cleared.push(id) }, forgetLast() {} })
  page._sourceFiles = new Map()
  const loading = page.loadUpdate(view.update.updateId, true)
  assert.equal(page.data.busy, true)
  const abandoning = page.abandonRestoringUpdate()
  assert.equal(page.data.abandoningRestore, true)
  release(view); await Promise.all([loading, abandoning])
  assert.deepEqual(calls, ['financeUpdates.get', 'financeUpdates.get', 'financeUpdates.abandon'])
  assert.equal(page.data.currentStep, 1); assert.equal(page.data.phase, 'idle'); assert.equal(page.data.update, null)
  assert.deepEqual(cleared, [view.update.updateId])
})

test('恢复整理已在途时等待该请求落定，后续刷新不执行，放弃失败可重试', async () => {
  const calls = []; let release, fail = true
  const view = accountView([unknownIssue()]); view.update.version = 1; view.update.requiresReorganization = true
  const cleared = []
  const page = pageFor(unknownIssue(), [], { createRequestId: () => 'request', callImport(action) {
    calls.push(action)
    if (action === 'financeUpdates.organize') return new Promise(resolve => { release = resolve })
    if (action === 'financeUpdates.abandon' && fail) return Promise.reject(new Error('offline'))
    return Promise.resolve(view)
  } }, { async pauseUpdate() {}, clearUpdate(id) { cleared.push(id) }, forgetLast() {} })
  page._sourceFiles = new Map()
  const loading = page.loadUpdate(view.update.updateId, true)
  await new Promise(resolve => setImmediate(resolve))
  const abandoning = page.abandonRestoringUpdate()
  view.update.version = 2; release(view); await Promise.all([loading, abandoning])
  assert.equal(calls.includes('reviewIssues.refreshAccountGroups'), false)
  assert.deepEqual(cleared, []); assert.equal(page.data.abandoningRestore, false)
  assert.equal(page.data.restoreUpdateId, view.update.updateId)
  fail = false; await page.abandonRestoringUpdate()
  assert.equal(page.data.phase, 'idle'); assert.deepEqual(cleared, [view.update.updateId])
})


test('输入名称、备注和分配金额时后台完成不能向编辑表单回写，失焦后保留最新输入', () => {
  const view = accountView([unknownIssue()]); const { page } = draftPage(view, async () => view)
  page.data.currentIssue = { issueId: 'editing', issueType: 'transfer_accounts' }
  page.data.issueDraft = { newAccountName: '', repaymentOwner: 'self' }
  page.data.paymentRows = [{ componentIndex: 0, amountInput: '2.' }]
  page.data.paymentEvidenceNote = '正在输入的说明'
  page.data.repaymentAllocationChoices = [{ accountId: 'new', isNew: true, name: '新增信用卡', amountInput: '3.' }]
  const patches = [], original = page.setData
  page.setData = function (patch) { patches.push(JSON.parse(JSON.stringify(patch))); original.call(this, patch) }
  page.beginInputEditing({ currentTarget: { dataset: { inputKey: 'changeDraftAccountName' } } })
  for (const name of ['中', '中文', '中文账户', '中文账户0022']) {
    page.changeDraftAccountName({ detail: { value: name } })
    patches.length = 0
    page.applyUpdateView({ ...view, update: { ...view.update, version: 2 } }, true)
    assert.deepEqual(patches, [])
    assert.equal(page.data.issueDraft.newAccountName, name)
  }
  page.finishInputEditing()
  assert.equal(page.data.issueDraft.newAccountName, '中文账户0022')
  assert.equal(page.data.paymentRows[0].amountInput, '2.')
  assert.equal(page.data.paymentEvidenceNote, '正在输入的说明')
  assert.equal(page.data.repaymentAllocationChoices[0].name, '新增信用卡')
  assert.equal(page.data.repaymentAllocationChoices[0].amountInput, '3.')
  assert.ok(patches.every(patch => Object.keys(patch).every(key => !/^(issueDraft|paymentRows|paymentEvidenceNote|repaymentAllocationChoices)(\.|\[|$)/.test(key))))
})

test('后台不重新发送未改动的表单对象，即使输入框暂时失焦', () => {
  const view = accountView([unknownIssue()]); const { page } = draftPage(view, async () => view)
  page.data.currentIssue = { issueId: 'editing' }; page.data.issueDraft.newAccountName = '未提交名称'
  const patches = [], original = page.setData
  page.setData = function (patch) { patches.push(patch); original.call(this, patch) }
  page.applyUpdateView(view, true)
  assert.equal(page.data.currentIssue.issueId, 'editing')
  assert.ok(patches.every(patch => !Object.keys(patch).some(key => /^(issueDraft|currentIssue|paymentRows|repaymentAllocationChoices)(\.|\[|$)/.test(key))))
})

test('修改分配金额只更新对应字段，不能把另一行名称重新下发', () => {
  const page = pageFor(unknownIssue()); page.data.issueEvents = [{ amountMinor: '10000' }]
  page.data.repaymentAllocationChoices = [
    { accountId: 'new-a', isNew: true, name: '正在编写的账户', amountInput: '' },
    { accountId: 'b', name: '已有账户', amountInput: '' }
  ]
  const patches = [], original = page.setData
  page.setData = function (patch) { patches.push(patch); original.call(this, patch) }
  page.changeRepaymentAllocation({ currentTarget: { dataset: { index: 1 } }, detail: { value: '50.' } })
  assert.equal(page.data.repaymentAllocationChoices[1].amountInput, '50.')
  assert.ok(patches.some(patch => patch['repaymentAllocationChoices[1].amountInput'] === '50.'))
  assert.ok(patches.every(patch => !Object.keys(patch).some(key => key === 'repaymentAllocationChoices' || key.includes('[0].name'))))
})

test('仅草稿同步状态变化不重算事件、分类、核对或资金摘要', async () => {
  const view = accountView([{ issueId: 'review', issueType: 'shared_fields', status: 'open', blocking: true, version: 1, subjectEventIds: ['event'] }])
  view.events = [{ eventId: 'event', status: 'needs_action', economicNature: 'expense', amountMinor: '100' }]
  const { page, session } = draftPage(view, async () => { throw Object.assign(new Error('合成网络失败'), { code: 'CLOUD_CALL_FAILED' }) })
  session.enqueue([{ kind: 'review', issueId: 'review', issueVersion: 1, subjectIds: ['event'], issueType: 'shared_fields', decision: { decision: 'apply_fields', fields: {} } }])
  const names = ['eventView', 'organizerRecordState', 'categoryIssueCards', 'reviewIssueGroups', 'finalSummary', 'fundsFlowSummary']
  const original = Object.fromEntries(names.map(name => [name, model[name]]))
  let calls = 0
  names.forEach(name => { model[name] = (...args) => { calls++; return original[name](...args) } })
  try {
    const pending = session.flush()
    assert.equal(page.data.draftSync.syncing, true)
    await assert.rejects(pending)
    assert.equal(page.data.draftSync.syncing, false)
    assert.equal(page.data.draftSync.pending, 1)
    assert.match(page.data.draftSync.error, /网络恢复/)
    assert.equal(calls, 0)
  } finally { names.forEach(name => { model[name] = original[name] }) }
})
