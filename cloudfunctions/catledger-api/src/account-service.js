const { randomUUID } = require('node:crypto')

const { normalizeAccountName } = require('./account-name')
const { ledgerError } = require('./ledger-errors')
const { executeIdempotentMutation, resolveUid } = require('./ledger-transaction')
const { parseLocalDateTime } = require('./local-time')
const { minorUnitsToString, parseMinorUnits } = require('./money')

const ACCOUNT_TYPES = Object.freeze({
  cash: 'asset',
  bank: 'asset',
  wallet: 'asset',
  credit: 'liability',
  other_asset: 'asset',
  other_liability: 'liability'
})

function parseVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw ledgerError('VALIDATION_ERROR')
  }
  return value
}

function validateAccountType(value) {
  if (!Object.prototype.hasOwnProperty.call(ACCOUNT_TYPES, value)) {
    throw ledgerError('VALIDATION_ERROR')
  }
  return value
}

function validateCurrency(value = 'CNY') {
  if (value !== 'CNY') {
    throw ledgerError('UNSUPPORTED_CURRENCY')
  }
  return value
}

function accountToPublic(row) {
  const bookBalance = BigInt(minorUnitsToString(row.bookBalance == null ? '0' : row.bookBalance))
  const balanceDirection = bookBalance < 0n ? 'liability' : 'asset'
  const displayBalance = bookBalance < 0n ? -bookBalance : bookBalance

  return {
    accountId: row.accountId,
    type: row.type,
    nature: row.nature,
    name: row.name,
    currency: row.currency,
    version: Number(row.version),
    archived: row.archivedAt != null,
    bookBalanceMinor: bookBalance.toString(),
    displayBalanceMinor: displayBalance.toString(),
    balanceDirection
  }
}

async function listAccountRows(connection, uid) {
  const [rows] = await connection.execute(
    `SELECT a.account_id AS accountId,
            a.type,
            a.nature,
            a.name,
            a.currency,
            a.version,
            a.archived_at AS archivedAt,
            COALESCE(b.book_balance, 0) AS bookBalance
       FROM catledger_accounts a
       LEFT JOIN (
         SELECT entries.uid,
                entries.account_id,
                SUM(entries.delta_minor) AS book_balance
           FROM (
             SELECT uid,
                    destination_account_id AS account_id,
                    CAST(amount_minor AS DECIMAL(20, 0)) AS delta_minor
               FROM catledger_transactions
              WHERE uid = ? AND destination_account_id IS NOT NULL AND deleted_at IS NULL
             UNION ALL
             SELECT uid,
                    source_account_id AS account_id,
                    -CAST(amount_minor AS DECIMAL(20, 0)) AS delta_minor
               FROM catledger_transactions
              WHERE uid = ? AND source_account_id IS NOT NULL AND deleted_at IS NULL
           ) entries
          GROUP BY entries.uid, entries.account_id
       ) b ON b.uid = a.uid AND b.account_id = a.account_id
      WHERE a.uid = ?
      ORDER BY a.archived_at IS NOT NULL, a.nature, a.created_at, a.account_id`,
    [uid, uid, uid]
  )
  return rows
}

async function listAccountsForUser(connection, uid) {
  const rows = await listAccountRows(connection, uid)
  return rows.map(accountToPublic)
}

async function lockAccount(connection, uid, accountId) {
  if (typeof accountId !== 'string' || accountId.length > 64) {
    throw ledgerError('VALIDATION_ERROR')
  }

  const [rows] = await connection.execute(
    `SELECT account_id AS accountId,
            type,
            nature,
            name,
            currency,
            version,
            archived_at AS archivedAt
       FROM catledger_accounts
      WHERE uid = ? AND account_id = ?
      LIMIT 1
      FOR UPDATE`,
    [uid, accountId]
  )

  if (!rows[0]) {
    throw ledgerError('NOT_FOUND')
  }
  return rows[0]
}

async function queryBookBalance(connection, uid, accountId) {
  const [[row]] = await connection.execute(
    `SELECT COALESCE(SUM(entries.delta_minor), 0) AS bookBalance
       FROM (
         SELECT CAST(amount_minor AS DECIMAL(20, 0)) AS delta_minor
           FROM catledger_transactions
          WHERE uid = ? AND destination_account_id = ? AND deleted_at IS NULL
         UNION ALL
         SELECT -CAST(amount_minor AS DECIMAL(20, 0)) AS delta_minor
           FROM catledger_transactions
          WHERE uid = ? AND source_account_id = ? AND deleted_at IS NULL
       ) entries`,
    [uid, accountId, uid, accountId]
  )
  return BigInt(minorUnitsToString(row.bookBalance))
}

async function insertBalanceAdjustment(connection, {
  uid,
  accountId,
  delta,
  occurredLocalAt,
  timezoneOffsetMinutes
}) {
  if (delta === 0n) {
    throw ledgerError('VALIDATION_ERROR')
  }

  const time = parseLocalDateTime(occurredLocalAt, timezoneOffsetMinutes)
  const sourceAccountId = delta < 0n ? accountId : null
  const destinationAccountId = delta > 0n ? accountId : null
  const amountMinor = delta < 0n ? -delta : delta

  await connection.execute(
    `INSERT INTO catledger_transactions
       (uid, transaction_id, type, source_account_id, destination_account_id,
        category_id, amount_minor, occurred_local_date, occurred_local_at,
        timezone_offset_minutes, occurred_at_utc, note, origin)
     VALUES (?, ?, 'balance_adjustment', ?, ?, NULL, ?, ?, ?, ?, ?, NULL, 'system')`,
    [
      uid,
      randomUUID(),
      sourceAccountId,
      destinationAccountId,
      amountMinor.toString(),
      time.localDate,
      time.localAt,
      time.timezoneOffsetMinutes,
      time.occurredAtUtc
    ]
  )
}

