const api = require('../../services/catledger-import')
const readCache = require('../../services/read-cache')
const observer = require('../../services/read-observer')
const inlineEvidence = require('./inline-evidence')
const { formatMinor } = require('../../utils/money')
const { errorText, direction } = require('./presentation')

// 建议配对一页十组，逐笔判断一页一对；选择范围由服务端签名。
const SUGGESTED_PAGE_SIZE = 10
const initialData = { pairingSheet: null, pairingRows: [], pairingPage: null, pairingLoading: false,
  pairingError: '', pairingCanConfirm: false, pairingSelectedCount: 0, pairingPageSelectedCount: 0,
  pairingScopeText: '', pairingChoiceText: '', pairingNeedsRecheck: false, pairingMissingCount: 0,
  pairingProgressText: '', pairingBusy: false, pairingCanResume: false, pairingSaved: false, pairingCanDecide: false }
const copy = value => JSON.parse(JSON.stringify(value))
const keyFor = (mode, issueId) => mode + ':' + (issueId || 'all')
const owner = () => { const app = getApp(); return app.hasLoginApproval() ? app.globalData.uid || '' : '' }

function active(page, token) {
  return token && page._viewActive && page._pairingToken === token && token.owner === owner() &&
    token.scope === readCache.getSession() && page._viewEpoch === token.epoch && page._viewSession === token.session
}
function current(page, token) { return active(page, token) && token.session.active && token.version === token.session.summary.viewVersion }
function draftFor(page) {
  const sheet = page.data.pairingSheet
  return sheet && page._draftSession && page._draftSession.state.pairingDrafts[sheet.key]
}
function rowsFor(row) {
  const display = record => ({ eventId: record.eventId, sourceLabel: { bank: '银行卡账单', wechat: '微信账单', alipay: '支付宝账单' }[record.sourceType] || '原始账单',
    localAt: record.localAt || '', title: String(record.counterparty || record.item || '待核对记录').slice(0, 160), item: String(record.item || '').slice(0, 160),
    amountText: (record.currency && record.currency !== 'CNY' ? record.currency + ' ' : '') + formatMinor(record.amountMinor),
    evidenceCount: record.evidenceCount, evidence: [], evidenceLoading: true, evidenceError: '' })
  return { pairKey: row.pairKey, economicNature: row.economicNature, collapsed: false,
    natureLabel: { expense: '消费', refund: '退款' }[row.economicNature] || '待入账记录',
    bank: display(row.bank), platform: display(row.platform),
    reasonText: '账户、金额、币种与收支方向一致，交易分钟和支付渠道符合匹配规则。' }
}
function progressFor(task) { return task && (task.progress || task) }
function mark(page, token, phase, start) {
  if (!active(page, token) || token.marks.has(phase)) return
  token.marks.add(phase)
  observer.record('interactive', { page: 'pages/import-workbench/index', phase, elapsedMs: Date.now() - (start || token.startedAt), ok: true })
}

