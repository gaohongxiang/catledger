const app = getApp()

function run(page, afterLogin) {
  if (page && typeof page.requestLogin === 'function') {
    page.requestLogin(afterLogin)
    return app.hasLoginApproval()
  }
  if (app.hasLoginApproval()) {
    if (typeof afterLogin === 'function') afterLogin()
    return true
  }
  wx.nextTick(function () {
    const sheet = page && page.selectComponent && page.selectComponent('#page-login-sheet')
    if (sheet && typeof sheet.show === 'function') {
      sheet.show({ afterLogin })
    }
  })
  return false
}

module.exports = { run }
