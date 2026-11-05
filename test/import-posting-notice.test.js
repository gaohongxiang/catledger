const test = require('node:test')
const assert = require('node:assert/strict')
const { facts } = require('./helpers/local-review')
const posting = require('../miniprogram/packages/finance/services/import-local-posting')
const sessionFactory = require('../miniprogram/packages/finance/services/import-local-session')

// 成功路径只用到 clear()；recheck 分支会 download 一份补充事实。
const files = {
  save: () => {}, clear: () => true, close() {}, touch() {},
  download: async () => ({ historyCoverage: { duplicates: [], refunds: [] }, accounts: [], categories: [], issues: [],
    members: [], events: [], history: [], historyGroups: [], refundCandidates: [] })
}

async function build() {
  const value = await facts({ count: 1 })
  let seq = 0
  return sessionFactory.create({
    files,
    restored: { facts: value, records: [] },
    callNetwork: async () => { throw new Error('不应联网') },
    requestId: () => '11111111-1111-4111-8111-' + String(++seq).padStart(12, '0'),
    alive: () => true,
    saveReceipt: () => {},
    cleanup: () => {}
  })
}

// 入账成功后，上一次 recheck 或“结果待核实”遗留的旧提示必须被清空，
// 否则界面会出现“明明成功却还说没写入/待核实”的误导。
test('入账成功后清空上一次 recheck 遗留的“没有写入”提示', async () => {
  const session = await build()
  const updateId = session.state.updateId
  const originSubmit = posting.submit, originFinish = posting.finish
  try {
    // 第一次：服务端返回 recheck（未写入），应留下“入账没有写入…”提示。
    posting.submit = async () => ({ action: 'financeUpdates.post', updateId, status: 'review', outcome: 'recheck', recheck: 'obj-1' })
    const first = await session.post()
    assert.equal(first.outcome, 'recheck')
    assert.match(session.status.error, /入账没有写入/)
    // 第二次：真正成功（posted），提示必须被清空。
    posting.submit = async () => ({ action: 'financeUpdates.post', updateId, status: 'posted', update: { updateId, status: 'posted', version: 3 } })
    const receipt = await session.post()
    assert.equal(receipt.status, 'posted')
    assert.equal(session.status.error, '', '成功入账后不应残留“没有写入/待核实”提示')
  } finally {
    posting.submit = originSubmit
    posting.finish = originFinish
  }
})

// 成功但本机清理确有遗留时，提示应换成“已入账，本机清理将在恢复时重试”，而不是旧的未写入。
test('入账成功但清理遗留时，只提示已入账 + 清理重试，不带“没有写入”', async () => {
  const session = await build()
  const updateId = session.state.updateId
  const originSubmit = posting.submit, originFinish = posting.finish
  try {
    posting.submit = async () => ({ action: 'financeUpdates.post', updateId, status: 'posted', update: { updateId, status: 'posted', version: 3 } })
    posting.finish = () => ({ saved: true, cleaned: false, cleanupPending: true })
    const receipt = await session.post()
    assert.equal(receipt.status, 'posted')
    assert.equal(session.status.error, '已入账，本机清理将在恢复时重试')
  } finally {
    posting.submit = originSubmit
    posting.finish = originFinish
  }
})
