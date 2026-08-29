const registry = require('../../theme/registry')
const themeService = require('../../theme/service')

function markCurrent(themes, currentId) {
  return themes.map(function (theme) {
    return Object.assign({}, theme, { selected: theme.id === currentId })
  })
}

Page({
  data: {
    themes: [],
    themeId: registry.DEFAULT_THEME_ID,
    themeName: '',
    themeClass: '',
    themeStyle: ''
  },

  onLoad: function () {
    this.refreshTheme()
  },

  onShow: function () {
    this.refreshTheme()
  },

  refreshTheme: function () {
    themeService.bindPage(this)
    const current = themeService.currentPresentation()
    this.setData({ themes: markCurrent(registry.listThemes(), current.themeId) })
  },

  chooseTheme: function (event) {
    const themeId = String(event.currentTarget.dataset.id || '')
    if (!themeId || themeId === this.data.themeId) {
      return
    }
    const presentation = themeService.selectTheme(themeId)
    this.setData(Object.assign({}, presentation, {
      themes: markCurrent(registry.listThemes(), presentation.themeId)
    }))
    wx.showToast({ title: '已切换为' + presentation.themeName, icon: 'none' })
  }
})
