const { randomUUID } = require('node:crypto')

const { normalizeAccountName } = require('./account-name')
const { normalizeBilling } = require('./account-billing')
const { ledgerError } = require('./ledger-errors')
const { executeLedgerRead } = require('./ledger-read')
const { executeIdempotentMutation } = require('./ledger-transaction')
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
const MAX_BATCH_ACCOUNTS = 20

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

function accountToPublic(row, extra) {
  const bookBalance = BigInt(minorUnitsToString(row.bookBalance == null ? '0' : row.bookBalance))
  const isLiabilityDue = row.nature === 'liability' && bookBalance < 0n
  const balanceDirection = isLiabilityDue ? 'liability' : 'asset'
  const displayBalance = isLiabilityDue ? -bookBalance : bookBalance

  // 负债账户的「欠款」：总欠款 = 最近一期账单本期应还 + 未来未到期次分期剩余本息（读取侧聚合）。
  // 仅在传入 extra.debtMinor 时给出（列表读写路径），单账户即时返回时由调用方按需补齐。
  const debt = row.nature === 'liability' && extra && extra.debtMinor != null ? BigInt(extra.debtMinor) : null

  return {
    accountId: row.accountId,
    type: row.type,
    nature: row.nature,
    name: row.name,
    currency: row.currency,
    statementDay: row.statementDay == null ? null : Number(row.statementDay),
    repaymentDay: row.repaymentDay == null ? null : Number(row.repaymentDay),
    creditLimitMinor: row.creditLimitMinor == null ? null : minorUnitsToString(row.creditLimitMinor),
    statementDueMinor: row.statementDueMinor == null ? null : minorUnitsToString(row.statementDueMinor),
    statementMinimumMinor: row.statementMinimumMinor == null ? null : minorUnitsToString(row.statementMinimumMinor),
    statementDueDate: row.statementDueDate == null ? null : String(row.statementDueDate).slice(0, 10),
    statementCycle: row.statementCycle == null ? null : row.statementCycle,
    version: Number(row.version),
    archived: row.archivedAt != null,
    bookBalanceMinor: bookBalance.toString(),
    displayBalanceMinor: displayBalance.toString(),
    balanceDirection,
    debtMinor: debt == null ? null : debt.toString(),
    debtDirection: debt == null ? null : (debt > 0n ? 'debt' : 'paid'),
    hasStatementData: Boolean(extra && extra.hasStatementData),
    hasInstallmentPlan: Boolean(extra && extra.hasInstallmentPlan),
    needsInstallmentPlan: Boolean(extra && extra.needsInstallmentPlan)
  }
}

// 未来未到期次的分期剩余本息合计（按负债账户聚合）。
// 判据：期次 due_date 晚于该账户最近一期账单的到期还款日（账单已含还款日前的分期应还）；
// 无到期还款日时退化为晚于今天。本期账单应还额已含本期分期应还，故只加未来期次，天然防重复。
// 已还分摊按有效还款扣减（a.active=1 且 payment.status='active'），与首页「本月待还」同一口径。
const FUTURE_PERIOD_OUTSTANDING_SQL = `
  SELECT x.account_id AS accountId, COALESCE(SUM(x.outstanding), 0) AS futureMinor
    FROM (
      SELECT l.account_id AS account_id, t.uid, t.loan_id, t.principal_minor + t.interest_minor + t.fee_minor
             - COALESCE((SELECT SUM(a.principal_minor + a.interest_minor + a.fee_minor)
                           FROM catledger_loan_period_allocations a
                           JOIN catledger_loan_payments p
                             ON p.uid = a.uid AND p.payment_id = a.payment_id AND p.status = 'active'
                          WHERE a.uid = t.uid AND a.period_id = t.period_id AND a.active = 1), 0) AS outstanding
        FROM catledger_loan_periods t
        JOIN catledger_loans l ON l.uid = t.uid AND l.loan_id = t.loan_id
       WHERE t.uid = ? AND t.cancelled = 0 AND l.archived_at IS NULL AND l.deleted_at IS NULL
         AND (
           CASE WHEN EXISTS (SELECT 1 FROM catledger_installment_items i
                              WHERE i.uid = l.uid AND i.loan_id = l.loan_id AND i.active = 1)
             -- 账单锚点：该分期计划导入的账单里出现的最早期次；未来 = 比它更晚的期次（账单已含锚点及之前）。
             THEN t.period_number > (SELECT MIN(i.period_number) FROM catledger_installment_items i
                                      WHERE i.uid = l.uid AND i.loan_id = l.loan_id AND i.active = 1)
             -- 无账单来源时退回：期次到期日晚于该卡账单到期还款日（无则今天）。
             ELSE t.due_date > COALESCE((SELECT a2.statement_due_date FROM catledger_accounts a2
                                          WHERE a2.uid = l.uid AND a2.account_id = l.account_id), CURRENT_DATE)
           END)
    ) x
   WHERE x.outstanding > 0
   GROUP BY x.account_id`

