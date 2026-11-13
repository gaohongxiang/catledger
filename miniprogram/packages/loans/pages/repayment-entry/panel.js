const { panel } = require('../../../../shell/panel')
const { createRepaymentEntryPage } = require('./page')

// 宿主二级面板：与整页共用 page.js 业务，底栏常驻。
Component(panel('repayment-entry', createRepaymentEntryPage({ app: getApp(), wx, api: require('../../../../services/catledger-api'), themeService: require('../../../../theme/service') })))
