const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture, runtime, flush } = require('./helpers/paged-workbench')
const tap = dataset => ({ currentTarget: { dataset } })
const installment = { creditStatement: true, factKind: 'billing', component: 'principal', periodNumber: 3, totalTerms: 6, originKind: 'cash_borrowing' }

test('本金出账合并为分期卡，原文说明期次，不提供实际还款编辑入口', async t => {
  const data = fixture(1)
  Object.assign(data.events[0], { economicNature: 'repayment', flowDirection: 'neutral', installment })
  const { page } = runtime(data)
  t.after(() => page.onUnload())
  page.data.activeReviewStatus = 'completed'
  await page.setStep({ currentStep: 3 })
  const card = page.data.reviewedEvents[0]
  // 同一账户＋同期次的分期行合成一张卡，期内只有本金时也仍是这张卡。
  assert.equal(card.isInstallmentCard, true)
  assert.equal(card.natureLabel, '分期出账')
  assert.equal(card.rows.length, 1)
  const row = card.rows[0]
  assert.equal(row.natureLabel, '分期出账')
  assert.match(row.displayDetailMeta, /第3期／共6期/)
  await page.openReviewDetails(tap({ id: row.eventId }))
  assert.match(page.data.reviewDetailSheet.installmentNote, /关联或新建分期计划/)
  // 本金出账不开放实际还款编辑（repaymentEditable=false），但来源字段仍可核对（reviewEditable=true）。
  assert.equal(page.data.reviewDetailSheet.repaymentEditable, false)
  assert.equal(page.data.reviewDetailSheet.reviewEditable, true)
  assert.equal(page.data.reviewDetailSheet.editor.principal, true)
  page.closeReviewDetails()
  await page.openEvidence(tap({ id: row.eventId }))
  assert.equal(page.data.evidenceSheet.repaymentEditable, undefined)
  assert.match(page.data.evidenceSheet.installmentNote, /不记实际还款/)
  assert.match(page.data.evidenceSheet.installmentNote, /关联或新建分期计划/)
})

test('分期本金与人工性质冲突经来源编辑纠正，但不解除来源冲突', async t => {
  const editor = require('./helpers/editor-workbench')
  const { page } = await editor.open(t, { economicNature: 'internal_transfer', installment,
    ledgerAccountId: 'synthetic-credit', counterpartyLedgerAccountId: 'synthetic-target',
    reasonCodes: ['core_fields_conflict'] }, { issueType: 'field_conflict',
    accounts: [{ accountId: 'synthetic-credit', name: '合成信用卡', type: 'credit' }] })
  assert.equal(editor.view(page).principal, true)
  assert.equal(editor.view(page).showLoan, false)
  assert.equal(editor.view(page).natureLabel, '分期出账')
  editor.edit(page, 'periodInput', '4')
  const fields = editor.view(page).payload.fields
  assert.equal(fields.economicNature, 'repayment')
  assert.equal(fields.counterpartyLedgerAccountId, null)
  assert.equal(editor.view(page).payload.sourceCorrection.periodNumber, 4)
  assert.equal(editor.view(page).complete, false)
  editor.nature(page, 'expense')
  assert.equal(editor.draft(page).economicNature, 'repayment')
})

const presentation = require('../miniprogram/packages/finance/pages/import-workbench/presentation')

