const config = require('../../miniprogram/app.json')
const routes = [...config.pages, ...(config.subPackages || []).flatMap(pack => pack.pages.map(page => pack.root + '/' + page))]

function pageRoute(name) {
  const suffix = 'pages/' + name + '/index'
  const matches = routes.filter(route => route === suffix || route.endsWith('/' + suffix))
  if (matches.length !== 1) throw new Error('测试页面须有唯一注册路径: ' + name)
  return matches[0]
}

module.exports = { routes, pageRoute }
