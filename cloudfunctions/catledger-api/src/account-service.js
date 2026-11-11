const { randomUUID } = require('node:crypto')

const { normalizeAccountName } = require('./account-name')
const { normalizeBilling } = require('./account-billing')
const { ledgerError } = require('./ledger-errors')
const { executeLedgerRead } = require('./ledger-read')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { parseLocalDateTime } = require('./local-time')
const { minorUnitsToString, parseMinorUnits } = require('./money')
const { accountTotals } = require('./net-worth')

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
  const version = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(version) || version < 1) {
    throw ledgerError('VALIDATION_ERROR')
  }
  return version
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

// 账单归属月（YYYY-MM）：优先到期还款日，其次账单周期结束日，最后退回该账户分期来源最晚发生日。
// 用于前端「本期账单 · 2026年X月」的标题，避免"本期"被误当最新一期；都取不到返回 null（不显示月份）。
function accountStatementMonth(row, extra) {
  const ymd = value => {
    const m = String(value == null ? '' : value).match(/^(\d{4})-?(\d{2})-?(\d{2})/)
    return m ? m[1] + '-' + m[2] : null
  }
  const due = ymd(row.statementDueDate)
  if (due) return due
  const cycle = row.statementCycle ? String(row.statementCycle) : ''
  const cycleEnd = cycle.split('-')[1]
  const fromCycle = ymd(cycleEnd)
  if (fromCycle) return fromCycle
  const fromSource = ymd(extra && extra.latestSourceDate)
  return fromSource || null
}

function accountToPublic(row, extra) {
  const bookBalance = BigInt(minorUnitsToString(row.bookBalance == null ? '0' : row.bookBalance))
  const isLiabilityDue = row.nature === 'liability' && bookBalance < 0n
  const balanceDirection = isLiabilityDue ? 'liability' : 'asset'
  const displayBalance = isLiabilityDue ? -bookBalance : bookBalance

  // 负债账户的「欠款」：总欠款 = 最近一期账单本期应还 + 未来未到期次分期剩余本息（读取侧聚合）。
  // 仅在传入 extra.debtMinor 时给出（列表读写路径），单账户即时返回时由调用方按需补齐。
  const debt = row.nature === 'liability' && extra && extra.debtMinor != null ? BigInt(extra.debtMinor) : null
  // 该账户所有分期计划的全期总利息（含已还）。仅负债账户、且传入了 totalInterestMinor 时给出。
  const totalInterest = row.nature === 'liability' && extra && extra.totalInterestMinor != null ? BigInt(extra.totalInterestMinor) : null

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
    statementMonth: accountStatementMonth(row, extra),
    version: Number(row.version),
    archived: row.archivedAt != null,
    bookBalanceMinor: bookBalance.toString(),
    displayBalanceMinor: displayBalance.toString(),
    balanceDirection,
    debtMinor: debt == null ? null : debt.toString(),
    debtDirection: debt == null ? null : (debt > 0n ? 'debt' : 'paid'),
    installmentTotalInterestMinor: totalInterest == null ? null : totalInterest.toString(),
    hasStatementData: Boolean(extra && extra.hasStatementData),
    hasInstallmentPlan: Boolean(extra && extra.hasInstallmentPlan),
    needsInstallmentPlan: Boolean(extra && extra.needsInstallmentPlan)
  }
}

// 各负债账户「各分期计划未还期次本息费」合计。
// 与贷款详情/逐期表同一口径：复用 buildView 的未还汇总（按账单锚点+进度动态算），
// 不再维护一套独立的 SQL 边界判断，避免账户页与详情页两个数字打架（定稿第七节）。
async function futureInstallmentDebtByAccount(connection, uid) {
  return require('./installment-service').unpaidDebtByAccount(connection, uid)
}

