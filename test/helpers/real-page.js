const { runtime } = require('./read-runtime')
function realPage(lab) {
  const ui = runtime()
  ui.uid = ui.app.globalData.uid = lab.uid
  ui.rawResponse = true
  ui.respond = (action, data) => lab.services.api({ action, data })
  return ui
}
module.exports = { realPage }
