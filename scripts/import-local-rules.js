// Explicit portable dependency closure. These are source files, not generated
// bundles; --check prevents deployed rules and the Mini Program drifting apart.
const fs = require('node:fs'), path = require('node:path')
const root = path.resolve(__dirname, '..'), source = path.join(root, 'cloudfunctions/catledger-import/src')
const target = path.join(root, 'miniprogram/packages/finance/domain/import-review')
const roots = ['review/editor-policy','organizer-model','organizer-plan-policy','source-funds','bank-channel-matching',
  'coverage-report','review/bank-channel-graph','workbench-summary','excluded-event-groups','repayment-policy',
  'refund-relation-policy','historical-match-policy','local-review-protocol','local-review-snapshot','local-review-identity','review/account-mapping-policy',
  'review/evidence-hydration','review/merge-origins','review/pair-primary-policy','review-presentation','review-attention']
const visited = new Set()
function visit(name) {
  if (!name.endsWith('.js')) name = fs.existsSync(path.join(source, name + '.js')) ? name + '.js' : name + '/index.js'
  if (visited.has(name)) return
  visited.add(name)
  const content = fs.readFileSync(path.join(source, name), 'utf8')
  if (/\b(?:Buffer|process|wx)\b/.test(content.replace(/\/\/[^\n]*/g, ''))) throw new Error('Nonportable global: ' + name)
  for (const match of content.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    if (!match[1].startsWith('.')) throw new Error('Nonportable dependency: ' + name + ' -> ' + match[1])
    visit(path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1])))
  }
  const output = path.join(target, name)
  if (process.argv.includes('--write')) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, content) }
  else if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== content) throw new Error('Local rule source differs: ' + name)
}
for (const name of roots) visit(name)
console.log('Portable import rules verified: ' + visited.size + ' files')