test('分期性质在真实 Page 的各页签、卡头与详情一致，不被计划名或收支类别覆盖', async t => {
  for (const [component, label] of [['principal', '分期出账'], ['interest', '分期利息'], ['fee', '分期手续费']]) {
    const kinds = ['待核对', '已核对', '重复', '已排除', ...(component === 'principal' ? ['无需分类'] : ['待分类', '已分类'])]
    for (const kind of kinds) await t.test(component + '／' + kind, async t => {
      const data = fixture(1, kind === '待核对' || kind === '待分类')
      const event = data.events[0]
      Object.assign(event, { economicNature: component === 'principal' ? 'repayment' : 'fee',
        natureLabel: '故意残留的旧名称', installment: { ...installment, component, planName: '合成分期计划' } })
      if (kind === '待分类') data.issues[0].issueType = 'category_assignment'
      if (kind === '重复') event.status = 'duplicate'
      if (kind === '已排除') { event.status = 'excluded'; event.reasonCodes = ['source_non_financial'] }
      const h = runtime(data), page = h.page
      t.after(() => page.onUnload())
      if (['待分类', '已分类', '无需分类'].includes(kind)) {
        page.data.activeReviewTab = 'category'
        page.data.activeCategoryStatus = { 待分类: 'pending', 已分类: 'completed', 无需分类: 'none' }[kind]
      } else page.data.activeReviewStatus = { 待核对: 'pending', 已核对: 'completed', 重复: 'duplicate', 已排除: 'excluded' }[kind]
      await page.setStep({ currentStep: 3 })
      let card, row
      if (kind === '待核对') { card = page.data.reviewGroups[0].issues[0]; row = card.subjects[0] }
      else if (kind === '已核对') { card = page.data.reviewedEvents[0]; row = card.rows[0] }
      else if (kind === '待分类') { card = page.data.categoryCards[0]; row = card.subjects[0] }
      else if (kind === '已分类') row = page.data.categorizedEvents[0]
      else if (kind === '无需分类') row = page.data.noCategoryEvents[0]
      else if (kind === '重复') row = page.data.duplicateReviewEvents[0]
      else {
        await page.toggleExcludedGroup(tap({ key: page.data.excludedReviewGroups[0].key }))
        row = page.data.excludedReviewGroups[0].events[0]
      }
      assert.equal(row.natureLabel, label)
      if (card) assert.equal(card.natureLabel, label, '卡头和成员性质一致')
      await page.openReviewDetails(tap({ id: row.eventId }))
      assert.equal(page.data.reviewDetailSheet.fields.find(field => field.key === 'nature').value, label)
      assert.equal(page.data.reviewDetailSheet.editor.natureLabel, label)
      const choices = page.data.reviewDetailSheet.editor.natureOptions
      assert.equal(choices.find(item => item.value === event.economicNature).label, label)
      assert.equal(h.calls.some(call => /setReview|resolve|\.post$/.test(call.action)), false)
    })
  }
})

test('普通和分期共用同一卡头与交易行，不再按卡片类型分两次渲染', () => {
  const fs = require('node:fs'), path = require('node:path')
  const root = path.join(__dirname, '../miniprogram/packages/finance/pages/import-workbench')
  const markup = fs.readFileSync(path.join(root, 'index.wxml'), 'utf8')
  const shared = fs.readFileSync(path.join(root, 'review-cards.wxml'), 'utf8')
  assert.match(markup, /<import src="review-cards.wxml"/)
  assert.equal((markup.match(/wx:for="\{\{reviewedEvents\}\}"/g) || []).length, 1)
  const completed = markup.split("activeReviewStatus === 'completed'")[1].split('暂无已核对交易')[0]
  assert.match(completed, /is="review-card-heading"/)
  assert.match(completed, /is="review-record-content"/)
  assert.doesNotMatch(completed, /item\.installmentPlan/)
  assert.match(shared, /pending \? card\.label : card\.natureLabel/)
  assert.doesNotMatch(shared, /installmentPlan|分期出账/)
})

function installmentEvent(component, minor, ledgerAccountId, periodNumber, totalTerms, localAt, item, planLabel) {
  const title = item || '招财猫商城'
  return {
    eventId: ['evt', ledgerAccountId, periodNumber, component, title].join('-'),
    economicNature: 'repayment',
    flowDirection: 'neutral',
    ledgerAccountId,
    localAt: localAt || '2026-10-05T10:00:00',
    amountMinor: String(minor),
    primaryEvidence: { sourceType: 'bank', item: title, counterparty: '' },
    installment: { creditStatement: true, factKind: 'billing', component, periodNumber, totalTerms, originKind: 'cash_borrowing',
      ...(planLabel ? { planLabel } : {}) }
  }
}

