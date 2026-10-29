const { panel } = require('../../shell/panel')
const { createProfilePage } = require('./page')

Component(panel('profile', createProfilePage({
  app: getApp(),
  api: require('../../services/catledger-api'),
  themeService: require('../../theme/service'),
  wx
})))
