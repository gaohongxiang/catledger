const { publicError } = require('./presentation')
const presentation = require('./presentation')
const { errorText, direction } = require('./presentation')
const api = require('../../../../services/catledger-import')
const drafts = require('../../../../services/import-draft-session')
const readCache = require('../../../../services/read-cache')
const { buildFinalDetail, presentAccountRows, presentFinalRecord, TITLES: FINAL_DETAIL_TITLES } = require('./final-detail')
const model = require('./model')
const tabRouter = require('../../../../shell/router')
const accountPending = require('./account-pending')

// 确认页只带着当前这一屏的交易，账户名称在目录里。缺的按编号补齐，避免全部落到「未命名账户」。
async function accountsForEvents(page, events) {
  const known = [...(page.businessData().accounts || []), ...(page.businessData().accountDrafts || [])]
  const have = new Set(known.map(account => account.accountId).filter(Boolean))
  const missing = [...new Set((events || []).flatMap(event => model.eventAccountIds(event)))].filter(id => !have.has(id))
  if (!missing.length || !page._viewSession) return known
  const found = []
  for (let start = 0; start < missing.length; start += 100) {
    const ids = missing.slice(start, start + 100)
    for (const kind of ['accounts', 'accountDrafts']) {
      const response = await page._viewSession.read('financeUpdates.options', { kind, ids, pageSize: ids.length })
      found.push(...(response.items || []))
    }
  }
  const byId = new Map()
  for (const account of known.concat(found)) if (account && account.accountId && !byId.has(account.accountId)) byId.set(account.accountId, account)
  return [...byId.values()]
}

