const api = require('../../../../services/catledger-import')
const cache = require('../../../../services/read-cache')
const pending = require('../../../../services/pending-ledger-write')
const presentation = require('./presentation')
const { record, errorText, sourceCaption, refundCandidateView, canChangeJudgment, groupReviewAction } = presentation
const model = require('./review-editor-model')
const { readDetail } = require('./detail-reader')
const { previewFields } = require('./inline-evidence')
const { setChangedData } = require('../../services/view-patch')
const ACTION = 'financeUpdates.setReview'
// 账单事实（金额、日期、时间、交易对方）只读：核对页只接受用户自己的记账决定，不接受旧控件事件改写原文。
const TEXT_FIELDS = new Set(['note','evidenceNote','principalInput','interestInput','feeInput','periodInput','totalTermsInput'])
function current(page, token) {
  return Boolean(token && page._viewActive && page._reviewEditToken === token && page.data.reviewEditSheet &&
    page._viewEpoch === token.epoch && page._viewSession === token.session && cache.getSession() === token.scope && getApp().hasLoginApproval())
}
function editable(page, token) {
  const sheet = page.data.reviewEditSheet
  return !page._draftSession?.state.postFlight && current(page, token) && token.session.active && token.session.summary.viewVersion === token.version && token.draft &&
    token.row.editorFacts?.version === 1 && !token.row.editorFacts.readonly &&
    !sheet.stale && !sheet.loading && !sheet.saving && !sheet.pending && !sheet.saved
}
// 本次草稿里勾选、且仍属于“本期未归属”的利息。已保存或已经离开候选的行不重复写。
// 归属改动有两类：把未归属的勾给本卡，和把已归到本卡的取消掉。两者都要逐笔写回。
function pendingAttributionChanges(token) {
  if (!token || token.view?.attribution?.role !== 'principal') return { assign: [], clear: [] }
  const ids = new Set((token.view.attribution.pending || []).map(item => item.eventId))
  const pick = set => [...(set || [])].filter(id => ids.has(id))
  return { assign: pick(token.attributionSelections), clear: pick(token.attributionClears) }
}
function packetFor(page, eventId) {
  const packet = pending.pending()
  return packet && packet.target === 'import' && packet.action === ACTION && page.data.update &&
    packet.payload.updateId === page.data.update.updateId && (!eventId || packet.payload.eventId === eventId) ? packet : null
}
function refresh(page) {
  const token = page._reviewEditToken, sheet = page.data.reviewEditSheet || {}
  const view = token.view = model.derive(token.row, token.draft, { accounts: [...token.accounts.values()],
    categories: [...token.categories.values()], siblings: token.siblings || [],
    // 本金编辑器里的未归属利息是可勾选候选；勾选只存在草稿里，保存时才逐笔写回。
    pendingSelections: token.attributionSelections || new Set(),
    // 已归到本卡的利息点一下取消归属：取消也只在草稿里，保存时才写回。
    pendingClears: token.attributionClears || new Set(),
    // 状态文案和暂记动作由模型统一派生，模板不再自己拼条件。候选数量只用于区分
    // “还有候选可选”和“当前没有候选项”，不决定暂记能不能点。
    refundCandidateCount: (sheet.refundChoices || []).length, refundStale: Boolean(sheet.refundStale) })
  const labels = view.accountFields
  const { payload, ...visibleEditor } = view
  const { dirty, dormant, acknowledgedChanges, ...visibleDraft } = token.draft
  setChangedData(page, { reviewEditSheet: { ...sheet, draft: visibleDraft, editor: visibleEditor,
    economicNature: token.draft.economicNature,
    ledgerAccountId: token.draft.ledgerAccountId, counterpartyLedgerAccountId: token.draft.counterpartyLedgerAccountId,
    accountLabel: labels.find(field => field.key === 'account')?.label || '资金账户',
    destinationLabel: labels.find(field => field.key === 'counterparty')?.label || '资金账户',
    accountFields: labels, hasDestination: labels.length === 2, refundClosed: Boolean(view.refundConflict),
    attributionSelected: Boolean(
      (token.attributionSelections && token.attributionSelections.size) || (token.attributionClears && token.attributionClears.size)),
    canSave: view.canSave || Boolean(
      (token.attributionSelections && token.attributionSelections.size) || (token.attributionClears && token.attributionClears.size)), error: '' } })
}
function update(page, key, value) {
  const token = page._reviewEditToken
  if (!editable(page, token)) return
  const next = model.change(token.row, token.draft, key, value)
  if (next === token.draft) return
  // 本金字段和利息归属共用一个保存动作；本金字段真的改了才清掉勾选，
  // 避免保存时只写归属、漏掉本金改动。
  if (token.attributionSelections && token.attributionSelections.size) token.attributionSelections.clear()
  if (token.attributionClears && token.attributionClears.size) token.attributionClears.clear()
  token.draft = next; token.editVersion = (token.editVersion || 0) + 1
  if (['economicNature','ledgerAccountId','counterpartyLedgerAccountId'].includes(key)) {
    token.refundEpoch = (token.refundEpoch || 0) + 1; token.refundOptions = []; token.refundCursor = null
    token.draft.refund = null
    // 金额、时间和对方是只读账单事实；性质或收款账户一改，候选就必须重新核对，
    // 不能继续显示旧候选或空态，否则“本批没有能退这笔的消费”会变成一句假话。
    page.setData({ 'reviewEditSheet.refundChoices': [], 'reviewEditSheet.refundLoading': false,
      'reviewEditSheet.refundStale': true, 'reviewEditSheet.refundTotal': null,
      'reviewEditSheet.refundError': '', 'reviewEditSheet.refundHistoryPending': false })
  }
  if (['loanId','loanMode','owner','economicNature'].includes(key) || key === 'repaymentDetails' && !next.repaymentDetails) {
    token.chargeEpoch = (token.chargeEpoch || 0) + 1
    if (key === 'loanId') { token.charges.clear(); token.chargeCursor = null; token.draft.chargeAllocations = [] }
    page.setData({ 'reviewEditSheet.chargeLoading': false, 'reviewEditSheet.chargeError': '', 'reviewEditSheet.chargeChoices': [], 'reviewEditSheet.chargeMore': false })
  }
  refresh(page)
  page.loadEditorSuggestions()
}
async function evidence(page, token) {
  if (!current(page, token) || token.evidenceReading) return
  token.evidenceReading = true
  try {
    const result = await token.session.read('economicEvents.evidence', { eventId: token.eventId, cursor: token.evidenceCursor || null, pageSize: 8 }, () => current(page, token))
    if (!current(page, token)) return
    const start = token.sourceCount || 0
    token.sourceCount = start + result.items.length; token.evidenceCursor = result.nextCursor
    page.setData({ 'reviewEditSheet.evidenceLoading': false, 'reviewEditSheet.evidenceError': '',
      'reviewEditSheet.moreEvidence': Boolean(result.nextCursor) })
    for (const [offset, source] of result.items.entries()) {
      if (!current(page, token)) return
      const path = 'reviewEditSheet.sources[' + (start + offset) + ']'
      // 标题、账单文件和行号合成一行；长名省略中间，扩展名与行号始终可见。
      const total = Number(result.total || 0) || Math.max(start + result.items.length, 1)
      const label = '原始交易' + (total > 1 ? ' ' + (start + offset + 1) : '')
      page.setData({ [path]: { ...source, fields: [], loading: true,
        sourceCaption: sourceCaption(label, source.fileName, source.rowNumber, 34) } })
      try {
        let text = '', cursor = null
        for (let part = 0; part < 4; part++) {
          const value = await token.session.read('economicEvents.detail', { eventId: token.eventId, evidenceId: source.evidenceId, cursor }, () => current(page, token))
          if (!current(page, token)) return
          text += value.part; cursor = value.nextCursor
          if (!cursor) break
        }
        page.setData({ [path + '.fields']: previewFields(text, !cursor), [path + '.loading']: false, [path + '.incomplete']: Boolean(cursor) })
      } catch (error) { if (current(page, token)) page.setData({ [path + '.loading']: false, [path + '.error']: errorText(error) }) }
    }
  } catch (error) { if (current(page, token)) page.setData({ 'reviewEditSheet.evidenceLoading': false, 'reviewEditSheet.evidenceError': errorText(error) }) }
  finally { token.evidenceReading = false }
}
module.exports = {
  pendingReviewEdit() { return packetFor(this) },
  async openReviewEdit(event) {
    const eventId = event.currentTarget.dataset.id
    if (!eventId || !this._viewActive || !this._viewSession?.active || this.data.busy ||
      this.data.reviewEditSheet?.saving || this.data.update.status !== 'review') return
    const token = this._reviewEditToken = { session: this._viewSession, scope: cache.getSession(), epoch: this._viewEpoch,
      version: this._viewSession.summary.viewVersion, eventId, updateVersion: this.data.update.version,
      accounts: new Map(), categories: new Map(), charges: new Map(), sourceCount: 0, evidenceSources: [],
      // 本金编辑器里勾选的利息只在本机草稿里，保存时才逐笔写回，和退款候选的选择语义一致。
      attributionSelections: new Set(),
      // 已归到本卡的利息被点掉时记在这里，保存时清空那笔的归属。
      attributionClears: new Set(),
      focusIssueId: event.currentTarget.dataset.focusIssueId || '' }
    this.setData({ reviewEditSheet: { eventId, record: null, loading: true, saving: false, pending: false,
      saved: false, stale: false, canSave: false, error: '',
      natureOpen: false, natureHint: '',
      suggestionLoading: false, suggestionError: '', suggestionMore: false,
      sources: [], evidenceLoading: true, evidenceError: '', moreEvidence: false,
      chargeChoices: [], chargeLoading: false, chargeError: '', chargeMore: false,
      refundChoices: [], refundKind: 'event', refundLoading: false, refundError: '', refundTotal: null,
      refundStale: false, refundHistoryPending: false } })
    try {
      const verified = this._reviewDetailToken
      const row = verified?.eventId === eventId && verified.version === token.version && verified.row ||
        await readDetail(token.session, eventId, () => current(this, token))
      if (!current(this, token)) return
      if (!row || !['ready', 'needs_action'].includes(row.status)) throw Error('交易已变化，请返回刷新列表')
      token.row = row
      // 同组行只在打开时取一次：分期归属区据此列出本期次还没指定归属的利息。
      const siblingRows = this._businessData && this._businessData.events || []
      token.siblings = siblingRows.map(record)
      // 保存勾选时要用原事件版本逐笔写回；展示投影不带 version，这里保留一份原始行。
      token.siblingRows = new Map(siblingRows.map(row => [row.eventId, row]))
      const packet = packetFor(this, eventId)
      token.payload = packet && packet.payload
      token.draft = packet ? model.restore(row, packet.payload) : model.create(row)
      for (const item of [].concat(this.data.accounts || [], this.data.accountDrafts || [], row.detailFacts?.accounts || [])) token.accounts.set(item.accountId, item)
      for (const item of [].concat(this.data.categories || [], row.detailFacts?.categories || [])) token.categories.set(item.categoryId, item)
      if (row.categoryId && row.categoryName) token.categories.set(row.categoryId, { categoryId: row.categoryId, name: row.categoryName, kind: model.categoryKind(row.economicNature) })
      // 多来源合成、（重复页签的）记录都能改同笔判断；不能只看是不是还款渠道。
      const judgmentEditable = this.data.update.status === 'review' && Boolean(
        (this.data.duplicateReviewEvents || []).some(item => item.eventId === eventId) ||
        canChangeJudgment(row) || row && row.repaymentChannel)
      // 同笔判断已经由底部“修改同笔判断”承接，不再在来源区重复一个入口。
      const groupAction = groupReviewAction(row.pendingIssue, judgmentEditable)
      this.setData({ 'reviewEditSheet.record': record(row), 'reviewEditSheet.loading': false,
        'reviewEditSheet.pending': Boolean(packet), 'reviewEditSheet.issue': row.pendingIssue || null,
        'reviewEditSheet.groupAction': groupAction,
        'reviewEditSheet.attention': (row.reviewAttention?.steps || []).filter(step => row.status !== 'ready' || step.key !== 'review'),
        'reviewEditSheet.originalRefund': row.detailFacts?.refund || null, 'reviewEditSheet.loanName': row.detailFacts?.loan?.name || '',
        'reviewEditSheet.sourceFields': require('./detail-fields').fieldsFor(row, {}, { omit: ['nature','amount','time','party','account','counterparty','category','note'] }),
        'reviewEditSheet.judgmentEditable': judgmentEditable })
      refresh(this)
      if (packet) this.setData({ 'reviewEditSheet.canSave': true })
      token.suggestionRead = this.loadEditorSuggestions()
      token.evidenceRead = evidence(this, token)
      // 退款默认直接列出本批原消费：候选只在本机内存里过滤，不该让用户先点一次范围才看得到。
      // 不做这一步时页面只显示空块，看起来像“系统没找到”，实际是根本没查。
      if (token.view.refund && editable(this, token)) token.refundRead = this.loadEditorRefunds({ currentTarget: { dataset: {} } })
    } catch (error) { if (current(this, token)) this.setData({ 'reviewEditSheet.loading': false, 'reviewEditSheet.error': errorText(error) }) }
  },
  // 本金编辑器里的未归属利息是可选候选：点一下勾选，再点取消，保存时逐笔归到本计划。
  toggleEditorPendingInterest(event) {
    const token = this._reviewEditToken
    if (!current(this, token) || !editable(this, token)) return
    if (Object.keys(token.draft.dirty).length) {
      this.setData({ 'reviewEditSheet.error': '请先保存本笔修改，再选择利息归属' })
      return
    }
    const id = String(event.currentTarget.dataset.id || '')
    const item = (token.view?.attribution?.pending || []).find(row => row.eventId === id)
    // 已归到别的本金的利息只作展示：点它不生效，改归属要去那笔利息所在的卡里取消。
    if (!item || item.disabled) return
    const selections = token.attributionSelections || (token.attributionSelections = new Set())
    const clears = token.attributionClears || (token.attributionClears = new Set())
    if (item.mine) {
      // 已归到本卡：点一下＝取消归属，保存后这笔回到本期待指定。
      if (clears.has(id)) clears.delete(id)
      else clears.add(id)
    } else if (selections.has(id)) selections.delete(id)
    else selections.add(id)
    refresh(this)
  },
  changeEditorText(event) {
    const key = event.currentTarget.dataset.field
    if (TEXT_FIELDS.has(key)) update(this, key, String(event.detail.value))
  },
  async loadEditorSuggestions(event) {
    const token = this._reviewEditToken
    if (!editable(this, token)) return
    const suggestion = token.view.bankSuggestion
    if (!suggestion) {
      token.suggestionKey = ''
      if (this.data.reviewEditSheet.suggestionLoading || this.data.reviewEditSheet.suggestionError || this.data.reviewEditSheet.suggestionMore) {
        this.setData({ 'reviewEditSheet.suggestionLoading': false, 'reviewEditSheet.suggestionError': '', 'reviewEditSheet.suggestionMore': false })
      }
      return
    }
    if (this.data.reviewEditSheet.suggestionLoading && token.suggestionKey === suggestion.key) return
    if (token.suggestionKey === suggestion.key && !event?.currentTarget?.dataset?.retry) return
    const key = token.suggestionKey = suggestion.key
    const active = () => editable(this, token) && token.suggestionKey === key && token.view.bankSuggestion?.key === key
    this.setData({ 'reviewEditSheet.suggestionLoading': true, 'reviewEditSheet.suggestionError': '', 'reviewEditSheet.suggestionMore': false })
    try {
      const response = await token.session.read('financeUpdates.options', { kind: 'accounts', query: suggestion.bank, pageSize: 12 }, active)
      if (!active()) return
      for (const account of response.items) token.accounts.set(account.accountId, account)
      refresh(this)
      this.setData({ 'reviewEditSheet.suggestionLoading': false, 'reviewEditSheet.suggestionMore': Boolean(response.nextCursor) })
    } catch (error) {
      if (active()) this.setData({ 'reviewEditSheet.suggestionLoading': false, 'reviewEditSheet.suggestionError': '建议账户未能读取，可重试或直接选择账户' })
    }
  },
  selectEditorSuggestion(event) {
    const token = this._reviewEditToken
    if (!editable(this, token)) return
    const suggestion = token.view.bankSuggestion
    const account = suggestion?.candidates.find(item => item.accountId === event.currentTarget.dataset.id)
    if (account) this.selectEditorDirectory(account, suggestion.target)
  },
  // 性质是这张表单的模式：独立一行打开列表，选完立即重建下面全部区域。
  // 分期本金默认“分期出账”，可改判为支出、收入、手续费或待确认；分期利息和手续费由来源确定，只读。
  openNatureSheet() {
    const token = this._reviewEditToken
    if (!editable(this, token) || !token.view?.natureEditable) return
    const draft = token.draft, resets = [], hints = []
    if (token.view.principal) hints.push('本金行改判为支出、收入或手续费后会按实际流水入账；同一笔消费已入账时不要重复选择。')
    if (draft.refund) resets.push('退款原消费')
    if ((draft.chargeAllocations || []).length) resets.push('费用分配')
    if (token.attributionSelections && token.attributionSelections.size) resets.push('利息归属')
    if (resets.length) hints.push('切换会清空已选的' + resets.join('、') + '，需要的话重新选一次。')
    this.setData({ 'reviewEditSheet.natureOpen': true, 'reviewEditSheet.natureHint': hints.join(' ') })
  },
  closeNatureSheet() {
    if (this.data.reviewEditSheet?.natureOpen) this.setData({ 'reviewEditSheet.natureOpen': false, 'reviewEditSheet.natureHint': '' })
  },
  selectEditorNature(event) {
    const index = Number(event.currentTarget.dataset.index)
    const options = this.data.reviewEditSheet?.editor?.natureOptions || []
    if (!Number.isInteger(index) || !options[index]) return
    this.changeReviewedNature({ detail: { value: index } })
    this.closeNatureSheet()
  },
  changeReviewedNature(event) {
    const token = this._reviewEditToken
    if (!editable(this, token) || !token.view?.natureEditable) return
    const option = token.view.natureOptions[Number(event.detail.value)]
    if (!option) return
    this.closeDirectory()
    update(this, 'economicNature', option.value)
    // 切到退款是离散动作：立即按新性质读一次候选，不要等用户再点“本批消费”。
    if (token.view.refund && editable(this, token)) token.refundRead = this.loadEditorRefunds({ currentTarget: { dataset: {} } })
  },
  changeEditorMode(event) {
    const { field, value } = event.currentTarget.dataset
    // 资金结构不再是一个可点的模式：拆开/收起来自账户行的加号与删除，composition 只由 addFundsAccount
    // 和 removeFundsAccount 改写，界面没有直接切换它的入口。
    const choices = { owner: ['self','other'], otherTreatment: ['expense','pending'],
      loanMode: ['defer','associate'], repaymentChannelConfirmed: [true, false] }
    if (!choices[field]?.includes(value)) return
    const token = this._reviewEditToken
    if (!editable(this, token) || field === 'owner' && value === 'other' && token.draft.composition === 'repayment') return
    this.closeDirectory()
    // 可选单选（代还处理方式）允许回到“未选”：再点已选项清空。贷款关联仍是必选，
    // 点已选项保持幂等，不制造假空值。
    if (field === 'otherTreatment' && token.draft.otherTreatment === value) return update(this, field, '')
    update(this, field, value)
  },
  // 还款明细是可选的展开区：收起表示“整笔就是还款本金”。已关联计划时收起仍保留整笔关联；
  // 没关联计划时，收起会解除已有拆分决定。
  toggleRepaymentDetails() {
    const token = this._reviewEditToken
    if (!editable(this, token)) return
    this.closeDirectory()
    update(this, 'repaymentDetails', !token.draft.repaymentDetails)
  },
  // 处理方式三选一：没记过记一笔／记过只冲抵／待核对。三个选项同时摆出来，点哪个是哪个，
  // 不再“点一下换一档”让人猜。信用卡的“记过只冲抵”只把金额计入转账，不生成费用；贷款才会关联收费项。
  setEditorTreatment(event) {
    const token = this._reviewEditToken, { field, value } = event.currentTarget.dataset
    if (!editable(this, token) || !['interestTreatment','feeTreatment'].includes(field) || !['expense','accrued',''].includes(value)) return
    this.closeDirectory()
    update(this, field, value)
  },
  // 分期费用归属：只能从服务端下发的候选计划里选，避免客户端自造计划名。
  // 与退款原消费同一条可选单选规则：再点已选中的计划即取消归属，回到待核对。
  selectEditorInstallmentPlan(event) {
    const token = this._reviewEditToken
    if (!editable(this, token)) return
    const plan = (token.view.attribution?.plans || []).find(item => item.planName === event.currentTarget.dataset.plan)
    if (plan) update(this, 'planLabel', plan.selected ? '' : plan.planName)
  },
  // 资金路径的账户级操作。加号往当前端点组追加一行账户；composition 只在这里被读写，
  // 模板不再需要知道“组合支付/多个还入”这两个模式名。能否点、是否已在分摊都由视图的
  // split/addable 决定，事件层不另判一遍，免得文案和实际行为各说一套。
  addFundsAccount(event) {
    const token = this._reviewEditToken, side = event.currentTarget.dataset.endpoint
    if (!editable(this, token) || !['payer', 'payee'].includes(side)) return
    const endpoint = (token.view.fundsEndpoints || []).find(item => item.key === side)
    if (!endpoint || !endpoint.addable) return
    this.closeDirectory()
    if (endpoint.split) {
      if (token.draft.parts.length >= 20) return
      return update(this, 'parts', token.draft.parts.concat({ accountId: '', amountInput: '' }))
    }
    // 加号是「再加一个账户」：这一端已选的账户留在第一行，不是清空重来。
    const keep = (endpoint.accounts[0] && endpoint.accounts[0].accountId) || ''
    // 另一端若正停在只有一行的多账户上，它的账户要写回单账户字段，否则切换会丢。
    const otherKey = side === 'payer' ? 'counterpartyLedgerAccountId' : 'ledgerAccountId'
    const otherSide = (token.view.fundsEndpoints || []).find(item => item.key !== side)
    const otherKeep = otherSide && otherSide.multi && !otherSide.split && otherSide.accounts[0]
      ? otherSide.accounts[0].accountId || '' : ''
    const target = side === 'payer' ? 'payment' : 'repayment'
    // 已经是这一端的多账户、只是还没到两行：直接补一行，别重播种。
    if (token.draft.composition === target) return update(this, 'parts', token.draft.parts.concat({ accountId: '', amountInput: '' }))
    update(this, 'composition', target)
    if (token.draft.composition !== target) return
    // 分摊至少两行：历史分配或播种只给到一行时补齐，第一行沿用已有账户。
    // 历史分配可能是上一次留下的空行，所以「行数够」不等于「已经有账户」——两行全空时也要把
    // 这一端已选的账户放回第一行，否则点一次加号就看着像账户丢了。
    const restored = token.draft.parts
    const seeded = restored.some(part => part.accountId)
    if (restored.length < 2 || !seeded) {
      const first = restored[0] || { accountId: '', amountInput: '' }
      update(this, 'parts', [{ accountId: first.accountId || keep, amountInput: first.amountInput || '' },
        { accountId: restored[1] ? restored[1].accountId || '' : '', amountInput: restored[1] ? restored[1].amountInput || '' : '' }])
    }
    if (otherKeep && !token.draft[otherKey]) update(this, otherKey, otherKeep)
  },
  changeFundsAmount(event) {
    const token = this._reviewEditToken, index = Number(event.currentTarget.dataset.index)
    if (!editable(this, token) || !Number.isInteger(index) || !token.draft.parts[index]) return
    update(this, 'parts', token.draft.parts.map((part, i) => i === index ? { ...part, amountInput: String(event.detail.value) } : part))
  },
  // 分摊至少要有两行：删到只剩一行就收回单账户，这一端留剩下的那个账户；
  // 一个账户时总额必然全走它，不再需要金额输入。两端各自的账户都按原样放回。
  removeFundsAccount(event) {
    const token = this._reviewEditToken, index = Number(event.currentTarget.dataset.index)
    if (!editable(this, token) || !Number.isInteger(index) || !token.draft.parts[index]) return
    const parts = token.draft.parts.filter((_, i) => i !== index)
    if (parts.length > 1) return update(this, 'parts', parts)
    const side = event.currentTarget.dataset.endpoint === 'payee' ? 'payee' : 'payer'
    const keep = (parts[0] && parts[0].accountId) || ''
    // composition 回 single 会按「不猜保留哪一端」清空两端；撤回前先记下另一端的账户。
    const field = (token.view.accountFields || []).find(item => item.key === (side === 'payee' ? 'account' : 'counterparty'))
    const otherKey = field && field.target === 'reviewCounterparty' ? 'counterpartyLedgerAccountId' : 'ledgerAccountId'
    const other = token.draft[otherKey] || ''
    update(this, 'composition', 'single')
    if (token.draft.composition !== 'single') return
    update(this, side === 'payee' ? 'counterpartyLedgerAccountId' : 'ledgerAccountId', keep)
    if (other) update(this, otherKey, other)
  },
  clearEditorChoice(event) {
    const token = this._reviewEditToken, key = event.currentTarget.dataset.field
    if (!editable(this, token) || !['ledgerAccountId','counterpartyLedgerAccountId','categoryId','interestCategoryId','feeCategoryId','loanId'].includes(key)) return
    update(this, key, '')
    if (key === 'loanId') { update(this, 'loanVersion', 0); this.setData({ 'reviewEditSheet.loanName': '' }) }
  },
  reviewEditorDirectory(target) {
    const token = this._reviewEditToken
    if (!editable(this, token)) return null
    const field = token.view.accountFields.find(field => field.target === target)
    if (field) return field.readonly ? null : { kind: 'accounts', title: '选择' + field.label, selectedId: field.accountId, allowedTypes: field.allowedTypes }
    if (token.view.repaymentChannel) return null
    if (/^editorPart\d+$/.test(target)) return { kind: 'accounts', title: '选择分配账户', selectedId: token.draft.parts[Number(target.slice(10))]?.accountId,
      allowedTypes: token.draft.composition === 'repayment' ? model.DEBTS : token.draft.economicNature === 'repayment' ? model.ASSETS : null }
    const categories = { editorCategory: 'categoryId', editorInterest: 'interestCategoryId', editorFee: 'feeCategoryId' }
    if (categories[target]) return { kind: 'categories', title: '选择分类', selectedId: token.draft[categories[target]],
      categoryKind: target === 'editorCategory' ? token.view.categoryKind : 'expense' }
    if (target === 'editorLoan') return { kind: 'loans', title: '选择贷款计划', selectedId: token.draft.loanId }
    return null
  },
  isReviewEditorCurrent() { return editable(this, this._reviewEditToken) },
  selectReviewedAccount(item, target) { return this.selectEditorDirectory(item, target) },
  selectEditorDirectory(item, target) {
    const token = this._reviewEditToken, options = this.reviewEditorDirectory(target)
    if (!options || !item) return false
    if (options.kind === 'accounts') {
      if (!item.accountId || item.archivedAt || item.unavailable || options.allowedTypes && !options.allowedTypes.includes(item.type)) return false
      token.accounts.set(item.accountId, item)
      if (/^editorPart\d+$/.test(target)) {
        const index = Number(target.slice(10))
        if (!token.draft.parts[index]) return false
        update(this, 'parts', token.draft.parts.map((part, i) => i === index ? { ...part, accountId: item.accountId, label: item.name } : part))
      } else update(this, target === 'reviewAccount' ? 'ledgerAccountId' : 'counterpartyLedgerAccountId', item.accountId)
    } else if (options.kind === 'categories') {
      if (!item.categoryId || item.archivedAt || item.kind !== options.categoryKind) return false
      token.categories.set(item.categoryId, item)
      update(this, { editorCategory: 'categoryId', editorInterest: 'interestCategoryId', editorFee: 'feeCategoryId' }[target], item.categoryId)
    } else {
      if (!item.loanId || !item.version) return false
      if (item.accountId && !token.view.accountFields.some(field => field.label === '还入账户' && field.accountId === item.accountId)) {
        this.setData({ 'reviewEditSheet.error': '该贷款不属于当前还入账户，请先核对资金账户' }); return false
      }
      update(this, 'loanId', item.loanId); update(this, 'loanVersion', Number(item.version)); update(this, 'chargeAllocations', [])
      this.setData({ 'reviewEditSheet.loanName': item.name })
    }
    return true
  },
  async loadEditorRefunds(event) {
    const token = this._reviewEditToken
    if (!editable(this, token) || !token.view.refund || token.view.errors.length || model.minor(token.draft.amountInput) == null || !token.draft.date || !token.draft.time) return
    const data = event?.currentTarget?.dataset || {}, sheet = this.data.reviewEditSheet
    // 默认看本批原消费；历史只在用户明确切换时读取，作为备用范围。
    const kind = data.toggle === 'history' ? 'transaction'
      : data.toggle === 'event' ? 'event'
      : data.kind || sheet.refundKind || 'event'
    // scope 只对本批有意义：'matched' 是默认的“能解释得通”的候选，'all' 是用户主动要求的全量兜底。
    const scope = data.scope === 'all' ? 'all' : data.scope === 'matched' ? 'matched' : (sheet.refundScope || 'matched')
    const more = data.more
    const fingerprintOf = () => JSON.stringify([token.draft.economicNature, token.draft.amountInput, token.draft.date, token.draft.time, token.draft.ledgerAccountId])
    const fingerprint = fingerprintOf()
    const epoch = token.refundEpoch = (token.refundEpoch || 0) + 1
    const active = () => editable(this, token) && token.refundEpoch === epoch && fingerprint === fingerprintOf()
    // 继续读取更多时保留前面页的完整候选，否则翻页后点上一页的卡片会查不到数据，
    // 看起来像“这张卡点不动”。重新筛选才从空列表开始。
    if (!more) token.refundOptions = []
    this.setData({ 'reviewEditSheet.refundKind': kind, 'reviewEditSheet.refundScope': scope, 'reviewEditSheet.refundLoading': true,
      'reviewEditSheet.refundError': '', 'reviewEditSheet.refundStale': false,
      ...(!more ? { 'reviewEditSheet.refundChoices': [], 'reviewEditSheet.refundTotal': null, 'reviewEditSheet.refundMore': false } : {}) })
    refresh(this)
    try {
      const fields = { amountMinor: model.minor(token.draft.amountInput), occurredLocalAt: token.draft.date + ' ' + token.draft.time,
        timezoneOffsetMinutes: token.row.editorFacts.timezoneOffsetMinutes, ledgerAccountId: token.draft.ledgerAccountId || null }
      const result = await token.session.read('economicEvents.refundCandidates', { eventId: token.eventId, eventVersion: token.row.version, kind, scope, fields,
        cursor: more ? token.refundCursor : null, pageSize: 12 }, active)
      if (!active()) return
      // 本批没有“说得通”的候选时自动落到全部消费：按钮仍然只有本批/已入账两个，
      // 但点“本批消费”永远能看到东西，不会只剩一句空话。
      // 同订单的原单已关闭/失败时不再自动放开全部消费：这不是“找不到”，而是状态四，
      // 列一堆无关支出只会干扰判断。
      if (kind === 'event' && scope !== 'all' && Number(result.total) === 0 && !result.closedOriginal && !data.auto) {
        return this.loadEditorRefunds({ currentTarget: { dataset: { kind: 'event', scope: 'all', auto: true } } })
      }
      token.refundCursor = result.nextCursor
      const views = result.items.map(refundCandidateView)
      token.refundOptions = more ? (token.refundOptions || []).concat(result.items) : result.items
      const page = more ? (this.data.reviewEditSheet.refundChoices || []).concat(views) : views
      this.setData({ 'reviewEditSheet.refundChoices': page,
        'reviewEditSheet.refundClosedOriginal': kind === 'event' ? (result.closedOriginal || null) : this.data.reviewEditSheet.refundClosedOriginal,
        'reviewEditSheet.refundHistoryPending': kind === 'transaction' ? result.serverReviewPending === true : this.data.reviewEditSheet.refundHistoryPending,
        'reviewEditSheet.refundTotal': result.total, 'reviewEditSheet.refundMore': Boolean(result.nextCursor),
        'reviewEditSheet.refundStale': false, 'reviewEditSheet.refundLoading': false })
      refresh(this)
    } catch (error) {
      if (active()) {
        this.setData({ 'reviewEditSheet.refundLoading': false, 'reviewEditSheet.refundError': errorText(error) })
        refresh(this)
      }
    }
  },
  // 原单关闭/失败却退款成功：默认按“已退回”处理——原单保持不入账，这笔退款也不入账，
  // 净额 0；这是明确的业务决定，会写进本批决定里，不是静默丢弃。
  async excludeRefundAsReversed() {
    const token = this._reviewEditToken
    const issue = token && token.row && token.row.pendingIssue
    if (!editable(this, token)) return
    // 按钮只在原因码带 refund_source_conflict 时出现，但可处理事项可能已被账户等其他
    // 问题顶到 pendingIssue 之外。这里明说原因，不能再静默返回让按钮看起来点不动。
    if (!issue || issue.issueType !== 'refund_relation') {
      this.setData({ 'reviewEditSheet.error': '这笔退款的核对事项已变化，请返回列表刷新后再试' })
      return
    }
    const accepted = await new Promise(resolve => wx.showModal({ title: '按已退回处理',
      content: '这笔退款对应的原单在账单里是“交易关闭／失败”。确认后原单和这笔退款都不入账，净额 0，原文仍保留。',
      // confirmText 最多 4 个字符；超长时微信直接 fail，弹窗不会出现，看起来就像按钮没反应。
      confirmText: '确认退回', success: resolve, fail: error => resolve({ confirm: false, error }) }))
    if (!accepted.confirm) {
      if (accepted.error && current(this, token)) this.setData({ 'reviewEditSheet.error': '确认窗口没有打开，请再点一次' })
      return
    }
    if (!current(this, token)) return
    try {
      this._draftSession.enqueue([{ kind: 'review', issueId: issue.issueId, issueVersion: issue.version, issueType: issue.issueType,
        subjectIds: issue.subjectEventIds || [token.eventId],
        decision: { decision: 'exclude_events', selection: { mode: 'all' } },
        form: { issueDraft: this.data.issueDraft, historicalSelection: this.data.historicalSelection,
          accountId: '', categoryId: '', categoryChanged: false } }])
      this.closeReviewEdit()
    } catch (error) { this.setData({ 'reviewEditSheet.error': errorText(error) }) }
  },

  // 退款原消费是“可选单选”，不是必须永远有值：再点已选项取消这次选择，回到上一次
  // 已保存的关联（没有则是未选）。清除已保存关系仍走明确的“清除关联”，不会被一次误触拆掉。
  // 暂记是否可点只认模型派生的 editor.refundActions.pending，事件层不再自判一遍候选数。
  selectEditorRefund(event) {
    const token = this._reviewEditToken
    if (!editable(this, token)) return
    const data = event.currentTarget.dataset, draft = token.draft
    if (data.mode === 'pending') {
      // 按钮在草稿已暂记时会让位给「取消暂记」；这里仍支持直接再点一次撤销，
      // 避免资格变化后只剩一个点不动的灰按钮。
      if (draft.refund?.mode === 'pending') return update(this, 'refund', null)
      const action = this.data.reviewEditSheet.editor?.refundActions?.pending
      if (action && action.enabled) update(this, 'refund', { mode: 'pending' })
      else if (action && action.reason) this.setData({ 'reviewEditSheet.error': action.reason })
      return
    }
    if (data.mode === 'clear' || data.mode === 'unlinked') {
      // 有本次草稿选择时先取消草稿；没有草稿选择才清除已保存关系。
      if (draft.refund) update(this, 'refund', null)
      else update(this, 'refund', { mode: 'unlinked' })
      return
    }
    // 候选卡要有当前列表才能选；暂记和撤销不依赖候选读取，不必跟着一起等。
    if (this.data.reviewEditSheet.refundLoading) return
    const item = token.refundOptions?.find(row => row.id === data.id)
    if (!item) return
    const selected = draft.refund?.mode === 'link' && draft.refund.id === item.id
    update(this, 'refund', selected ? null : { mode: 'link', kind: item.kind, id: item.id, version: item.version })
  },
  async loadEditorCharges(event) {
    const token = this._reviewEditToken
    if (!editable(this, token) || !token.view.showLoan || !token.draft.repaymentDetails || !token.draft.loanId || token.draft.loanMode !== 'associate') return
    const loanId = token.draft.loanId, epoch = token.chargeEpoch = (token.chargeEpoch || 0) + 1
    const active = () => editable(this, token) && token.chargeEpoch === epoch && token.draft.loanId === loanId
    this.setData({ 'reviewEditSheet.chargeLoading': true, 'reviewEditSheet.chargeError': '' })
    try {
      const more = event?.currentTarget?.dataset?.more
      const chargeApi = this._draftSession && this._draftSession.isLocal ? { callApi: (action, data) => this._draftSession.call(action, data) } : require('../../../../services/catledger-api')
      const result = await chargeApi.callApi('loans.chargePlan', { loanId, pageSize: 20, ...(more && token.chargeCursor ? { cursor: token.chargeCursor } : {}) }, { force: true })
      if (!active()) return
      if (Number(result.loanVersion) !== token.draft.loanVersion) throw Error('贷款资料已变更，请重新选择该计划后核验费用')
      const choices = result.items.filter(item => ['planned','recorded','baseline'].includes(item.state))
      for (const item of choices) token.charges.set(item.chargeId, item)
      token.chargeCursor = result.nextCursor
      this.setData({ 'reviewEditSheet.chargeChoices': choices.map(item => ({ chargeId: item.chargeId, component: item.component,
        label: (item.periodNumber ? '第 ' + item.periodNumber + ' 期' : '一次性') + (item.component === 'interest' ? '利息' : '费用'),
        treatment: item.state === 'planned' ? '补记费用' : '已记费用', amount: model.yuan(item.outstandingMinor),
        selected: token.draft.chargeAllocations.some(part => part.chargeId === item.chargeId) })),
        'reviewEditSheet.chargeLoading': false, 'reviewEditSheet.chargeMore': Boolean(result.nextCursor) })
    } catch (error) { if (active()) this.setData({ 'reviewEditSheet.chargeLoading': false, 'reviewEditSheet.chargeError': error.message || errorText(error) }) }
  },
  selectEditorCharge(event) {
    const token = this._reviewEditToken, id = event.currentTarget.dataset.id
    if (!editable(this, token) || this.data.reviewEditSheet.chargeLoading) return
    const item = token.charges.get(id)
    if (!item) return
    const old = token.draft.chargeAllocations, exists = old.some(part => part.chargeId === id)
    if (!exists && old.length >= 80) return
    update(this, 'chargeAllocations', exists ? old.filter(part => part.chargeId !== id)
      : old.concat({ chargeId: id, component: item.component, amountInput: model.yuan(item.outstandingMinor) }))
    this.setData({ 'reviewEditSheet.chargeChoices': this.data.reviewEditSheet.chargeChoices.map(choice => ({ ...choice, selected: token.draft.chargeAllocations.some(part => part.chargeId === choice.chargeId) })) })
  },
  changeEditorChargeAmount(event) {
    const token = this._reviewEditToken, index = Number(event.currentTarget.dataset.index)
    if (!editable(this, token) || !Number.isInteger(index) || !token.draft.chargeAllocations[index]) return
    update(this, 'chargeAllocations', token.draft.chargeAllocations.map((part, i) => i === index ? { ...part, amountInput: String(event.detail.value) } : part))
  },
  removeEditorCharge(event) {
    const token = this._reviewEditToken, index = Number(event.currentTarget.dataset.index)
    if (editable(this, token) && Number.isInteger(index)) update(this, 'chargeAllocations', token.draft.chargeAllocations.filter((_, i) => i !== index))
  },
  async openEditorOriginal(event) {
    const token = this._reviewEditToken
    if (!current(this, token) || this.data.reviewEditSheet.saving) return
    this.setData({ 'reviewEditSheet.hidden': true })
    await this.openEvidence({ currentTarget: { dataset: { id: token.eventId } } })
    if (current(this, token) && !this.data.evidenceSheet) this.setData({ 'reviewEditSheet.hidden': false })
  },
  loadEditorEvidence() { const token = this._reviewEditToken; if (current(this, token)) return evidence(this, token) },
  async openEditorIssue() {
    const token = this._reviewEditToken, sheet = this.data.reviewEditSheet, issue = sheet?.issue
    if (!current(this, token) || !sheet?.groupAction || sheet.saving || sheet.pending) return
    if (!issue) return
    if (Object.keys(token.draft.dirty).length) {
      this.setData({ 'reviewEditSheet.error': '请先保存当前修改，再核对关系；关系判断不会自动保存本笔字段' })
      return
    }
    this.closeReviewEdit()
    return this.openIssue({ currentTarget: { dataset: { id: issue.issueId } } })
  },
  async openEditorRepaymentJudgment() {
    const token = this._reviewEditToken
    if (!editable(this, token) || !this.data.reviewEditSheet.judgmentEditable) return
    if (Object.keys(token.draft.dirty).length) {
      this.setData({ 'reviewEditSheet.error': '请先保存当前修改，再修改同笔判断；关系判断不会自动保存本笔字段' })
      return
    }
    this.closeReviewEdit()
    return this.openDuplicateEdit({ currentTarget: { dataset: { id: token.eventId } } })
  },
  invalidateReviewEdit() {
    if (this.data.reviewEditSheet) this.setData({ 'reviewEditSheet.stale': true, 'reviewEditSheet.loading': false,
      ...(!this._reviewEditToken?.sent ? { 'reviewEditSheet.saving': false } : {}),
      'reviewEditSheet.canSave': this.data.reviewEditSheet.pending, 'reviewEditSheet.error': '记录已更新，输入已保留，请重新读取后核验' })
  },
  closeReviewEdit() {
    if (this.data.reviewEditSheet?.saving) return
    this._reviewEditToken = null
    if (this.data.directorySheet?.editorDirectory) this.closeDirectory()
    this.setData({ reviewEditSheet: null }); this.applyPendingBackgroundView()
  },
  async refreshReviewEdit() {
    const token = this._reviewEditToken
    if (!current(this, token) || this.data.reviewEditSheet.saving) return
    if (!token.receipt) {
      const draft = token.draft
      this.setData({ 'reviewEditSheet.saving': true })
      try {
        const summary = await api.readSummary(token.session.summary.update.updateId)
        if (!current(this, token)) return
        this._reviewEditToken = null; this._reviewDetailToken = null
        this.setData({ reviewEditSheet: null, reviewDetailSheet: null })
        await this.applyUpdateView(summary, false, false, false, true)
        await this.openReviewEdit({ currentTarget: { dataset: { id: token.eventId } } })
        const fresh = this._reviewEditToken
        if (!fresh || fresh.eventId !== token.eventId || !editable(this, fresh)) return
        fresh.draft = draft; fresh.editVersion = (token.editVersion || 0) + 1
        refresh(this)
        this.setData({ 'reviewEditSheet.error': '已读取最新记录，输入仍保留，请核验后保存' })
      } catch (error) { if (current(this, token)) this.setData({ 'reviewEditSheet.saving': false, 'reviewEditSheet.error': errorText(error) }) }
      return
    }
    this.setData({ 'reviewEditSheet.saving': true })
    try {
      const summary = await api.readSummary(token.receipt.update.updateId)
      if (!current(this, token)) return
      this._reviewEditToken = null; this._reviewDetailToken = null; this._pendingBackgroundView = null
      this.setData({ reviewEditSheet: null, reviewDetailSheet: null })
      await this.applyUpdateView(summary, false, false, false, true)
      wx.showToast({ title: token.receipt.event?.status === 'needs_action' ? '已保存，仍有待核对事项' : '本笔修改已保存', icon: 'none' })
    } catch (_) { if (current(this, token)) this.setData({ 'reviewEditSheet.saving': false, 'reviewEditSheet.error': '修改已保存，列表暂未刷新，请重试刷新' }) }
  },
  async saveEditorAttributions(token, changes) {
    const planLabel = token.view?.attribution?.planLabel || ''
    if (changes.assign.length && !planLabel) {
      this.setData({ 'reviewEditSheet.error': '这笔本金还没有计划名，不能指定利息归属' })
      return
    }
    // 先勾给本卡，再取消已归到本卡的：两件事都是对单笔利息写 planLabel（null 表示清除）。
    const tasks = changes.assign.map(id => ({ id, planLabel }))
      .concat(changes.clear.map(id => ({ id, planLabel: null })))
    this.setData({ 'reviewEditSheet.saving': true, 'reviewEditSheet.error': '' })
    let updateVersion = token.updateVersion
    let last = null
    const done = []
    try {
      for (const task of tasks) {
        const id = task.id
        const raw = token.siblingRows && token.siblingRows.get(id)
        if (!raw) throw Object.assign(new Error('这笔利息已变化，请重新打开'), { code: 'CONFLICT' })
        const result = await pending.send('import', ACTION, {
          updateId: this.data.update.updateId, updateVersion, eventId: id,
          eventVersion: raw.version, editorVersion: 1, sourceCorrection: { planLabel: task.planLabel }
        }, { exact: true, canSend: () => current(this, token) })
        if (!current(this, token)) return
        last = result.result
        updateVersion = last.update.version
        if (last.event && Number.isInteger(last.event.version)) raw.version = last.event.version
        // 本组快照同步成这一轮的结果，下一次 refresh 不再按旧归属显示。
        const sibling = (token.siblings || []).find(row => row.eventId === id)
        if (sibling) {
          sibling.installmentPlanLabel = task.planLabel || ''
          if (sibling.installmentAttribution) sibling.installmentAttribution = { ...sibling.installmentAttribution, planLabel: task.planLabel || '' }
        }
        if (token.attributionSelections) token.attributionSelections.delete(id)
        if (token.attributionClears) token.attributionClears.delete(id)
        done.push(id)
      }
      token.receipt = last ? { update: last.update } : null
      this.setData({ 'reviewEditSheet.saving': false })
      return this.refreshReviewEdit()
    } catch (error) {
      if (!current(this, token)) return
      this.setData({ 'reviewEditSheet.saving': false })
      refresh(this)
      this.setData({ 'reviewEditSheet.error': done.length
        ? `已归 ${done.length} 笔，剩余 ${ids.length - done.length} 笔未保存，请重试`
        : errorText(error) })
    }
  },
  async saveReviewEdit() {
    const token = this._reviewEditToken, sheet = this.data.reviewEditSheet
    if (!current(this, token) || sheet.saving || sheet.loading || sheet.saved || !sheet.canSave || !sheet.pending && !editable(this, token)) return
    // 本金编辑器里勾选的利息是另一笔事件：先逐笔写回归属，再走原来的本笔保存/刷新。
    // 两件事不混在一个请求里，服务端仍按单笔事务复核；部分失败时保留未保存的勾选。
    const changes = pendingAttributionChanges(token)
    if (changes.assign.length || changes.clear.length) return this.saveEditorAttributions(token, changes)
    const editVersion = token.editVersion || 0
    const payload = token.payload || { updateId: this.data.update.updateId, updateVersion: token.updateVersion,
      eventId: token.eventId, eventVersion: token.row.version, ...token.view.payload }
    const requires = []
    if (!sheet.pending && token.row.detailFacts?.refund?.status === 'confirmed' && (token.draft.economicNature !== 'refund' || token.draft.refund)) requires.push('refund')
    if (!sheet.pending && token.row.loanRepayment && payload.decisions?.repayment === null) requires.push('repayment')
    if (!sheet.pending && token.row.editorFacts && payload.composition && (token.row.paymentResolution || token.row.repaymentAllocations?.length) &&
      (payload.composition.kind !== token.row.editorFacts.composition || payload.composition.incomplete)) requires.push('composition')
    if (requires.length && !requires.every(key => payload.acknowledgedChanges.includes(key))) {
      const accepted = await new Promise(resolve => wx.showModal({ title: '确认关系变更', content: '保存将重新核验或解除本笔已保存的资金分配、退款或还款关系，原始账单不会改变。', success: result => resolve(result.confirm), fail: () => resolve(false) }))
      if (!accepted || !editable(this, token) || editVersion !== (token.editVersion || 0)) return
      payload.acknowledgedChanges = [...new Set(payload.acknowledgedChanges.concat(requires))]
    }
    this.setData({ 'reviewEditSheet.saving': true, 'reviewEditSheet.error': '' })
    try {
      if (!sheet.pending && this._draftSession) await this._draftSession.flush()
      if (!current(this, token) || !sheet.pending && (sheet.stale || !token.session.active || token.session.summary.viewVersion !== token.version)) return
      token.sent = true
      const result = await pending.send('import', ACTION, payload, { exact: true,
        canSend: () => current(this, token) && (sheet.pending || !this.data.reviewEditSheet.stale && token.session.active && token.session.summary.viewVersion === token.version) })
      if (!current(this, token)) return
      token.receipt = result.result
      this.setData({ 'reviewEditSheet.saved': true, 'reviewEditSheet.pending': false, 'reviewEditSheet.canSave': false, 'reviewEditSheet.saving': false })
      return this.refreshReviewEdit()
    } catch (error) {
      if (!current(this, token)) return
      const packet = packetFor(this, token.eventId), stale = ['CONFLICT', 'STALE_VIEW', 'NOT_FOUND'].includes(error.code)
      token.payload = packet && packet.payload
      this.setData({ 'reviewEditSheet.pending': Boolean(packet), 'reviewEditSheet.stale': stale || sheet.stale,
        'reviewEditSheet.canSave': Boolean(packet) || !stale && sheet.canSave,
        'reviewEditSheet.error': packet ? '保存结果待确认，重试会继续上次修改' : stale ? '记录已更新，输入已保留，请重新核验' : errorText(error) })
    } finally { if (current(this, token) && !token.receipt) this.setData({ 'reviewEditSheet.saving': false }) }
  }
}
