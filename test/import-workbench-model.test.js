const assert = require('node:assert/strict')
const test = require('node:test')

const model = require('../miniprogram/pages/import-workbench/model')

test('多文件摘要分别统计解析成功与失败，不把失败文件伪装成整批失败', function () {
  const files = [
    { clientId: 'a', state: 'ready' },
    { clientId: 'b', state: 'failed' },
    { clientId: 'c', state: 'duplicate' },
    { clientId: 'd', state: 'ready' }
  ]
  assert.deepEqual(model.uploadSummary(files), { total: 4, queued: 0, ready: 2, failed: 1, attention: 2 })
})

test('解析失败后追加的新账单仍可单独进入待解析队列', function () {
  const files = [
    { clientId: 'a', state: 'failed' },
    { clientId: 'b', state: 'queued' }
  ]
  assert.deepEqual(model.uploadSummary(files), { total: 2, queued: 1, ready: 0, failed: 1, attention: 1 })
})

test('未入账旧整理由服务端直接替换，文件列表只需标记已经入账的重复文件', function () {
  assert.equal(model.fileStateText('duplicate'), '已经入账')
  assert.deepEqual(model.uploadSummary([{ state: 'duplicate' }]), {
    total: 1, queued: 0, ready: 0, failed: 0, attention: 1
  })
})

test('文件状态更新只影响目标来源身份', function () {
  const files = [
    { clientId: 'a', state: 'uploading', progress: 10 },
    { clientId: 'b', state: 'uploading', progress: 20 }
  ]
  const result = model.updateFile(files, 'b', { state: 'failed', progress: 20 })
  assert.deepEqual(result, [
    { clientId: 'a', state: 'uploading', progress: 10 },
    { clientId: 'b', state: 'failed', progress: 20 }
  ])
  assert.notEqual(result, files)
})

test('本地重复账单必须元数据与文件内容都相同', function () {
  assert.equal(model.sameFileMetadata(
    { name: '账单.csv', size: 3 },
    { name: '账单.csv', size: 3 }
  ), true)
  assert.equal(model.sameFileMetadata(
    { name: '账单.csv', size: 3 },
    { name: '账单.csv', size: 4 }
  ), false)
  assert.equal(model.sameFileContent(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 3])), true)
  assert.equal(model.sameFileContent(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 4])), false)
})

test('ReviewIssue 使用原业务类型而不是 post/skip 行决定', function () {
  const issue = model.issueView({
    issueId: 'issue-1',
    issueType: 'same_event',
    reasonCodes: ['same_event_candidate', 'relation_ambiguous']
  })
  assert.equal(issue.label, '判断是否同一笔')
  assert.equal(issue.reasonText, '确认不同来源记录是不是同一笔交易')
  assert.equal(Object.prototype.hasOwnProperty.call(issue, 'disposition'), false)
})

test('账户问题使用支付账户标题，资金流转保留双账户语义', function () {
  const context = { label: '微信零钱', recognized: true, sourceType: 'wechat' }
  assert.equal(model.issueView({ issueType: 'account_mapping', accountContext: context }).label, '微信零钱')
  assert.equal(model.issueView({ issueType: 'transfer_accounts', accountContext: context }).label, '资金流转 · 微信零钱')
})

test('只有稳定识别的支付工具显示以后不计入', function () {
  const reusable = model.accountChoiceOptions([], [], true)
  assert.deepEqual(reusable.slice(-2), [
    { value: 'ignore', name: '仅本次不计入' },
    { value: 'ignore_future', name: '以后不计入' }
  ])
  const generic = model.accountChoiceOptions([], [], false)
  assert.deepEqual(generic.slice(-1), [{ value: 'ignore', name: '仅本次不计入' }])
  assert.equal(generic.some(function (choice) { return choice.value === 'ignore_future' }), false)
})

test('资金投影只把真正缺失的一端交给用户', function () {
  const base = {
    issueType: 'transfer_accounts',
    subject: {
      ledgerAccountId: 'account-balance',
      counterpartyLedgerAccountId: null,
      fundsProjection: {
        from: { label: '支付宝账户余额' },
        to: { label: '浙江农商联合银行' }
      }
    }
  }
  const missingTo = model.issueView(base)
  assert.equal(missingTo.label, '转入账户待确认')
  assert.equal(missingTo.missingFundsSide, 'to')
  assert.equal(missingTo.missingAccountLabel, '转入账户')

  const missingFrom = model.issueView({
    issueType: 'transfer_accounts',
    subject: Object.assign({}, base.subject, { ledgerAccountId: null, counterpartyLedgerAccountId: 'account-card' })
  })
  assert.equal(missingFrom.label, '转出账户待确认')
  assert.equal(missingFrom.missingFundsSide, 'from')

  const bothMissing = model.issueView({ issueType: 'transfer_accounts', subject: {} })
  assert.equal(bothMissing.missingAccountLabel, '转出账户')
})