async function futureInstallmentDebtByAccount(connection, uid) {  const [rows] = await connection.execute(FUTURE_PERIOD_OUTSTANDING_SQL, [uid])
  const map = new Map()
  for (const row of rows) map.set(row.accountId, String(row.futureMinor == null ? '0' : row.futureMinor))
  return map
}

// 有账单快照但没有任何生效分期计划的负债账户 ID 集合。
// 用于提示「账单可能含分期，请补建/关联分期计划，否则总欠款漏掉分期部分」。
// 仍有未处理分期来源（active 且 loan_id IS NULL，即还没归入/还没建计划）的负债账户。
// 不管是"待创建计划"还是"待归属到已有计划"，只要还有未归的账单分期就提示，避免漏算。
async function accountsMissingInstallmentPlan(connection, uid) {
  const [rows] = await connection.execute(
    `SELECT DISTINCT i.account_id AS accountId
       FROM catledger_installment_items i
       JOIN catledger_accounts a ON a.uid = i.uid AND a.account_id = i.account_id
      WHERE i.uid = ? AND i.active = 1 AND i.loan_id IS NULL
        AND a.nature = 'liability' AND a.archived_at IS NULL`,
    [uid]
  )
  return new Set(rows.map((row) => row.accountId))
}

// 有生效分期计划（贷款未删除未归档）的负债账户 ID 集合。
async function accountsWithInstallmentPlan(connection, uid) {
  const [rows] = await connection.execute(
    `SELECT DISTINCT l.account_id AS accountId
       FROM catledger_loans l
       JOIN catledger_accounts a ON a.uid = l.uid AND a.account_id = l.account_id
      WHERE l.uid = ? AND a.nature = 'liability' AND a.archived_at IS NULL
        AND l.deleted_at IS NULL AND l.archived_at IS NULL`,
    [uid]
  )
  return new Set(rows.map((row) => row.accountId))
}
async function accountToPublicWithDebt(connection, uid, row) {
  if (row.nature !== 'liability') return accountToPublic(row)
  const [futureDebt, missingPlan, hasPlan] = await Promise.all([
    futureInstallmentDebtByAccount(connection, uid),
    accountsMissingInstallmentPlan(connection, uid),
    accountsWithInstallmentPlan(connection, uid)
  ])
  const statementDue = row.statementDueMinor == null ? 0n : BigInt(minorUnitsToString(row.statementDueMinor))
  const future = BigInt(futureDebt.get(row.accountId) || '0')
  return accountToPublic(row, {
    debtMinor: (statementDue + future).toString(),
    hasStatementData: row.statementDueMinor != null,
    hasInstallmentPlan: hasPlan.has(row.accountId),
    needsInstallmentPlan: missingPlan.has(row.accountId)
  })
}

