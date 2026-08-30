const { randomInt, randomUUID } = require('node:crypto')

const { DEFAULT_CATEGORIES } = require('./default-categories')
const { normalizeCategoryName } = require('./category-name')

const MAX_BOOTSTRAP_ATTEMPTS = 5
const RETRYABLE_TRANSACTION_ERRORS = new Set([
  'ER_DUP_ENTRY',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT'
])

function isRetryableTransactionError(error) {
  return error && RETRYABLE_TRANSACTION_ERRORS.has(error.code)
}

async function waitBeforeRetry(error, attempt) {
  if (error.code === 'ER_DUP_ENTRY') {
    return
  }

  const maximumDelayMs = Math.min(100, 10 * (2 ** attempt))
  const delayMs = randomInt(1, maximumDelayMs + 1)
  await new Promise((resolve) => setTimeout(resolve, delayMs))
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

function createUserRepository({ getPool, defaultCategories = DEFAULT_CATEGORIES }) {
  return {
    async bootstrap({ provider, subjectHash }) {
      for (let attempt = 0; attempt < MAX_BOOTSTRAP_ATTEMPTS; attempt += 1) {
        const connection = await getPool().getConnection()

        try {
          await connection.beginTransaction()

          const identity = await findIdentity(connection, provider, subjectHash)
          const uid = identity ? identity.uid : randomUUID()

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

          await insertDefaultCategories(connection, uid, defaultCategories)
          const categories = await listCategories(connection, uid)

          await connection.commit()
          return {
            isNewUser: !identity,
            categories
          }
        } catch (error) {
          await connection.rollback()

          if (isRetryableTransactionError(error) && attempt + 1 < MAX_BOOTSTRAP_ATTEMPTS) {
            await waitBeforeRetry(error, attempt)
            continue
          }

          throw error
        } finally {
          connection.release()
        }
      }

      throw new Error('Bootstrap attempts exhausted')
    }
  }
}

module.exports = {
  createUserRepository
}
