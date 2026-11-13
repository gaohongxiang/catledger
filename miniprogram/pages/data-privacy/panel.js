const { panel } = require('../../shell/panel')
const { dataPrivacyDefinition } = require('./page')

// 宿主二级面板：与整页共用 page.js 定义。
Component(panel('data-privacy', dataPrivacyDefinition))