async function listAccountRows(connection, uid) {
  const [rows] = await connection.execute(
    `SELECT a.account_id AS accountId,
            a.type,
            a.nature,
            a.name,
            a.currency,
            a.statement_day AS statementDay,
            a.repayment_day AS repaymentDay,
            a.credit_limit_minor AS creditLimitMinor,
            a.statement_due_minor AS statementDueMinor,
            a.statement_minimum_minor AS statementMinimumMinor,
            a.statement_due_date AS statementDueDate,
            a.statement_cycle AS statementCycle,
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
  const liabilities = rows.filter((row) => row.nature === 'liability')
  if (!liabilities.length) return rows.map((row) => accountToPublic(row))
  const futureDebt = await futureInstallmentDebtByAccount(connection, uid)
  const missingPlan = await accountsMissingInstallmentPlan(connection, uid)
  const hasPlan = await accountsWithInstallmentPlan(connection, uid)
  return rows.map((row) => {
    if (row.nature !== 'liability') return accountToPublic(row)
    const statementDue = row.statementDueMinor == null ? 0n : BigInt(minorUnitsToString(row.statementDueMinor))
    const future = BigInt(futureDebt.get(row.accountId) || '0')
    return accountToPublic(row, {
      debtMinor: (statementDue + future).toString(),
      hasStatementData: row.statementDueMinor != null,
      hasInstallmentPlan: hasPlan.has(row.accountId),
      needsInstallmentPlan: missingPlan.has(row.accountId)
    })
  })
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
            statement_day AS statementDay,
            repayment_day AS repaymentDay,
            credit_limit_minor AS creditLimitMinor,
            statement_due_minor AS statementDueMinor,
            statement_minimum_minor AS statementMinimumMinor,
            statement_due_date AS statementDueDate,
            statement_cycle AS statementCycle,
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

function prepareNewAccount(data) {
  const type = validateAccountType(data && data.type)
  const currency = validateCurrency(data && data.currency)
  const { name, normalizedName } = normalizeAccountName(data && data.name)
  return {
    accountId: randomUUID(),
    type,
    nature: ACCOUNT_TYPES[type],
    name,
    normalizedName,
    currency,
    ...normalizeBilling(data, ACCOUNT_TYPES[type])
  }
}

async function insertAccounts(connection, uid, accounts) {
  const placeholders = accounts.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
  const values = accounts.flatMap((account) => [
    uid,
    account.accountId,
    account.type,
    account.nature,
    account.name,
    account.normalizedName,
    account.currency,
    account.statementDay,
    account.repaymentDay,
    account.creditLimitMinor,
    account.statementDueMinor,
    account.statementMinimumMinor,
    account.statementDueDate,
    account.statementCycle
  ])
  try {
    await connection.execute(
      `INSERT INTO catledger_accounts
         (uid, account_id, type, nature, name, normalized_name, currency, statement_day, repayment_day, credit_limit_minor,
          statement_due_minor, statement_minimum_minor, statement_due_date, statement_cycle)
       VALUES ${placeholders}`,
      values
    )
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') throw ledgerError('CONFLICT')
    throw error
  }
}

function zeroBalancePublicAccount(account) {
  return accountToPublic({
    ...account,
    version: 1,
    archivedAt: null,
    bookBalance: '0'
  }, account.nature === 'liability' ? { debtMinor: '0', needsInstallmentPlan: false } : undefined)
}

function createAccountService({ getPool }) {
  async function list({ provider, subjectHash, read }) {
    return executeLedgerRead({
      getPool,
      provider,
      subjectHash,
      read,
      operation: async (connection, uid) => ({ accounts: await listAccountsForUser(connection, uid), liabilitySettingsVersion: 1 })
    })
  }

  async function create(context) {
    return executeIdempotentMutation({
      getPool,
      currentReads: true,
      ...context,
      action: 'accounts.create',
      operation: async (connection, uid, data) => {
        const account = prepareNewAccount(data)
        const openingDisplayBalance = parseMinorUnits(
          data.openingDisplayBalanceMinor == null ? '0' : data.openingDisplayBalanceMinor,
          { allowZero: true }
        )
        await insertAccounts(connection, uid, [account])

        const targetBookBalance = account.nature === 'liability'
          ? -openingDisplayBalance
          : openingDisplayBalance
        if (targetBookBalance !== 0n) {
          await insertBalanceAdjustment(connection, {
            uid,
            accountId: account.accountId,
            delta: targetBookBalance,
            occurredLocalAt: data.occurredLocalAt,
            timezoneOffsetMinutes: data.timezoneOffsetMinutes
          })
        }

        return accountToPublicWithDebt(connection, uid, {
          ...account,
          version: 1,
          archivedAt: null,
          bookBalance: targetBookBalance.toString()
        })
      }
    })
  }

  async function createBatch(context) {
    return executeIdempotentMutation({
      getPool,
      currentReads: true,
      ...context,
      action: 'accounts.createBatch',
      operation: async (connection, uid, data) => {
        if (!data || !Array.isArray(data.accounts) || data.accounts.length < 1 || data.accounts.length > MAX_BATCH_ACCOUNTS) {
          throw ledgerError('VALIDATION_ERROR')
        }
        const accounts = data.accounts.map(prepareNewAccount)
        const normalizedNames = new Set()
        for (const account of accounts) {
          if (normalizedNames.has(account.normalizedName)) throw ledgerError('CONFLICT')
          normalizedNames.add(account.normalizedName)
        }
        await insertAccounts(connection, uid, accounts)
        return { accounts: accounts.map(zeroBalancePublicAccount) }
      }
    })
  }

  async function update(context) {
    return executeIdempotentMutation({
      getPool,
      currentReads: true,
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
        const { name, normalizedName } = normalizeAccountName(data.name === undefined ? current.name : data.name)
        const billing = normalizeBilling(data, current.nature, current)

        try {
          await connection.execute(
            `UPDATE catledger_accounts
                SET name = ?, normalized_name = ?, statement_day = ?, repayment_day = ?, credit_limit_minor = ?,
                    statement_due_minor = ?, statement_minimum_minor = ?, statement_due_date = ?, statement_cycle = ?,
                    version = version + 1
              WHERE uid = ? AND account_id = ? AND version = ?`,
            [name, normalizedName, billing.statementDay, billing.repaymentDay, billing.creditLimitMinor,
              billing.statementDueMinor, billing.statementMinimumMinor, billing.statementDueDate, billing.statementCycle,
              uid, current.accountId, version]
          )
        } catch (error) {
          if (error && error.code === 'ER_DUP_ENTRY') {
            throw ledgerError('CONFLICT')
          }
          throw error
        }

        const bookBalance = await queryBookBalance(connection, uid, current.accountId)
        return accountToPublicWithDebt(connection, uid, {
          ...current,
          name,
          ...billing,
          version: version + 1,
          bookBalance: bookBalance.toString()
        })
      }
    })
  }

  async function archive(context) {
    return executeIdempotentMutation({
      getPool,
      currentReads: true,
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
        return accountToPublicWithDebt(connection, uid, {
          ...current,
          version: version + 1,
          archivedAt: new Date(),
          bookBalance: bookBalance.toString()
        })
      }
    })
  }

  async function restore(context) {
    return executeIdempotentMutation({
      getPool,
      currentReads: true,
      ...context,
      action: 'accounts.restore',
      operation: async (connection, uid, data) => {
        const current = await lockAccount(connection, uid, data.accountId)
        const version = parseVersion(data.version)
        if (Number(current.version) !== version) throw ledgerError('CONFLICT')
        const archived = current.archivedAt != null
        if (archived) {
          try {
            await connection.execute(
              `UPDATE catledger_accounts
                  SET archived_at = NULL, version = version + 1
                WHERE uid = ? AND account_id = ? AND version = ?`,
              [uid, current.accountId, version]
            )
          } catch (error) {
            if (error && error.code === 'ER_DUP_ENTRY') throw ledgerError('ACCOUNT_NAME_CONFLICT')
            throw error
          }
        }
        const bookBalance = await queryBookBalance(connection, uid, current.accountId)
        return accountToPublicWithDebt(connection, uid, {
          ...current,
          version: version + (archived ? 1 : 0),
          archivedAt: null,
          bookBalance: bookBalance.toString()
        })
      }
    })
  }

  async function correctBalance(context) {
    return executeIdempotentMutation({
      getPool,
      currentReads: true,
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

        return accountToPublicWithDebt(connection, uid, {
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
    createBatch,
    list,
    restore,
    update
  }
}

module.exports = {
  ACCOUNT_TYPES,
  MAX_BATCH_ACCOUNTS,
  accountToPublic,
  accountsMissingInstallmentPlan,
  createAccountService,
  listAccountsForUser
}
