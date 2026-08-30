const { randomUUID } = require('node:crypto')

const { normalizeCategoryName } = require('./category-name')
const { ledgerError } = require('./ledger-errors')
const { executeIdempotentMutation, resolveUid } = require('./ledger-transaction')

const KINDS = new Set(['expense', 'income'])

function validateKind(value) {
  if (!KINDS.has(value)) throw ledgerError('VALIDATION_ERROR')
  return value
}

function validateId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) {
    throw ledgerError('VALIDATION_ERROR')
  }
  return value
}

function validateVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw ledgerError('VALIDATION_ERROR')
  return value
}

function toPublic(row) {
  return {
    id: row.id,
    kind: row.kind,
    systemKey: row.systemKey == null ? null : row.systemKey,
    name: row.name,
    sortOrder: Number(row.sortOrder),
    version: Number(row.version),
    archived: row.archivedAt != null,
    isSystemDefault: Boolean(row.isSystemDefault)
  }
}

async function listRows(connection, uid, { forUpdate = false } = {}) {
  const [rows] = await connection.execute(
    `SELECT category_id AS id, kind, system_key AS systemKey, name,
            sort_order AS sortOrder, version, archived_at AS archivedAt,
            is_system_default AS isSystemDefault
       FROM catledger_categories
      WHERE uid = ?
      ORDER BY kind, archived_at IS NOT NULL, sort_order, category_id${forUpdate ? ' FOR UPDATE' : ''}`,
    [uid]
  )
  return rows
}

async function lockCategory(connection, uid, categoryId) {
  validateId(categoryId)
  const [rows] = await connection.execute(
    `SELECT category_id AS id, kind, system_key AS systemKey, name,
            normalized_name AS normalizedName, sort_order AS sortOrder,
            version, archived_at AS archivedAt, is_system_default AS isSystemDefault
       FROM catledger_categories
      WHERE uid = ? AND category_id = ?
      LIMIT 1 FOR UPDATE`,
    [uid, categoryId]
  )
  if (!rows[0]) throw ledgerError('NOT_FOUND')
  return rows[0]
}

function translateDuplicate(error) {
  if (error && error.code === 'ER_DUP_ENTRY') throw ledgerError('CONFLICT')
  throw error
}

function createCategoryService({ getPool }) {
  async function list(context) {
    const connection = await getPool().getConnection()
    try {
      const uid = await resolveUid(connection, context.provider, context.subjectHash)
      return { categories: (await listRows(connection, uid)).map(toPublic) }
    } finally {
      connection.release()
    }
  }

  async function create(context) {
    return executeIdempotentMutation({
      getPool, ...context, action: 'categories.create',
      operation: async (connection, uid, data) => {
        const kind = validateKind(data.kind)
        const { name, normalizedName } = normalizeCategoryName(data.name)
        const [positions] = await connection.execute(
          `SELECT sort_order AS sortOrder
             FROM catledger_categories
            WHERE uid = ? AND kind = ? AND archived_at IS NULL
            ORDER BY sort_order, category_id FOR UPDATE`,
          [uid, kind]
        )
        const sortOrder = positions.reduce(function (maximum, row) {
          return Math.max(maximum, Number(row.sortOrder))
        }, 0) + 10
        const id = randomUUID()
        try {
          await connection.execute(
            `INSERT INTO catledger_categories
               (category_id, uid, kind, system_key, name, normalized_name,
                sort_order, is_system_default, version)
             VALUES (?, ?, ?, NULL, ?, ?, ?, 0, 1)`,
            [id, uid, kind, name, normalizedName, sortOrder]
          )
        } catch (error) { translateDuplicate(error) }
        return toPublic({ id, kind, systemKey: null, name, sortOrder, version: 1, archivedAt: null, isSystemDefault: 0 })
      }
    })
  }

  async function update(context) {
    return executeIdempotentMutation({
      getPool, ...context, action: 'categories.update',
      operation: async (connection, uid, data) => {
        const current = await lockCategory(connection, uid, data.categoryId)
        if (current.archivedAt != null || Number(current.version) !== validateVersion(data.version)) {
          throw ledgerError(current.archivedAt != null ? 'NOT_FOUND' : 'CONFLICT')
        }
        const { name, normalizedName } = normalizeCategoryName(data.name)
        try {
          await connection.execute(
            `UPDATE catledger_categories
                SET name = ?, normalized_name = ?, version = version + 1
              WHERE uid = ? AND category_id = ? AND version = ? AND archived_at IS NULL`,
            [name, normalizedName, uid, current.id, data.version]
          )
        } catch (error) { translateDuplicate(error) }
        return toPublic({ ...current, name, version: Number(current.version) + 1 })
      }
    })
  }

  async function setArchived(context, archived) {
    const action = archived ? 'categories.archive' : 'categories.restore'
    return executeIdempotentMutation({
      getPool, ...context, action,
      operation: async (connection, uid, data) => {
        const current = await lockCategory(connection, uid, data.categoryId)
        if (Number(current.version) !== validateVersion(data.version)) throw ledgerError('CONFLICT')
        if ((current.archivedAt != null) === archived) return toPublic(current)
        try {
          await connection.execute(
            `UPDATE catledger_categories
                SET archived_at = ${archived ? 'CURRENT_TIMESTAMP(3)' : 'NULL'}, version = version + 1
              WHERE uid = ? AND category_id = ? AND version = ?`,
            [uid, current.id, data.version]
          )
        } catch (error) { translateDuplicate(error) }
        return toPublic({ ...current, archivedAt: archived ? new Date().toISOString() : null, version: Number(current.version) + 1 })
      }
    })
  }

  async function reorder(context) {
    return executeIdempotentMutation({
      getPool, ...context, action: 'categories.reorder',
      operation: async (connection, uid, data) => {
        const kind = validateKind(data.kind)
        if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 100) {
          throw ledgerError('VALIDATION_ERROR')
        }
        const rows = (await listRows(connection, uid, { forUpdate: true }))
          .filter((row) => row.kind === kind && row.archivedAt == null)
        const requested = data.items.map((item) => ({
          id: validateId(item && item.categoryId),
          version: validateVersion(item && item.version)
        }))
        if (new Set(requested.map((item) => item.id)).size !== requested.length || requested.length !== rows.length) {
          throw ledgerError('CONFLICT')
        }
        const byId = new Map(rows.map((row) => [row.id, row]))
        if (requested.some((item) => !byId.has(item.id) || Number(byId.get(item.id).version) !== item.version)) {
          throw ledgerError('CONFLICT')
        }
        for (let index = 0; index < requested.length; index += 1) {
          await connection.execute(
            `UPDATE catledger_categories SET sort_order = ?, version = version + 1
              WHERE uid = ? AND category_id = ? AND version = ?`,
            [(index + 1) * 10, uid, requested[index].id, requested[index].version]
          )
        }
        return { categories: (await listRows(connection, uid)).filter((row) => row.kind === kind && row.archivedAt == null).map(toPublic) }
      }
    })
  }

  return {
    list,
    create,
    update,
    archive: (context) => setArchived(context, true),
    restore: (context) => setArchived(context, false),
    reorder
  }
}

module.exports = { createCategoryService, toPublic, validateKind }