test('聚合还款只列出本事件候选集内的真实负债账户', function () {
  const issue = model.issueView({
    issueType: 'transfer_accounts',
    subject: {
      ledgerAccountId: 'bank', counterpartyLedgerAccountId: null, amountMinor: '10000',
      fundsProjection: {
        from: { label: '浙江农商联合银行储蓄卡(5564)' },
        to: {
          referenceKind: 'aggregate', label: '支付宝花呗｜信用购',
          candidates: [{ accountId: 'credit' }, { accountId: 'huabei' }]
        }
      }
    }
  })
  assert.equal(issue.aggregateRepayment, true)
  assert.equal(issue.label, '还款分配待确认')
  assert.equal(issue.missingFundsSide, 'allocation')

  const options = model.repaymentAllocationOptions([
    { accountId: 'other', name: '其他信用卡', type: 'credit' },
    { accountId: 'huabei', name: '支付宝花呗', type: 'credit' },
    { accountId: 'cash', name: '现金', type: 'cash' }
  ], [
    { accountId: 'credit', name: '江苏银行信用购', type: 'credit' }
  ], issue.fundsProjection)
  assert.deepEqual(options.map(function (item) { return item.accountId }), ['credit', 'huabei'])
  assert.deepEqual(options.map(function (item) { return item.recommended }), [true, true])
  assert.equal(model.yuanInputToMinor('61.2'), '6120')
  assert.equal(model.yuanInputToMinor('1.234'), null)
  assert.deepEqual(model.buildRepaymentAllocationDraft([
    { accountId: 'credit', amountInput: '60' },
    { accountId: 'huabei', amountInput: '40' }
  ], '10000'), {
    valid: true, reason: '', remainingMinor: '0',
    allocations: [
      { accountId: 'credit', amountMinor: '6000' },
      { accountId: 'huabei', amountMinor: '4000' }
    ]
  })
  assert.deepEqual(model.buildRepaymentAllocationDraft([
    { accountId: 'credit', amountInput: '60.01' },
    { accountId: 'huabei', amountInput: '40' }
  ], '10000'), {
    valid: false, reason: '分配金额不能超过本笔还款', remainingMinor: '-1',
    allocations: [
      { accountId: 'credit', amountMinor: '6001' },
      { accountId: 'huabei', amountMinor: '4000' }
    ]
  })
})

test('账户选择面板支持类型说明、搜索并可排除顶部推荐项', function () {
  const options = model.accountSelectorOptions([
    { accountId: 'everbright', name: '光大银行信用卡(2690)', type: 'credit' },
    { accountId: 'alipay', name: '支付宝账户余额', type: 'wallet' }
  ], [
    { accountId: 'wechat-draft', name: '微信零钱', type: 'wallet' }
  ])
  assert.deepEqual(options.map(function (option) { return option.detail }), [
    '信用卡 / 消费信贷', '平台钱包', '平台钱包'
  ])
  assert.equal(options[2].name, '微信零钱（本批新建）')
  assert.deepEqual(
    model.filterAccountSelectorOptions(options, '支付 宝', 'everbright').map(function (option) { return option.accountId }),
    ['alipay']
  )
})

test('最多五份文件可并行上传解析且全部任务都会收口', async function () {
  let active = 0
  let maximum = 0
  const completed = []
  await model.runWithConcurrency([1, 2, 3, 4, 5], 5, async function (value) {
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise(function (resolve) { setTimeout(resolve, 4) })
    completed.push(value)
    active -= 1
  })
  assert.equal(maximum, 5)
  assert.deepEqual(completed.sort(), [1, 2, 3, 4, 5])
})