test('同账户同期次的分期本金／利息／手续费合并为一张卡并给出本期合计', () => {
  const events = [
    installmentEvent('principal', 221743, 'acct-1', 12, 12, '2026-10-05T10:00:00'),
    installmentEvent('interest', 17600, 'acct-1', 12, 12, '2026-10-05T10:01:00'),
    installmentEvent('fee', 7983, 'acct-1', 12, 12, '2026-10-05T10:02:00')
  ]
  const cards = presentation.buildReviewedCards(events, { fullEvents: events })
  assert.equal(cards.length, 1)
  const card = cards[0]
  assert.equal(card.isInstallmentCard, true)
  assert.equal(card.installmentKey, 'acct-1|12|12|招财猫商城')
  assert.equal(card.installmentPeriod, '第12期／共12期')
  assert.equal(card.natureLabel, '分期出账')
  assert.equal(card.rows.length, 3)
  const roles = new Set(card.rows.map(r => r.rowRole))
  assert.equal(roles.size, 3)
  assert.ok(roles.has('本金') && roles.has('利息') && roles.has('手续费'))
  assert.equal(card.periodComplete, true)
  assert.equal(card.amountText, '¥2473.26')
  card.rows.forEach(r => assert.match(r.eventId, /^evt-acct-1-12-/))
})

test('跨页不完整（全量中还有同键行）时不显示合计', () => {
  const all = [
    installmentEvent('principal', 221743, 'acct-1', 12, 12),
    installmentEvent('interest', 17600, 'acct-1', 12, 12),
    installmentEvent('fee', 7983, 'acct-1', 12, 12)
  ]
  const cards = presentation.buildReviewedCards([all[0]], { fullEvents: all })
  assert.equal(cards.length, 1)
  assert.equal(cards[0].periodComplete, false)
  assert.equal(cards[0].amountText, '')
})

test('运行期分页：分期行贴着有邻页的边界时不显示合计', () => {
  const principal = installmentEvent('principal', 221743, 'acct-1', 12, 12)
  const atEnd = presentation.buildReviewedCards([principal], { pageEdges: { hasPrevious: false, hasNext: true } })
  assert.equal(atEnd[0].periodComplete, false)
  const alone = presentation.buildReviewedCards([principal], { pageEdges: { hasPrevious: false, hasNext: false } })
  assert.equal(alone[0].periodComplete, true)
  assert.equal(alone[0].amountText, '¥2217.43')
})

test('非分期交易保持原单行卡片，不被合并', () => {
  const normal = { eventId: 'n1', economicNature: 'expense', amountMinor: '10000', primaryEvidence: {}, localAt: '2026-10-01T00:00:00' }
  const cards = presentation.buildReviewedCards([normal], { fullEvents: [normal] })
  assert.equal(cards.length, 1)
  assert.notEqual(cards[0].isInstallmentCard, true)
  assert.equal(cards[0].eventId, 'n1')
})

test('同一页内分期与非分期共存，各自独立', () => {
  const normal = { eventId: 'n1', economicNature: 'expense', amountMinor: '10000', primaryEvidence: {}, localAt: '2026-10-01T00:00:00' }
  const principal = installmentEvent('principal', 221743, 'acct-1', 12, 12)
  const cards = presentation.buildReviewedCards([normal, principal], { fullEvents: [normal, principal] })
  assert.equal(cards.length, 2)
  const instCard = cards.find(c => c.isInstallmentCard)
  assert.equal(instCard.rows.length, 1)
  assert.equal(instCard.amountText, '¥2217.43')
})

test('不同账户或不同期次的分期不合并', () => {
  const a = installmentEvent('principal', 100000, 'acct-1', 12, 12)
  const b = installmentEvent('principal', 100000, 'acct-2', 12, 12)
  const c = installmentEvent('principal', 100000, 'acct-1', 11, 12)
  const cards = presentation.buildReviewedCards([a, b, c], { fullEvents: [a, b, c] })
  assert.equal(cards.length, 3)
})

