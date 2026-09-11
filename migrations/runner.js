const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const MIGRATION_FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/
const MIGRATION_LOCK_NAME = 'catledger:schema-migrations'

function checksum(contents) {
  return crypto.createHash('sha256').update(contents, 'utf8').digest('hex')
}

function splitSqlStatements(contents) {
  const statements = []
  let current = ''
  let quote = null
  let delimiter = ';'
  let index = 0

  while (index < contents.length) {
    const character = contents[index]
    if (quote) {
      current += character
      index += 1
      if (character === '\\') {
        if (index < contents.length) current += contents[index++]
      } else if (character === quote) {
        if (contents[index] === quote) current += contents[index++]
        else quote = null
      }
      continue
    }

    if ((index === 0 || contents[index - 1] === '\n') && !current.trim()) {
      const directive = contents.slice(index).match(/^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i)
      if (directive) {
        delimiter = directive[1]
        index += directive[0].length
        continue
      }
    }
    if ((contents.startsWith('--', index) && /\s/.test(contents[index + 2] || '\n')) || character === '#') {
      const end = contents.indexOf('\n', index)
      current += '\n'
      index = end < 0 ? contents.length : end + 1
      continue
    }
    if (contents.startsWith('/*', index)) {
      const end = contents.indexOf('*/', index + 2)
      if (end < 0) throw new Error('Migration contains an unterminated comment')
      current += ' '
      index = end + 2
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
    } else if (contents.startsWith(delimiter, index)) {
      if (current.trim()) statements.push(current.trim())
      current = ''
      index += delimiter.length
      continue
    }
    current += character
    index += 1
  }

  if (quote) throw new Error('Migration contains an unterminated quoted value')
  if (current.trim()) statements.push(current.trim())
  return statements
}

async function listMigrationFiles(migrationsDirectory) {
  const entries = await fs.readdir(migrationsDirectory, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && MIGRATION_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
}

async function ensureMigrationTable(connection) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS catledger_schema_migrations (
      version VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}

async function getAppliedMigration(connection, version) {
  const [rows] = await connection.execute(
    'SELECT checksum FROM catledger_schema_migrations WHERE version = ?',
    [version]
  )
  return rows[0] || null
}

async function runMigrations({ pool, migrationsDirectory }) {
  const connection = await pool.getConnection()
  const applied = []
  let lockAcquired = false

  try {
    const [[lockResult]] = await connection.execute(
      'SELECT GET_LOCK(?, 30) AS acquired',
      [MIGRATION_LOCK_NAME]
    )
    lockAcquired = Number(lockResult && lockResult.acquired) === 1
    if (!lockAcquired) {
      throw new Error('Could not acquire the Catledger migration lock')
    }

    await ensureMigrationTable(connection)
    const files = await listMigrationFiles(migrationsDirectory)

    for (const file of files) {
      const contents = await fs.readFile(path.join(migrationsDirectory, file), 'utf8')
      const expectedChecksum = checksum(contents)
      const existing = await getAppliedMigration(connection, file)

      if (existing) {
        if (existing.checksum !== expectedChecksum) {
          throw new Error(`Migration checksum mismatch: ${file}`)
        }
        continue
      }

      for (const statement of splitSqlStatements(contents)) {
        await connection.query(statement)
      }

      await connection.execute(
        'INSERT INTO catledger_schema_migrations (version, checksum) VALUES (?, ?)',
        [file, expectedChecksum]
      )
      applied.push(file)
    }

    return applied
  } finally {
    if (lockAcquired) {
      await connection.execute('SELECT RELEASE_LOCK(?) AS released', [MIGRATION_LOCK_NAME])
    }
    connection.release()
  }
}

module.exports = {
  checksum,
  runMigrations,
  splitSqlStatements
}
