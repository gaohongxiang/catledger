const tabs = [
  { id: 'home', route: 'pages/index/index', title: '招财猫记账本' },
  { id: 'transactions', route: 'pages/transactions/index', title: '明细' },
  { id: 'statistics', route: 'pages/statistics/index', title: '统计' },
  { id: 'accounts', route: 'pages/accounts/index', title: '账户管理' },
  { id: 'categories', route: 'pages/categories/index', title: '分类管理' },
  { id: 'profile', route: 'pages/profile/index', title: '我的' }
]

// 二级页：同样是宿主面板，只是不作为底栏可视位。进入时底栏保持常驻，高亮沿用来源 tab(parent)。
// key = 面板 id；route 用于整页兜底重定向；parent = 进入时底栏应高亮的可视位 key。
const subpages = {
  'theme': { route: 'pages/theme/index', title: '主题', parent: 'profile' },
  'data-privacy': { route: 'pages/data-privacy/index', title: '数据与隐私', parent: 'profile' },
  'about': { route: 'pages/about/index', title: '关于', parent: 'profile' },
  'import-history': { route: 'packages/finance/pages/import-history/index', title: '导入记录', parent: 'profile' },
  'account-detail': { route: 'pages/account-detail/index', title: '账户详情', parent: 'accounts' },
  'account-transactions': { route: 'pages/account-transactions/index', title: '账户账目', parent: 'accounts' },
  'loans': { route: 'packages/loans/pages/loans/index', title: '贷款与还款', parent: 'accounts' },
  'loan-detail': { route: 'packages/loans/pages/loan-detail/index', title: '贷款详情', parent: 'accounts' },
  'loan-form': { route: 'packages/loans/pages/loan-form/index', title: '贷款', parent: 'accounts' },
  'loan-payment': { route: 'packages/loans/pages/loan-payment/index', title: '还款', parent: 'accounts' },
  'loan-plan': { route: 'packages/loans/pages/loan-plan/index', title: '分期计划', parent: 'accounts' },
  'loan-link': { route: 'packages/loans/pages/loan-link/index', title: '关联', parent: 'accounts' },
  'repayment-entry': { route: 'packages/loans/pages/repayment-entry/index', title: '还款', parent: 'accounts' },
  'installment-sources': { route: 'packages/loans/pages/installment-sources/index', title: '分期来源', parent: 'accounts' },
  'due-this-month': { route: 'packages/loans/pages/due-this-month/index', title: '本月待还', parent: 'home' }
}

const ALL = tabs.concat(Object.keys(subpages).map(id => ({ id: id, route: subpages[id].route, title: subpages[id].title })))

function resolveTab(id) {
  const tab = tabs.find(item => item.id === id)
  if (tab) return tab
  if (subpages[id]) return { id: id, route: subpages[id].route, title: subpages[id].title }
  return tabs[0]
}

function isSubpage(id) { return Object.prototype.hasOwnProperty.call(subpages, id) }

// 底栏可视位映射：首页=0 / 明细·统计=1 / 账户·分类=2 / 我的=3。
function visualIndex(id) {
  if (id === 'home') return 0
  if (id === 'transactions' || id === 'statistics') return 1
  if (id === 'accounts' || id === 'categories') return 2
  if (id === 'profile') return 3
  if (subpages[id]) return visualIndex(subpages[id].parent)
  return -1
}

// 底栏高亮 key（字符串）：二级页沿用其 parent 的高亮位。
function visualKey(id) {
  if (id === 'home') return 'home'
  if (id === 'transactions' || id === 'statistics') return 'records'
  if (id === 'accounts' || id === 'categories') return 'accounts'
  if (id === 'profile') return 'profile'
  if (subpages[id]) return visualKey(subpages[id].parent)
  return ''
}

module.exports = { tabs, subpages, ALL, resolveTab, isSubpage, visualIndex, visualKey, HOST_ROUTE: 'shell/index' }