// 以下用真实账单文案：同一期次出现两个分期计划时，两行利息的摘要一字不差
//（「分期付款利息第12期共12期」），账单只有日期／摘要／金额／卡号四列可用，无法判定归属。
const CASH_PLAN = '电销现分按月收12期第12期共12期'
const BILL_PLAN = '电销总账分月12期第12期共12期'
const PERIOD_INTEREST = '分期付款利息第12期共12期'

test('同期次有多个分期计划时，利息不猜归属，单独成卡且不给合计', () => {
  const events = [
    installmentEvent('principal', 221743, 'acct-1', 12, 12, undefined, BILL_PLAN),
    installmentEvent('interest', 7983, 'acct-1', 12, 12, undefined, PERIOD_INTEREST),
    installmentEvent('principal', 183333, 'acct-1', 12, 12, undefined, CASH_PLAN),
    installmentEvent('interest', 17600, 'acct-1', 12, 12, undefined, PERIOD_INTEREST)
  ]
  const cards = presentation.buildReviewedCards(events, { fullEvents: events })
  assert.equal(cards.length, 3)
  const planCards = cards.filter(card => card.installmentPlan !== '利息待归属')
  assert.deepEqual(planCards.map(card => card.installmentPlan).sort(), ['电销总账分月12期', '电销现分按月收12期'])
  planCards.forEach(card => {
    assert.equal(card.rows.length, 1)
    assert.equal(card.rows[0].rowRole, '本金')
    assert.equal(card.amountText, card.rows[0].amountText)
  })
  const pending = cards.find(card => card.installmentPlan === '利息待归属')
  assert.equal(pending.rows.length, 2)
  assert.equal(pending.amountText, '')
  assert.equal(pending.installmentPeriod, '第12期／共12期')
  assert.match(pending.planNote, /2 个分期计划/)
})

test('人工确认计划归属后，利息与对应本金合成一张卡', () => {
  const events = [
    installmentEvent('principal', 221743, 'acct-1', 12, 12, undefined, BILL_PLAN),
    installmentEvent('interest', 7983, 'acct-1', 12, 12, undefined, PERIOD_INTEREST, '电销总账分月12期'),
    installmentEvent('principal', 183333, 'acct-1', 12, 12, undefined, CASH_PLAN),
    installmentEvent('interest', 17600, 'acct-1', 12, 12, undefined, PERIOD_INTEREST, '电销现分按月收12期')
  ]
  const cards = presentation.buildReviewedCards(events, { fullEvents: events })
  assert.equal(cards.length, 2)
  assert.deepEqual(cards.map(card => card.installmentPlan + '=' + card.amountText).sort(),
    ['电销总账分月12期=¥2297.26', '电销现分按月收12期=¥2009.33'])
  cards.forEach(card => assert.equal(card.planNote, ''))
  cards.forEach(card => assert.equal(card.natureLabel, '分期出账'))
  cards.forEach(card => assert.equal(card.eventId, card.rows.find(row => row.rowRoleKey === 'principal').eventId))
})

test('本期次只有一笔本金时，利息自动归属并给出本期合计', () => {
  const events = [
    installmentEvent('principal', 190275, 'acct-1', 8, 12, undefined, '电销现分按月收12期第8期共12期'),
    installmentEvent('interest', 9133, 'acct-1', 8, 12, undefined, '分期付款利息第8期共12期')
  ]
  const cards = presentation.buildReviewedCards(events, { fullEvents: events })
  assert.equal(cards.length, 1)
  assert.equal(cards[0].installmentPlan, '电销现分按月收12期')
  assert.equal(cards[0].installmentPeriod, '第8期／共12期')
  assert.equal(cards[0].amountText, '¥1994.08')
  assert.equal(cards[0].planNote, '')
})