function render(page) {
  const sheet = page.data.pairingSheet, token = page._pairingToken
  if (!sheet || !active(page, token)) return
  const session = page._draftSession, draft = draftFor(page), range = page._pairingRange
  const task = session.pairingTask(sheet.key), progress = progressFor(task)
  const missing = new Set(draft && draft.missingPairKeys || [])
  const choices = new Map((draft && draft.pairs || []).filter(pair => !missing.has(pair.pairKey)).map(pair => [pair.pairKey, pair]))
  const exclusions = new Set((draft && draft.excludedPairKeys || []).filter(key => !missing.has(key)))
  const used = new Set()
  choices.forEach(pair => { used.add(pair.bankEventId); used.add(pair.platformEventId) })
  const choicePatch = {}
  const rows = (page.data.pairingRows || []).map((row, index) => {
    const choice = choices.get(row.pairKey), decision = sheet.mode === 'suggested' ? exclusions.has(row.pairKey) ? '' : 'same' : choice && choice.decision || ''
    const state = { decision, selected: Boolean(decision), occupied: !decision && (used.has(row.bank.eventId) || used.has(row.platform.eventId)) }
    for (const [key, value] of Object.entries(state)) if (row[key] !== value) choicePatch['pairingRows[' + index + '].' + key] = value
    return state
  })
  const saved = Boolean(task && task.status === 'saved' && !(draft && draft.scopeToken && draft.scopeToken !== task.scopeToken))
  const pendingTask = task && task.kind === 'pairing' && task.status !== 'saved'
  const syncing = Boolean(pendingTask && session.status.syncing)
  const needsRecheck = Boolean(draft && (draft.needsRecheck || draft.viewVersion !== token.session.summary.viewVersion))
  const selected = sheet.mode === 'suggested' ? Math.max(0, (range && range.total || 0) - exclusions.size) : choices.size
  const otherPending = session.state.entries.some(entry => entry.status !== 'saved' && entry.issueId !== 'pairing:' + sheet.key)
  const ready = Boolean(current(page, token) && range && draft && draft.scopeToken === range.scopeToken && !page.data.pairingLoading && !page.data.pairingError &&
    !needsRecheck && (!missing.size || draft.missingAcknowledged) && (!pendingTask || task.error) && !saved && !otherPending && !session.status.syncing)
  let scopeText = ''
  if (range) {
    scopeText = sheet.mode === 'suggested' ? '共 ' + range.total + ' 组' + (Number.isSafeInteger(range.scopeSourceCount) ? '，' + range.scopeSourceCount + ' 条来源' : '')
      : '当前范围共 ' + range.total + ' 条候选关系；每条记录本次最多用于一条决定'
    if (sheet.mode === 'suggested' && !exclusions.size && range.scopeNatureCounts) {
      const counts = range.scopeNatureCounts
      scopeText += '（消费 ' + Number(counts.expense || 0) + ' 组、退款 ' + Number(counts.refund || 0) + ' 组）'
    }
  }
  let progressText = ''
  if (progress && Number.isSafeInteger(progress.savedCount)) {
    progressText = (task.previousSavedCount ? '此前已保存 ' + task.previousSavedCount + ' 组；本轮' : '') + '已保存 ' + progress.savedCount + ' / ' + progress.totalCount + ' 组'
    if (progress.remainingCount) progressText += '，剩余 ' + progress.remainingCount + ' 组' + (task.error ? '待重新核对' : session.state.flight ? '结果待核实' : '待提交')
    else progressText += task.summaryReady ? '，结果已更新' : '，结果待刷新'
  }
  page.setData({ ...choicePatch, pairingSelectedCount: selected, pairingPageSelectedCount: rows.filter(row => row.selected).length,
    pairingScopeText: scopeText, pairingChoiceText: sheet.mode === 'suggested' ? '跨页共选 ' + selected + ' 组' + (exclusions.size ? ' · 已取消 ' + exclusions.size + ' 组' : '') : '跨页共选 ' + selected + ' 条决定',
    pairingNeedsRecheck: needsRecheck, pairingMissingCount: missing.size && !draft.missingAcknowledged ? missing.size : 0,
    pairingBusy: syncing, pairingSaved: saved, pairingProgressText: progressText,
    pairingCanResume: Boolean(pendingTask && !task.error && !session.status.syncing || saved && !task.summaryReady),
    pairingCanDecide: ready && sheet.mode === 'ambiguous' && rows.length === 1,
    pairingCanConfirm: ready && selected > 0 }, () => {
      if (page.data.pairingCanConfirm) mark(page, token, 'pairing_ready')
      if (saved && token.submitStartedAt) mark(page, token, 'pairing_submit', token.submitStartedAt)
    })
}

function persistChoices(page, draft) {
  const next = Object.assign({}, draft, { revision: Number(draft.revision || 0) + 1 })
  page._draftSession.savePairingDraft(page.data.pairingSheet.key, next)
  render(page)
}

