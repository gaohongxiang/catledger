const registry = require('../../theme/registry')
const themeService = require('../../theme/service')

function markCurrent(themes, currentId) {
  return themes.map(function (theme) {
    return Object.assign({}, theme, { selected: theme.id === currentId })
  })
}

Page(themeService.page({
  data: {
    themes: []
  },

  onLoad: function () {
    this.refreshTheme()
  },

  onShow: function () {
    this.refreshTheme()
  },

  refreshTheme: function () {
    const current = themeService.currentPresentation()
    if (this.data.themes.some(function (theme) { return theme.selected && theme.id === current.themeId })) return
    this.setData({ themes: markCurrent(registry.listThemes(), current.themeId) })
  },

  chooseTheme: function (event) {
    const themeId = String(event.currentTarget.dataset.id || '')
    if (!themeId || themeId === this.data.themeId) {
      return
    }
    let presentation
    try {
      presentation = themeService.selectTheme(themeId)
    } catch (_) {
      wx.showToast({ title: '主题暂未保存，请重试', icon: 'none' })
      return
    }
    this.setData(Object.assign({}, presentation, {
      themes: markCurrent(registry.listThemes(), presentation.themeId)
    }))
    wx.showToast({ title: '已切换为' + presentation.themeName, icon: 'none' })
  }
}))