test('本期次没有本金行时，利息单独成卡并说明原因，不给合计', () => {
  const events = [installmentEvent('interest', 17600, 'acct-1', 12, 12, undefined, PERIOD_INTEREST)]
  const cards = presentation.buildReviewedCards(events, { fullEvents: events })
  assert.equal(cards.length, 1)
  assert.equal(cards[0].installmentPlan, '利息待归属')
  assert.equal(cards[0].amountText, '')
  assert.match(cards[0].planNote, /没有识别到分期本金行/)
})

test('摘要自带的计划名优先于「唯一本金」，两个计划并存时也能归属', () => {
  const events = [
    installmentEvent('principal', 221743, 'acct-1', 12, 12, undefined, BILL_PLAN),
    installmentEvent('principal', 183333, 'acct-1', 12, 12, undefined, CASH_PLAN),
    installmentEvent('interest', 7983, 'acct-1', 12, 12, undefined, '电销总账分月12期分期利息第12期共12期')
  ]
  const cards = presentation.buildReviewedCards(events, { fullEvents: events })
  assert.equal(cards.length, 2)
  const bill = cards.find(card => card.installmentPlan === '电销总账分月12期')
  assert.equal(bill.rows.length, 2)
  assert.equal(bill.amountText, '¥2297.26')
})

test('真实 Page：同账户同期次按计划分段成卡，归属未定的利息单独一张且无合计', async t => {
  const data = fixture(4)
  const rows = [
    ['principal', 221743, BILL_PLAN],
    ['interest', 7983, PERIOD_INTEREST],
    ['principal', 183333, CASH_PLAN],
    ['interest', 17600, PERIOD_INTEREST]
  ]
  data.events.forEach((event, index) => {
    const [component, minor, item] = rows[index]
    Object.assign(event, { economicNature: 'repayment', flowDirection: 'neutral', amountMinor: String(minor),
      primaryEvidence: { sourceType: 'bank', item, counterparty: '' },
      installment: { creditStatement: true, factKind: 'billing', component, periodNumber: 12, totalTerms: 12, originKind: 'cash_borrowing' } })
  })
  const { page } = runtime(data)
  t.after(() => page.onUnload())
  page.data.activeReviewStatus = 'completed'
  await page.setStep({ currentStep: 3 })
  const cards = page.data.reviewedEvents
  assert.equal(cards.length, 3)
  const pending = cards.filter(card => card.installmentPlan === '利息待归属')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].rows.length, 2)
  assert.equal(pending[0].amountText, '')
  assert.equal(pending[0].periodComplete, true)
  assert.match(pending[0].planNote, /2 个分期计划/)
  const planCards = cards.filter(card => card.installmentPlan !== '利息待归属')
  assert.equal(planCards.length, 2)
  planCards.forEach(card => {
    assert.equal(card.rows.length, 1)
    assert.equal(card.periodComplete, true)
    assert.match(card.installmentPeriod, /第12期／共12期/)
  })
  assert.notEqual(planCards[0].installmentKey, planCards[1].installmentKey)
})

test('客户端采用服务端下发的分组键与归属结论，不再自行重算', () => {
  const event = installmentEvent('interest', 17600, 'acct-1', 12, 12, undefined, PERIOD_INTEREST)
  event.installment = { ...event.installment, groupKey: 'bank|6106|12|12', planName: '电销现分按月收12期' }
  event.installmentAttribution = { version: 'installment-attribution-v1', groupKey: 'bank|6106|12|12',
    periodNumber: 12, totalTerms: 12, role: 'charge', planLabel: '电销现分按月收12期', plans: [] }
  const cards = presentation.buildReviewedCards([event], { fullEvents: [event] })
  assert.equal(cards.length, 1)
  // 分组键取自服务端（来源账户身份），计划名也取自服务端，客户端不再从摘要重新截断。
  assert.equal(cards[0].installmentKey, 'bank|6106|12|12|电销现分按月收12期')
  assert.equal(cards[0].installmentPlan, '电销现分按月收12期')
  assert.equal(cards[0].amountText, '¥176.00')
  assert.equal(cards[0].natureLabel, '分期利息')
  assert.equal(cards[0].planNote, '所属计划：电销现分按月收12期')
})

