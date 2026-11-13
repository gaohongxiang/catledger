const path = require('node:path')

// 主 Tab 的业务定义来自生产 factory；兼容路由只负责导航，不能充当业务夹具。
const factories = {
  'pages/index/index': ['pages/index/page.js', 'createHomePage'],
  'pages/transactions/index': ['pages/transactions/page.js', 'createTransactionsPage'],
  'pages/statistics/index': ['pages/statistics/page.js', 'createStatisticsPage'],
  'pages/accounts/index': ['pages/accounts/page.js', 'createAccountsPage'],
  'pages/categories/index': ['pages/categories/page.js', 'createCategoriesPage'],
  'pages/profile/index': ['pages/profile/page.js', 'createProfilePage'],
  'pages/account-detail/index': ['pages/account-detail/page.js', 'createAccountDetailPage'],
  'pages/account-transactions/index': ['pages/transactions/page.js', 'createTransactionsPage'],
  'packages/finance/pages/import-history/index': ['packages/finance/pages/import-history/page.js', 'createImportHistoryPage'],
  'packages/loans/pages/loans/index': ['packages/loans/pages/loans/page.js', 'createLoansPage'],
  'packages/loans/pages/loan-detail/index': ['packages/loans/pages/loan-detail/page.js', 'createLoanDetailPage'],
  'packages/loans/pages/loan-form/index': ['packages/loans/pages/loan-form/page.js', 'createLoanFormPage'],
  'packages/loans/pages/loan-payment/index': ['packages/loans/pages/loan-payment/page.js', 'createLoanPaymentPage'],
  'packages/loans/pages/loan-plan/index': ['packages/loans/pages/loan-plan/page.js', 'createLoanPlanPage'],
  'packages/loans/pages/loan-link/index': ['packages/loans/pages/loan-link/page.js', 'createLoanLinkPage'],
  'packages/loans/pages/repayment-entry/index': ['packages/loans/pages/repayment-entry/page.js', 'createRepaymentEntryPage'],
  'packages/loans/pages/installment-sources/index': ['packages/loans/pages/installment-sources/page.js', 'createInstallmentSourcesPage'],
  'packages/loans/pages/due-this-month/index': ['packages/loans/pages/due-this-month/page.js', 'createDueThisMonthPage']
,
  'pages/theme/index': ['pages/theme/page.js', 'themeDefinition*'],
  'pages/about/index': ['pages/about/page.js', 'aboutDefinition*'],
  'pages/data-privacy/index': ['pages/data-privacy/page.js', 'dataPrivacyDefinition*']
}

function pageDefinition(root, route, load, dependencies) {
  const factory = factories[route]
  if (!factory) return load(path.join(root, route + '.js'))
  const exported = load(path.join(root, factory[0]))
  if (factory[1].endsWith('*')) return JSON.parse(JSON.stringify(exported[factory[1].slice(0, -1)]))
  const create = exported[factory[1]]
  const SUBPAGE = new Set([
    'pages/account-detail/index','pages/account-transactions/index',
    'packages/finance/pages/import-history/index','packages/loans/pages/loans/index',
    'packages/loans/pages/loan-detail/index','packages/loans/pages/loan-form/index',
    'packages/loans/pages/loan-payment/index','packages/loans/pages/loan-plan/index',
    'packages/loans/pages/loan-link/index','packages/loans/pages/repayment-entry/index',
    'packages/loans/pages/installment-sources/index','packages/loans/pages/due-this-month/index'
  ])
  const def = factory[1] === 'createTransactionsPage'
    ? create(route === 'pages/account-transactions/index', dependencies)
    : create(dependencies)
  // 二级页原本是 Page(theme.page({...}))：主题生命周期由适配器拥有，测试夹具需等效包裹。
  if (SUBPAGE.has(route) && dependencies && dependencies.themeService) return dependencies.themeService.page(def)
  return def
}

module.exports = { factories, pageDefinition }
