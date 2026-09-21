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

async function insertDefaultCategories(connection, uid, categories, existing) {
  let inserted = 0
  // Parents first; the caller holds the user lock for this entire bootstrap transaction.
  for (const childLevel of [false, true]) {
    const additions = []
    for (const category of categories.filter(row => Boolean(row.parentSystemKey) === childLevel)) {
      if (existing.some(row => row.systemKey === category.systemKey)) continue
      const parent = childLevel && existing.find(row => row.systemKey === category.parentSystemKey && row.kind === category.kind && row.archivedAt == null && !row.parentId)
      if (childLevel && !parent) continue
      const parentId = parent ? parent.id : null
      const normalizedName = normalizeCategoryName(category.name).normalizedName
      // A user's own same-name category is never adopted, renamed or duplicated.
      if (existing.some(row => row.kind === category.kind && (row.parentId || null) === parentId && row.archivedAt == null && row.normalizedName === normalizedName)) continue
      const row = { ...category, id: randomUUID(), parentId, normalizedName, archivedAt: null }
      additions.push(row); existing.push(row)
    }
    if (!additions.length) continue
    await connection.execute(
      `INSERT INTO catledger_categories
         (category_id, uid, kind, system_key, parent_id, name, normalized_name, sort_order, is_system_default)
       VALUES ${additions.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, 1)').join(', ')}`,
      additions.flatMap(row => [row.id, uid, row.kind, row.systemKey, row.parentId, row.name, row.normalizedName, row.sortOrder]))
    inserted += additions.length
  }
  return inserted
}

async function listCategories(connection, uid) {
  const [rows] = await connection.execute(
    `SELECT category_id AS id,
            kind,
            system_key AS systemKey, parent_id AS parentId,
            name,
            sort_order AS sortOrder,
            version
       FROM catledger_categories
      WHERE uid = ? AND archived_at IS NULL
      ORDER BY kind, parent_id IS NOT NULL, sort_order, category_id`,
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
          const [existing] = await connection.execute('SELECT system_key AS systemKey, category_id AS id, kind, parent_id AS parentId, normalized_name AS normalizedName, archived_at AS archivedAt FROM catledger_categories WHERE uid=?', [uid])
          const inserted = await insertDefaultCategories(connection, uid, defaultCategories, existing)
          if (inserted) await connection.execute('UPDATE catledger_users SET data_revision=data_revision+1 WHERE uid=?', [uid])
          const categories = await listCategories(connection, uid)

          await connection.commit()
          transactionStarted = false
          return {
            uid,
            isNewUser: !identity,
            nickname: active.nickname || '',
            dataRevision: (BigInt(active.dataRevision) + (inserted ? 1n : 0n)).toString(),
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