test('服务端分组键优先于账本账户，同卡同期次不会因账户不同被拆开', () => {
  const principal = installmentEvent('principal', 221743, 'acct-1', 12, 12)
  const interest = installmentEvent('interest', 7983, 'acct-2', 12, 12)
  principal.installment.groupKey = 'bank|6106|12|12'
  interest.installment.groupKey = 'bank|6106|12|12'
  const cards = presentation.buildReviewedCards([principal, interest], { fullEvents: [principal, interest] })
  assert.equal(cards.length, 1)
  assert.equal(cards[0].installmentKey, 'bank|6106|12|12|招财猫商城')
  assert.equal(cards[0].rows.length, 2)
})

// 待核对：一个本金计划一张卡（与已核对的一计划一卡同口径）。归属未定的利息不属于任何计划，
// 不单独占卡，而是作为“本期次待指定”的行挂在每张计划卡里，点一笔就带着这张卡的计划打开那一笔。
const PLAN_CANDIDATES = [
  { planName: '电销总账分月12期', eventId: 'p-bill', amountMinor: '221743' },
  { planName: '电销现分按月收12期', eventId: 'p-cash', amountMinor: '183333' }
]
const GROUP_KEY = 'bank|6106|12|12'
const ATTRIBUTION_ISSUE = {
  issueId: 'issue-attribution', issueType: 'installment_origin', status: 'open', blocking: true,
  primaryReasonCode: 'installment_attribution_required', memberCount: 4, candidateCount: 0
}

// 服务端下发的归属有两种形态：费用行是「这笔属于哪个计划」（planLabel 空即待指定），
// 本金行是本组上下文（它自己不用指定，但它是那张卡的入口）。
function pendingInstallmentEvent(component, minor, item, planName) {
  const event = installmentEvent(component, minor, 'acct-1', 12, 12, undefined, item)
  event.pendingIssue = ATTRIBUTION_ISSUE
  event.installment = { ...event.installment, groupKey: GROUP_KEY, ...(planName ? { planName } : {}) }
  event.installmentAttribution = { version: 'installment-attribution-v1', groupKey: GROUP_KEY,
    periodNumber: 12, totalTerms: 12, plans: PLAN_CANDIDATES,
    ...(component === 'principal' ? { role: 'principal', planLabel: planName } : { role: 'charge', planLabel: '' }) }
  return event
}

test('待核对按计划一卡：两笔本金各自一张卡，未归属的利息挂在每张卡里', () => {
  const bill = pendingInstallmentEvent('principal', 221743, BILL_PLAN, '电销总账分月12期')
  const cash = pendingInstallmentEvent('principal', 183333, CASH_PLAN, '电销现分按月收12期')
  const interest = pendingInstallmentEvent('interest', 7983, PERIOD_INTEREST)
  // 刻意让利息先出现：拆分后本金必须各归各卡，而不是被并到同一张卡里。
  const split = presentation.splitInstallmentCards([interest, bill, cash].map(event => presentation.pendingCard(event, false)))
  assert.equal(split.length, 2)
  assert.deepEqual(split.map(card => card.installmentPlan).sort(), ['电销总账分月12期', '电销现分按月收12期'])
  split.forEach(card => {
    // 一计划一卡：卡里只有本计划的本金行，利息待指定作为卡内动作行，不占 subject。
    assert.deepEqual(card.subjects.map(row => row.rowRoleKey), ['principal'])
    assert.deepEqual(card.installmentPendingRows.map(row => row.eventId), [interest.eventId])
    assert.deepEqual(card.installmentPendingRows.map(row => row.plan), [card.installmentPlan])
    assert.match(card.label, /利息待归属/)
    // 卡面只保留可操作的行：候选计划与期次说明都不再下发（说明位全局 display:none，属死数据）。
    assert.equal(card.installmentCandidates, undefined)
    assert.equal(card.installmentPeriodLabel, undefined)
  })
})

