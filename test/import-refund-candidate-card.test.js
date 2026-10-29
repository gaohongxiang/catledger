const test = require('node:test')
const assert = require('node:assert/strict')
const presentation = require('../miniprogram/packages/finance/pages/import-workbench/presentation')
const { runtime, fixture } = require('./helpers/paged-workbench')
const editor = require('./helpers/editor-workbench')

// 微信 8 月账单里的真实形状：退款行交易对方与商品都只写“美团平台商户”，
// 原消费行商品是“美团订单-…”，退款金额是原消费之后到达的一笔差价。
const original = { id: 'synthetic-original', version: 3, kind: 'event', localAt: '2026-08-30 14:03:00', utcAt: '2026-08-30 06:03:00',
  amountMinor: '6304', currency: 'CNY', merchant: '美团平台商户', item: '美团订单-26083011200700001303415196319610',
  note: '美团平台商户', sourceType: 'wechat', remainingMinor: '6304' }
const historyCandidate = { id: 'synthetic-history', version: 7, kind: 'transaction', localAt: '2026-08-02 13:56:00', utcAt: '2026-08-02 05:56:00',
  amountMinor: '5869', currency: 'CNY', note: '历史原文串 {"商品":"美团外卖"}', sourceType: 'wechat', remainingMinor: '5846' }

test('退款候选卡把商家、时间、原消费与已退可退、匹配依据分开显示', () => {
  const card = presentation.refundCandidateView({ ...original, matchKind: 'explicit_refund_evidence', note: '' })
  assert.equal(card.title, '美团平台商户')
  assert.equal(card.item, '美团订单-26083011200700001303415196319610')
  assert.equal(card.localAtText, '2026-08-30 14:03')
  assert.equal(card.sourceTypeLabel, '微信')
  assert.equal(card.amountText, '¥63.04')
  assert.equal(card.remainingText, '¥63.04')
  assert.equal(card.refundedText, '¥0.00')
  assert.equal(card.matchLabel, '原单写明已退金额')
  assert.equal(card.id, 'synthetic-original')
})

test('已退金额由原消费减可退算出，历史候选的原文串不直接当标题', () => {
  const card = presentation.refundCandidateView(historyCandidate)
  assert.equal(card.refundedText, '¥0.23')
  assert.equal(card.remainingText, '¥58.46')
  assert.equal(card.title, '历史原文串', '夹在正文后的原文串被去掉，只留可读文字')
  assert.equal(card.amountText, '¥58.69')
  // 整段都是原文 JSON 时才按字段取：商户优先，其次是商品。
  assert.equal(presentation.refundCandidateView({ note: '{"交易对方":"美团平台商户","商品":"美团外卖"}' }).title, '美团平台商户')
  assert.equal(presentation.refundCandidateView({ note: '{"商品":"美团外卖"}' }).title, '美团外卖')
})

test('商家缺失时退回商品名，两者都没有才显示未命名', () => {
  assert.equal(presentation.refundCandidateView({ item: '美团订单-1' }).title, '美团订单-1')
  assert.equal(presentation.refundCandidateView({}).title, '未命名原消费')
})

test('编辑器默认展示本批原消费，历史只能由用户主动切换且不覆盖本批结果', async t => {
  const data = fixture(1, true)
  Object.assign(data.events[0], { economicNature: 'refund', flowDirection: 'inflow', amountMinor: '11' })
  data.issues[0].issueType = 'refund_relation'
  data.issues[0].primaryReasonCode = 'refund_relation_required'
  const h = runtime(data), page = h.page
  t.after(() => page.onUnload())
  h.refundCandidates = { event: [{ ...original, matchKind: 'merchant_evidence' }], transaction: [historyCandidate] }
  await page.openReviewEdit(editor.tap({ id: data.events[0].eventId }))
  const refunds = action => h.calls.filter(call => call.action === 'economicEvents.refundCandidates' && call.input.kind === action)
  // 打开即列出本批原消费：不再要求用户先点一次范围，否则一进来是空块。
  await page._reviewEditToken.refundRead
  assert.equal(refunds('event').length, 1, '打开编辑器就读取本批原消费')
  assert.equal(refunds('transaction').length, 0, '打开时不顺手查已入账范围')
  const first = page.data.reviewEditSheet.refundChoices[0]
  assert.equal(first.id, original.id)
  assert.equal(first.matchLabel, '同一商户')
  await page.loadEditorRefunds(editor.tap({ toggle: 'history' }))
  assert.equal(page.data.reviewEditSheet.refundKind, 'transaction')
  assert.equal(page.data.reviewEditSheet.refundChoices[0].id, historyCandidate.id)
  await page.loadEditorRefunds(editor.tap({ toggle: 'event' }))
  assert.equal(page.data.reviewEditSheet.refundKind, 'event')
  assert.equal(page.data.reviewEditSheet.refundChoices[0].id, original.id, '切回本批不残留历史候选')
})

