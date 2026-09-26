'use strict'

const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const os = require('node:os')

// 检查现行手册；阶段规格正文保留当时的文档上下文，不批量改写历史锚点。
function withoutFences(text) {
  let fence = null
  return text.split(/\r?\n/).map(line => {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (match && !fence) { fence = match[1]; return '' }
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length) fence = null
      return ''
    }
    return line
  }).join('\n')
}

function anchors(text) {
  const source = withoutFences(text), result = new Set(), used = new Set()
  for (const match of source.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) result.add(match[1])
  for (const match of source.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1].replace(/<[^>]*>/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`*_~]/g, '').toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-')
    let slug = base, index = 0
    while (used.has(slug)) slug = base + '-' + (++index)
    used.add(slug); result.add(slug)
  }
  return result
}

function destinations(text) {
  const source = withoutFences(text), links = []
  // Supports the inline links/images and reference definitions used in this handbook.
  for (const match of source.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g)) links.push(match[1] || match[2])
  for (const match of source.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm)) links.push(match[1] || match[2])
  for (const match of source.matchAll(/<(?:img|a)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/g)) links.push(match[1])
  return links
}

function validateTarget(root, from, target, anchorCache) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return null
  const marker = target.indexOf('#'), rawFile = marker < 0 ? target : target.slice(0, marker)
  const rawFragment = marker < 0 ? '' : target.slice(marker + 1)
  let relative, fragment
  try { relative = decodeURIComponent(rawFile.split('?')[0]); fragment = decodeURIComponent(rawFragment) }
  catch (_) { return '无效 URL 编码: ' + target }
  const filename = relative ? (relative.startsWith('/') ? path.resolve(root, '.' + relative) : path.resolve(root, path.dirname(from), relative)) : path.resolve(root, from)
  const resolved = path.relative(root, filename)
  if (resolved === '..' || resolved.startsWith('..' + path.sep) || path.isAbsolute(resolved)) return '链接越出仓库: ' + target
  if (!fs.existsSync(filename)) return '目标不存在: ' + target
  if (!fragment) return null
  if (fs.statSync(filename).isDirectory()) return '目录链接不能核验章节: ' + target
  if (filename.endsWith('.md')) {
    if (!anchorCache.has(filename)) anchorCache.set(filename, anchors(fs.readFileSync(filename, 'utf8')))
    return anchorCache.get(filename).has(fragment) ? null : '章节不存在: ' + target
  }
  const lines = fragment.match(/^L(\d+)(?:-L(\d+))?$/)
  if (lines) {
    const count = fs.readFileSync(filename, 'utf8').split(/\r?\n/).length
    const start = Number(lines[1]), end = Number(lines[2] || lines[1])
    return start >= 1 && end >= start && end <= count ? null : '源码行范围无效: ' + target
  }
  return '非 Markdown 片段未支持核验: ' + target
}

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) return []
    return entry.isDirectory() ? markdownFiles(filename) : filename.endsWith('.md') ? [filename] : []
  })
}

function check(root) {
  const files = ['README.md', 'AGENTS.md', 'specs/README.md', ...markdownFiles(path.join(root, 'docs')).map(file => path.relative(root, file))]
  const errors = [], cache = new Map()
  let count = 0
  for (const file of files) {
    if (!fs.existsSync(path.join(root, file))) { errors.push(file + ': 缺少现行入口'); continue }
    for (const target of destinations(fs.readFileSync(path.join(root, file), 'utf8'))) {
      count++
      const error = validateTarget(root, file, target, cache)
      if (error) errors.push(file + ': ' + error)
    }
  }
  if (errors.length) throw new Error('文档检查失败\n' + errors.join('\n'))
  process.stdout.write(`文档检查通过：${files.length} 份现行入口，${count} 个链接；外部链接不联网，历史规格正文保持原状。\n`)
}

function selfTest() {
  const sample = '# Hello\n## 账户与金额\n<a id="import-post"></a>\n## Repeat\n## Repeat\n```md\n[skip](missing.md)\n## Hidden\n```\n[go](docs/a.md#intro)\n![logo](assets/logo.png)\n'
  assert.deepEqual(destinations(sample), ['docs/a.md#intro', 'assets/logo.png'])
  const ids = anchors(sample)
  for (const id of ['hello', '账户与金额', 'import-post', 'repeat', 'repeat-1']) assert.ok(ids.has(id))
  assert.ok(!ids.has('hidden'))
  assert.equal(withoutFences('~~~md\nx\n~~~\ny').trim(), 'y')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catledger-doc-check-'))
  try {
    fs.mkdirSync(path.join(root, 'docs'))
    fs.writeFileSync(path.join(root, 'docs/a.md'), '# Intro\n<a id="稳定入口"></a>\n')
    fs.writeFileSync(path.join(root, 'sample.js'), 'const ok = true\n')
    const cache = new Map()
    for (const target of ['docs/a.md#intro', 'docs/a.md#%E7%A8%B3%E5%AE%9A%E5%85%A5%E5%8F%A3', 'sample.js#L1', 'https://example.invalid/ignored']) assert.equal(validateTarget(root, 'README.md', target, cache), null)
    for (const target of ['docs/missing.md', 'docs/a.md#missing', '../outside', 'sample.js#L99', '%zz']) assert.notEqual(validateTarget(root, 'README.md', target, cache), null)
    assert.equal(validateTarget(root, 'docs/a.md', '#intro', cache), null)
  } finally {
    // 仅删除本函数随机创建的检查夹具，不触碰仓库或用户工作区。
    fs.rmSync(root, { recursive: true, force: true })
  }
  process.stdout.write('文档检查器自测通过：本地路径、中文/显式/重复锚点、代码围栏、失效链接与越界反例。\n')
}

if (require.main === module) {
  try {
    if (process.argv.includes('--self-test')) selfTest()
    else check(path.resolve(__dirname, '..'))
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1 }
}
module.exports = { withoutFences, anchors, destinations, validateTarget, check }
