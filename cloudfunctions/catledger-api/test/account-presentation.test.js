const assert = require('node:assert/strict')
const test = require('node:test')

const { accountToPublic } = require('../src/account-service')

function accountRow(overrides) {
  return Object.assign({
    accountId: 'account-id',
    type: 'cash',
    nature: 'asset',
    name: '现金',
    currency: 'CNY',
    version: 1,
    archivedAt: null,
    bookBalance: '0'
  }, overrides)
}

test('资产账户负余额保留负号，不伪装成待还金额', function () {
  const account = accountToPublic(accountRow({ bookBalance: '-4780' }))
  assert.equal(account.bookBalanceMinor, '-4780')
  assert.equal(account.displayBalanceMinor, '-4780')
  assert.equal(account.balanceDirection, 'asset')
})

test('负债待还显示正数，溢缴余额按资产方向显示', function () {
  const due = accountToPublic(accountRow({
    type: 'credit', nature: 'liability', bookBalance: '-5000'
  }))
  assert.equal(due.displayBalanceMinor, '5000')
  assert.equal(due.balanceDirection, 'liability')

  const overpaid = accountToPublic(accountRow({
    type: 'credit', nature: 'liability', bookBalance: '300'
  }))
  assert.equal(overpaid.displayBalanceMinor, '300')
  assert.equal(overpaid.balanceDirection, 'asset')
})
