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
const INITIALIZATION_VERSION = 1
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

function createUserRepository({ getPool, defaultCategories = DEFAULT_CATEGORIES, generateUid = createUserId, now = Date.now }) {
  return {
    async bootstrap({ provider, subjectHash }, observePhase = () => {}) {
      for (let attempt = 0; attempt < MAX_BOOTSTRAP_ATTEMPTS; attempt += 1) {
        let connection
        let transactionStarted = false
        const timed = async (phase, work) => {
          const start = now()
          try { return await work() } finally { observePhase({ phase, ms: Math.max(0, now() - start), attempt }) }
        }

        try {
          connection = await timed('connection', () => getPool().getConnection())
          // 分类与 revision 必须属于同一只读快照；日常登录不持用户写锁。
          await timed('readTransaction', async () => {
            await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            await connection.query('START TRANSACTION READ ONLY')
          })
          transactionStarted = true
          const [[known]] = await timed('identity', () => connection.execute(`SELECT i.uid, u.status, u.nickname,
            u.initialization_version AS initializationVersion, CAST(u.data_revision AS CHAR) AS dataRevision
            FROM catledger_user_identities i JOIN catledger_users u ON u.uid=i.uid
            WHERE i.provider=? AND i.subject_hash=? LIMIT 1`, [provider, subjectHash]))
          if (known && known.status !== 'active') throw ledgerError('INITIALIZATION_REQUIRED')
          if (known && Number(known.initializationVersion) >= INITIALIZATION_VERSION) {
            const categories = await timed('categories', () => listCategories(connection, known.uid))
            await timed('commit', () => connection.commit())
            transactionStarted = false
            return { uid: known.uid, isNewUser: false, nickname: known.nickname || '', dataRevision: known.dataRevision, categories }
          }
          // 旧用户只做一次安全补齐；退出只读快照后重新锁定身份，防止并发初始化。
          await timed('commit', () => connection.commit())
          transactionStarted = false
          await timed('initialization', () => connection.beginTransaction())
          transactionStarted = true

          const identity = await timed('identity', () => findIdentity(connection, provider, subjectHash))
          const uid = identity ? identity.uid : generateUid()

          const result = await timed('initialization', async () => {
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
            const [[active]] = await connection.execute("SELECT uid, nickname, initialization_version AS initializationVersion, CAST(data_revision AS CHAR) AS dataRevision FROM catledger_users WHERE uid=? AND status='active' FOR UPDATE", [uid])
            if (!active) throw ledgerError('INITIALIZATION_REQUIRED')
            let inserted = 0
            if (Number(active.initializationVersion) < INITIALIZATION_VERSION) {
              const [existing] = await connection.execute('SELECT system_key AS systemKey, category_id AS id, kind, parent_id AS parentId, normalized_name AS normalizedName, archived_at AS archivedAt FROM catledger_categories WHERE uid=?', [uid])
              inserted = await insertDefaultCategories(connection, uid, defaultCategories, existing)
              await connection.execute('UPDATE catledger_users SET initialization_version=?, data_revision=data_revision+? WHERE uid=?', [INITIALIZATION_VERSION, inserted ? 1 : 0, uid])
            }
            return { uid, isNewUser: !identity, nickname: active.nickname || '', dataRevision: (BigInt(active.dataRevision) + (inserted ? 1n : 0n)).toString() }
          })
          const categories = await timed('categories', () => listCategories(connection, uid))

          await timed('commit', () => connection.commit())
          transactionStarted = false
          return { ...result, categories }
        } catch (error) {
          if (transactionStarted) await timed('rollback', () => safeRollback(connection))

          if (isRetryableTransactionError(error) && attempt + 1 < MAX_BOOTSTRAP_ATTEMPTS) {
            await timed('retry', () => waitBeforeRetry(error, attempt))
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
