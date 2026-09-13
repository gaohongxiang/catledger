const api = require('../../services/catledger-api')
const session = require('../../services/page-read-session')
const money = require('../../utils/money')
const { addMinor } = require('../../utils/minor-arithmetic')
const model = require('./model')
function rows(items) { return items.map(t => Object.assign({}, t, { amountText: money.formatMinor(t.amountMinor),
  accountText: (t.sourceAccount && t.sourceAccount.name || '') + (t.destinationAccount ? ' → ' + t.destinationAccount.name : ''),
  typeText: {expense:'支出',income:'收入',transfer:'转账'}[t.type] || t.type })) }
module.exports = {
  chooseMode(event) {
    if (this.data.saving) return
    this._selectedSources = new Map()
    this.setData({ modeIndex: Number(event.detail.value), source: null, sourceTransactions: [], sourceRows: [], sourceSelectedCount: 0, sourceTiming: null, confirmed: false })
    this.review()
  },
  sourceMonth(event) { this.setData({ sourceMonth: event.detail.value, sourceRows: [], nextSourceCursor: null }) },
  async loadSources(event) {
    if (this.data.loading || this.data.saving) return
    const current = session.capture(this)
    const next = event && event.currentTarget && event.currentTarget.dataset.next
    const month = this.data.sourceMonth || this.data.date.slice(0,7) || new Date().toISOString().slice(0,7)
    this.setData({ loading: true, errorMessage: '', sourceMonth: month })
    try {
      const result = await api.callApi('transactions.list', { month, pageSize: 40, ...(next && this.data.nextSourceCursor ? { cursor: this.data.nextSourceCursor } : {}) }, { force: true })
      if (current()) this.setData({ sourceRows: rows(result.transactions.filter(t => ['expense','income','transfer'].includes(t.type))).map(t =>
        Object.assign({}, t, { selected: Boolean(this._selectedSources && this._selectedSources.has(t.transactionId)) })), nextSourceCursor: result.nextCursor })
    } catch (error) { if (current()) this.setData({ errorMessage: error.message }) }
    finally { if (current()) this.setData({ loading: false }) }
  },
  selectSources(event) {
    const selected = new Set(event.detail.value), values = new Map(this._selectedSources || [])
    for (const row of this.data.sourceRows) { if (selected.has(row.transactionId)) values.set(row.transactionId, row); else values.delete(row.transactionId) }
    if (values.size > 60) { this.setData({ errorMessage: '一次最多选择 60 笔账目' }); return }
    this._selectedSources = values
    this.setData({ sourceSelectedCount: values.size, source: null, sourceTiming: null, sourceTransactions: [], confirmed: false })
  },
  async inspectSource() {
    if (this.data.saving || this.data.loading) return
    const ids = [...(this._selectedSources || new Map()).keys()]
    if (!ids.length) { this.setData({ errorMessage: '请先选择账目' }); return }
    const current = session.capture(this)
    this.setData({ loading: true, errorMessage: '' })
    try {
      const result = await api.callApi('loans.source', { transactionIds: ids }, { force: true })
      if (!current()) return
      const transactions = result.transactions, first = transactions[0], drawdown = this.data.kindIndex === 1
      const account = drawdown ? first.destinationAccount : first.sourceAccount
      const accountId = account && account.accountId
      this.setData({ source: result.source, sourceTransactions: rows(transactions), sourceRows: [], nextSourceCursor: null,
        sourceTiming: { occurredLocalAt: first.occurredLocalAt.replace(' ','T'), timezoneOffsetMinutes: first.timezoneOffsetMinutes },
        accountIndex: this.data.accounts.findIndex(a => a.accountId === accountId), date: first.occurredLocalAt.slice(0,10), time: first.occurredLocalAt.slice(11,16),
        totalYuan: money.minorToYuan(transactions.reduce((sum,t) => addMinor(sum,t.amountMinor), '0')), confirmed: false })
      this.review()
    } catch (error) { if (current()) this.setData({ errorMessage: error.message }) }
    finally { if (current()) this.setData({ loading: false }) }
  },
  editPayment() { this.beginEdit(false) },
  reconcileImport() { this.beginEdit(true) },
  beginEdit(reconcile) {
    if (this.data.saving || this.data.loading || this.data.hasPending || !this.data.payment || this.data.payment.status !== 'active') return
    const previous = { paymentId: this.data.payment.paymentId, version: this.data.payment.version, loans: this.data.allocations.map(a => ({ loanId:a.loanId,version:a.version })) }
    this._viewPaymentId = this._paymentId
    this._paymentId = null
    this._selectedSources = new Map()
    this.setData(Object.assign(model.editView(this.data), { hasPayment: false, payment: null, editingPayment: reconcile ? null : previous,
      replacePayment: reconcile ? previous : null, source: null, sourceTransactions: [], sourceRows: [], sourceSelectedCount: 0,
      modeIndex: reconcile ? 2 : 0, confirmed: false, savedMessage: '', errorMessage: '' }))
    if (reconcile) this.setData({ sourceTiming: null })
    this.review()
  },
  cancelEdit() {
    if (this.data.saving || this.data.hasPending) return
    this._paymentId = this._viewPaymentId
    this.setData({ hasPayment: true, editingPayment: null, replacePayment: null, sourceTiming: null })
    return this.load()
  }
}
