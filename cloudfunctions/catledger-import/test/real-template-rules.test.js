const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveRowSemantic } = require('../src/row-semantic-resolver')
const { inspectControls } = require('../src/parsers/record-classifier')
const { parseEvidenceFile } = require('../src/parsers')
const alipay = require('../src/profiles/alipay-app')
const pocket = { sourceType: 'alipay', sourceFormat: 'alipay_app_csv', rawTransactionType: '宠物',
  direction: 'neutral', rawStatus: '交易成功', paymentMethod: '小荷包测试', amountMinor: '1234' }

test('小荷包不计收支消费必须同时满足模板、类型、账户、状态和正金额', () => {
  const resolved = resolveRowSemantic(pocket)
  assert.equal(resolved.sourceAction, 'purchase')
  assert.equal(resolved.resolutionStatus, 'resolved')
  for (const change of [{ sourceFormat: 'alipay_web_csv' }, { rawTransactionType: '新业务' },
    { paymentMethod: '余额' }, { rawStatus: '等待处理' }, { amountMinor: '0' },
    { paymentMethod: '小荷包测试&招商银行储蓄卡(1234)' }]) {
    assert.notEqual(resolveRowSemantic({ ...pocket, ...change }).resolutionStatus, 'resolved')
  }
})

test('平台商户退款的方向和到账金额一致才确认为退款，不接受未知退款后缀', () => {
  const row = { sourceType: 'wechat', sourceFormat: 'wechat_xlsx', rawTransactionType: '测试平台商户-退款',
    direction: 'income', rawStatus: '已退款¥12.34', amountMinor: '1234', paymentMethod: '零钱' }
  assert.equal(resolveRowSemantic(row).sourceAction, 'refund_credit')
  for (const change of [{ direction: 'expense' }, { amountMinor: '1235' }, { rawStatus: '已退款待入账' },
    { rawTransactionType: '未知业务-退款' }]) {
    assert.notEqual(resolveRowSemantic({ ...row, ...change }).resolutionStatus, 'resolved')
  }
  assert.equal(resolveRowSemantic({ ...row, rawTransactionType: '商户退款', rawStatus: '已退款待入账' }).moneyEffect, 'unknown')
})

test('余额宝双端已确定时无需普通收付款端点', () => {
  const semantic = resolveRowSemantic({ ...pocket, rawTransactionType: '投资理财',
    item: '余额宝-转出到余额', paymentMethod: '/' })
  assert.equal(semantic.resolutionStatus, 'resolved')
  assert.equal(semantic.fundsProjection.kind, 'platform_savings_out')
})

test('源文件笔数与金额分别核对，关闭订单不影响支付宝汇总金额', () => {
  const row = (direction, amountMinor, status = '交易成功') => ({ parseState: 'valid', raw: { status }, normalized: { direction, amountMinor } })
  const controls = [{ values: ['支出：2笔 12.34元'], sourceLocator: 'CSV:1-1' }]
  const rows = [row('expense', '1234'), row('expense', '100', '交易关闭'), row('neutral', '888')]
  assert.ok(inspectControls(controls, rows, alipay).controls.every((x) => x.passed))
  assert.ok(inspectControls(controls, rows.slice(1), alipay).issues.some((x) => x.code === 'statement_count_mismatch'))
  assert.ok(inspectControls(controls, [...rows, row('expense', '1')], alipay).issues.some((x) => x.code === 'statement_amount_mismatch'))
})

test('支付宝导出标题和对方账号列明确观察，对方账号不推导自身资金端点', async () => {
  const doc = await parseEvidenceFile({ extension: 'csv', timezoneOffsetMinutes: -480, content: Buffer.from([
    '导出信息：',
    '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号',
    '2026-07-01 10:00:00,转账红包,测试,测试账号,测试,收入,12.34,,交易成功,synthetic-1'
  ].join('\n')) })
  assert.deepEqual(doc.issues, [])
  assert.equal(doc.rows[0].observations.counterpartyAccount.state, 'value')
  assert.equal(doc.rows[0].semantic.toAccountRef, null)
  assert.ok(doc.rows[0].semantic.issues.some((x) => x.code === 'account_endpoint_unknown'))
})