test('详情工具栏：合成来源数与按钮同路由，同笔判断与核对结果同一行', () => {
  const fs = require('node:fs'), path = require('node:path')
  const dir = path.join(__dirname, '../miniprogram/packages/finance/pages/import-workbench')
  const markup = fs.readFileSync(path.join(dir, 'review-detail.wxml'), 'utf8')
  const styles = fs.readFileSync(path.join(dir, 'review-editor.wxss'), 'utf8')
  assert.match(markup, /class="sheet-actions detail-actions"/)
  const row = markup.slice(markup.indexOf('editor-actions-row'), markup.indexOf('wx:elif="{{reviewDetailSheet.reviewEditable}}"'))
  assert.match(row, /openReviewJudgment/)
  assert.match(row, /openReviewEdit/)
  assert.ok(markup.indexOf('返回列表') > markup.indexOf('editor-actions-row'), '返回列表在操作行下方')
  assert.match(styles, /\.detail-actions/)
})

test('多笔合成一笔的事件详情也提供修改同笔判断，且与修改核对结果同排', async t => {
  const { runtime, fixture } = require('./helpers/paged-workbench')
  const tap = id => ({ currentTarget: { dataset: { id } } })
  // 同笔合并后主事件只留下一条 primary 来源，pairCount 记录合成前有两条来源。
  const data = fixture(1)
  data.events[0] = { ...data.events[0], evidenceCount: 1, duplicateEvidenceCount: 0, pairCount: 2 }
  const h = runtime(data), page = h.page
  t.after(() => page.onUnload())
  h.intercept = action => action === 'economicEvents.evidence' ? { viewVersion: h.summary.viewVersion, items: [], total: 0, nextCursor: null } : undefined
  await page.setStep({ currentStep: 3, activeReviewStatus: 'completed' })
  await page.openReviewDetails(tap(data.events[0].eventId))
  assert.equal(page.data.reviewDetailSheet.canEdit, true, '合成来源数就绪时应给同笔判断入口')
  assert.equal(page.data.reviewDetailSheet.reviewEditable, true)
})

test('自动关联的退款也能回看并更换：已关联信息进入编辑器，读取候选不回服务器', async t => {
  const data = fixture(1, true)
  Object.assign(data.events[0], { economicNature: 'refund', flowDirection: 'inflow', amountMinor: '11',
    detailFacts: { refund: { status: 'confirmed', autoLinked: true,
      originals: [{ eventId: 'synthetic-original', localAt: '2026-08-30 14:03', amountMinor: '6304', categoryName: '餐饮',
        matchKind: 'explicit_refund_evidence' }] } } })
  data.issues[0].issueType = 'refund_relation'
  data.issues[0].primaryReasonCode = 'refund_relation_required'
  const h = runtime(data), page = h.page
  t.after(() => page.onUnload())
  h.refundCandidates = { event: [{ ...original, matchKind: 'merchant_evidence' }], transaction: [] }
  await page.openReviewEdit(editor.tap({ id: data.events[0].eventId }))
  const linked = page.data.reviewEditSheet.editor.refundLinked
  assert.equal(linked.id, 'synthetic-original')
  assert.equal(linked.auto, true)
  assert.equal(linked.matchKind, 'explicit_refund_evidence')
  await page.loadEditorRefunds(editor.tap({}))
  // 已关联的自动退款默认就是当前选择，保存前不必再挑一次。
  assert.equal(linked.auto, true)
  // 改选另一笔时，决策里带上它的事实版本，保存前由服务端重新核验额度。
  page.selectEditorRefund(editor.tap({ id: original.id }))
  const decision = page._reviewEditToken.view.payload.decisions.refund
  assert.equal(decision.mode, 'link')
  assert.equal(decision.kind, 'event')
  assert.equal(decision.id, original.id)
  assert.equal(decision.version, original.version)
})

