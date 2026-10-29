const tabs = [
  { id: 'home', route: 'pages/index/index', title: '招财猫记账本' },
  { id: 'transactions', route: 'pages/transactions/index', title: '明细' },
  { id: 'statistics', route: 'pages/statistics/index', title: '统计' },
  { id: 'profile', route: 'pages/profile/index', title: '我的' }
]

function resolveTab(id) { return tabs.find(tab => tab.id === id) || tabs[0] }

module.exports = { tabs, resolveTab, HOST_ROUTE: 'shell/index' }