async function open(page, mode, issueId, recheck) {
  if (!page._viewActive || !page._viewSession || !page._viewSession.active || !page._draftSession || page.data.update.status !== 'review') return
  page.cancelPairingReview()
  const session = page._viewSession, key = keyFor(mode, issueId)
  const token = page._pairingToken = { session, version: session.summary.viewVersion, epoch: page._viewEpoch, scope: readCache.getSession(), owner: owner(), startedAt: Date.now(), marks: new Set() }
  page._pairingRange = null
  page.setData(Object.assign({}, initialData, { pairingSheet: { key, mode, issueId, title: mode === 'suggested' ? '建议配对' : '判断是否同一笔' }, pairingLoading: true }), () => mark(page, token, 'pairing_feedback'))
  let draft = draftFor(page)
  if (!draft) {
    draft = { mode, issueId, viewVersion: token.version, revision: 0, excludedPairKeys: [], missingPairKeys: [], pairs: [], needsRecheck: false }
    try { page._draftSession.savePairingDraft(key, draft) } catch (error) { page.setData({ pairingLoading: false, pairingError: errorText(error) }); return }
  }
  const input = { mode, pageSize: mode === 'ambiguous' ? 1 : SUGGESTED_PAGE_SIZE }
  if (issueId) input.issueId = issueId
  if (recheck) input.recheckPairKeys = mode === 'suggested' ? draft.excludedPairKeys || [] : (draft.pairs || []).map(pair => pair.pairKey)
  page._pairingRecheck = Boolean(recheck)
  page._pairingPager = session.pager('reviewIssues.pairings', input)
  page._unsubscribePairing = page._draftSession.subscribe(() => render(page))
  return page.changePairingPage({ currentTarget: { dataset: {} } })
}

