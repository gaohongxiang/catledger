const { panel } = require('../../shell/panel')
const { createStatisticsPage } = require('./page')

Component(panel('statistics', createStatisticsPage({
  app: getApp(),
  api: require('../../services/catledger-api'),
  themeService: require('../../theme/service'),
  wx
})))
