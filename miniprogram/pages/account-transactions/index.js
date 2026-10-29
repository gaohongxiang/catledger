const { createTransactionsPage } = require('../transactions/page')

const themeService = require('../../theme/service')

Page(themeService.page(createTransactionsPage(true, {
  app: getApp(),
  api: require('../../services/catledger-api'),
  themeService: require('../../theme/service'),
  wx
})))
