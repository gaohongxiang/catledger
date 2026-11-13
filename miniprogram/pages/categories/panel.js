const { panel } = require('../../shell/panel')
const { createCategoriesPage } = require('./page')

// 宿主面板：与独立页共用 page.js，底栏常驻。与 明细·统计 面板同一机制。
Component(panel('categories', createCategoriesPage({
  app: getApp(),
  api: require('../../services/catledger-api'),
  themeService: require('../../theme/service'),
  wx
})))
