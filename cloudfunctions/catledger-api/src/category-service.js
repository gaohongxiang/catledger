const { randomUUID } = require('node:crypto')

const { normalizeCategoryName } = require('./category-name')
const { ledgerError } = require('./ledger-errors')
const { executeLedgerRead } = require('./ledger-read')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { parseMonth } = require('./local-time')

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

function parseCategoryEvidence(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch (_) { return {} }
}

function groupUnclassifiedRows(rows) {
  const groups = new Map()
  ;(rows || []).forEach(function (row) {
    const evidence = parseCategoryEvidence(row.categoryEvidence)
    const aliasKey = evidence.aliasKeys && evidence.aliasKeys[0]
    const groupKey = [row.type, row.sourceType || 'manual', aliasKey || row.transactionId].join(':')
    const group = groups.get(groupKey) || {
      groupKey,
      kind: row.type,
      title: row.rawTransactionType || row.counterparty || row.item || row.note || '未分类交易',
      count: 0,
      amountMinor: '0',
      samples: [],
      members: []
    }
    group.count += 1
    group.amountMinor = (BigInt(group.amountMinor) + BigInt(String(row.amountMinor || 0))).toString()
    if (group.samples.length < 3) {
      group.samples.push({
        transactionId: row.transactionId,
        occurredLocalAt: row.occurredLocalAt,
        title: row.item || row.counterparty || row.note || group.title,
        amountMinor: String(row.amountMinor || 0)
      })
    }
    group.members.push({ transactionId: row.transactionId, version: Number(row.version) })
    groups.set(groupKey, group)
  })
  return [...groups.values()].sort(function (left, right) {
    return left.kind.localeCompare(right.kind) || left.title.localeCompare(right.title) || left.groupKey.localeCompare(right.groupKey)
  })
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
    return executeLedgerRead({
      getPool,
      ...context,
      operation: async (connection, uid) => ({ categories: (await listRows(connection, uid)).map(toPublic) })
    })
  }

  async function unclassified(context) {
    return executeLedgerRead({
      getPool,
      ...context,
      consistentSnapshot: true,
      operation: async function (connection, uid) {
        const month = context.data && context.data.month
        const range = parseMonth(month)
        const [rows] = await connection.execute(
          `SELECT t.transaction_id AS transactionId, t.version,
                  t.type, t.amount_minor AS amountMinor,
                  t.occurred_local_at AS occurredLocalAt, t.note,
                  source.source_type_snapshot AS sourceType,
                  import_row.transaction_type_raw AS rawTransactionType,
                  import_row.counterparty_raw AS counterparty,
                  import_row.item_raw AS item,
                  import_row.category_evidence_json AS categoryEvidence
             FROM catledger_transactions t
             LEFT JOIN catledger_economic_event_transactions event_link
               ON event_link.uid = t.uid AND event_link.transaction_id = t.transaction_id
             LEFT JOIN catledger_event_evidence evidence
               ON evidence.uid = event_link.uid AND evidence.update_id = event_link.update_id
              AND evidence.event_id = event_link.event_id AND evidence.evidence_role = 'primary'
             LEFT JOIN catledger_import_rows import_row
               ON import_row.uid = evidence.uid AND import_row.row_id = evidence.row_id
             LEFT JOIN catledger_finance_update_sources source
               ON source.uid = import_row.uid AND source.update_id = event_link.update_id
              AND source.batch_id = import_row.batch_id
            WHERE t.uid = ? AND t.deleted_at IS NULL
              AND t.category_id IS NULL AND t.type IN ('income', 'expense')
              AND t.occurred_local_date >= ? AND t.occurred_local_date < ?
            ORDER BY t.occurred_local_at, t.transaction_id`,
          [uid, range.startDate, range.endDate]
        )
        return {
          month,
          groups: groupUnclassifiedRows(rows),
          categories: (await listRows(connection, uid)).filter(function (row) {
            return row.archivedAt == null
          }).map(toPublic)
        }
      }
    })
  }

  async function assignTransactions(context) {
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'categories.assignTransactions',
      operation: async function (connection, uid, data) {
        const category = await lockCategory(connection, uid, data.categoryId)
        if (category.archivedAt != null) throw ledgerError('NOT_FOUND')
        if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 500) {
          throw ledgerError('VALIDATION_ERROR')
        }
        const items = data.items.map(function (item) {
          return {
            transactionId: validateId(item && item.transactionId),
            version: validateVersion(item && item.version)
          }
        })
        if (new Set(items.map(function (item) { return item.transactionId })).size !== items.length) {
          throw ledgerError('VALIDATION_ERROR')
        }
        const [transactions] = await connection.execute(
          `SELECT transaction_id AS transactionId, version, type
             FROM catledger_transactions
            WHERE uid = ? AND transaction_id IN (${items.map(function () { return '?' }).join(', ')})
              AND deleted_at IS NULL FOR UPDATE`,
          [uid].concat(items.map(function (item) { return item.transactionId }))
        )
        const requested = new Map(items.map(function (item) { return [item.transactionId, item] }))
        if (transactions.length !== items.length || transactions.some(function (transaction) {
          const item = requested.get(transaction.transactionId)
          return !item || Number(transaction.version) !== item.version || transaction.type !== category.kind
        })) throw ledgerError('CONFLICT')

        for (const item of items) {
          const [result] = await connection.execute(
            `UPDATE catledger_transactions
                SET category_id = ?, version = version + 1
              WHERE uid = ? AND transaction_id = ? AND version = ?
                AND category_id IS NULL AND deleted_at IS NULL`,
            [category.id, uid, item.transactionId, item.version]
          )
          if (result.affectedRows !== 1) throw ledgerError('CONFLICT')
        }

        const [evidenceRows] = await connection.execute(
          `SELECT source.source_type_snapshot AS sourceType,
                  import_row.category_evidence_json AS categoryEvidence
             FROM catledger_economic_event_transactions event_link
             JOIN catledger_event_evidence evidence
               ON evidence.uid = event_link.uid AND evidence.update_id = event_link.update_id
              AND evidence.event_id = event_link.event_id AND evidence.evidence_role <> 'discarded'
             JOIN catledger_import_rows import_row
               ON import_row.uid = evidence.uid AND import_row.row_id = evidence.row_id
             JOIN catledger_finance_update_sources source
               ON source.uid = import_row.uid AND source.update_id = event_link.update_id
              AND source.batch_id = import_row.batch_id
            WHERE event_link.uid = ? AND event_link.transaction_id IN (${items.map(function () { return '?' }).join(', ')})`,
          [uid].concat(items.map(function (item) { return item.transactionId }))
        )
        const aliases = new Map()
        evidenceRows.forEach(function (row) {
          const evidence = parseCategoryEvidence(row.categoryEvidence)
          ;(evidence.aliasKeys || []).forEach(function (aliasKey) {
            aliases.set(`${row.sourceType}:${aliasKey}`, { sourceType: row.sourceType, aliasKey })
          })
        })
        for (const alias of aliases.values()) {
          await connection.execute(
            `INSERT INTO catledger_import_category_mappings
               (uid, mapping_id, source_type, alias_key, alias_key_version, category_id)
             VALUES (?, ?, ?, ?, 'category-alias-v1', ?)
             ON DUPLICATE KEY UPDATE category_id = VALUES(category_id), version = version + 1`,
            [uid, randomUUID(), alias.sourceType, alias.aliasKey, category.id]
          )
        }
        return { updatedCount: items.length }
      }
    })
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
    unclassified,
    assignTransactions,
    create,
    update,
    archive: (context) => setArchived(context, true),
    restore: (context) => setArchived(context, false),
    reorder
  }
}

module.exports = { createCategoryService, groupUnclassifiedRows, toPublic, validateKind }
