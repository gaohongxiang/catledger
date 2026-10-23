// 只运行既有合成导出/双库恢复反例，不接收用户备份或恢复目标。
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { testConfig } = require('./isolated-mysql')

function main(args = process.argv.slice(2)) {
  if (args.length > 1 || args.some(arg => arg !== '--check')) {
    process.stderr.write('用法：node scripts/drill-data-restore.js [--check]；不接受备份路径或目标库参数。\n')
    return 1
  }
  const required = ['HOST', 'USER', 'PASSWORD', 'NAME']
  if (required.some(key => !process.env['CATLEDGER_TEST_DB_' + key])) {
    process.stderr.write('隔离恢复演练需要完整 CATLEDGER_TEST_DB_* 配置；缺少配置不会跳过或算作通过。\n')
    return 1
  }
  try { testConfig() }
  catch (_) {
    process.stderr.write('仅允许本机专用 MySQL 和名称以 _test 结尾的连接库；未连接数据库。\n')
    return 1
  }
  if (args.includes('--check')) {
    process.stdout.write('配置形状检查通过；未连接数据库，未执行恢复演练。\n')
    return 0
  }
  process.stdout.write('运行合成导出与双库恢复演练；只向本次创建的随机隔离库写入，结束回收隔离库和测试账号。\n')
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1',
    'test/export-files.test.js', 'test/data-export.test.js'], {
    cwd: path.resolve(__dirname, '..'), env: process.env, stdio: 'inherit'
  })
  if (result.error || result.signal || result.status !== 0) {
    process.stderr.write('恢复演练未通过；保留失败摘要并检查隔离库清理结果，不切换到真实数据库重试。\n')
    return result.status || 1
  }
  return 0
}

if (require.main === module) process.exitCode = main()
module.exports = { main }
