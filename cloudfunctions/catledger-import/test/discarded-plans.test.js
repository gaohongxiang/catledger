const test = require('node:test')
const assert = require('node:assert/strict')
const { discardUpdateGraph } = require('../src/discarded-update')

// 只验证回执来源和候选去重；真实引用与最小权限由数据库用例覆盖。
function connection({ deletable, createdPlans = [] }) {
  const deleted = { periods: [], loans: [], tables: [] }
  return {
    deleted,
    async execute(sql, params) {
      if (/SELECT status FROM catledger_finance_updates/.test(sql)) return [[{ status: 'abandoned' }]]
      if (/FROM catledger_mutation_receipts/.test(sql)) return [createdPlans.map(loanId => ({ loanId }))]
      if (/SELECT l\.loan_id AS loanId FROM catledger_loans/.test(sql)) {
        const loanId = params[1]
        return [deletable.has(loanId) ? [{ loanId }] : []]
      }
      if (/^UPDATE catledger_loan_periods/.test(sql)) { deleted.periods.push(params[1]); return [{}] }
      if (/^UPDATE catledger_loans/.test(sql)) { deleted.loans.push(params[1]); return [{}] }
      if (/^DELETE FROM catledger_/.test(sql)) { deleted.tables.push(sql); return [{}] }
      throw Error('Unexpected SQL: ' + sql)
    }
  }
}

test('放弃只注销创建回执证明属于本批的未使用计划', async () => {
  const c = connection({ deletable: new Set(['server-plan', 'local-plan', 'manual-plan']),
    createdPlans: ['server-plan', 'local-plan', 'server-plan', 'used-plan'] })
  await discardUpdateGraph(c, 'uid-1', 'update-1', { planIds: ['manual-plan'] })
  assert.deepEqual(c.deleted.loans.sort(), ['local-plan', 'server-plan'])
  assert.deepEqual(c.deleted.periods.sort(), ['local-plan', 'server-plan'])
})

test('没有创建来源回执时不凭客户端计划 ID 注销既有计划', async () => {
  const c = connection({ deletable: new Set(['manual-plan']) })
  await discardUpdateGraph(c, 'uid-1', 'update-1', { planIds: ['manual-plan'] })
  assert.deepEqual(c.deleted.loans, [])
})
