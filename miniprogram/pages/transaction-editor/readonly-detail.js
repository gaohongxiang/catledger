const money = require('../../utils/money')
const TYPES = { expense: '支出', income: '收入', refund: '退款', transfer: '转账', adjustment: '余额校正', balance_adjustment: '余额校正' }
function buildReadonlyDetail(transaction, categories, canEditCategory) {
  const options = [{ id: null, name: '未分类' }].concat(categories.filter(row => row.kind === transaction.type && !row.archivedAt && !row.archived))
  const categoryId = transaction.category && transaction.category.categoryId || null
  const categoryIndex = options.findIndex(row => row.id === categoryId)
  const rows = [{ label: '类型', value: TYPES[transaction.type] || transaction.typeLabel || '账目' },
    { label: '时间', value: String(transaction.occurredLocalAt || '').replace('T', ' ').replace(/\.\d+$/, '') }]
  if (transaction.sourceAccount) rows.push({ label: transaction.destinationAccount ? '转出账户' : '付款账户', value: transaction.sourceAccount.name || '未命名账户' })
  if (transaction.destinationAccount) rows.push({ label: transaction.sourceAccount ? '转入账户' : '收款账户', value: transaction.destinationAccount.name || '未命名账户' })
  if (transaction.note) rows.push({ label: '备注', value: transaction.note })
  if (transaction.type === 'refund' && transaction.originalTransaction) rows.push({ label: '原支出', value: String(transaction.originalTransaction.occurredLocalAt || '').slice(0, 10) + ' · ' + money.formatMinor(transaction.originalTransaction.amountMinor) })
  return { amountText: money.formatMinor(transaction.amountMinor), rows, categories: options, categoryIndex,
    categoryName: transaction.category && transaction.category.name || '未分类', canEditCategory: Boolean(canEditCategory),
    typeClass: transaction.type === 'expense' ? 'detail-expense' : (transaction.type === 'income' || transaction.type === 'refund') ? 'detail-income' : '',
    sourceLabel: transaction.origin === 'import' || transaction.importContext ? '账单导入' : '账单记录' }
}
module.exports = { buildReadonlyDetail }