// 每个负债账户的「分期来源最晚发生日」（accountId -> 'YYYY-MM-DD'）。
// 仅在账户没有到期还款日/账单周期时，用于兜底推算「本期账单」的归属月。
async function latestSourceDateByAccount(connection, uid) {
  const [rows] = await connection.execute(
    `SELECT i.account_id AS accountId, MAX(i.occurred_date) AS latestDate
       FROM catledger_installment_items i
       JOIN catledger_accounts a ON a.uid = i.uid AND a.account_id = i.account_id
      WHERE i.uid = ? AND i.active = 1 AND i.occurred_date IS NOT NULL
        AND a.nature = 'liability' AND a.archived_at IS NULL
      GROUP BY i.account_id`,
    [uid]
  )
  const map = new Map()
  for (const row of rows) map.set(row.accountId, row.latestDate == null ? null : String(row.latestDate).slice(0, 10))
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
  const [futureDebt, missingPlan, hasPlan, latestSource] = await Promise.all([
    futureInstallmentDebtByAccount(connection, uid),
    accountsMissingInstallmentPlan(connection, uid),
    accountsWithInstallmentPlan(connection, uid),
    latestSourceDateByAccount(connection, uid)
  ])
  const statementDue = row.statementDueMinor == null ? 0n : BigInt(minorUnitsToString(row.statementDueMinor))
  const future = BigInt(futureDebt.get(row.accountId) || '0')
  return accountToPublic(row, {
    debtMinor: (statementDue + future).toString(),
    hasStatementData: row.statementDueMinor != null,
    hasInstallmentPlan: hasPlan.has(row.accountId),
    needsInstallmentPlan: missingPlan.has(row.accountId),
    latestSourceDate: latestSource.get(row.accountId) || null
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
  const latestSource = await latestSourceDateByAccount(connection, uid)
  const totalInterest = await require('./installment-service').totalInterestByAccount(connection, uid)
  return rows.map((row) => {
    if (row.nature !== 'liability') return accountToPublic(row)
    const statementDue = row.statementDueMinor == null ? 0n : BigInt(minorUnitsToString(row.statementDueMinor))
    const future = BigInt(futureDebt.get(row.accountId) || '0')
    return accountToPublic(row, {
      debtMinor: (statementDue + future).toString(),
      totalInterestMinor: totalInterest.get(row.accountId) || '0',
      hasStatementData: row.statementDueMinor != null,
      hasInstallmentPlan: hasPlan.has(row.accountId),
      needsInstallmentPlan: missingPlan.has(row.accountId),
      latestSourceDate: latestSource.get(row.accountId) || null
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

// ── 账户彻底删除的依赖模型 ────────────────────────────────────────────────
// 删除一个账户 = 一个事务内按「依赖链」把属于它的数据清干净。分三类：
//
// 1. 硬阻塞（HARD_ACCOUNT_BLOCKERS）：账户被贷款/分期/还款/费用合同/导入映射等真实业务引用。
//    这些数据离开账户无法自洽，必须保留——存在即只允许归档，绝不级联删除。
// 2. 可级联清理的流水（PURGEABLE_TRANSACTION）：余额调整（期初/校正，无真实收支）或已软删除的记录。
//    它们属于账户自身，账户消亡后无意义，连同其「溯源链接」（economic_event / import 链接）一并删除。
// 3. 真实流水（正常收支/转账/退款）：阻止删除（用户应先自行删流水），不静默吞掉。
//
// 表名与迁移里的 ON DELETE RESTRICT 外键一一对应；新增引用账户/流水的表须同步补到这里。
const HARD_ACCOUNT_BLOCKERS = Object.freeze([
  ['catledger_import_account_mappings', 'account_id'],
  ['catledger_loans', 'account_id'],
  ['catledger_loan_payments', 'asset_account_id'],
  ['catledger_loan_repayment_details', 'liability_account_id'],
  ['catledger_installment_bindings', 'account_id'],
  ['catledger_installment_items', 'account_id'],
  ['catledger_loan_charge_contracts', 'account_id']
])

// 引用「可级联清理流水」的溯源链接表（表, 引用交易的列）。删除账户时先删这些链接再删流水。
// 注意：catledger_import_transaction_links / catledger_import_decisions 已在迁移 0012 中删除，勿再引用。
const PURGEABLE_TRANSACTION_LINKS = Object.freeze([
  ['catledger_economic_event_transactions', 'transaction_id']
])

// 引用「可级联清理流水」的硬依赖表（贷款还款/被替换/分期/费用）：出现即说明该流水其实牵涉真实贷款，
// 不能当余额调整一删了之，整体阻止删除。
const PURGEABLE_TRANSACTION_BLOCKERS = Object.freeze([
  ['catledger_loan_payment_transactions', 'transaction_id'],
  ['catledger_loan_replaced_transactions', 'transaction_id'],
  ['catledger_installment_items', 'transaction_id'],
  ['catledger_loan_charges', 'transaction_id'],
  ['catledger_loan_charges', 'balance_adjustment_id']
])

const CHUNK = 200
function placeholders(count) { return new Array(count).fill('?').join(', ') }
async function countWhereIn(connection, uid, table, column, ids) {
  let total = 0
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK)
    const [[row]] = await connection.execute(
      `SELECT COUNT(*) AS n FROM ${table} WHERE uid = ? AND ${column} IN (${placeholders(part.length)})`,
      [uid, ...part]
    )
    total += Number(row.n)
  }
  return total
}

// 返回该账户可级联清理的流水 ID（余额调整或已软删除）。真实收支不在其中。
async function purgeableTransactionIds(connection, uid, accountId) {
  const [rows] = await connection.execute(
    `SELECT transaction_id AS id FROM catledger_transactions
      WHERE uid = ? AND (source_account_id = ? OR destination_account_id = ?)
        AND (type = 'balance_adjustment' OR deleted_at IS NOT NULL)`,
    [uid, accountId, accountId]
  )
  return rows.map(row => row.id)
}

// 该账户是否存在「真实流水」（非余额调整、未软删除）。存在则不能彻底删除。
async function countRealTransactions(connection, uid, accountId) {
  const [[row]] = await connection.execute(
    `SELECT COUNT(*) AS n FROM catledger_transactions
      WHERE uid = ? AND (source_account_id = ? OR destination_account_id = ?)
        AND type <> 'balance_adjustment' AND deleted_at IS NULL`,
    [uid, accountId, accountId]
  )
  return Number(row.n)
}

// 账户级硬阻塞：任一表有行即返回该表名（用于结构化失败原因）；无则 null。
async function firstAccountBlocker(connection, uid, accountId) {
  for (const [table, column] of HARD_ACCOUNT_BLOCKERS) {
    try {
      const [[row]] = await connection.execute(
        `SELECT COUNT(*) AS n FROM ${table} WHERE uid = ? AND ${column} = ?`,
        [uid, accountId]
      )
      if (Number(row.n) > 0) return table
    } catch (error) {
      if (error && (error.code === 'ER_TABLEACCESS_DENIED_ERROR' || error.code === 'ER_NO_SUCH_TABLE')) continue
      throw error
    }
  }
  return null
}

// 可级联流水是否被真实贷款/分期/费用引用；有则返回表名否则 null。
async function firstTransactionBlocker(connection, uid, ids) {
  if (!ids.length) return null
  for (const [table, column] of PURGEABLE_TRANSACTION_BLOCKERS) {
    if (await countWhereIn(connection, uid, table, column, ids) > 0) return table
  }
  return null
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
      operation: async (connection, uid) => {
        const accounts = await listAccountsForUser(connection, uid)
        // 净资产汇总走唯一真源（只算未归档），与 dashboard.get 同口径。
        return { accounts, liabilitySettingsVersion: 1, totals: accountTotals(accounts) }
      }
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

  // 彻底删除账户：仅当该账户没有任何流水或关联记录时允许。
  // 有流水/分期/贷款/导入映射等依赖的账户只能归档（archived），不能删——否则会断账或留下孤儿记录。
  // 数据库侧所有外键均为 ON DELETE RESTRICT，是最后一道防线；这里先做可读的检查给出明确错误码。
  // 彻底删除账户：一个事务内按依赖链清理属于账户自身的数据。
  // 结构：
  //   1) 若有真实收支/转账/退款流水 → 阻止（用户需自行先删流水）。错误码 ACCOUNT_HAS_RECORDS，前端给内联删除入口。
  //   2) 若可级联流水被贷款/分期/费用引用 → 阻止（ACCOUNT_HAS_RECORDS），这些账户只能归档。
  //   3) 若账户被贷款/分期/还款/费用合同/导入映射引用 → 阻止（ACCOUNT_HAS_LOANS），只能归档。
  //   4) 否则：删溯源链接（economic_event / import）→ 删余额调整与已软删除流水 → 删账户，全部在同一事务。
  async function remove(context) {
    return executeIdempotentMutation({
      getPool,
      currentReads: true,
      ...context,
      action: 'accounts.remove',
      operation: async (connection, uid, data) => {
        const current = await lockAccount(connection, uid, data.accountId)
        const version = parseVersion(data.version)
        if (Number(current.version) !== version) throw ledgerError('CONFLICT')
        const accountId = current.accountId

        // 1) 真实流水存在 → 不可删，交由前端内联删除。
        if (await countRealTransactions(connection, uid, accountId) > 0) throw ledgerError('ACCOUNT_HAS_RECORDS')
        // 2) 账户级硬阻塞（贷款/分期/还款等）→ 只能归档。
        const accountBlocker = await firstAccountBlocker(connection, uid, accountId)
        if (accountBlocker) throw ledgerError('ACCOUNT_HAS_LOANS')
        // 3) 可级联流水若被真实贷款/费用引用 → 只能归档。
        const purgeIds = await purgeableTransactionIds(connection, uid, accountId)
        const txBlocker = await firstTransactionBlocker(connection, uid, purgeIds)
        if (txBlocker) throw ledgerError('ACCOUNT_HAS_LOANS')

        try {
          if (purgeIds.length) {
            // 3a) 先断溯源链接（这些链接只指向本条流水，账户消亡后其追溯也随之中止）。
            for (const [table, column] of PURGEABLE_TRANSACTION_LINKS) {
              for (let i = 0; i < purgeIds.length; i += CHUNK) {
                const part = purgeIds.slice(i, i + CHUNK)
                try {
                  await connection.execute(
                    `DELETE FROM ${table} WHERE uid = ? AND ${column} IN (${placeholders(part.length)})`,
                    [uid, ...part]
                  )
                } catch (error) {
                  if (error && (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_TABLEACCESS_DENIED_ERROR')) continue
                  throw error
                }
              }
            }
            // 3b) 删可级联流水（余额调整 / 已软删除）。
            for (let i = 0; i < purgeIds.length; i += CHUNK) {
              const part = purgeIds.slice(i, i + CHUNK)
              await connection.execute(
                `DELETE FROM catledger_transactions WHERE uid = ? AND transaction_id IN (${placeholders(part.length)})`,
                [uid, ...part]
              )
            }
          }
          // 3c) 删账户本身。
          await connection.execute(
            `DELETE FROM catledger_accounts WHERE uid = ? AND account_id = ? AND version = ?`,
            [uid, accountId, version]
          )
        } catch (error) {
          // 并发下若检查后新插入了依赖行，外键 RESTRICT 会拦住；按"仍有记录"处理，事务整体回滚。
          if (error && (error.code === 'ER_ROW_IS_REFERENCED_2' || error.code === 'ER_ROW_IS_REFERENCED')) {
            throw ledgerError('ACCOUNT_HAS_RECORDS')
          }
          throw error
        }
        return accountToPublic(current)
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
    remove,
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
