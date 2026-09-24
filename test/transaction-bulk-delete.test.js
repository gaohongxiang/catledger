const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call } = require('./helpers/local-services')

test('完整批量删除在隔离 MySQL 中保持整组原子性和幂等', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), subject = 'synthetic-complete-selection'
    const services = localServices({ apiPool, subject }), api = (action, data) => call(services.api, action, data)
    const user = await api('bootstrap')
    const expense = user.categories.find(row => row.kind === 'expense').id
    const income = user.categories.find(row => row.kind === 'income').id
    const account = async (type = 'bank', amount = '1000000') => (await api('accounts.create', {
      requestId: randomUUID(), type, name: '合成完整删除账户' + randomUUID().slice(0, 6), openingDisplayBalanceMinor: amount,
      occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480
    })).accountId
    const bank = await account()
    const request = rows => ({ requestId: randomUUID(), items: rows.map(({ transactionId, version }) => ({ transactionId, version })) })
    const balance = async id => (await api('accounts.list')).accounts.find(row => row.accountId === id).bookBalanceMinor
    const revision = async () => {
      const [[row]] = await lab.owner.execute('SELECT data_revision AS revision FROM catledger_users WHERE uid=?', [user.uid])
      return BigInt(row.revision)
    }
    const receipts = async () => {
      const [[row]] = await lab.owner.execute("SELECT COUNT(*) AS count FROM catledger_mutation_receipts WHERE uid=? AND action='transactions.deleteMany'", [user.uid])
      return Number(row.count)
    }
    const live = async rows => {
      const [[row]] = await lab.owner.execute(`SELECT COUNT(*) AS count FROM catledger_transactions
        WHERE uid=? AND deleted_at IS NULL AND transaction_id IN (${rows.map(() => '?').join(',')})`, [user.uid, ...rows.map(r => r.transactionId)])
      return Number(row.count)
    }
    async function seed(count, override = () => ({})) {
      const ids = Array.from({ length: count }, () => randomUUID()).sort()
      const rows = ids.map((transactionId, i) => ({ transactionId, version: 1, type: 'expense', sourceAccountId: bank,
        destinationAccountId: null, categoryId: expense, originalTransactionId: null, amountMinor: '100',
        origin: i % 2 ? 'import' : 'manual', ...override(i, ids) }))
      for (let offset = 0; offset < rows.length; offset += 100) {
        const part = rows.slice(offset, offset + 100)
        await lab.owner.execute(`INSERT INTO catledger_transactions
          (uid,transaction_id,type,source_account_id,destination_account_id,category_id,original_transaction_id,
           amount_minor,origin,occurred_local_date,occurred_local_at,timezone_offset_minutes,occurred_at_utc)
          VALUES ${part.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,
        part.flatMap(row => [user.uid, row.transactionId, row.type, row.sourceAccountId, row.destinationAccountId,
          row.categoryId, row.originalTransactionId, row.amountMinor, row.origin,
          '2026-09-05', '2026-09-05 12:00:00', -480, '2026-09-05 04:00:00']))
      }
      return rows
    }

    await t.test('1505笔手动/导入混选一次删完，并发和回执只记一次且保留未选账目', async () => {
      const rows = await seed(1506), selected = rows.slice(0, 1505), data = request(selected)
      const before = { balance: BigInt(await balance(bank)), revision: await revision(), receipts: await receipts(),
        expense: BigInt((await api('transactions.list', { month: '2026-09' })).summary.expenseMinor) }
      const other = localServices({ apiPool, subject: 'synthetic-complete-other' }); await call(other.api, 'bootstrap')
      await assert.rejects(call(other.api, 'transactions.deleteMany', data), { publicCode: 'NOT_FOUND' })
      assert.equal(await live(rows), 1506)
      const results = await Promise.all([api('transactions.deleteMany', data), api('transactions.deleteMany', data)])
      assert.deepEqual(results[0], results[1]); assert.equal(results[0].deletedCount, 1505)
      assert.deepEqual(results[0].transactionIds, selected.map(row => row.transactionId))
      assert.equal(await live(rows), 1); assert.equal(await live(rows.slice(-1)), 1)
      assert.equal(BigInt(await balance(bank)), before.balance + 150500n)
      assert.equal(BigInt((await api('transactions.list', { month: '2026-09' })).summary.expenseMinor), before.expense - 150500n)
      assert.equal(await revision(), before.revision + 1n); assert.equal(await receipts(), before.receipts + 1)
      assert.deepEqual((await api('transactions.commandResult', { requestId: data.requestId, commandAction: 'transactions.deleteMany' })).result, results[0])
    })

    await t.test('最后一块版本过期则全部保留，版本和回执均不推进', async () => {
      const rows = await seed(205), data = request(rows), before = { revision: await revision(), receipts: await receipts() }
      data.items.at(-1).version++
      await assert.rejects(api('transactions.deleteMany', data), { publicCode: 'CONFLICT' })
      assert.equal(await live(rows), rows.length)
      assert.equal(await revision(), before.revision); assert.equal(await receipts(), before.receipts)
    })

    await t.test('退款与原消费跨块仍按完整选择校验，遗漏退款整组拒绝', async () => {
      const rows = await seed(205, (i, ids) => i === 204 ? { type: 'refund', sourceAccountId: null,
        destinationAccountId: bank, originalTransactionId: ids[0], amountMinor: '50' } : {})
      await assert.rejects(api('transactions.deleteMany', request(rows.slice(0, -1))), { publicCode: 'REFUNDED_TRANSACTION_LOCKED' })
      assert.equal(await live(rows), 205)
      assert.equal((await api('transactions.deleteMany', request(rows))).deletedCount, 205)
      assert.equal(await live(rows), 0)
    })

    await t.test('跨块现金收支按整组最终余额判断，不能按块误拒绝或分开提交', async () => {
      const cash = await account('cash', '0')
      const rows = await seed(240, i => i < 120 ? { type: 'income', sourceAccountId: null, destinationAccountId: cash, categoryId: income }
        : { sourceAccountId: cash })
      assert.equal(await balance(cash), '0')
      await assert.rejects(api('transactions.deleteMany', request(rows.slice(0, 120))), { publicCode: 'INSUFFICIENT_CASH_BALANCE' })
      assert.equal(await live(rows), 240)
      assert.equal((await api('transactions.deleteMany', request(rows))).deletedCount, 240)
      assert.equal(await balance(cash), '0'); assert.equal(await live(rows), 0)
    })

    await t.test('第二块写入故障回滚第一块、回执和版本；原请求可完整重试', async () => {
      const rows = await seed(205), data = request(rows), before = { revision: await revision(), receipts: await receipts(), balance: await balance(bank) }
      let updates = 0
      const failingPool = new Proxy(apiPool, { get(target, key) {
        if (key === 'getConnection') return async () => {
          const connection = await target.getConnection()
          return new Proxy(connection, { get(conn, method) {
            if (method === 'execute') return async (sql, values) => {
              if (/UPDATE catledger_transactions\s+SET deleted_at/.test(sql) && ++updates === 2) throw new Error('synthetic second chunk failure')
              return conn.execute(sql, values)
            }
            return typeof conn[method] === 'function' ? conn[method].bind(conn) : conn[method]
          } })
        }
        return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
      } })
      const failing = localServices({ apiPool: failingPool, subject })
      await assert.rejects(call(failing.api, 'transactions.deleteMany', data), { publicCode: 'INTERNAL_ERROR' })
      assert.equal(updates, 2); assert.equal(await live(rows), 205)
      assert.equal(await revision(), before.revision); assert.equal(await receipts(), before.receipts)
      assert.equal(await balance(bank), before.balance)
      assert.equal((await api('transactions.deleteMany', data)).deletedCount, 205)
      assert.equal(await live(rows), 0)
    })
  } finally { await lab.close() }
})