test('支付工具唯一匹配已有账户时默认沿用，兼容标点、银行主体和尾号', function () {
  assert.equal(model.normalizePaymentAccountName(' 光大银行-信用卡（2690） '), '光大银行信用卡2690')
  assert.equal(model.normalizePaymentAccountName('ＡＢＣ Wallet 123'), 'abcwallet123')
  const nativeNormalize = String.prototype.normalize
  try {
    String.prototype.normalize = undefined
    assert.equal(model.normalizePaymentAccountName('ＡＢＣ账户（１２３４）'), 'abc账户1234')
  } finally {
    String.prototype.normalize = nativeNormalize
  }
  const accounts = [
    { accountId: 'everbright', name: '光大银行信用卡(2690)', currency: 'CNY' },
    { accountId: 'xingye', name: '兴业信用卡 6106', currency: 'CNY' },
    { accountId: 'xingye-usd', name: '兴业银行信用卡6106', currency: 'USD' }
  ]
  assert.equal(model.suggestExistingAccount({
    label: '光大银行信用卡（2690）', sourceType: 'wechat', recognized: true
  }, accounts).accountId, 'everbright')
  assert.equal(model.suggestExistingAccount({
    label: '兴业银行信用卡 尾号6106', sourceType: 'wechat', recognized: true
  }, accounts).accountId, 'xingye')
})

test('平台余额别名可推荐已有账户，但不同银行同尾号和并列候选不猜测', function () {
  assert.equal(model.suggestExistingAccount({
    label: '支付宝账户余额', sourceType: 'alipay', recognized: true
  }, [{ accountId: 'alipay', name: '支付宝余额', currency: 'CNY' }]).accountId, 'alipay')
  assert.equal(model.suggestExistingAccount({
    label: '光大银行信用卡(2690)', sourceType: 'wechat', recognized: true
  }, [{ accountId: 'other', name: '其他银行信用卡(2690)', currency: 'CNY' }]), null)
  assert.equal(model.suggestExistingAccount({
    label: '兴业银行信用卡(6106)', sourceType: 'wechat', recognized: true
  }, [
    { accountId: 'a', name: '兴业信用卡6106', currency: 'CNY' },
    { accountId: 'b', name: '兴业银行贷记卡6106', currency: 'CNY' }
  ]), null)
  assert.equal(model.suggestExistingAccount({
    label: '银行卡', sourceType: 'wechat', recognized: false
  }, [{ accountId: 'generic', name: '银行卡', currency: 'CNY' }]), null)
})

test('账户问题与其他整理问题分步展示，门禁按未解决问题推进', function () {
  const groups = model.partitionOpenIssues([
    { issueType: 'same_event', issueId: 'same' },
    { issueType: 'account_mapping', issueId: 'account' },
    { issueType: 'transfer_accounts', issueId: 'transfer' },
    { issueType: 'refund_relation', issueId: 'refund' }
  ])
  assert.deepEqual(groups.account.map(function (issue) { return issue.issueId }), ['account'])
  assert.deepEqual(groups.review.map(function (issue) { return issue.issueId }), ['same', 'transfer', 'refund'])
  assert.deepEqual(model.workflowPosition('needs_action', groups), { currentStep: 2, unlockedStep: 2 })
  assert.deepEqual(model.workflowPosition('needs_action', { account: [], review: groups.review }), { currentStep: 3, unlockedStep: 3 })
  assert.deepEqual(model.workflowPosition('ready', { account: [], review: [] }), { currentStep: 4, unlockedStep: 4 })
})

test('金额与文件大小使用展示字符串且不经过浮点金额计算', function () {
  assert.equal(model.amountText('1234'), '¥12.34')
  assert.equal(model.amountText('1'), '¥0.01')
  assert.equal(model.formatFileSize(1024), '1.0 KB')
})

test('问题事件缺少主证据时仍安全展示，分类只匹配经济性质', function () {
  assert.deepEqual(model.eventView({ amountMinor: '500', economicNature: 'refund', primaryEvidence: null }), {
    amountMinor: '500', economicNature: 'refund', primaryEvidence: null,
    amountText: '¥5.00', displayTitle: 'refund', displayMeta: '',
    displayDay: '', displayMonth: '', displayDetailMeta: '', directionClass: ''
  })
  const categories = [
    { categoryId: 'income', kind: 'income' },
    { categoryId: 'expense', kind: 'expense' }
  ]
  assert.deepEqual(model.categoriesForNature(categories, 'income'), [categories[0]])
  assert.deepEqual(model.categoriesForNature(categories, 'refund'), [])
})

