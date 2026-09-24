const { createTransactionsPage } = require('../transactions/page')

Page(createTransactionsPage(true, {
  app: getApp(),
  api: require('../../services/catledger-api'),
  themeService: require('../../theme/service'),
  wx
}))
