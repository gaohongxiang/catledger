const { randomUUID } = require('node:crypto')

const { ledgerError } = require('./ledger-errors')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { minorUnitsToString } = require('./money')
const { assertCashBalanceChanges } = require('./cash-balance-guard')
const {
  MANUAL_TYPES,
  buildManualTransaction,
  parseVersion,
  transactionToPublic,
  validateId
} = require('./transaction-domain')

async function lockAccounts(connection, uid, accountIds) {
  const ids = [...new Set(accountIds.filter(Boolean).map(validateId))].sort()
  if (ids.length === 0) return new Map()

  const placeholders = ids.map(() => '?').join(', ')
  const [rows] = await connection.execute(
    `SELECT account_id AS accountId, type, name, currency, archived_at AS archivedAt
       FROM catledger_accounts
      WHERE uid = ? AND account_id IN (${placeholders})
      ORDER BY account_id
      FOR UPDATE`,
    [uid, ...ids]
  )
  if (rows.length !== ids.length) throw ledgerError('NOT_FOUND')

  const accounts = new Map(rows.map((row) => [row.accountId, row]))
  for (const account of accounts.values()) {
    if (account.archivedAt != null) throw ledgerError('ACCOUNT_INACTIVE')
    if (account.currency !== 'CNY') throw ledgerError('UNSUPPORTED_CURRENCY')
  }
  return accounts
}

async function validateCategory(connection, uid, categoryId, expectedKind) {
  validateId(categoryId)
  const [rows] = await connection.execute(
    `SELECT kind
       FROM catledger_categories
      WHERE uid = ? AND category_id = ? AND archived_at IS NULL
      LIMIT 1`,
    [uid, categoryId]
  )
  if (!rows[0]) throw ledgerError('NOT_FOUND')
  if (rows[0].kind !== expectedKind) throw ledgerError('VALIDATION_ERROR')
}

async function validateTransactionRelations(connection, uid, transaction, extraAccountIds = []) {
  const accounts = await lockAccounts(connection, uid, [
    transaction.sourceAccountId,
    transaction.destinationAccountId,
    ...extraAccountIds
  ])

  if (transaction.categoryId && transaction.type !== 'refund') {
    await validateCategory(connection, uid, transaction.categoryId, transaction.type)
  }
  return accounts
}

async function lockOriginalExpense(connection, uid, transactionId) {
  validateId(transactionId)
  const [rows] = await connection.execute(
    `SELECT transaction_id AS transactionId, category_id AS categoryId,
            amount_minor AS amountMinor, occurred_local_at AS occurredLocalAt,
            occurred_at_utc AS occurredAtUtc,
            note, version
       FROM catledger_transactions
      WHERE uid = ? AND transaction_id = ? AND type = 'expense' AND deleted_at IS NULL
      LIMIT 1 FOR UPDATE`,
    [uid, transactionId]
  )
  if (!rows[0]) throw ledgerError('NOT_FOUND')
  return rows[0]
}

async function sumRefunds(connection, uid, originalTransactionId, excludeTransactionId = null) {
  const values = [uid, originalTransactionId]
  let exclude = ''
  if (excludeTransactionId) {
    exclude = ' AND transaction_id <> ?'
    values.push(excludeTransactionId)
  }
  const [[row]] = await connection.execute(
    `SELECT COALESCE(SUM(amount_minor), 0) AS refundedMinor
       FROM catledger_transactions
      WHERE uid = ? AND original_transaction_id = ? AND type = 'refund'
        AND deleted_at IS NULL${exclude}`,
    values
  )
  return BigInt(minorUnitsToString(row.refundedMinor))
}

async function prepareRefund(connection, uid, transaction, currentTransactionId = null) {
  if (transaction.type !== 'refund') return null
  if (transaction.originalTransactionId === currentTransactionId) throw ledgerError('VALIDATION_ERROR')
  const original = await lockOriginalExpense(connection, uid, transaction.originalTransactionId)
  const refundOccurredAtUtc = transaction.occurredAtUtc
  if (refundOccurredAtUtc && String(original.occurredAtUtc) > String(refundOccurredAtUtc)) {
    throw ledgerError('VALIDATION_ERROR')
  }
  const alreadyRefunded = await sumRefunds(connection, uid, original.transactionId, currentTransactionId)
  if (alreadyRefunded + BigInt(transaction.amountMinor) > BigInt(minorUnitsToString(original.amountMinor))) {
    throw ledgerError('REFUND_EXCEEDS_ORIGINAL')
  }
  transaction.categoryId = original.categoryId
  return original
}

async function protectRefundedExpense(connection, uid, current, transaction) {
  if (current.type !== 'expense') return 0n
  const refunded = await sumRefunds(connection, uid, current.transactionId)
  if (refunded === 0n) return refunded
  if (!transaction || transaction.type !== 'expense' || BigInt(transaction.amountMinor) < refunded) {
    throw ledgerError('REFUNDED_TRANSACTION_LOCKED')
  }
  return refunded
}

