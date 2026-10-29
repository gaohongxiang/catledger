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

test('分期本金与人工性质冲突经来源编辑纠正，并可改判为实际支出', async t => {
  const editor = require('./helpers/editor-workbench')
  const { page } = await editor.open(t, { economicNature: 'internal_transfer', installment,
    ledgerAccountId: 'synthetic-credit', counterpartyLedgerAccountId: 'synthetic-target',
    reasonCodes: ['core_fields_conflict'] }, { issueType: 'field_conflict',
    accounts: [{ accountId: 'synthetic-credit', name: '合成信用卡', type: 'credit' }] })
  assert.equal(editor.view(page).principal, true)
  assert.equal(editor.view(page).showLoan, false)
  assert.equal(editor.view(page).natureLabel, '分期出账')
  editor.edit(page, 'periodInput', '4')
  let fields = editor.view(page).payload.fields
  assert.equal(fields.economicNature, 'repayment')
  assert.equal(fields.counterpartyLedgerAccountId, null)
  assert.equal(editor.view(page).payload.sourceCorrection.periodNumber, 4)
  assert.equal(editor.view(page).complete, false)
  editor.nature(page, 'expense')
  assert.equal(editor.draft(page).economicNature, 'expense')
  assert.equal(editor.view(page).natureLabel, '支出')
  fields = editor.view(page).payload.fields
  assert.equal(fields.economicNature, 'expense')
  assert.equal(fields.counterpartyLedgerAccountId, null)
  assert.equal(editor.view(page).canSave, true)
  // 本金行仍不开放需要第二端或原消费关系的性质。
  editor.nature(page, 'internal_transfer')
  assert.equal(editor.draft(page).economicNature, 'expense')
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
      // 分期角色只用于界面性质，不混进可切换的经济性质选项；本金可改判实际性质，利息和手续费仍只读。
      const choices = page.data.reviewDetailSheet.editor.natureOptions
      assert.equal(choices.find(item => item.value === event.economicNature).label,
        { principal: '分期出账', interest: '利息／手续费', fee: '利息／手续费' }[component])
      // 重复和已排除本身不可编辑；其余页签里只有本金行开放性质改判。
      assert.equal(page.data.reviewDetailSheet.editor.natureEditable,
        component === 'principal' && !['重复', '已排除'].includes(kind))
      assert.equal(page.data.reviewDetailSheet.editor.natureFixedHint, component === 'principal' ? '' : '由分期来源确定')
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

test('分期来源区：期次一行，计划单选复用退款候选，本金卡候选列表直接勾选', () => {
  const fs = require('node:fs'), path = require('node:path')
  const root = path.join(__dirname, '../miniprogram/packages/finance/pages/import-workbench')
  const fields = fs.readFileSync(path.join(root, 'review-editor-fields.wxml'), 'utf8')
  assert.match(fields, /class="editor-row-value period-field"/)
  assert.match(fields, /class="period-input money-number"/)
  assert.match(fields, /class="attribution-plan-radio"/)
  assert.match(fields, /class="attribution-check"/)
  assert.match(fields, /bindtap="toggleEditorPendingInterest"/)
  assert.match(fields, /勾选后保存/)
  assert.match(fields, /选择一个计划才能入账/)
  // 本金行里的未归属利息收成一个候选列表：第一行标题与金额，第二行时间与账户，整行勾选。
  assert.match(fields, /class="attribution-candidates"/)
  assert.match(fields, /class="attribution-candidate/)
  assert.doesNotMatch(fields, /attribution-role/)
  assert.match(fields, /class="attribution-candidate-meta"/)
  assert.match(fields, /class="attribution-head-main"/)
  assert.match(fields, /· 归到 \{\{editor\.attribution\.planLabel\}\}/)
  assert.doesNotMatch(fields, /attribution\.pending\.length\}\} 笔|pendingTotalText/)
  assert.doesNotMatch(fields, /openEditorInterestDetail|openEditorPendingInterest/)
  // 不再每行重复动作词，也不再另设“详情”或“取消指定”；再点已选计划即可取消。
  assert.doesNotMatch(fields, /归入本计划|选它|已归属|取消指定|attribution-plan-flag|attribution-planline|>详情</)
  assert.doesNotMatch(fields, /<text>本期期号<\/text>|总期数 · 选填/)
  assert.equal((fields.match(/class="mapping-field"/g) || []).length > 0, true, '其他字段仍沿用原有行样式')
  const wxss = fs.readFileSync(path.join(root, 'review-editor.wxss'), 'utf8')
  assert.match(wxss, /\.period-field \{[^}]*justify-content: center/)
  assert.doesNotMatch(wxss, /\.period-input \{[^}]*border-bottom/)
  assert.match(wxss, /\.attribution-head-plan \{[^}]*text-overflow: ellipsis/)
  assert.match(wxss, /\.attribution-candidates \{[^}]*border-radius/)
  assert.match(wxss, /\.attribution-candidate\.is-selected::before/)
  assert.match(wxss, /\.attribution-candidate \.attribution-check \{[^}]*position: absolute/)
  assert.match(wxss, /\.attribution-candidate\.is-selected \.attribution-check/)

  const sheet = fs.readFileSync(path.join(root, 'review-edit.wxml'), 'utf8')
  assert.match(sheet, /class="evidence-section"/)
  assert.doesNotMatch(sheet, /evidence-section-title|>原始交易</)
  assert.match(sheet, /class="review-relation-callout/)
  assert.match(sheet, /reviewEditSheet\.groupAction/)
  assert.match(sheet, /保存利息归属/)
  assert.doesNotMatch(sheet, /来源与同笔|显示完整范围/)

  const list = fs.readFileSync(path.join(root, 'index.wxml'), 'utf8')
  // 计划卡只保留状态和“处理”；同一个共享候选池不在每张卡里重复渲染。
  assert.doesNotMatch(list, /installmentPendingCount|review-attribution-pending|review-pending-action|assignPendingInterest|归入本计划/)
})

test('整组关系入口只服务同笔、来源和字段冲突，分期归属不走这个入口', () => {
  assert.deepEqual(presentation.groupReviewAction({ issueType: 'same_event' }, false),
    { label: '核对同笔关系', hint: '这笔可能和另一笔是同一笔交易，避免重复记账' })
  // 底部已有“修改同笔判断”，不再重复一个同笔入口。
  assert.equal(presentation.groupReviewAction({ issueType: 'same_event' }, true), null)
  assert.match(presentation.groupReviewAction({ issueType: 'identity_conflict' }, false).label, /来源冲突/)
  assert.match(presentation.groupReviewAction({ issueType: 'field_conflict' }, false).label, /字段冲突/)
  // 利息待归属、退款和账户都有自己的处理区域，不能被“整组关系”截走。
  assert.equal(presentation.groupReviewAction({ issueType: 'installment_origin',
    primaryReasonCode: 'installment_attribution_required' }, false), null)
  assert.equal(presentation.groupReviewAction({ issueType: 'refund_relation', primaryReasonCode: 'refund_source_conflict' }, false), null)
  assert.equal(presentation.groupReviewAction({ issueType: 'account_mapping', primaryReasonCode: 'account_mapping_conflict' }, false), null)
  assert.equal(presentation.groupReviewAction(null, false), null)
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

test('待核对按计划一卡：两笔本金各自一张卡，未归属利息单独一张', () => {
  const bill = pendingInstallmentEvent('principal', 221743, BILL_PLAN, '电销总账分月12期')
  const cash = pendingInstallmentEvent('principal', 183333, CASH_PLAN, '电销现分按月收12期')
  const interest = pendingInstallmentEvent('interest', 7983, PERIOD_INTEREST)
  // 刻意让利息先出现：拆分后本金必须各归各卡，而不是被并到同一张卡里。
  const split = presentation.splitInstallmentCards([interest, bill, cash].map(event => presentation.pendingCard(event, false)))
  // 未归属利息不属于任何计划，保持原卡单独出现，用户点它就能选归到哪笔本金。
  assert.equal(split.length, 3)
  const planCards = split.filter(card => card.installmentPlan !== undefined)
  assert.deepEqual(planCards.map(card => card.installmentPlan).sort(), ['电销总账分月12期', '电销现分按月收12期'])
  planCards.forEach(card => {
    // 一计划一卡：卡面只有本卡的本金（和本卡已归属的费用）；归属未定的利息不上卡面，
    // 它在打开本金编辑器后按本期次列成候选，勾哪笔哪笔归到本卡计划。
    assert.deepEqual(card.subjects.map(row => row.rowRoleKey), ['principal'])
    assert.equal(card.installmentPendingCount, undefined)
    assert.equal(card.installmentPendingTotalText, undefined)
    assert.equal(card.installmentPendingEntryId, undefined)
    assert.match(card.label, /利息待归属/)
    // 卡面只保留可操作的行：候选计划与期次说明都不再下发（说明位全局 display:none，属死数据）。
    assert.equal(card.installmentCandidates, undefined)
    assert.equal(card.installmentPeriodLabel, undefined)
  })
  const chargeCard = split.find(card => card.installmentPlan === undefined)
  assert.equal(chargeCard.subjects.length, 1)
  assert.equal(chargeCard.subjects[0].rowRoleKey, 'interest')
  assert.equal(chargeCard.subjects[0].installmentPending, true)
  // 卡头只写状态：每张卡都是同一件事，不重复“还有 N 笔”。笔数是组级事实，放组标题上。
  assert.equal(chargeCard.label, '分期利息｜利息待归属')
  // 只有一笔时不写——那是废话，卡片自己就在。
  assert.equal(presentation.installmentPendingNote([chargeCard]), '')
  const another = presentation.pendingCard(pendingInstallmentEvent('interest', 17600, PERIOD_INTEREST), false)
  assert.equal(presentation.installmentPendingNote([chargeCard, another]), '本期利息待归属 2 笔')
  // 本金卡不算进笔数：它是已确定的行，不是待归属的利息。
  assert.equal(presentation.installmentPendingNote([chargeCard, another].concat(planCards)), '本期利息待归属 2 笔')
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
  assert.equal(billCard.installmentPendingCount, undefined)
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
    displayTitle: '分期付款利息', displayDate: '09-02', displayTime: '10:00', accountText: '招商银行信用卡',
    installmentPlanLabel: planLabel || '', amountText }
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
  assert.equal('pendingTotalText' in view.attribution, false)
  assert.equal(view.attribution.pending[0].roleLabel, undefined)
  assert.equal(view.attribution.pending[0].title, '分期付款利息')
  assert.equal(view.attribution.pending[0].meta, '09-02 · 10:00 · 招商银行信用卡')
  // 账单计划与标题相同，不重复提示。
  assert.equal(view.attribution.pending[0].planHint, '')
  assert.equal(view.attribution.pending[0].selected, false)
  assert.equal(view.attribution.selectedCount, 0)
  // 账单自己写了另一个计划名时才提醒，方便判断这笔利息是否真属于本卡。
  const other = sibling('i-3', 'interest', '利息', GROUP_KEY, '', '¥1.00')
  other.rowTitle = '另一个分期计划'
  const hinted = editorModel.derive(principal, editorModel.create(principal), { siblings: [sibling('p-bill', 'principal', '本金', GROUP_KEY, '', '¥2217.43'), other] })
  assert.equal(hinted.attribution.pending[0].planHint, '另一个分期计划')
  // 勾选只存在本次草稿：同一份记录带上选择集，候选项直接变成选中态。
  const picked = editorModel.derive(principal, editorModel.create(principal), { siblings: [
    sibling('p-bill', 'principal', '本金', GROUP_KEY, '', '¥2217.43'),
    sibling('i-1', 'interest', '利息', GROUP_KEY, '', '¥79.83')
  ], pendingSelections: new Set(['i-1']) })
  assert.equal(picked.attribution.pending[0].selected, true)
  assert.equal(picked.attribution.selectedCount, 1)
  // 利息只逐笔展示，不再汇总合计；金额缺失也不伪造 0。
  const both = editorModel.derive(principal, editorModel.create(principal), { siblings: [
    sibling('p-bill', 'principal', '本金', GROUP_KEY, '', '¥2217.43'),
    sibling('i-1', 'interest', '利息', GROUP_KEY, '', '¥79.83'),
    sibling('i-4', 'interest', '利息', GROUP_KEY, '', '¥20.00')
  ] })
  assert.deepEqual(both.attribution.pending.map(item => item.amountText), ['¥79.83', '¥20.00'])
  const missing = editorModel.derive(principal, editorModel.create(principal), { siblings: [
    sibling('p-bill', 'principal', '本金', GROUP_KEY, '', '¥2217.43'),
    sibling('i-5', 'interest', '利息', GROUP_KEY, '', '')
  ] })
  assert.equal(missing.attribution.pending[0].amountText, '')
})

test('本期次没有费用行时不显示归属区', () => {
  const principal = editorRow('principal', 'p-bill', '电销总账分月12期')
  principal.installmentAttribution = { version: 'installment-attribution-v1', role: 'principal', groupKey: GROUP_KEY,
    periodNumber: 12, totalTerms: 12, planLabel: '电销总账分月12期', plans: PLAN_CANDIDATES }
  const view = editorModel.derive(principal, editorModel.create(principal),
    { siblings: [sibling('p-bill', 'principal', '本金', GROUP_KEY, '', '¥2217.43')] })
  assert.equal(view.attribution, null)
})

// 本期有两笔本金、两笔利息时，候选必须两笔都列：已归属的那笔从候选里消失，
// 用户会以为账单只有一笔利息，也就无从判断剩下那笔该给谁。
test('本期两笔利息全部列在候选里，已归到别的本金只读、归到本卡的可取消', () => {
  const siblings = [
    sibling('p-bill', 'principal', '本金', GROUP_KEY, '', '¥2217.43'),
    sibling('p-cash', 'principal', '本金', GROUP_KEY, '', '¥1833.33'),
    sibling('i-176', 'interest', '利息', GROUP_KEY, '电销现分按月收12期', '¥176.00'),
    sibling('i-79', 'interest', '利息', GROUP_KEY, '', '¥79.83')
  ]
  const bill = editorRow('principal', 'p-bill', '电销总账分月12期')
  bill.installmentAttribution = { version: 'installment-attribution-v1', role: 'principal', groupKey: GROUP_KEY,
    periodNumber: 12, totalTerms: 12, planLabel: '电销总账分月12期', plans: PLAN_CANDIDATES }
  const billView = editorModel.derive(bill, editorModel.create(bill), { siblings })
  assert.deepEqual(billView.attribution.pending.map(item => [item.eventId, item.amountText, item.selected, item.disabled, item.assignedPlan]),
    [['i-176', '¥176.00', false, true, '电销现分按月收12期'], ['i-79', '¥79.83', false, false, '']])
  assert.equal(billView.attribution.selectedCount, 0)

  const cash = editorRow('principal', 'p-cash', '电销现分按月收12期')
  cash.installmentAttribution = { version: 'installment-attribution-v1', role: 'principal', groupKey: GROUP_KEY,
    periodNumber: 12, totalTerms: 12, planLabel: '电销现分按月收12期', plans: PLAN_CANDIDATES }
  const cashView = editorModel.derive(cash, editorModel.create(cash), { siblings })
  // 归到本卡的默认勾选，且可点掉；点掉只进草稿，保存时才清空归属。
  assert.deepEqual(cashView.attribution.pending.map(item => [item.eventId, item.selected, item.disabled, item.mine]),
    [['i-176', true, false, true], ['i-79', false, false, false]])
  // 已归到本卡的已经在账上，不计入“随本笔保存”的笔数。
  assert.equal(cashView.attribution.selectedCount, 0)
  const cleared = editorModel.derive(cash, editorModel.create(cash), { siblings, pendingClears: new Set(['i-176']) })
  assert.equal(cleared.attribution.pending.find(item => item.eventId === 'i-176').selected, false)
})

test('利息编辑器给出候选计划单选，未指定时标为必填', () => {
  const interest = editorRow('interest', 'i-1')
  interest.installmentAttribution = { version: 'installment-attribution-v1', role: 'charge', groupKey: GROUP_KEY,
    periodNumber: 12, totalTerms: 12, planLabel: '', plans: PLAN_CANDIDATES }
  const view = editorModel.derive(interest, editorModel.create(interest), { siblings: [] })
  assert.equal(view.attribution.role, 'charge')
  assert.equal(view.attribution.required, true)
  assert.equal(view.attribution.selected, false)
  assert.deepEqual(view.attribution.plans.map(item => [item.planName, item.selected, item.amountText]),
    [['电销总账分月12期', false, '¥2217.43'], ['电销现分按月收12期', false, '¥1833.33']])
  // 选中态跟着草稿走：用户点了哪个计划，哪个就高亮；再点同一张卡即取消。
  const chosen = editorModel.change(interest, editorModel.create(interest), 'planLabel', '电销现分按月收12期')
  const after = editorModel.derive(interest, chosen, { siblings: [] })
  assert.equal(after.attribution.required, false)
  assert.equal(after.attribution.selected, true)
  assert.deepEqual(after.attribution.plans.map(item => item.selected), [false, true])
  const cleared = editorModel.change(interest, chosen, 'planLabel', '')
  const back = editorModel.derive(interest, cleared, { siblings: [] })
  assert.equal(back.attribution.required, true)
  assert.equal(back.attribution.selected, false)
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
  // 再点已选中的同一张卡即取消，不需要单独的“取消指定”按钮。
  page.selectEditorInstallmentPlan(tap({ plan: '合成计划 B' }))
  assert.equal(editor.view(page).payload.sourceCorrection.planLabel, null)
  assert.equal(editor.view(page).attribution.required, true)
  assert.equal(editor.writes(h).length, writes)
})

test('没有归属上下文的分期行不显示归属区', () => {
  const interest = editorRow('interest', 'i-1')
  const view = editorModel.derive(interest, editorModel.create(interest), { siblings: [] })
  assert.equal(view.attribution, null)
})

// 卡内顺序是账本口径，不是入库顺序：利息行经常比本金行先落库，直接按原序渲染会让
// 用户看到「利息在上、本金在下」，读起来像两笔不相干的账。
test('本息同卡时本金固定在上，与入库先后无关', () => {
  const interest = installmentEvent('interest', 9133, 'acct-1', 8, 12, '2026-08-13T09:00:00')
  const principal = installmentEvent('principal', 190275, 'acct-1', 8, 12, '2026-08-13T18:00:00')
  const cards = presentation.buildReviewedCards([interest, principal], { fullEvents: [interest, principal] })
  assert.equal(cards.length, 1)
  assert.deepEqual(cards[0].rows.map(row => row.rowRoleKey), ['principal', 'interest'])
  // 卡头也说本金的计划，而不是先入库的利息摘要。
  assert.equal(cards[0].installmentPlan, '招财猫商城')
})

// 分页按条切，不按分期组切：同组的本金和利息可能被分到两页。本页只剩费用行时，
// 服务端的归属候选证明本期次有本金，那就不能断言“没有本金行”，也不能拿半期的利息算合计。
// 样本放在页面中间：贴页首／页尾的组本来就会被边界规则判为不完整，测不到这条判断。
function plainEvent(id, localAt) {
  return { eventId: id, status: 'ready', economicNature: 'expense', flowDirection: 'outflow',
    ledgerAccountId: 'acct-1', amountMinor: '1000', localAt, reasonCodes: [],
    primaryEvidence: { sourceType: 'wechat', item: '合成消费', counterparty: '' } }
}

test('本页只剩费用行而归属候选里还有本金时，判为跨页并保留提示', () => {
  const interest = installmentEvent('interest', 13511, 'acct-1', 28, 36)
  interest.installmentAttribution = { version: 'installment-attribution-v1', role: 'charge',
    groupKey: 'acct-1|28|36', periodNumber: 28, totalTerms: 36, planLabel: '',
    plans: [{ planName: '电销现分按月收36期', eventId: 'evt-principal-28', amountMinor: '300000' }] }
  const events = [plainEvent('p-1', '2026-08-13T08:00:00'), interest, plainEvent('p-2', '2026-08-13T20:00:00')]
  const cards = presentation.buildReviewedCards(events, { pageEdges: { hasPrevious: true, hasNext: true } })
  const card = cards.find(item => item.isInstallmentCard)
  assert.equal(card.periodComplete, false)
  assert.equal(card.amountText, '')
  assert.match(card.planNote, /本期本金在另一页/)
})

test('确实没有本金候选时仍按“未识别到本金行”说明，不冒充跨页', () => {
  const interest = installmentEvent('interest', 13511, 'acct-1', 28, 36)
  const events = [plainEvent('p-1', '2026-08-13T08:00:00'), interest, plainEvent('p-2', '2026-08-13T20:00:00')]
  const cards = presentation.buildReviewedCards(events, { pageEdges: { hasPrevious: true, hasNext: true } })
  const card = cards.find(item => item.isInstallmentCard)
  assert.equal(card.periodComplete, true)
  assert.equal(card.amountText, '')
  assert.match(card.planNote, /没有识别到分期本金行/)
})
