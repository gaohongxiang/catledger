const mysql = require('mysql2/promise')

let pool

class DatabaseConfigurationError extends Error {
  constructor() {
    super('Catledger database environment is incomplete')
    this.name = 'DatabaseConfigurationError'
    this.publicCode = 'SERVICE_NOT_CONFIGURED'
  }
}

function getDatabaseConfig(env = process.env) {
  const required = [
    'CATLEDGER_DB_HOST',
    'CATLEDGER_DB_USER',
    'CATLEDGER_DB_PASSWORD',
    'CATLEDGER_DB_NAME'
  ]

  if (required.some((key) => !env[key])) {
    throw new DatabaseConfigurationError()
  }

  const port = Number(env.CATLEDGER_DB_PORT || 3306)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DatabaseConfigurationError()
  }

  return {
    host: env.CATLEDGER_DB_HOST,
    port,
    user: env.CATLEDGER_DB_USER,
    password: env.CATLEDGER_DB_PASSWORD,
    database: env.CATLEDGER_DB_NAME,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 4,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  }
}

function createPool(config = getDatabaseConfig()) {
  return mysql.createPool(config)
}

function getPool() {
  if (!pool) {
    pool = createPool()
  }

  return pool
}

async function closePool() {
  if (!pool) {
    return
  }

  const activePool = pool
  pool = undefined
  await activePool.end()
}

module.exports = {
  DatabaseConfigurationError,
  closePool,
  createPool,
  getDatabaseConfig,
  getPool
}
