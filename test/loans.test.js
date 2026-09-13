const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call } = require('./helpers/local-services')
const hasDatabase = Boolean(process.env.CATLEDGER_TEST_DB_HOST)

test('贷款资料不写总账，已知零与未知、分页隔离和幂等版本均可核对', { skip: !hasDatabase }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    const first = localServices({ apiPool, importPool, subject: 'synthetic-loan-a' })
    const other = localServices({ apiPool, importPool, subject: 'synthetic-loan-b' })
    const identity = await call(first.api, 'bootstrap'); await call(other.api, 'bootstrap')
    const debt = await call(first.api, 'accounts.create', { requestId: randomUUID(), name: '合成负债', type: 'other_liability', currency: 'CNY',
      openingDisplayBalanceMinor: '100000', occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })
    const before = await call(first.api, 'accounts.list')
    const [[countBefore]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid=?', [identity.uid])
    const payload = { requestId: randomUUID(), name: '合成借款甲', institution: '合成机构', kind: 'borrowing', accountId: debt.accountId,
      baselinePrincipalMinor: null, baselineDate: null, startDate: null, endDate: null, repaymentMethod: null }
    let unknown, zero
    await t.test('资料创建和重放只生成一个贷款，不修改已有负债或正式交易', async () => {
      unknown = await call(first.api, 'loans.create', payload)
      assert.deepEqual(await call(first.api, 'loans.create', payload), unknown)
      assert.equal(unknown.version, 1)
      const view = await call(first.api, 'loans.get', { loanId: unknown.loanId })
      assert.equal(view.loan.remainingPrincipalMinor, null)
      assert.equal(view.loan.status, 'unknown')
      assert.deepEqual(await call(first.api, 'accounts.list'), before)
      const [[after]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid=?', [identity.uid])
      assert.equal(after.count, countBefore.count)
      const receipt = await call(first.api, 'transactions.commandResult', { requestId: payload.requestId, commandAction: 'loans.create' })
      assert.deepEqual(receipt.result, unknown)
    })
    await t.test('同一账户允许多贷款，明确零不按未知展示', async () => {
      zero = await call(first.api, 'loans.create', { ...payload, requestId: randomUUID(), name: '合成借款乙', baselinePrincipalMinor: '0', baselineDate: '2026-09-01' })
      assert.notEqual(zero.loanId, unknown.loanId)
      const view = await call(first.api, 'loans.get', { loanId: zero.loanId })
      assert.equal(view.loan.remainingPrincipalMinor, '0')
      assert.equal(view.loan.status, 'settled')
    })
    await t.test('分页签名不跨用户，列表与详情拒绝越权', async () => {
      const firstPage = await call(first.api, 'loans.list', { pageSize: 1 })
      assert.equal(firstPage.items.length, 1); assert.ok(firstPage.nextCursor)
      const second = await call(first.api, 'loans.list', { pageSize: 1, cursor: firstPage.nextCursor })
      assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null)
      assert.notEqual(firstPage.items[0].loanId, second.items[0].loanId)
      assert.deepEqual((await call(other.api, 'loans.list')).items, [])
      await assert.rejects(call(other.api, 'loans.get', { loanId: unknown.loanId }), { publicCode: 'NOT_FOUND' })
      await assert.rejects(call(other.api, 'loans.list', { cursor: firstPage.nextCursor }), { publicCode: 'VALIDATION_ERROR' })
      await assert.rejects(call(first.api, 'loans.list', { pageSize: 41 }), { publicCode: 'VALIDATION_ERROR' })
      assert.ok(Buffer.byteLength(JSON.stringify(firstPage)) < 8192)
    })
    await t.test('版本竞争只有一次生效，不能通过资料接口修改账户余额', async () => {
      const changes = await Promise.allSettled(['新名称甲','新名称乙'].map(name => call(first.api, 'loans.update', {
        ...payload, requestId: randomUUID(), loanId: unknown.loanId, version: 1, name, baselinePrincipalMinor: '80000', baselineDate: '2026-09-01'
      })))
      assert.equal(changes.filter(x => x.status === 'fulfilled').length, 1)
      assert.equal(changes.find(x => x.status === 'rejected').reason.publicCode, 'CONFLICT')
      assert.deepEqual(await call(first.api, 'accounts.list'), before)
      await assert.rejects(call(other.api, 'loans.update', { ...payload, requestId: randomUUID(), loanId: zero.loanId, version: 1 }), { publicCode: 'NOT_FOUND' })
      await assert.rejects(call(other.api, 'loans.create', { ...payload, requestId: randomUUID() }), { publicCode: 'NOT_FOUND' })
    })
    await t.test('缺少本金日期、不合法金额与资产账户不能冒充贷款负债', async () => {
      const asset = await call(first.api, 'accounts.create', { requestId: randomUUID(), name: '合成资产', type: 'bank', currency: 'CNY',
        openingDisplayBalanceMinor: '0', occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })
      for (const patch of [{ baselinePrincipalMinor: '0' }, { baselinePrincipalMinor: '-1', baselineDate: '2026-09-01' },
        { baselinePrincipalMinor: '1', baselineDate: '2026-02-30' }, { kind: 'lending' }, { accountId: asset.accountId }, { name: '' }, { openingDisplayBalanceMinor: '10' }]) {
        await assert.rejects(call(first.api, 'loans.create', { ...payload, ...patch, requestId: randomUUID() }), { publicCode: 'VALIDATION_ERROR' })
      }
    })
  } finally { await lab.close() }
})
