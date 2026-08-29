const path = require('node:path')

const { runMigrations } = require('../../../migrations/runner')
const { closePool, getPool } = require('../src/database')

async function main() {
  const applied = await runMigrations({
    pool: getPool(),
    migrationsDirectory: path.resolve(__dirname, '../../../migrations')
  })

  console.info(`Catledger migrations applied: ${applied.length}`)
}

main()
  .catch((error) => {
    const code = error && typeof error.code === 'string'
      ? ` (${error.code})`
      : ''
    console.error(`Catledger migration failed${code}`)
    process.exitCode = 1
  })
  .finally(closePool)