test('问题面板的退款候选也换成同一套卡片：点选后由底部按钮确认', async t => {
  const data = fixture(1, true)
  Object.assign(data.events[0], { economicNature: 'refund', flowDirection: 'inflow', amountMinor: '11' })
  data.issues[0].issueType = 'refund_relation'
  data.issues[0].primaryReasonCode = 'refund_relation_required'
  const h = runtime(data), page = h.page
  t.after(() => page.onUnload())
  const relation = { relationId: 'synthetic-relation', relationType: 'refund_of', status: 'proposed', version: 1,
    sourceEventId: data.events[0].eventId, targetEventId: 'synthetic-original', amountMinor: '11', currency: 'CNY',
    reasonCodes: ['refund_merchant_evidence_candidate'] }
  h.intercept = action => {
    if (action !== 'reviewIssues.members') return
    return { protocolVersion: 2, viewVersion: h.summary.viewVersion, items: [{
      objectType: 'relation', objectId: relation.relationId, objectVersion: 1, memberRole: 'candidate',
      relation: { ...relation, targetEvent: { eventId: 'synthetic-original', version: 2, economicNature: 'expense',
        amountMinor: '6304', localAt: '2026-08-30 14:03:00', primaryEvidence: { sourceType: 'wechat', counterparty: '美团平台商户', item: '美团订单-1' } } }
    }], total: 1, nextCursor: null }
  }
  await page.openIssue({ currentTarget: { dataset: { id: data.issues[0].issueId } } })
  const card = page.data.issueRelations[0]
  assert.equal(card.title, '美团平台商户')
  assert.equal(card.matchLabel, '同一商户')
  assert.ok(card.amountText, '卡片带金额')
  assert.equal(page.data.issueDraft.targetEventId, 'synthetic-original', '唯一候选默认选中')
  assert.match(page.data.issueRefundPending.reason, /选中的原消费不会生效/, '选了一笔后说明暂记会覆盖这次选择')
  page.selectIssueRefund({ currentTarget: { dataset: { id: 'synthetic-original' } } })
  assert.equal(page.data.issueDraft.targetEventId, '', '再点已选项取消选择')
  assert.match(page.data.issueRefundPending.reason, /补关联/, '取消后回到“先入账、暂不冲减”的说明')
  page.selectIssueRefund({ currentTarget: { dataset: { id: 'synthetic-original' } } })
  assert.equal(page.data.issueDraft.targetEventId, 'synthetic-original')
})

test('问题面板有候选时也能暂记，直接写入“这些都不是”', async t => {
  const data = fixture(1, true)
  Object.assign(data.events[0], { economicNature: 'refund', flowDirection: 'inflow', amountMinor: '11' })
  data.issues[0].issueType = 'refund_relation'
  data.issues[0].primaryReasonCode = 'refund_relation_required'
  const h = runtime(data), page = h.page
  t.after(() => page.onUnload())
  h.intercept = action => action === 'reviewIssues.members'
    ? { protocolVersion: 2, viewVersion: h.summary.viewVersion, items: [], total: 0, nextCursor: null } : undefined
  await page.openIssue({ currentTarget: { dataset: { id: data.issues[0].issueId } } })
  const pending = page.data.issueRefundPending
  assert.equal(pending.visible, true)
  assert.equal(pending.enabled, true)
  assert.match(pending.reason, /补关联/)
  page.markIssueRefundPending()
  // 入队即代表已接受这次决定；不要求候选范围为空，也不先写一条“为什么不能点”。
  const queued = page._draftSession.state.entries.find(entry => entry.issueId === data.issues[0].issueId)
  assert.equal(queued.decision.decision, 'mark_refund_pending')
})

test('多来源合成的退款也能改同笔判断：按钮与保存同一行', async t => {
  const data = fixture(1, true)
  // 同笔合并后主事件只剩一条 primary，pairCount 记录合成前有两条来源。
  Object.assign(data.events[0], { economicNature: 'refund', flowDirection: 'inflow', amountMinor: '23',
    evidenceCount: 1, duplicateEvidenceCount: 0, pairCount: 2 })
  const h = runtime(data), page = h.page
  t.after(() => page.onUnload())
  await page.openReviewEdit(editor.tap({ id: data.events[0].eventId }))
  assert.equal(page.data.reviewEditSheet.judgmentEditable, true, '合成来源数就绪时应给同笔判断入口')
  const fs = require('node:fs'), path = require('node:path')
  const markup = fs.readFileSync(path.join(__dirname, '../miniprogram/packages/finance/pages/import-workbench/review-edit.wxml'), 'utf8')
  const row = markup.slice(markup.indexOf('wx:elif="{{reviewEditSheet.judgmentEditable}}"'), markup.indexOf('wx:else class="sheet-confirm sheet-confirm-wide"'))
  assert.match(row, /openEditorRepaymentJudgment/)
  assert.match(row, /saveReviewEdit/)
})
