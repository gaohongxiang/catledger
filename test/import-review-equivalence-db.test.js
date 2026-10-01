const test = require('node:test')
const assert = require('node:assert/strict')
const { measure } = require('../scripts/measure-import-review')
test('当前分类预设下导入业务图、回执、请求量与 SQL 顺序保持', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async () => {
  // 逐字段对照 cadde88b：44 表 165 行及 14 阶段响应，仅计划 v30→v31 与派生视图键变化。
  // 临时进程仅固定旧计划版本后，完整业务图与响应相同；保留交易、余额、关系、回执和所有 ID。
  // 读取投影增加原始时间，重复计数包含 supporting；业务写入与事务顺序保持。
  // 已核对查询增量：无银行账户确认 +1 次来源门禁，单银行账户确认/分类提交各 +9 次候选重验读取；其余轮次不变。
  // JOINT-20261001：14阶段响应与SQL次数、原44表账务字段保持；只新增初始化列及空决定表。
  // 两个银行核对阶段改为同轮读取来源身份，更新对应SQL指纹，不把漏掉历史核对读取当成优化。
  const expected = require('./fixtures/import-review-baseline.json')
  assert.deepEqual(await measure(), expected)
})
