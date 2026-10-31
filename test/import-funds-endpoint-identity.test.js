const test = require('node:test')
const assert = require('node:assert/strict')
const editor = require('./helpers/editor-workbench')

// 点加号只是把这一端拆成多个账户，不会改变两端谁收谁付。
// 早先拆开时会把「还入账户」翻成「付款账户」，原账户也跟着换到另一行。
test('拆开某一端的加号不改变两端的收付身份，原账户留在第一行', async t => {
  const { page } = await editor.open(t, { economicNature: 'repayment', sourceDirection: 'income',
    ledgerAccountId: 'account-1', counterpartyLedgerAccountId: 'account-2' })
  const before = editor.view(page).fundsEndpoints.map(item => [item.key, item.label])
  const originalPayer = editor.view(page).fundsEndpoints.find(item => item.key === 'payer').accounts[0].accountId
  assert.equal(originalPayer, 'account-2', '流入还款的原账单账户是还入端，付款端在对端字段')
  page.addFundsAccount(editor.tap({ endpoint: 'payer' }))
  const endpoints = editor.view(page).fundsEndpoints
  assert.deepEqual(endpoints.map(item => [item.key, item.label]), before, '拆开后两端标题不应互换')
  const payer = endpoints.find(item => item.key === 'payer')
  assert.equal(payer.split, true, '拆开后这一端应进入分摊')
  assert.equal(payer.accounts[0].accountId, originalPayer, '原付款账户应留在第一行')
  assert.equal(payer.accounts[1].accountId, '', '新加的一行应是待选')
})

test('两行历史分配都空着时，加号仍把这一端已选账户放回第一行', async t => {
  const { page } = await editor.open(t, { economicNature: 'expense', sourceDirection: 'expense',
    ledgerAccountId: 'account-1', composition: 'payment' })
  page.addFundsAccount(editor.tap({ endpoint: 'payer' }))
  const payer = editor.view(page).fundsEndpoints.find(item => item.key === 'payer')
  assert.equal(payer.split, true)
  assert.equal(payer.accounts[0].accountId, 'account-1', '空的历史分配不能把已选账户挤掉')
})