function createAccountService({ getPool }) {
  async function list({ provider, subjectHash }) {
    const connection = await getPool().getConnection()
    try {
      const uid = await resolveUid(connection, provider, subjectHash)
      return { accounts: await listAccountsForUser(connection, uid) }
    } finally {
      connection.release()
    }
  }

  async function create(context) {
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'accounts.create',
      operation: async (connection, uid, data) => {
        const type = validateAccountType(data.type)
        const nature = ACCOUNT_TYPES[type]
        const currency = validateCurrency(data.currency)
        const { name, normalizedName } = normalizeAccountName(data.name)
        const openingDisplayBalance = parseMinorUnits(
          data.openingDisplayBalanceMinor == null ? '0' : data.openingDisplayBalanceMinor,
          { allowZero: true }
        )
        const accountId = randomUUID()

        try {
          await connection.execute(
            `INSERT INTO catledger_accounts
               (uid, account_id, type, nature, name, normalized_name, currency)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [uid, accountId, type, nature, name, normalizedName, currency]
          )
        } catch (error) {
          if (error && error.code === 'ER_DUP_ENTRY') {
            throw ledgerError('CONFLICT')
          }
          throw error
        }

        const targetBookBalance = nature === 'liability'
          ? -openingDisplayBalance
          : openingDisplayBalance
        if (targetBookBalance !== 0n) {
          await insertBalanceAdjustment(connection, {
            uid,
            accountId,
            delta: targetBookBalance,
            occurredLocalAt: data.occurredLocalAt,
            timezoneOffsetMinutes: data.timezoneOffsetMinutes
          })
        }

        return accountToPublic({
          accountId,
          type,
          nature,
          name,
          currency,
          version: 1,
          archivedAt: null,
          bookBalance: targetBookBalance.toString()
        })
      }
    })
  }

  async function update(context) {
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'accounts.update',
      operation: async (connection, uid, data) => {
        const current = await lockAccount(connection, uid, data.accountId)
        if (current.archivedAt != null) {
          throw ledgerError('ACCOUNT_INACTIVE')
        }
        const version = parseVersion(data.version)
        if (Number(current.version) !== version) {
          throw ledgerError('CONFLICT')
        }
        const { name, normalizedName } = normalizeAccountName(data.name)

        try {
          await connection.execute(
            `UPDATE catledger_accounts
                SET name = ?, normalized_name = ?, version = version + 1
              WHERE uid = ? AND account_id = ? AND version = ?`,
            [name, normalizedName, uid, current.accountId, version]
          )
        } catch (error) {
          if (error && error.code === 'ER_DUP_ENTRY') {
            throw ledgerError('CONFLICT')
          }
          throw error
        }

        const bookBalance = await queryBookBalance(connection, uid, current.accountId)
        return accountToPublic({
          ...current,
          name,
          version: version + 1,
          bookBalance: bookBalance.toString()
        })
      }
    })
  }

  async function archive(context) {
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'accounts.archive',
      operation: async (connection, uid, data) => {
        const current = await lockAccount(connection, uid, data.accountId)
        if (current.archivedAt != null) {
          throw ledgerError('ACCOUNT_INACTIVE')
        }
        const version = parseVersion(data.version)
        if (Number(current.version) !== version) {
          throw ledgerError('CONFLICT')
        }

        await connection.execute(
          `UPDATE catledger_accounts
              SET archived_at = CURRENT_TIMESTAMP(3), version = version + 1
            WHERE uid = ? AND account_id = ? AND version = ?`,
          [uid, current.accountId, version]
        )
        const bookBalance = await queryBookBalance(connection, uid, current.accountId)
        return accountToPublic({
          ...current,
          version: version + 1,
          archivedAt: new Date(),
          bookBalance: bookBalance.toString()
        })
      }
    })
  }

  async function correctBalance(context) {
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'accounts.correctBalance',
      operation: async (connection, uid, data) => {
        const current = await lockAccount(connection, uid, data.accountId)
        if (current.archivedAt != null) {
          throw ledgerError('ACCOUNT_INACTIVE')
        }

        const displayBalance = parseMinorUnits(data.displayBalanceMinor, { allowZero: true })
        const targetBookBalance = current.nature === 'liability'
          ? -displayBalance
          : displayBalance
        const currentBookBalance = await queryBookBalance(connection, uid, current.accountId)
        const delta = targetBookBalance - currentBookBalance
        await insertBalanceAdjustment(connection, {
          uid,
          accountId: current.accountId,
          delta,
          occurredLocalAt: data.occurredLocalAt,
          timezoneOffsetMinutes: data.timezoneOffsetMinutes
        })

        return accountToPublic({
          ...current,
          bookBalance: targetBookBalance.toString()
        })
      }
    })
  }

  return {
    archive,
    correctBalance,
    create,
    list,
    update
  }
}

module.exports = {
  ACCOUNT_TYPES,
  accountToPublic,
  createAccountService,
  listAccountsForUser
}
