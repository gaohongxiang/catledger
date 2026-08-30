const money = require('./money')

const TYPE_LABELS = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  refund: '退款',
  balance_adjustment: '余额校正'
}

function transactionView(transaction) {
  let accountLine = ''
  if (transaction.type === 'transfer') {
    accountLine = (transaction.sourceAccount ? transaction.sourceAccount.name : '转出账户') +
      ' → ' + (transaction.destinationAccount ? transaction.destinationAccount.name : '转入账户')
  } else if (transaction.sourceAccount) {
    accountLine = transaction.sourceAccount.name || '付款账户'
  } else if (transaction.destinationAccount) {
    accountLine = transaction.destinationAccount.name || '收款账户'
  }

  const label = transaction.category && transaction.category.name
    ? transaction.category.name
    : TYPE_LABELS[transaction.type] || '账目'
  const prefix = transaction.type === 'expense' ? '-' : (transaction.type === 'income' || transaction.type === 'refund') ? '+' : ''
  return Object.assign({}, transaction, {
    typeLabel: TYPE_LABELS[transaction.type] || '账目',
    label: label,
    accountLine: accountLine,
    amountText: prefix + money.formatMinor(transaction.amountMinor),
    amountClass: transaction.type === 'income'
      ? 'amount-income'
      : transaction.type === 'expense'
        ? 'amount-expense'
        : transaction.type === 'refund'
          ? 'amount-refund'
        : 'amount-neutral',
    timeText: String(transaction.occurredLocalAt || '').slice(5, 16).replace('T', ' '),
    editable: transaction.type !== 'balance_adjustment'
  })
}

module.exports = {
  transactionView: transactionView
}