async function selectTransaction(connection, uid, transactionId, { forUpdate = false } = {}) {
  validateId(transactionId)
  const [rows] = await connection.execute(
    `SELECT t.transaction_id AS transactionId,
            t.type,
            t.source_account_id AS sourceAccountId,
            sa.name AS sourceAccountName,
            t.destination_account_id AS destinationAccountId,
            da.name AS destinationAccountName,
            t.category_id AS categoryId,
            c.name AS categoryName,
            c.kind AS categoryKind,
            t.original_transaction_id AS originalTransactionId,
            original.amount_minor AS originalAmountMinor,
            original.occurred_local_at AS originalOccurredLocalAt,
            original.note AS originalNote,
            t.amount_minor AS amountMinor,
            t.occurred_local_at AS occurredLocalAt,
            t.occurred_at_utc AS occurredAtUtc,
            t.timezone_offset_minutes AS timezoneOffsetMinutes,
            t.note,
            t.origin,
            t.version,
            t.deleted_at AS deletedAt
       FROM catledger_transactions t
       LEFT JOIN catledger_accounts sa
         ON sa.uid = t.uid AND sa.account_id = t.source_account_id
       LEFT JOIN catledger_accounts da
         ON da.uid = t.uid AND da.account_id = t.destination_account_id
       LEFT JOIN catledger_categories c
         ON c.uid = t.uid AND c.category_id = t.category_id
       LEFT JOIN catledger_transactions original
         ON original.uid = t.uid AND original.transaction_id = t.original_transaction_id
      WHERE t.uid = ? AND t.transaction_id = ?
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [uid, transactionId]
  )
  if (!rows[0]) throw ledgerError('NOT_FOUND')
  return rows[0]
}

function ensureEditable(row, version) {
  if (row.deletedAt != null || row.origin !== 'manual' || !MANUAL_TYPES.has(row.type)) {
    throw ledgerError('NOT_FOUND')
  }
  if (Number(row.version) !== parseVersion(version)) throw ledgerError('CONFLICT')
}

async function insertManualTransaction(connection, uid, transactionId, transaction) {
  await connection.execute(
    `INSERT INTO catledger_transactions
       (uid, transaction_id, type, source_account_id, destination_account_id,
        category_id, original_transaction_id, amount_minor, occurred_local_date, occurred_local_at,
        timezone_offset_minutes, occurred_at_utc, note, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
    [
      uid,
      transactionId,
      transaction.type,
      transaction.sourceAccountId,
      transaction.destinationAccountId,
      transaction.categoryId,
      transaction.originalTransactionId,
      transaction.amountMinor,
      transaction.localDate,
      transaction.localAt,
      transaction.timezoneOffsetMinutes,
      transaction.occurredAtUtc,
      transaction.note
    ]
  )
}

async function linkPendingRefund(connection, uid, data) {
  const transactionId = validateId(data.transactionId)
  const current = await selectTransaction(connection, uid, transactionId, { forUpdate: true })
  if (current.deletedAt != null || current.type !== 'refund' || current.originalTransactionId != null) {
    throw ledgerError('NOT_FOUND')
  }
  if (Number(current.version) !== parseVersion(data.version)) throw ledgerError('CONFLICT')
  const transaction = {
    type: 'refund',
    originalTransactionId: validateId(data.originalTransactionId),
    amountMinor: minorUnitsToString(current.amountMinor),
    occurredAtUtc: current.occurredAtUtc
  }
  const original = await prepareRefund(connection, uid, transaction, current.transactionId)
  const [updated] = await connection.execute(
    `UPDATE catledger_transactions
        SET category_id = ?, original_transaction_id = ?, version = version + 1
      WHERE uid = ? AND transaction_id = ? AND version = ? AND deleted_at IS NULL
        AND type = 'refund' AND original_transaction_id IS NULL`,
    [original.categoryId, transaction.originalTransactionId, uid, current.transactionId, data.version]
  )
  if (updated.affectedRows !== 1) throw ledgerError('CONFLICT')
  const [eventLinks] = await connection.execute(
    `SELECT update_id AS updateId, event_id AS eventId
       FROM catledger_economic_event_transactions
      WHERE uid = ? AND transaction_id = ? AND role = 'refund_transaction'
      LIMIT 1 FOR UPDATE`,
    [uid, current.transactionId]
  )
  if (eventLinks[0]) {
    await connection.execute(
      `INSERT INTO catledger_economic_event_transactions
         (uid, link_id, update_id, event_id, transaction_id, role,
          creation_method, rule_version, transaction_version)
       VALUES (?, ?, ?, ?, ?, 'refund_original', 'manual_link', 'refund-link-v1', ?)`,
      [uid, randomUUID(), eventLinks[0].updateId, eventLinks[0].eventId,
        transaction.originalTransactionId, Number(original.version)]
    )
  }
  return transactionToPublic({
    ...current,
    categoryId: original.categoryId,
    originalTransactionId: transaction.originalTransactionId,
    originalAmountMinor: original.amountMinor,
    originalOccurredLocalAt: original.occurredLocalAt,
    originalNote: original.note,
    version: Number(current.version) + 1
  })
}

function createTransactionCommandService({ getPool }) {
  async function create(context) {
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'transactions.create',
      operation: async (connection, uid, data) => {
        const transaction = buildManualTransaction(data)
        const original = await prepareRefund(connection, uid, transaction)
        const accounts = await validateTransactionRelations(connection, uid, transaction)
        await assertCashBalanceChanges(connection, uid, accounts, [{ transaction }])
        const transactionId = randomUUID()
        await insertManualTransaction(connection, uid, transactionId, transaction)
        return transactionToPublic({
          transactionId,
          ...transaction,
          originalAmountMinor: original && original.amountMinor,
          originalOccurredLocalAt: original && original.occurredLocalAt,
          originalNote: original && original.note,
          occurredLocalAt: transaction.localAt,
          version: 1
        })
      }
    })
  }

  async function update(context) {
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'transactions.update',
      operation: async (connection, uid, data) => {
        const current = await selectTransaction(connection, uid, data.transactionId, { forUpdate: true })
        ensureEditable(current, data.version)
        const transaction = buildManualTransaction(data)
        await protectRefundedExpense(connection, uid, current, transaction)
        const original = await prepareRefund(connection, uid, transaction, current.transactionId)
        const accounts = await validateTransactionRelations(connection, uid, transaction, [
          current.sourceAccountId,
          current.destinationAccountId
        ])
        await assertCashBalanceChanges(connection, uid, accounts, [
          { transaction: current, multiplier: -1n },
          { transaction }
        ])

        await connection.execute(
          `UPDATE catledger_transactions
              SET type = ?, source_account_id = ?, destination_account_id = ?, category_id = ?, original_transaction_id = ?,
                  amount_minor = ?, occurred_local_date = ?, occurred_local_at = ?,
                  timezone_offset_minutes = ?, occurred_at_utc = ?, note = ?, version = version + 1
            WHERE uid = ? AND transaction_id = ? AND version = ? AND deleted_at IS NULL`,
          [
            transaction.type,
            transaction.sourceAccountId,
            transaction.destinationAccountId,
            transaction.categoryId,
            transaction.originalTransactionId,
            transaction.amountMinor,
            transaction.localDate,
            transaction.localAt,
            transaction.timezoneOffsetMinutes,
            transaction.occurredAtUtc,
            transaction.note,
            uid,
            current.transactionId,
            data.version
          ]
        )
        if (current.type === 'expense' && transaction.type === 'expense' && current.categoryId !== transaction.categoryId) {
          await connection.execute(
            `UPDATE catledger_transactions
                SET category_id = ?, version = version + 1
              WHERE uid = ? AND original_transaction_id = ? AND type = 'refund' AND deleted_at IS NULL`,
            [transaction.categoryId, uid, current.transactionId]
          )
        }
        return transactionToPublic({
          transactionId: current.transactionId,
          ...transaction,
          originalAmountMinor: original && original.amountMinor,
          originalOccurredLocalAt: original && original.occurredLocalAt,
          originalNote: original && original.note,
          occurredLocalAt: transaction.localAt,
          version: Number(current.version) + 1
        })
      }
    })
  }

  async function linkRefund(context) {
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'transactions.linkRefund',
      operation: async (connection, uid, data) => linkPendingRefund(connection, uid, data)
    })
  }

  async function remove(context) {
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'transactions.delete',
      operation: async (connection, uid, data) => {
        const current = await selectTransaction(connection, uid, data.transactionId, { forUpdate: true })
        ensureEditable(current, data.version)
        if (current.type === 'expense') {
          await protectRefundedExpense(connection, uid, current, null)
        }
        const accounts = await lockAccounts(connection, uid, [current.sourceAccountId, current.destinationAccountId])
        await assertCashBalanceChanges(connection, uid, accounts, [
          { transaction: current, multiplier: -1n }
        ])
        await connection.execute(
          `UPDATE catledger_transactions
              SET deleted_at = CURRENT_TIMESTAMP(3), version = version + 1
            WHERE uid = ? AND transaction_id = ? AND version = ? AND deleted_at IS NULL`,
          [uid, current.transactionId, data.version]
        )
        return {
          transactionId: current.transactionId,
          deleted: true,
          version: Number(current.version) + 1
        }
      }
    })
  }

  return { create, linkRefund, remove, update }
}

module.exports = { createTransactionCommandService, linkPendingRefund }