test('已指定归属的利息进对应计划卡，不再出现在待指定里', () => {
  const bill = pendingInstallmentEvent('principal', 221743, BILL_PLAN, '电销总账分月12期')
  const cash = pendingInstallmentEvent('principal', 183333, CASH_PLAN, '电销现分按月收12期')
  const interest = pendingInstallmentEvent('interest', 7983, PERIOD_INTEREST)
  interest.installmentAttribution = { ...interest.installmentAttribution, planLabel: '电销总账分月12期' }
  const split = presentation.splitInstallmentCards([bill, cash, interest].map(event => presentation.pendingCard(event, false)))
  assert.equal(split.length, 2)
  const billCard = split.find(card => card.installmentPlan === '电销总账分月12期')
  assert.deepEqual(billCard.subjects.map(row => row.rowRoleKey), ['principal', 'interest'])
  assert.equal(billCard.installmentPendingRows, undefined)
  assert.equal(billCard.label, '分期出账｜利息待归属')
  const cashCard = split.find(card => card.installmentPlan === '电销现分按月收12期')
  assert.deepEqual(cashCard.subjects.map(row => row.rowRoleKey), ['principal'])
})

test('构不成两个计划时不拆卡，原卡片原样保留', () => {
  const interest = pendingInstallmentEvent('interest', 7983, PERIOD_INTEREST)
  const cards = [presentation.pendingCard(interest, false)]
  assert.equal(presentation.splitInstallmentCards(cards), cards)
})

test('非分期待核对卡片不受拆卡影响，行入口仍指向同一笔', () => {
  const normal = { eventId: 'n1', economicNature: 'expense', flowDirection: 'outflow', amountMinor: '10000',
    ledgerAccountId: 'acct-1', status: 'needs_action', localAt: '2026-10-01T00:00:00',
    primaryEvidence: { sourceType: 'wechat', item: '合成消费', counterparty: '' }, reasonCodes: [] }
  const cards = [presentation.pendingCard(normal, false)]
  assert.equal(presentation.splitInstallmentCards(cards), cards)
})

// 编辑器里的归属区有两种形态：费用行单选计划，本金行列出本期次待指定的利息。
const editorModel = require('../miniprogram/packages/finance/pages/import-workbench/review-editor-model')

function editorRow(component, eventId, planName) {
  return { eventId, economicNature: component === 'principal' ? 'repayment' : 'fee',
    flowDirection: 'neutral', ledgerAccountId: 'acct-1', counterpartyLedgerAccountId: null,
    localAt: '2026-10-05 10:00:00', amountMinor: '7983', currency: 'CNY', editorFacts: { version: 1 },
    installment: { creditStatement: true, factKind: 'billing', component, periodNumber: 12, totalTerms: 12,
      groupKey: GROUP_KEY, ...(planName ? { planName } : {}) },
    primaryEvidence: { sourceType: 'bank', item: '本期分期', counterparty: '' } }
}

function sibling(eventId, rowRoleKey, rowRole, installmentKey, planLabel, amountText) {
  return { eventId, rowRoleKey, rowRole, installmentKey, rowTitle: '分期付款利息',
    installmentPlanLabel: planLabel || '', amountText, displayDate: '09-02' }
}

test('本金编辑器只列本期次待指定的利息，别的期次不串进来', () => {
  const principal = editorRow('principal', 'p-bill', '电销总账分月12期')
  principal.installmentAttribution = { version: 'installment-attribution-v1', role: 'principal', groupKey: GROUP_KEY,
    periodNumber: 12, totalTerms: 12, planLabel: '电销总账分月12期', plans: PLAN_CANDIDATES }
  const view = editorModel.derive(principal, editorModel.create(principal), { siblings: [
    sibling('p-bill', 'principal', '本金', GROUP_KEY, '', '¥2217.43'),
    sibling('i-1', 'interest', '利息', GROUP_KEY, '', '¥79.83'),
    // 另一期次的未归属利息不属于本组，不该列进来。
    sibling('i-2', 'interest', '利息', 'bank|6106|11|12', '', '¥12.00')
  ] })
  assert.equal(view.attribution.role, 'principal')
  assert.equal(view.attribution.planLabel, '电销总账分月12期')
  assert.equal(view.attribution.required, false)
  assert.deepEqual(view.attribution.pending.map(item => item.eventId), ['i-1'])
  assert.equal(view.attribution.pending[0].amountText, '¥79.83')
  assert.match(view.attribution.hint, /还有 1 笔利息没指定归属/)
})

