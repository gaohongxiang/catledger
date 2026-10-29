const { panel } = require('../../shell/panel')
const { createHomePage } = require('./page')

Component(panel('home', createHomePage({
  app: getApp(),
  api: require('../../services/catledger-api'),
  themeService: require('../../theme/service'),
  wx
})))
