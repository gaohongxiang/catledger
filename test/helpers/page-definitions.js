const path = require('node:path')

// 主 Tab 的业务定义来自生产 factory；兼容路由只负责导航，不能充当业务夹具。
const factories = {
  'pages/index/index': ['pages/index/page.js', 'createHomePage'],
  'pages/transactions/index': ['pages/transactions/page.js', 'createTransactionsPage'],
  'pages/statistics/index': ['pages/statistics/page.js', 'createStatisticsPage'],
  'pages/profile/index': ['pages/profile/page.js', 'createProfilePage']
}

function pageDefinition(root, route, load, dependencies) {
  const factory = factories[route]
  if (!factory) return load(path.join(root, route + '.js'))
  const create = load(path.join(root, factory[0]))[factory[1]]
  return factory[1] === 'createTransactionsPage' ? create(false, dependencies) : create(dependencies)
}

module.exports = { factories, pageDefinition }
