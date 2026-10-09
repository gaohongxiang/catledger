const test = require('node:test')
const assert = require('node:assert/strict')
const { measure } = require('../scripts/measure-import-review')
test('当前分类预设下导入业务图、回执、请求量与 SQL 顺序保持', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async () => {
  // 2026-10-03自动分类完善：用同一固定UUID/时钟逐字段对照改动前后合成图。
  // 仅美食名称、分类证据/记忆、计划v32和派生视图/回执变化；交易、余额、账户和来源关系全部一致。
  // 合成银行记录只有商品、没有明确商户，不再学习两个宽泛别名；post-distinct少6轮SQL。
  // 2026-10-04以e9cf030f读取实现作固定数据隔离对照：45张持久表、14阶段SQL数量与其他响应保持。
  // 仅summary视图版本/新鲜度、event-page视图版本及原账单status字段变化；该页SQL仅新增已有状态列。
  // 据此更新两阶段响应和event-page投影SQL的基线，不得无证据整体刷新快照。
  // 分期摘要修复另以17c27708作固定数据隔离对照：45表逐字段仅计划v33、银行profile/policy v3
  // 及其派生指纹变化；14阶段SQL数量、响应字节数和全部账务字段保持。SQL新增同用户账单映射投影。
  // 配对计数随摘要返回：仅summary增加pairingSuggestedCount=0（26字节）；45表、SQL顺序及其余13阶段保持。
  // 2026-10-07核对提示以9fcf1be8作固定UUID/时钟隔离对照：45表逐字段、14阶段SQL顺序与响应字节保持。
  // 仅summary.viewVersion/freshness.viewRevision和event-page.viewVersion随attention.VERSION变化，更新两处响应指纹。
  // 2026-10-08人工类型确认：固定数据测得45表及14阶段响应、SQL数量保持；
  // 仅summary原查询补读manual_field_mask以保持核对/入账口径一致，更新该阶段SQL指纹。
  const expected = require('./fixtures/import-review-baseline.json')
  assert.deepEqual(await measure(), expected)
})