test('整理问题按类型分组，并直接展示退款交易与候选数量', function () {
  const rows = model.reviewIssueRows([
    {
      issueId: 'refund-2', issueType: 'refund_relation', candidateCount: 0,
      subject: {
        eventId: 'event-2', localAt: '2026-08-03 12:30:00.000', amountMinor: '300', currency: 'CNY',
        flowDirection: 'inflow', economicNature: 'refund',
        primaryEvidence: { sourceType: 'wechat', item: '部分退款', counterparty: '示例商户' }
      }
    },
    {
      issueId: 'same-1', issueType: 'same_event', candidateCount: 1,
      subject: { eventId: 'event-3', amountMinor: '1000', primaryEvidence: { item: '午餐' } }
    },
    {
      issueId: 'refund-1', issueType: 'refund_relation', candidateCount: 2,
      subject: {
        eventId: 'event-1', localAt: '2026-08-02 09:00:00.000', amountMinor: '500', currency: 'CNY',
        flowDirection: 'inflow', economicNature: 'refund',
        primaryEvidence: { sourceType: 'alipay', item: '退款到账', counterparty: '另一商户' }
      }
    }
  ])

  assert.deepEqual(rows.map(function (item) { return item.issueId }), ['refund-1', 'refund-2', 'same-1'])
  assert.equal(rows[0].groupStart, true)
  assert.equal(rows[0].groupLabel, '退款关系')
  assert.equal(rows[0].groupCount, 2)
  assert.equal(rows[0].subjectTitle, '退款到账')
  assert.equal(rows[0].subjectAmountText, '¥5.00')
  assert.equal(model.eventView(rows[0].subject).displayDay, '02')
  assert.equal(model.eventView(rows[0].subject).displayMonth, '8月')
  assert.equal(rows[0].decisionText, '2 笔候选待核对')
  assert.equal(rows[1].groupStart, false)
  assert.equal(rows[1].decisionText, '未找到可确认的原消费')
  assert.equal(rows[2].groupStart, true)
})

test('退款在主页面逐笔直接展示，不创建顺序处理入口', function () {
  const issues = Array.from({ length: 5 }, function (_, index) {
    return {
      issueId: 'refund-' + index,
      issueType: 'refund_relation',
      memberCount: 1,
      candidateCount: 0,
      subject: {
        eventId: 'event-' + index,
        localAt: '2026-08-0' + (index + 1) + ' 09:00:00.000',
        amountMinor: String((index + 1) * 100),
        flowDirection: 'inflow',
        economicNature: 'refund',
        primaryEvidence: { sourceType: 'alipay', item: '退款到账 ' + index }
      }
    }
  })
  const groups = model.reviewIssueGroups(issues)
  assert.equal(groups.length, 1)
  assert.equal(Object.prototype.hasOwnProperty.call(groups[0], 'sequential'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(groups[0], 'firstIssueId'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(groups[0], 'previews'), false)
  assert.equal(groups[0].count, 5)
  assert.equal(groups[0].issues.length, 5)
  assert.equal(groups[0].issues[0].primarySubject.displayTitle, '退款到账 0')
  assert.equal(Object.prototype.hasOwnProperty.call(groups[0], 'actionText'), false)
})

test('已排除交易按明确原因和具体账户分组并默认收起', function () {
  const groups = model.excludedEventGroups([
    {
      eventId: 'account-1', status: 'excluded', reasonCodes: ['manual_exclusion', 'account_mapping_excluded'],
      localAt: '2026-07-14 14:14:00.000', amountMinor: '2455', flowDirection: 'outflow', economicNature: 'expense',
      primaryEvidence: { sourceType: 'alipay', paymentMethod: '支付宝小荷包（树与草的小荷包）', item: '健身弹力带' }
    },
    {
      eventId: 'account-2', status: 'excluded', reasonCodes: ['account_mapping_excluded'],
      localAt: '2026-07-14 14:26:00.000', amountMinor: '1600', flowDirection: 'outflow', economicNature: 'expense',
      primaryEvidence: { sourceType: 'alipay', paymentMethod: '支付宝小荷包（树与草的小荷包）', item: '眼镜礼品' }
    },
    {
      eventId: 'account-legacy', status: 'excluded', reasonCodes: ['manual_exclusion', 'source_account_ignored_default'],
      localAt: '2026-07-14 14:33:00.000', amountMinor: '1600', flowDirection: 'outflow', economicNature: 'expense',
      primaryEvidence: { sourceType: 'alipay', paymentMethod: '支付宝小荷包（树与草的小荷包）', item: '旧批次账户排除' }
    },
    {
      eventId: 'closed-1', status: 'excluded', reasonCodes: ['transaction_closed'],
      localAt: '2026-07-15 09:00:00.000', amountMinor: '4800', flowDirection: 'outflow', economicNature: 'expense',
      primaryEvidence: { sourceType: 'alipay', paymentMethod: '支付宝账户余额', item: '设备续费' }
    },
    {
      eventId: 'failed-1', status: 'excluded', reasonCodes: ['transaction_failed'],
      localAt: '2026-07-16 09:00:00.000', amountMinor: '1200', flowDirection: 'outflow', economicNature: 'expense',
      primaryEvidence: { sourceType: 'wechat', paymentMethod: '微信零钱', item: '失败交易' }
    }
  ])

  assert.deepEqual(groups.map(function (group) {
    return { label: group.label, count: group.count, expanded: group.expanded }
  }), [
    { label: '支付宝小荷包（树与草的小荷包）已排除', count: 3, expanded: false },
    { label: '交易已关闭', count: 1, expanded: false },
    { label: '交易失败', count: 1, expanded: false }
  ])
  assert.deepEqual(groups[0].events.map(function (event) { return event.eventId }), ['account-1', 'account-2', 'account-legacy'])
})

test('可共享决定的一张 ReviewIssue 显示批量处理数量而不拆行', function () {
  const groups = model.reviewIssueGroups([{
    issueId: 'shared-1', issueType: 'shared_fields', memberCount: 12, candidateCount: 0,
    subject: { eventId: 'event-1', amountMinor: '100', primaryEvidence: { item: '待补全记录' } }
  }])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].issues.length, 1)
  assert.equal(groups[0].issues[0].batchDecision, '批量处理 12 笔')
})

