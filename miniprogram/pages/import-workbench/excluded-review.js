const readCache = require('../../services/read-cache')
const { PAGE_SIZE, listRecord, errorText } = require('./presentation')

function current(page, token) {
  return page._viewActive && page._excludedGroupRead === token && page._viewSession === token.session &&
    page._viewEpoch === token.epoch && page._pageEpoch === token.pageEpoch && readCache.getSession() === token.scope &&
    token.session.summary.viewVersion === token.version && page.data.currentStep === 3 &&
    page.data.activeReviewTab === 'review' && page.data.activeReviewStatus === 'excluded' && page.data.reviewQuery === token.query
}

function patchGroup(page, key, patch) {
  const index = page.data.excludedReviewGroups.findIndex(group => group.key === key)
  if (index < 0) return
  page.setData({ ['excludedReviewGroups[' + index + ']']: Object.assign({}, page.data.excludedReviewGroups[index], patch) })
}

module.exports = {
  cancelExcludedGroup() {
    if (this._excludedGroupRead) this._excludedGroupRead.pager.cancel()
    this._excludedGroupRead = null
  },

  async toggleExcludedGroup(event) {
    const key = String(event.currentTarget.dataset.key || '')
    if (!this._viewActive || this.data.pageLoading || this.data.activeReviewTab !== 'review' || this.data.activeReviewStatus !== 'excluded') return
    const target = this.data.excludedReviewGroups.find(group => group.key === key)
    if (!target) return
    this.cancelExcludedGroup()
    for (const group of this.data.excludedReviewGroups) if (group.expanded) {
      patchGroup(this, group.key, { expanded: false, events: [], page: null, loading: false, error: '' })
    }
    this._businessData = Object.assign({}, this.businessData(), { events: [] })
    if (target.expanded) return
    const session = this._viewSession
    if (!session) return
    const token = this._excludedGroupRead = { key, session, epoch: this._viewEpoch, pageEpoch: this._pageEpoch,
      scope: readCache.getSession(), version: session.summary.viewVersion, query: this.data.reviewQuery,
      pager: session.pager('economicEvents.list', { status: 'excluded', excludedGroupId: target.groupId,
        query: this.data.reviewQuery, pageSize: PAGE_SIZE }, { fillPage: true }) }
    patchGroup(this, key, { expanded: true, loading: true, error: '', events: [] })
    return this.loadExcludedGroup(token)
  },

  async loadExcludedGroup(token, direction) {
    if (!token || !current(this, token) || token.loading) return
    token.loading = true
    patchGroup(this, token.key, { loading: true, error: '' })
    try {
      const result = await token.pager.load(direction)
      if (!current(this, token)) return
      token.retryDirection = undefined
      this._businessData = Object.assign({}, this.businessData(), { events: result.items })
      patchGroup(this, token.key, { events: result.items.map(listRecord), page: result.page, loading: false })
    } catch (error) {
      if (current(this, token)) {
        token.retryDirection = direction
        patchGroup(this, token.key, { loading: false, error: errorText(error) })
      }
    } finally { token.loading = false }
  },

  changeExcludedGroupPage(event) {
    const token = this._excludedGroupRead, key = String(event.currentTarget.dataset.key || '')
    if (!token || token.key !== key) return
    const value = event.currentTarget.dataset.direction
    const direction = value === 'retry' ? token.retryDirection : value === 'first' ? 'first' : Number(value || 0)
    return this.loadExcludedGroup(token, direction)
  }
}
