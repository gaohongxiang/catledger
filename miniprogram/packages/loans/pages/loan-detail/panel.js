const { panel } = require('../../../../shell/panel')
const { createLoanDetailPage } = require('./page')

// 宿主二级面板：与整页共用 page.js 业务，底栏常驻。
Component(panel('loan-detail', createLoanDetailPage({ app: getApp(), wx, api: require('../../../../services/catledger-api'), themeService: require('../../../../theme/service') })))