module.exports = {
  viewTransactions: function () {
    tabRouter.openTab('transactions')
  },

  viewStatistics: function () {
    tabRouter.openTab('statistics')
  },

  completeCategories: function () {
    getApp().globalData.openStatisticsCompletion = true
    tabRouter.openTab('statistics', { fail: function () { getApp().globalData.openStatisticsCompletion = false } })
  },

  correctBalances: function () {
    wx.navigateTo({ url: '/pages/accounts/index' })
  },

  openInstallmentSources: function () {
    // 已入账页直接带本批 updateId：列表只列这一批待补来源，计划名也取本批账单里的计划名。
    const updateId = this.data.update && this.data.update.updateId
    wx.navigateTo({ url: '/packages/loans/pages/installment-sources/index' + (updateId ? '?updateId=' + encodeURIComponent(updateId) : '') })
  },

  backFinalDetail: function () {
    if (this.data.finalDetailParent) this.setData({ finalDetailSheet: this.prepareFinalDetail(this.data.finalDetailParent), finalDetailParent: null })
    else this.closeFinalDetail()
  },

  prepareFinalDetail: function (kind, accountId, index) {
    this._finalDetail = buildFinalDetail(kind, this.businessData(), accountId)
    return presentation.detailWindow(this._finalDetail, index)
  },

  closeFinalDetail: function () {
    if (this._finalPager) this._finalPager.cancel()
    this._finalPager = null
    this._finalDetail = null; this.setData({ finalDetailSheet: null, finalDetailParent: null })
    this.applyPendingBackgroundView()
  },

  abandonUpdate: function () {
    const self = this
    if (this.data.busy || !this.data.update || !['draft', 'failed', 'review'].includes(this.data.update.status)) return
    if (this.blockFileNameEdit() || this.blockPendingFileRename()) return
    wx.showModal({
        title: '放弃本批账单？',
        content: '本批的账户选择和整理结果会被放弃。正式账户、余额、交易和统计都不会改变。',
        confirmText: '确认放弃',
        confirmColor: '#b54738',
        success: function (result) {
          if (!result.confirm) return
          self.performAbandonUpdate()
        }
      })
  },

  performAbandonUpdate: async function () {
    if (this.data.busy || !this.data.update) return
    if (this.blockFileNameEdit() || this.blockPendingFileRename()) return
    this.setData({ busy: true, abandoningUpdate: true, errorMessage: '', currentIssue: null })
    try {
      if (this._draftSession) {
        await this._draftSession.pause()
        const fresh = await this.request('financeUpdates.summary', { updateId: this.data.update.updateId })
        this.setData({ update: fresh.update })
      }
      const updateId = this.data.update.updateId, version = this.data.update.version
      const abandoned = await this.request('financeUpdates.abandon', {
          requestId: api.createRequestId(),
          updateId: updateId,
          version: version
        })
      this._abandonedUpdateId = updateId
      // 与恢复流程的放弃保持一致：本机草稿、最后批次和首页进度一起清掉，
      // 否则首页仍按旧进度显示「待核对 / 待分类」。
      drafts.clearUpdate(updateId)
      this.startAnother()
      if (abandoned.offlineAbandon) wx.showToast({ title: '本机已清理，服务端待联网放弃', icon: 'none' })
    } catch (error) {
      if (this._draftSession) this._draftSession.resume()
      this.setData({ busy: false, abandoningUpdate: false, errorMessage: publicError(error, '放弃失败，请重试') })
    }
  },

  openImportHistory: function () {
    if (!this.data.busy) wx.navigateTo({ url: '/packages/finance/pages/import-history/index' })
  },

  openFinalDetail: async function (event) {
    const kind = event.currentTarget.dataset.kind
    const accountId = event.currentTarget.dataset.id
    const filter = { status: 'ready' }
    let action = 'economicEvents.list'
    if (['new_accounts', 'affected_accounts'].includes(kind)) { action = 'financeUpdates.options'; filter.kind = kind; delete filter.status }
    else if (kind === 'account') filter.accountId = accountId
    else if (['categorized', 'uncategorized', 'no_category'].includes(kind)) filter.view = { categorized: 'category_completed', uncategorized: 'category_pending', no_category: 'category_none' }[kind]
    else if (kind === 'expense') filter.view = 'expense'
    else if (kind !== 'all') filter.economicNature = kind
    this._finalKind = { kind, accountId }
    // 读取层会按体积提前截断，页长才会出现 31、38 这种数。这里补齐到固定 50 笔。
    this._finalPager = this._viewSession.pager(action, Object.assign({ pageSize: presentation.PAGE_SIZE }, filter), { fillPage: true })
    const title = kind === 'account'
    ? ((this.businessData().accounts || []).concat(this.businessData().accountDrafts || [])
      .find(account => account.accountId === accountId) || {}).name || FINAL_DETAIL_TITLES.account
    : FINAL_DETAIL_TITLES[kind]
    this.setData({ finalDetailSheet: { kind, title: title || FINAL_DETAIL_TITLES.all, count: 0, records: [], accounts: [], loading: true }, finalDetailParent: null })
    return this.changeFinalPage(event)
  },

  changeFinalPage: async function (event) {
    const pager = this._finalPager, target = this._finalKind
    try {
      const response = await pager.load(direction(event))
      if (pager !== this._finalPager || !this.data.finalDetailSheet) return
      let sheet
      if (['new_accounts', 'affected_accounts'].includes(target.kind)) sheet = { kind: target.kind, title: target.kind === 'new_accounts' ? '新建账户' : '受影响账户', mode: 'accounts', accounts: presentAccountRows(response.items), records: [] }
      else sheet = buildFinalDetail(target.kind, Object.assign({}, this.businessData(), { events: response.items, accounts: await accountsForEvents(this, response.items) }), target.accountId)
      this._finalDetail = null
      this.setData({ finalDetailSheet: Object.assign({}, sheet, { count: response.eventTotal != null ? response.eventTotal : response.total, records: (sheet.records || []).map(presentFinalRecord), page: response.page, loading: false }), finalDetailScrollTop: 0 })
    } catch (error) { if (pager === this._finalPager) this.setData({ 'finalDetailSheet.loading': false, errorMessage: errorText(error) }) }
  },

  openFinalAccount: function (event) {
    return this.openFinalDetail({ currentTarget: { dataset: { kind: 'account', id: event.currentTarget.dataset.id } } })
  },

  postUpdate: async function () {
    if (!this._viewActive || !getApp().hasLoginApproval() || this.data.busy || !this._draftSession) return
    if (!this._draftSession.state.postFlight && accountPending.count(this, this.data.accountStepSummary?.pending) > 0) {
      this.flushAccountDraftSync()
      await this.setStep({ currentStep: 2, errorMessage: '请先确认保留的账户选择，再入账' })
      return
    }
    const reviewPending = this.pendingReviewEdit()
    if (reviewPending) {
      await this.openReviewEdit({ currentTarget: { dataset: { id: reviewPending.payload.eventId } } })
      return
    }
    const duplicatePending = this.pendingDuplicateEdit()
    if (duplicatePending) {
      await this.openDuplicateEdit({ currentTarget: { dataset: { id: duplicatePending.payload.eventId } } })
      return
    }
    const categoryPending = this.pendingCategoryEdit()
    if (categoryPending) {
      await this.openCategoryEdit({ currentTarget: { dataset: { id: categoryPending.payload.eventId } } })
      return
    }
    const session = this._draftSession
    const operation = this._postOperation = { epoch: this._viewEpoch, scope: readCache.getSession(), updateId: session.view.update.updateId }
    const active = () => this._viewActive && getApp().hasLoginApproval() && readCache.getSession() === operation.scope &&
      this._viewEpoch === operation.epoch && this._postOperation === operation && this.data.update && this.data.update.updateId === operation.updateId
    this.setData({ busy: true, errorMessage: '' })
    try {
      if (!session.state.postFlight) {
        await session.flush()
        if (!active()) return
        this.applyUpdateView(session.view, true)
        if (!session.view.coverage.selectedEventsReadyToPost) { this.setData({ errorMessage: '请完成剩余核对后再入账' }); return }
      }
      this.setData({ busy: true })
      const receipt = await session.post()
      if (!active()) return
      if (receipt.outcome === 'recheck') {
        this.applyUpdateView(receipt.localView || session.view, false)
        this.setData({ currentStep: 3, busy: false, errorMessage: '' })
        return
      }
      if (this._unsubscribeDraft) this._unsubscribeDraft()
      session.clear(); drafts.forgetLast(); this._draftSession = null
      this.applyUpdateView(receipt)
      await require('../../../../services/loan-charge-sync').beforePage(this,active)
      if(!active())return
      try {
        const summary = await api.readSummary(receipt.update.updateId)
        if (active()) this.applyUpdateView(summary)
      } catch (error) { /* 已入账状态保留，用户可独立刷新。 */ }
      // 账单已导入但负债账户还没有分期计划时提醒补建/关联，避免总欠款漏掉分期部分。
      try {
        const ledgerApi = require('../../../../services/catledger-api')
        const list = await ledgerApi.callApi('accounts.list', {})
        const missing = (Array.isArray(list && list.accounts) ? list.accounts : []).filter(function (a) {
          return a.nature === 'liability' && !a.archived && a.needsInstallmentPlan
        }).length
        if (active() && missing > 0) wx.showToast({ title: missing + ' 个账户需要新建分期计划', icon: 'none', duration: 3000 })
      } catch (error) { /* 提示失败不阻断入账结果。 */ }
    } catch (error) {
      if (active() && error.code === 'LOCAL_REORGANIZE_REQUIRED') {
        this.showResumeNotice({source:'local',state:'server_changed',canContinue:true,
          title:'请重新整理后继续',message:error.message},session.view.update.updateId,true)
      } else if (active() && session.isLocal && session.state.postFlight) {
        this.showResumeNotice({source:'local',state:'post_pending',canContinue:true,canAbandon:true,
          title:'上次入账结果待核实',message:'本机仍保留上次提交请求。可继续核实原请求，也可联网核实后重新开始；结果确定前会保留原文件和选择。'},session.view.update.updateId,true)
      } else if (active() && error.code === 'HISTORY_REVIEW_REQUIRED') {
        await this.loadUpdate(session.view.update.updateId, false)
        if (active() && this.data.phase !== 'error') this.setStep({ currentStep: 3, errorMessage: errorText(error) })
      } else if (active()) this.setData({ errorMessage: errorText(error) })
    }
    finally { if (active()) this.setData({ busy: false }) }
  }
}
