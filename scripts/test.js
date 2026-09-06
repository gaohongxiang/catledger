const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const database = process.argv.includes('--database')
const required = ['HOST', 'USER', 'PASSWORD', 'NAME'].map((name) => `CATLEDGER_TEST_DB_${name}`)
if (database && required.some((key) => !process.env[key])) {
  process.stderr.write('数据库验证需要完整 CATLEDGER_TEST_DB_* 配置；禁止把跳过当作通过。请使用可清空的隔离测试库。\n')
  process.exit(1)
}
const env = { ...process.env }
if (!database) {
  for (const key of Object.keys(env)) if (key.startsWith('CATLEDGER_TEST_DB_')) delete env[key]
  process.stdout.write('运行本地单元测试；数据库集成请使用 npm run test:db。\n')
}
// API 套件先应用迁移并清空测试数据；两个函数的数据库套件不能并行。
for (const directory of ['test', 'cloudfunctions/catledger-api/test', 'cloudfunctions/catledger-import/test']) {
  const files = fs.readdirSync(path.join(root, directory)).filter((name) => name.endsWith('.test.js'))
    .sort().map((name) => path.join(directory, name))
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}
