const { createTransactionsPage } = require('./page')

Page(createTransactionsPage(false, {
  app: getApp(),
  api: require('../../services/catledger-api'),
  themeService: require('../../theme/service'),
  wx
}))