module.exports = {
  SUGGESTED_PAGE_SIZE,
  initialData,
  openPairingReview() { return open(this, 'suggested', '') },
  openAmbiguousPairingReview(event) {
    const dataset = event && event.currentTarget && event.currentTarget.dataset || {}
    return open(this, 'ambiguous', dataset.issueId || dataset.id || '')
  },
  cancelPairingReview() {
    if (this._pairingPager) this._pairingPager.cancel()
    if (this._pairingInlineEvidence) this._pairingInlineEvidence.close()
    if (this._unsubscribePairing) this._unsubscribePairing()
    this._pairingPager = null; this._pairingInlineEvidence = null; this._unsubscribePairing = null
    this._pairingToken = null; this._pairingRange = null; this._pairingRefreshToken = null
    if (this.data.pairingSheet) this.setData(Object.assign({}, initialData))
  },
  closePairingReview() { this.cancelPairingReview(); this.applyPendingBackgroundView() },
  invalidatePairingReview(view) {
    const draft = draftFor(this), token = this._pairingToken
    if (!active(this, token) || view.viewVersion === token.version) return
    if (this._pairingInlineEvidence) this._pairingInlineEvidence.close()
    if (this._pairingPager) this._pairingPager.cancel()
    this.setData({ pairingLoading: false, pairingCanConfirm: false })
    if (!draft) { render(this); return }
    if (draft.needsRecheck) { render(this); return }
    const task = this._draftSession.pairingTask(this.data.pairingSheet.key)
    if (task && task.status === 'saved') { render(this); return }
    try { this._draftSession.savePairingDraft(this.data.pairingSheet.key, Object.assign({}, draft, { needsRecheck: true })) }
    catch (error) { this.setData({ pairingError: errorText(error) }) }
    render(this)
  },
  async changePairingPage(event) {
    const token = this._pairingToken, pager = this._pairingPager
    if (!current(this, token) || !pager) return
    if (this._pairingInlineEvidence) this._pairingInlineEvidence.close()
    this._pairingInlineEvidence = null
    const request = this._pairingPageToken = {}
    const valid = () => current(this, token) && this._pairingPageToken === request
    this.setData({ pairingLoading: true, pairingCanConfirm: false, pairingError: '' })
    try {
      const response = await pager.load(direction(event))
      if (!valid()) return
      if (typeof response.scopeToken !== 'string' || !Number.isSafeInteger(response.total) || !Array.isArray(response.items)) throw new Error('配对范围尚未核实，请重试')
      this._pairingRange = response
      const draft = copy(draftFor(this))
      if (this._pairingRecheck) {
        const requested = this.data.pairingSheet.mode === 'suggested' ? draft.excludedPairKeys || [] : (draft.pairs || []).map(pair => pair.pairKey)
        const returned = response.returnedKeys || [], missing = response.missingKeys || []
        if (requested.some(key => !returned.includes(key) && !missing.includes(key))) throw new Error('原选择尚未完成核验，请重新核对')
        draft.missingPairKeys = missing; draft.missingAcknowledged = !missing.length; draft.needsRecheck = false
      }
      if (draft.viewVersion !== token.version && !this._pairingRecheck) draft.needsRecheck = true
      else {
        draft.scopeToken = response.scopeToken; draft.viewVersion = token.version; draft.total = response.total
        draft.sourceCount = response.scopeSourceCount
      }
      this._pairingRecheck = false
      this._draftSession.savePairingDraft(this.data.pairingSheet.key, draft)
      const rows = response.items.map(rowsFor)
      this.setData({ pairingRows: rows, pairingPage: response.page, pairingLoading: false }, () => mark(this, token, 'pairing_content'))
      render(this)
      const records = [], locations = []
      rows.forEach((row, index) => ['bank', 'platform'].forEach(side => { records.push(row[side]); locations.push({ index, side }) }))
      const reader = this._pairingInlineEvidence = inlineEvidence.create(token.session, records, valid, (index, patch) => {
        if (!valid()) return
        // 每次只更新一组并保留摘要及勾选，十组长原文不作为整页反复传输。
        const location = locations[index], row = this.data.pairingRows[location.index]
        if (!row || row.pairKey !== rows[location.index].pairKey) return
        this.setData({ ['pairingRows[' + location.index + ']']: { ...row, [location.side]: { ...row[location.side], ...patch } } })
      })
      reader.loadAll().catch(() => {})
    } catch (error) {
      if (!valid()) return
      this.setData({ pairingLoading: false, pairingError: errorText(error), pairingCanConfirm: false })
      if (['STALE_VIEW', 'CONFLICT', 'INVALID_CURSOR'].includes(error.code)) this.invalidatePairingReview({ viewVersion: '' })
    }
  },
  retryPairingPage() { return this.changePairingPage({ currentTarget: { dataset: {} } }) },
  togglePairingCard(event) {
    const index = this.data.pairingRows.findIndex(row => row.pairKey === event.currentTarget.dataset.key)
    if (this.data.pairingLoading || index < 0) return
    this.setData({ ['pairingRows[' + index + '].collapsed']: !this.data.pairingRows[index].collapsed })
  },
  togglePairingPage() {
    const sheet = this.data.pairingSheet
    if (!sheet || sheet.mode !== 'suggested' || !this.data.pairingRows.length || this.data.pairingLoading || this.data.pairingBusy || this.data.pairingSaved || this.data.pairingNeedsRecheck) return
    const draft = draftFor(this), task = this._draftSession && this._draftSession.pairingTask(sheet.key)
    if (!draft || task && task.kind === 'pairing' && !task.error && task.status !== 'saved') return
    const next = copy(draft), excluded = new Set(next.excludedPairKeys || [])
    const allSelected = this.data.pairingRows.every(row => row.selected)
    this.data.pairingRows.forEach(row => { if (allSelected) excluded.add(row.pairKey); else excluded.delete(row.pairKey) })
    next.excludedPairKeys = [...excluded]
    try { this.setData({ pairingError: '' }); persistChoices(this, next) }
    catch (error) { this.setData({ pairingError: errorText(error), pairingCanConfirm: false }) }
  },
  selectPairing(event) {
    if (this.data.pairingLoading || this.data.pairingBusy || this.data.pairingSaved || this.data.pairingNeedsRecheck) return
    const draft = draftFor(this), row = this.data.pairingRows.find(item => item.pairKey === event.currentTarget.dataset.key)
    if (!draft || !row) return
    const task = this._draftSession.pairingTask(this.data.pairingSheet.key)
    if (task && task.kind === 'pairing' && !task.error && task.status !== 'saved') return
    const next = copy(draft)
    if (this.data.pairingSheet.mode === 'suggested') {
      const excluded = new Set(next.excludedPairKeys || [])
      if (excluded.has(row.pairKey)) excluded.delete(row.pairKey); else excluded.add(row.pairKey)
      next.excludedPairKeys = [...excluded]
    } else {
      const decision = event.currentTarget.dataset.decision || 'same'
      if (row.occupied) { this.setData({ pairingError: '这条记录已有另一条决定，请先取消原选择或保存后再核对' }); return }
      const prior = next.pairs.find(pair => pair.pairKey === row.pairKey)
      next.pairs = next.pairs.filter(pair => pair.pairKey !== row.pairKey)
      if (!prior || prior.decision !== decision) {
        if (next.pairs.length >= 100) { this.setData({ pairingError: '一次最多确认 100 条具体配对决定，请先保存当前选择；本次新增项未选中' }); return }
        next.pairs.push({ pairKey: row.pairKey, decision, bankEventId: row.bank.eventId, platformEventId: row.platform.eventId })
      }
    }
    try { this.setData({ pairingError: '' }); persistChoices(this, next) }
    catch (error) { this.setData({ pairingError: errorText(error), pairingCanConfirm: false }) }
  },
  acknowledgeMissingPairings() {
    const draft = draftFor(this)
    if (!draft || !(draft.missingPairKeys || []).length) return
    try { persistChoices(this, Object.assign({}, draft, { missingAcknowledged: true })) }
    catch (error) { this.setData({ pairingError: errorText(error), pairingCanConfirm: false }) }
  },
  changePairingEvidence(event) {
    if (this._pairingInlineEvidence) return this._pairingInlineEvidence.change(event.currentTarget.dataset.id, direction(event))
  },
  async recheckPairings() {
    const sheet = this.data.pairingSheet, task = sheet && this._draftSession.pairingTask(sheet.key)
    if (!sheet || this.data.pairingBusy || task && this._draftSession.state.flight && this._draftSession.state.flight.ids.includes(task.issueId)) return
    const updateId = this.data.update.updateId, mode = sheet.mode, issueId = sheet.issueId
    this.cancelPairingReview()
    const refresh = this._pairingRefreshToken = { epoch: this._viewEpoch, owner: owner(), scope: readCache.getSession() }
    this.setData({ pairingSheet: sheet, pairingLoading: true, pairingCanConfirm: false })
    const valid = () => this._viewActive && this._pairingRefreshToken === refresh && refresh.epoch === this._viewEpoch && refresh.owner === owner() && refresh.scope === readCache.getSession()
    try {
      const view = await api.readSummary(updateId)
      if (!valid()) return
      this.applyUpdateView(view, false)
      return open(this, mode, issueId, true)
    } catch (error) { if (valid()) this.setData({ pairingLoading: false, pairingError: errorText(error) }) }
  },
  async confirmPairings() {
    const token = this._pairingToken
    if (!current(this, token) || !this.data.pairingCanConfirm) return
    const session = this._draftSession, sheet = this.data.pairingSheet
    try {
      token.submitStartedAt = Date.now()
      session.enqueuePairing(sheet.key, draftFor(this), this.data.pairingSelectedCount)
      render(this)
      await session.flush()
    } catch (error) {
      if (active(this, token)) this.setData({ pairingError: session.status.error || errorText(error) })
    } finally { if (active(this, token)) render(this) }
  },
  async decidePairing(event) {
    const token = this._pairingToken, decision = event.currentTarget.dataset.decision
    if (!current(this, token) || !this.data.pairingCanDecide || !['same', 'distinct'].includes(decision)) return
    const row = this.data.pairingRows[0], draft = copy(draftFor(this)), session = this._draftSession
    // 此次点击只授权当前这一对；不能夹带旧版跨页尚未提交的选择。
    draft.pairs = [{ pairKey: row.pairKey, decision, bankEventId: row.bank.eventId, platformEventId: row.platform.eventId }]
    try {
      persistChoices(this, draft)
      await this.confirmPairings()
      const task = session.pairingTask(keyFor('ambiguous', this.data.pairingSheet && this.data.pairingSheet.issueId))
      if (active(this, token) && task && task.status === 'saved' && task.summaryReady) this.closePairingReview()
    } catch (error) { if (active(this, token)) this.setData({ pairingError: errorText(error) }) }
  },
  async resumePairings() {
    const token = this._pairingToken
    if (!active(this, token) || !this.data.pairingCanResume) return
    try { this.setData({ pairingError: '' }); await this._draftSession.flush() }
    catch (error) { if (active(this, token)) this.setData({ pairingError: this._draftSession.status.error || errorText(error) }) }
    finally { if (active(this, token)) render(this) }
  }
}
