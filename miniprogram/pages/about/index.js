const themeService = require('../../theme/service')

Page({
  data: {
    themeClass: '',
    themeStyle: ''
  },

  onShow: function () {
    themeService.bindPage(this)
  }
})
