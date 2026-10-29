const fs = require('node:fs')
const path = require('node:path')

// include 和使用方共享事件作用域；自定义组件另行校验，不能展开到宿主 Page。
function readMarkup(filename, ancestors = []) {
  if (ancestors.includes(filename)) throw new Error('WXML include 循环：' + filename)
  const source = fs.readFileSync(filename, 'utf8')
  return source.replace(/<include\b[^>]*\bsrc=["']([^"']+)["'][^>]*\/>/g, (_, reference) => {
    return readMarkup(path.resolve(path.dirname(filename), reference), ancestors.concat(filename))
  })
}

function readSource(filename) {
  return filename.endsWith('.wxml') ? readMarkup(filename) : fs.readFileSync(filename, 'utf8')
}

module.exports = { readMarkup, readSource }
