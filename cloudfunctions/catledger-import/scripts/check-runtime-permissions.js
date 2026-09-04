const { closePool, getPool } = require('../src/database')
const { assertRuntimePermissions } = require('../src/runtime-permission-contract')

async function main() {
  const [rows] = await getPool().query('SHOW GRANTS')
  const grants = rows.flatMap((row) => Object.values(row).map(String))
  assertRuntimePermissions(grants)
  console.info('Catledger import runtime database permission check passed')
}

main()
  .catch((error) => {
    console.error(error && error.code === 'CATLEDGER_DB_PERMISSION_MISSING'
      ? error.message
      : 'Catledger import runtime database permission check failed')
    process.exitCode = 1
  })
  .finally(closePool)
