// 连续前台使用期间复用；本机写入、重新进入前台及手动刷新控制重读。
const READ_POLICIES = Object.freeze({
  bootstrap: { ttl: Infinity, tags: ['categories'] },
  'categories.list': { ttl: Infinity, tags: ['categories'] },
  'accounts.list': { ttl: Infinity, tags: ['accounts'] },
  'dashboard.get': { ttl: Infinity, tags: ['accounts', 'transactions', 'categories'] },
  'transactions.list': { ttl: Infinity, tags: ['transactions', 'accounts', 'categories'] },
  'statistics.get': { ttl: Infinity, tags: ['transactions', 'categories'] },
  'transactions.refundable': { ttl: Infinity, tags: ['transactions', 'accounts', 'categories'] }
})

function mutationTags(action) {
  if (/^accounts\.(create|correctBalance)$/.test(action)) return ['accounts', 'transactions']
  if (/^accounts\.(createBatch|update|archive)$/.test(action)) return ['accounts']
  if (/^categories\.(create|update|archive|restore|reorder)$/.test(action)) return ['categories']
  if (action === 'categories.assignTransactions' || action === 'transactions.setCategory') return ['transactions']
  if (/^transactions\.(create|update|delete|linkRefund)$/.test(action)) return ['transactions', 'accounts']
  if (/^financeUpdates\.(post|undo)$/.test(action) || action === 'economicEvents.correct') return ['accounts', 'transactions', 'categories']
  return []
}
module.exports = { READ_POLICIES, mutationTags }
