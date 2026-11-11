// 云函数共享领域文件的单一来源同步器。
//
// 背景：微信云函数按函数目录**独立打包上传**，catledger-api 与 catledger-import 不能互相 require。
// 因此两支函数里存在一批「必须逐字节一致」的领域文件（还款契约、分期来源、费用关系、计划指纹等）。
// 手改两份极易漂移。这里把 catledger-import/src 定为**唯一手写来源**，其余位置视为生成副本：
//   - 编辑请只改 cloudfunctions/catledger-import/src/<name>.js
//   - 改完执行：node scripts/sync-cloud-domain.js --write
//   - check 模式：node scripts/sync-cloud-domain.js（或经 scripts/check.js 自动调用）校验一致
//
// 不改变云函数独立部署形态：api 侧仍保留物理副本，只是不再手写。
// miniprogram 端的可移植纯规则副本由 scripts/import-local-rules.js 单独负责（其来源同样是 import/src）。
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

const SOURCE_DIR = 'cloudfunctions/catledger-import/src'
// api ↔ import 必须逐字节一致的领域文件（来源 import/src）。
const SHARED = [
  'category-likeness',
  'category-memory',
  'installment-items',
  'installment-plan',
  'installment-plan-fingerprint',
  'loan-charge-coverage',
  'loan-charge-domain',
  'loan-charge-import',
  'loan-charge-payments',
  'loan-charge-store',
  'portable-digest',
  'repayment-booking',
  'repayment-policy'
]
const TARGETS = ['cloudfunctions/catledger-api/src']

function run(write) {
  const drift = []
  for (const name of SHARED) {
    const src = path.join(root, SOURCE_DIR, name + '.js')
    if (!fs.existsSync(src)) throw new Error('Shared domain source missing: ' + name)
    const content = fs.readFileSync(src, 'utf8')
    for (const dir of TARGETS) {
      const out = path.join(root, dir, name + '.js')
      const exists = fs.existsSync(out)
      if (write) {
        if (!exists || fs.readFileSync(out, 'utf8') !== content) fs.writeFileSync(out, content)
      } else if (!exists || fs.readFileSync(out, 'utf8') !== content) {
        drift.push(path.relative(root, out))
      }
    }
  }
  if (!write && drift.length) throw new Error('云函数共享领域文件与来源不一致（改来源后请运行 node scripts/sync-cloud-domain.js --write）：\n  ' + drift.join('\n  '))
  process.stdout.write(write
    ? `云函数共享领域文件已同步：${SHARED.length} 个文件 → ${TARGETS.join(', ')}\n`
    : `云函数共享领域文件一致：${SHARED.length} 个文件\n`)
}

run(process.argv.includes('--write'))
