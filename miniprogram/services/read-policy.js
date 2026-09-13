// 连续前台使用期间复用；本机写入、重新进入前台及手动刷新控制重读。
const READ_POLICIES = Object.freeze({
  'loans.payment': { ttl: Infinity, tags: ['loans', 'transactions'] },
  'loans.payments': { ttl: Infinity, tags: ['loans', 'transactions'] },
  'loans.list': { ttl: Infinity, tags: ['loans', 'accountDirectory'] },
  'loans.get': { ttl: Infinity, tags: ['loans', 'accountDirectory'] },
  'catalog.get': { ttl: 5 * 60 * 1000, tags: ['accountDirectory', 'categoryDirectory'] },
  bootstrap: { ttl: Infinity, tags: ['categories'] },
  'categories.list': { ttl: Infinity, tags: ['categories'] },
  'accounts.list': { ttl: Infinity, tags: ['accounts'] },
  'dashboard.get': { ttl: Infinity, tags: ['accounts', 'transactions', 'categories'] },
  'transactions.list': { ttl: Infinity, tags: ['transactions', 'accounts', 'categories'] },
  'statistics.get': { ttl: Infinity, tags: ['transactions', 'categories'] },
  'transactions.refundable': { ttl: Infinity, tags: ['transactions', 'accounts', 'categories'] }
})

function mutationTags(action) {
  if (/^loans\.(savePeriod|allocatePeriods)$/.test(action)) return ['loans']
  if (/^loans\.(record|correct|reverse)$/.test(action)) return ['loans', 'accounts', 'transactions']
  if (/^loans\.(create|update)$/.test(action)) return ['loans']
  if (action === 'accounts.create') return ['accounts', 'transactions', 'accountDirectory']
  if (action === 'accounts.correctBalance') return ['accounts', 'transactions']
  if (/^accounts\.(createBatch|update|archive)$/.test(action)) return ['accounts', 'accountDirectory']
  if (/^categories\.(create|update|archive|restore|reorder)$/.test(action)) return ['categories', 'categoryDirectory']
  if (action === 'categories.assignTransactions' || action === 'transactions.setCategory') return ['transactions']
  if (/^transactions\.(create|update|delete|linkRefund)$/.test(action)) return ['transactions', 'accounts']
  if (/^financeUpdates\.(post|undo)$/.test(action) || action === 'economicEvents.correct') return ['accounts', 'transactions', 'categories', 'accountDirectory', 'categoryDirectory']
  return []
}
module.exports = { READ_POLICIES, mutationTags }