test('本金行已经没有待指定利息时不显示归属区', () => {
  const principal = editorRow('principal', 'p-bill', '电销总账分月12期')
  principal.installmentAttribution = { version: 'installment-attribution-v1', role: 'principal', groupKey: GROUP_KEY,
    periodNumber: 12, totalTerms: 12, planLabel: '电销总账分月12期', plans: PLAN_CANDIDATES }
  const view = editorModel.derive(principal, editorModel.create(principal),
    { siblings: [sibling('p-bill', 'principal', '本金', GROUP_KEY, '', '¥2217.43')] })
  assert.equal(view.attribution, null)
})

test('利息编辑器给出候选计划单选，未指定时标为必填', () => {
  const interest = editorRow('interest', 'i-1')
  interest.installmentAttribution = { version: 'installment-attribution-v1', role: 'charge', groupKey: GROUP_KEY,
    periodNumber: 12, totalTerms: 12, planLabel: '', plans: PLAN_CANDIDATES }
  const view = editorModel.derive(interest, editorModel.create(interest), { siblings: [] })
  assert.equal(view.attribution.role, 'charge')
  assert.equal(view.attribution.required, true)
  assert.deepEqual(view.attribution.plans.map(item => [item.planName, item.selected, item.amountText]),
    [['电销总账分月12期', false, '¥2217.43'], ['电销现分按月收12期', false, '¥1833.33']])
  // 选中态跟着草稿走：用户点了哪个计划，哪个就高亮。
  const chosen = editorModel.change(interest, editorModel.create(interest), 'planLabel', '电销现分按月收12期')
  const after = editorModel.derive(interest, chosen, { siblings: [] })
  assert.equal(after.attribution.required, false)
  assert.deepEqual(after.attribution.plans.map(item => item.selected), [false, true])
})

test('归属模板按钮经真实 Page 可选计划与清除，未保存不写入', async t => {
  const editor = require('./helpers/editor-workbench')
  const interest = editorRow('interest', 'synthetic-interest')
  interest.installmentAttribution = { version: 'installment-attribution-v1', role: 'charge', groupKey: GROUP_KEY,
    periodNumber: 12, totalTerms: 12, planLabel: '', plans: [
      { planName: '合成计划 A', eventId: 'synthetic-a', amountMinor: '10000' },
      { planName: '合成计划 B', eventId: 'synthetic-b', amountMinor: '20000' }
    ] }
  const { h, page } = await editor.open(t, interest, { issueType: 'installment_origin' })
  const writes = editor.writes(h).length
  page.selectEditorInstallmentPlan(tap({ plan: '合成计划 B' }))
  assert.equal(editor.view(page).payload.sourceCorrection.planLabel, '合成计划 B')
  assert.deepEqual(Array.from(editor.view(page).attribution.plans, plan => plan.selected), [false, true])
  page.selectEditorInstallmentPlan(tap({ plan: '不在候选中的计划' }))
  assert.equal(editor.view(page).payload.sourceCorrection.planLabel, '合成计划 B')
  page.clearEditorInstallmentPlan()
  assert.equal(editor.view(page).payload.sourceCorrection.planLabel, null)
  assert.equal(editor.view(page).attribution.required, true)
  assert.equal(editor.writes(h).length, writes)
})

test('没有归属上下文的分期行不显示归属区', () => {
  const interest = editorRow('interest', 'i-1')
  const view = editorModel.derive(interest, editorModel.create(interest), { siblings: [] })
  assert.equal(view.attribution, null)
})
