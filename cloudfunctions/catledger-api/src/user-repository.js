const { randomUUID } = require('node:crypto')

const { DEFAULT_CATEGORIES } = require('./default-categories')
const { createUserId } = require('./user-id')
const { normalizeCategoryName } = require('./category-name')
const { ledgerError } = require('./ledger-errors')
const {
  isRetryableDatabaseError,
  safeRollback,
  waitBeforeDatabaseRetry
} = require('./database-errors')

const MAX_BOOTSTRAP_ATTEMPTS = 5
function isRetryableTransactionError(error) {
  return error && (error.code === 'ER_DUP_ENTRY' || isRetryableDatabaseError(error))
}

async function waitBeforeRetry(error, attempt) {
  if (error.code !== 'ER_DUP_ENTRY') await waitBeforeDatabaseRetry(attempt)
}

async function findIdentity(connection, provider, subjectHash) {
  const [rows] = await connection.execute(
    `SELECT uid
       FROM catledger_user_identities
      WHERE provider = ? AND subject_hash = ?
      LIMIT 1
      FOR UPDATE`,
    [provider, subjectHash]
  )

  return rows[0] || null
}

async function insertDefaultCategories(connection, uid, categories) {
  if (categories.length === 0) {
    return
  }

  const placeholders = categories.map(() => '(?, ?, ?, ?, ?, ?, ?, 1)').join(', ')
  const values = categories.flatMap((category) => [
    randomUUID(),
    uid,
    category.kind,
    category.systemKey,
    category.name,
    normalizeCategoryName(category.name).normalizedName,
    category.sortOrder
  ])

  await connection.execute(
    `INSERT INTO catledger_categories
       (category_id, uid, kind, system_key, name, normalized_name, sort_order, is_system_default)
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE category_id = category_id`,
    values
  )
}

async function listCategories(connection, uid) {
  const [rows] = await connection.execute(
    `SELECT category_id AS id,
            kind,
            system_key AS systemKey,
            name,
            sort_order AS sortOrder,
            version
       FROM catledger_categories
      WHERE uid = ? AND archived_at IS NULL
      ORDER BY kind, sort_order, category_id`,
    [uid]
  )

  return rows
}

function createUserRepository({ getPool, defaultCategories = DEFAULT_CATEGORIES, generateUid = createUserId }) {
  return {
    async bootstrap({ provider, subjectHash }) {
      for (let attempt = 0; attempt < MAX_BOOTSTRAP_ATTEMPTS; attempt += 1) {
        let connection
        let transactionStarted = false

        try {
          connection = await getPool().getConnection()
          await connection.beginTransaction()
          transactionStarted = true

          const identity = await findIdentity(connection, provider, subjectHash)
          const uid = identity ? identity.uid : generateUid()

          if (!identity) {
            await connection.execute(
              'INSERT INTO catledger_users (uid, status) VALUES (?, ?)',
              [uid, 'active']
            )
            await connection.execute(
              `INSERT INTO catledger_user_identities
                 (uid, provider, subject_hash)
               VALUES (?, ?, ?)`,
              [uid, provider, subjectHash]
            )
          }
          const [[active]] = await connection.execute("SELECT uid, nickname, CAST(data_revision AS CHAR) AS dataRevision FROM catledger_users WHERE uid=? AND status='active' FOR UPDATE", [uid])
          if (!active) throw ledgerError('INITIALIZATION_REQUIRED')
          const [existing] = await connection.execute('SELECT system_key AS systemKey FROM catledger_categories WHERE uid=? AND system_key IS NOT NULL', [uid])
          const keys = new Set(existing.map(row => row.systemKey))
          const missing = defaultCategories.filter(category => !keys.has(category.systemKey))
          await insertDefaultCategories(connection, uid, missing)
          if (missing.length) await connection.execute('UPDATE catledger_users SET data_revision=data_revision+1 WHERE uid=?', [uid])
          const categories = await listCategories(connection, uid)

          await connection.commit()
          transactionStarted = false
          return {
            uid,
            isNewUser: !identity,
            nickname: active.nickname || '',
            dataRevision: (BigInt(active.dataRevision) + (missing.length ? 1n : 0n)).toString(),
            categories
          }
        } catch (error) {
          if (transactionStarted) await safeRollback(connection)

          if (isRetryableTransactionError(error) && attempt + 1 < MAX_BOOTSTRAP_ATTEMPTS) {
            await waitBeforeRetry(error, attempt)
            continue
          }

          throw error
        } finally {
          if (connection) connection.release()
        }
      }

      throw new Error('Bootstrap attempts exhausted')
    }
  }
}

module.exports = {
  createUserRepository
}
