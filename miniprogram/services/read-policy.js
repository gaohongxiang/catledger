// 连续前台使用期间复用；本机写入、重新进入前台及手动刷新控制重读。
const ALL_TAGS = ['accounts', 'transactions', 'categories', 'profile', 'loans', 'accountDirectory', 'categoryDirectory']
const READ_POLICIES = Object.freeze({
  'loans.chargeImpact': { ttl:0,tags:['loans','transactions'] },
  'loans.dueCharges': { ttl: 0, tags: ['loans', 'transactions', 'accountDirectory'] },
  'loans.chargePlan': { ttl: 0, tags: ['loans', 'transactions', 'accountDirectory'] },
  'reads.validate': { ttl: 0, tags: ALL_TAGS },
  'loans.transaction': { ttl: Infinity, tags: ['loans', 'transactions', 'accountDirectory'] },
  'loans.unassigned': { ttl: Infinity, tags: ['loans', 'transactions', 'accountDirectory'] },
  'loans.payment': { ttl: Infinity, tags: ['loans', 'transactions'] },
  'loans.payments': { ttl: Infinity, tags: ['loans', 'transactions'] },
  'loans.installments': { ttl: Infinity, tags: ['loans', 'transactions', 'accountDirectory'] },
  'loans.installment': { ttl: Infinity, tags: ['loans', 'transactions', 'accountDirectory'] },
  'loans.installmentSources': { ttl: Infinity, tags: ['loans', 'transactions', 'accountDirectory'] },
  'loans.list': { ttl: Infinity, tags: ['loans', 'transactions', 'accountDirectory'] },
  'loans.get': { ttl: Infinity, tags: ['loans', 'transactions', 'accountDirectory'] },
  'catalog.get': { ttl: 5 * 60 * 1000, tags: ['accountDirectory', 'categoryDirectory'] },
  'profile.get': { ttl: 5 * 60 * 1000, tags: ['profile'] },
  bootstrap: { ttl: Infinity, tags: ['categories', 'profile'] },
  'categories.list': { ttl: Infinity, tags: ['categories'] },
  'accounts.list': { ttl: Infinity, tags: ['accounts'] },
  'dashboard.get': { ttl: Infinity, tags: ['accounts', 'transactions', 'categories'] },
  'transactions.list': { ttl: Infinity, tags: ['transactions', 'accounts', 'categories'] },
  'statistics.get': { ttl: Infinity, tags: ['transactions', 'categories'] },
  'transactions.refundable': { ttl: Infinity, tags: ['transactions', 'accounts', 'categories'] }
})

function mutationTags(action) {
  if (/^loans\.(confirmInstallments|setInstallmentProgress|linkInstallmentSource|archiveInstallment|removeInstallmentItem)$/.test(action)) return ['loans', 'transactions', 'accounts']
  if (/^loans\.(configureCharges|pauseCharges|syncCharges|changeCharge|endCharges)$/.test(action)) return ['loans', 'transactions', 'accounts']
  if (action === 'profile.update') return ['profile']
  if (/^loans\.(savePeriod|allocatePeriods|generatePlan)$/.test(action)) return ['loans']
  if (/^loans\.(record|correct|reverse|bookRepayment|assignRepayment|releaseRepayment)$/.test(action)) return ['loans', 'accounts', 'transactions']
  if (/^loans\.(create|update)$/.test(action)) return ['loans', 'transactions', 'accounts']
  if (action === 'accounts.create') return ['accounts', 'transactions', 'accountDirectory']
  if (action === 'accounts.correctBalance') return ['accounts', 'transactions']
  if (/^accounts\.(createBatch|update|archive)$/.test(action)) return ['accounts', 'accountDirectory']
  if (/^categories\.(create|update|archive|restore|reorder)$/.test(action)) return ['categories', 'categoryDirectory']
  if (action === 'categories.assignTransactions' || action === 'transactions.setCategory') return ['transactions']
  if (/^transactions\.(create|update|delete|deleteMany|linkRefund)$/.test(action)) return ['transactions', 'accounts']
  if (/^financeUpdates\.(post|undo)$/.test(action) || action === 'economicEvents.correct') return ['loans', 'accounts', 'transactions', 'categories', 'accountDirectory', 'categoryDirectory']
  return []
}
module.exports = { READ_POLICIES, mutationTags, ALL_TAGS }
