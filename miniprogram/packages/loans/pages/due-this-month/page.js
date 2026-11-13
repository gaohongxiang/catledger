const api = require('../../../../services/catledger-api')
const loginGuard = require('../../../../services/login-guard')
const theme = require('../../../../theme/service')
const money = require('../../../../utils/money')
const time = require('../../../../utils/time')

const businessInitialData = {
  loading: false, errorMessage: '', month: '', monthText: '',
  dueMinor: '0', dueText: '', periodCount: 0, items: []
}

function createDueThisMonthPage(dependencies) {
  return {
  data: businessInitialData,
  onLoad() { this.setData({ month: time.currentMonth() }) },
  onShow() { return loginGuard.run(this, () => this.load()) },
  onPullDownRefresh() { return this.load().then(() => wx.stopPullDownRefresh(), () => wx.stopPullDownRefresh()) },
  async load() {
    if (this.data.loading) return
    const month = this.data.month || time.currentMonth()
    this.setData({ loading: true, errorMessage: '' })
    try {
      const result = await api.callApi('loans.dueThisMonth', { month }, { force: true })
      const items = (result.items || []).map(row => ({
        loanId: row.loanId,
        loanName: row.loanName || '贷款',
        accountName: row.accountName || '',
        periodNumber: row.periodNumber,
        dueDateText: String(row.dueDate || '').replace(/-/g, '.'),
        outstandingText: money.formatMinor(row.outstandingMinor)
      })).sort((a, b) => (a.dueDateText < b.dueDateText ? -1 : a.dueDateText > b.dueDateText ? 1 : a.periodNumber - b.periodNumber))
      this.setData({
        loading: false, month,
        monthText: month.replace('-', ' 年 ') + ' 月',
        dueMinor: result.dueMinor || '0',
        dueText: money.formatMinor(result.dueMinor || '0'),
        periodCount: Number(result.periodCount) || items.length,
        items
      })
    } catch (error) {
      this.setData({ loading: false, errorMessage: error.message || '本月待还暂未读取' })
    }
  },
  openLoan(event) {
    const loanId = event.currentTarget.dataset.id
    if (loanId) require('../../../../shell/router').openSubpageUrl('/packages/loans/pages/loan-detail/index?loanId=' + encodeURIComponent(loanId))
  }
}
}

module.exports = { createDueThisMonthPage }
