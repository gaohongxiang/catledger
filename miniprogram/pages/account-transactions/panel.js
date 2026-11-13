const { panel } = require('../../shell/panel')
const { createTransactionsPage } = require('../transactions/page')

// 宿主二级面板：账户账目，复用 transactions 页工厂（accountMode=true），底栏常驻。
Component(panel('account-transactions', createTransactionsPage(true, { app: getApp(), wx, api: require('../../services/catledger-api'), themeService: require('../../theme/service') })))
