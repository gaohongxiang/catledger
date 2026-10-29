const theme = require('../theme/service')
const { createHost } = require('./host')
Page(theme.page(createHost()))
