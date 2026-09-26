const test = require('node:test')
const assert = require('node:assert/strict')
const { measure } = require('../scripts/measure-import-review')
test('MINI-1915 原业务图、回执、请求量保持；贷款费用身份防重 JOIN 的 SQL 文本明确登记', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async () => {
  const expected = require('../specs/mini-1915-import-modularization/equivalence-baseline.json')
  const actual=await measure()
  // 新费用表在非贷款合成场景必须为空；不得替换或删减原表中的任何字段/外键。
  const added=['catledger_loan_charge_allocations','catledger_loan_charge_audit','catledger_loan_charge_contracts','catledger_loan_charge_sources','catledger_loan_charges']
  assert.deepEqual(actual.graph.filter(r=>added.includes(r.table)),added.map(table=>({table,rows:0,hash:'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'})))
  actual.graph=actual.graph.filter(r=>!added.includes(r.table))
  const queryHashes={
  "prepare": "cb8c07f04c40529ea410f08d8b5ba872e88170bc93087ddbc94c83ee6a7594c4",
  "map-accounts": "96546f2e68a2dddadee0c9d734e22029efa6b49773f525f981d458c0b1bd7b73",
  "post": "be3f6801a06519434a8575c20a4cfa421dbae658dc25f9640ff5034ff3ccc7aa",
  "prepare-history": "1bc2edce0aa82032e00d059f663256b6bdce14d953aa6c6d9a6823c0c30d4d2f",
  "map-history-accounts": "7fbd629b659092149a86f025c59b4515909488723955c8deeb8a9daf5fe48db5",
  "category-fields": "6cace22debad1ca5ac559683d53ec57b2b0e0829c92c14ae2e954222d2b6a0a5",
  "history-distinct": "ae8e67b315fb66f3abe3ef440b78a25fe7e06b2e0bee0008a490fa81acd84547",
  "post-distinct": "7efbac2f6e7fde991e5354af7bc14f4fd1e1ae754a8dba978477940cb07fcc5e"
}
  expected.samples=expected.samples.map(r=>({...r,sqlOrderHash:queryHashes[r.name]||r.sqlOrderHash}))
  assert.deepEqual(actual,expected)
})
