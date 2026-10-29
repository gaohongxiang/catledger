const { panel } = require('../../shell/panel')
const { createTransactionsPage } = require('./page')

Component(panel('transactions', createTransactionsPage(false, {
  app: getApp(),
  api: require('../../services/catledger-api'),
  themeService: require('../../theme/service'),
  wx
})))
