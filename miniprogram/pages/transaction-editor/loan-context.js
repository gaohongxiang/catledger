const { contextView } = require('../loan-link/model')
const { buildReadonlyDetail } = require('./readonly-detail')
function createLoanContext({ api, session, navigate }) {
  return {
    loadLoanContext() {
      if (!this.data.transactionId || !session.isCurrent(this)) return Promise.resolve()
      if (this._loanLoad) return this._loanLoad
      const current = session.capture(this), transactionId = this.data.transactionId
      this.setData({ loanContextLoading: true, loanContextError: '' })
      this._loanLoad = api.callApi('loans.transaction', { transactionId }, { force: true }).then(result => {
        if (!current() || this.data.transactionId !== transactionId) return
        const context = contextView(result)
        const patch = { loanContext: context, loanManaged: context.linked }
        // 已有编辑草稿不能让迟到的分类目录重新开放整组贷款成员。
        if (context.linked && this.data.detail) patch.detail = Object.assign({}, this.data.detail, { canEditCategory: false })
        if (this.data.readonlyDetail && !this.data.categoryDirty) {
          this._detailTransaction = result.transaction
          patch.version = result.transaction.version
          patch.selectedCategoryId = result.transaction.category && result.transaction.category.categoryId || null
          patch.detail = buildReadonlyDetail(result.transaction, this._catalogCategories || [],
            !context.linked && this.data.mode === 'import' && ['income','expense'].includes(result.transaction.type))
        }
        this.setData(patch)
      }).catch(error => {
        if (current()) this.setData({ loanContext: null, loanContextError: error.message || '贷款关联暂未读取；不能据此认定未关联' })
      }).finally(() => { if (current()) { this._loanLoad = null; this.setData({ loanContextLoading: false }) } })
      return this._loanLoad
    },
    openLoanLink() {
      if (!session.isCurrent(this) || this.data.saving || this.data.loanContextLoading || !this.data.loanContext || this.data.loanContext.state !== 'candidate') return
      navigate({ url: '/pages/loan-link/index?transactionId=' + encodeURIComponent(this.data.transactionId) })
    },
    openLinkedPayment() {
      const context = this.data.loanContext
      if (session.isCurrent(this) && !this.data.loanContextLoading && context && context.linked) navigate({ url: '/pages/loan-payment/index?paymentId=' + encodeURIComponent(context.payment.paymentId) })
    },
    openLinkedLoan(event) {
      const context = this.data.loanContext
      const loan = context && context.allocations.find(a => a.loanId === event.currentTarget.dataset.id)
      if (!session.isCurrent(this) || this.data.loanContextLoading || !loan) return
      const plan = event.currentTarget.dataset.plan === 'yes'
      navigate({ url: '/pages/' + (plan ? 'loan-plan' : 'loan-detail') + '/index?loanId=' + encodeURIComponent(loan.loanId) +
        (plan && context.payment.kind === 'repayment' ? '&paymentId=' + encodeURIComponent(context.payment.paymentId) : '') })
    }
  }
}
module.exports = { createLoanContext }
