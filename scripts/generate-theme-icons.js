// 从现有矢量图标生成各主题的本地资源；轮廓与许可证保持不变。
const fs = require('node:fs')
const path = require('node:path')
const registry = require('../miniprogram/theme/registry')
const iconRoot = path.join(__dirname, '../miniprogram/assets/icons')
const icons = fs.readdirSync(iconRoot).filter(function (name) {
  return name.endsWith('.svg') && !['summary-income.svg', 'summary-expense.svg'].includes(name)
})
registry.listThemes().forEach(function (theme) {
  const tokens = registry.getTheme(theme.id).tokens
  const directory = path.join(iconRoot, 'themes', theme.id)
  fs.mkdirSync(directory, { recursive: true })
  icons.forEach(function (name) {
    const color = name === 'tab-plus.svg' ? tokens.onAccent
      : name.endsWith('-active.svg') ? tokens.accent
        : /^tab-(home|list|book|user)\.svg$/.test(name) ? tokens.textMuted : tokens.secondary
    const svg = fs.readFileSync(path.join(iconRoot, name), 'utf8').replace(/#[a-f\d]{3,8}\b/gi, color)
    fs.writeFileSync(path.join(directory, name), svg)
  })
})
console.log('已生成六主题本地矢量图标。')