test('退款候选展示原消费信息和服务端冻结的匹配依据', function () {
  const choice = model.relationChoiceView({
    eventId: 'expense-1', localAt: '2026-08-01 08:30:00.000', amountMinor: '1200',
    flowDirection: 'outflow', primaryEvidence: { sourceType: 'wechat', item: '原消费', counterparty: '示例商户' }
  }, {
    relationId: 'relation-1', targetEventId: 'expense-1',
    reasonCodes: ['refund_exact_reference_candidate']
  })

  assert.deepEqual(choice, {
    targetEventId: 'expense-1', relationId: 'relation-1', title: '原消费',
    meta: '08-01 · 08:30 · 示例商户 · 微信', amountText: '¥12.00', directionClass: 'row-expense',
    matchLabel: '订单匹配'
  })
})

test('商品标题证据显示为待核对而不是可靠自动匹配', function () {
  const choice = model.relationChoiceView({
    eventId: 'expense-2', amountMinor: '466', flowDirection: 'outflow',
    primaryEvidence: { sourceType: 'alipay', item: '手持小型缝纫机' }
  }, {
    relationId: 'relation-2', targetEventId: 'expense-2',
    reasonCodes: ['refund_item_evidence_candidate']
  })
  assert.equal(choice.matchLabel, '商品匹配待核对')
})

test('最终入账摘要按经济性质统计且缺分类时关闭入账门禁', function () {
  const summary = model.finalSummary([
    { status: 'ready', economicNature: 'expense', amountMinor: '1200', categoryId: 'food', ledgerAccountId: 'wallet' },
    { status: 'ready', economicNature: 'fee', amountMinor: '1', categoryId: null, ledgerAccountId: 'wallet' },
    { status: 'ready', economicNature: 'income', amountMinor: '5000', categoryId: 'salary', ledgerAccountId: 'wallet' },
    { status: 'ready', economicNature: 'refund', amountMinor: '200', ledgerAccountId: 'wallet' },
    { status: 'ready', economicNature: 'internal_transfer', amountMinor: '3000', ledgerAccountId: 'wallet', counterpartyLedgerAccountId: 'bank' },
    { status: 'excluded', economicNature: 'expense', amountMinor: '9999', categoryId: null }
  ], [{ accountId: 'wallet' }])

  assert.deepEqual(summary, {
    expenseText: '¥12.01', incomeText: '¥50.00', refundText: '¥2.00', transferCount: 1,
    categoryCount: 3, categorizedCount: 2, categoryCoverageText: '2 / 3', categoryComplete: false,
    newAccountCount: 1, affectedAccountCount: 2
  })
})
