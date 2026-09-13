const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')

for (const [kind, file] of [['api','ledger-transaction'],['import','import-transaction']]) {
  test(`${kind} 的所有写入在取得用户锁后重查 active，注销竞争不能穿过门禁`, async () => {
    const { executeIdempotentMutation } = require(`../cloudfunctions/catledger-${kind}/src/${file}`)
    let called = false, rolledBack = false
    const connection = { async query() {}, async beginTransaction() {}, async commit() {}, release() {},
      async rollback() { rolledBack = true },
      async execute(sql) {
        if (/SELECT i.uid/.test(sql)) return [[{uid:'1234567890'}]]
        if (/FOR UPDATE/.test(sql)) return [[]]
        return [{}]
      }
    }
    await assert.rejects(executeIdempotentMutation({ getPool:()=>({getConnection:async()=>connection}),
      provider:'wechat-mini',subjectHash:'synthetic',action:'synthetic.write',data:{requestId:randomUUID()},
      operation:async()=>{called=true;return {}} }), {publicCode:'INITIALIZATION_REQUIRED'})
    assert.equal(called,false); assert.equal(rolledBack,true)
  })
}
