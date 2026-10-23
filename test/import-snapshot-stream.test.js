const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const protocol = require('../cloudfunctions/catledger-import/src/local-review-protocol')
const codec = require('../cloudfunctions/catledger-import/src/local-review-snapshot')
const samples = {
  boundary: 'a'.repeat(128 * 1024 - 1) + '😀' + 'b'.repeat(128 * 1024 + 3),
  escaped: '中文\n"\\\t😀'.repeat(18000),
  lone: 'x\ud800y\udc00'.repeat(24000)
}
// Captured from b4c390bb before the streaming refactor. Root digests include
// every ordered chunk digest; these pin v3 bytes and chunk boundaries together.
const baseline = {
  'boundary:snapshot': [262150, '9e2aedf9267b9f4dfa35966058de431d02320506764cac7f92cc58e4ebdb128e', [131071,131072,5]],
  'boundary:decisions': [262150, '39e04374f6918d9902a472762813cd68f9d8edce75e8588e07c95bf540dbe992', [61438,61438,61436,61438,16398]],
  'escaped:snapshot': [252000, 'c774d7963330c727af47558a885b0251f977d73c435c0c7cdf33dbe32642f1ea', [109225,34775]],
  'escaped:decisions': [252000, 'fb7aaf3b595da40ab090b482e71ce6b6206752fddcb4c3da3f97be02848a1eba', [27305,27305,27306,27306,27304,7474]],
  'lone:snapshot': [192000, '6c620bb345dcbf1dcd00bc115b1cf6f94dc242a252940f936231b43f799645c2', [70217,25783]],
  'lone:decisions': [192000, 'e38605214b050b7e8487e16f46b38c96a49c00277ac4ae31559b88303c1fc3d1', [17553,17552,17552,17552,17552,8239]]
}
function* fragments(text, size) {
  yield ''
  for (let index=0;index<text.length;index+=size) yield text.slice(index,index+size)
}
test('有界分块保持旧v3字节、转义预算、代理边界及摘要，与输入片段大小无关',()=>{
  for (const [name,text] of Object.entries(samples)) for (const kind of ['snapshot','decisions']) {
    for (const size of [1,7,65536,text.length]) {
      const packed=protocol.splitTextParts(fragments(text,size),kind)
      assert.deepEqual([packed.bytes,packed.digest,packed.parts.map(part=>part.content.length)],baseline[name+':'+kind])
      assert.equal(packed.parts.map(part=>part.content).join(''),text)
      const limit=kind==='snapshot'?protocol.LIMITS.snapshotChunkWireBytes:protocol.LIMITS.decisionChunkWireBytes
      for(const part of packed.parts)assert.ok(Buffer.byteLength(JSON.stringify(part.content))<=limit)
    }
  }
  assert.throws(()=>protocol.splitTextParts([]),{code:'SNAPSHOT_INCOMPLETE'})
  assert.throws(()=>protocol.splitTextParts(['valid',null]),{code:'SNAPSHOT_INCOMPLETE'})
})
test('快照逐节点编码保留旧字典格式与摘要，消费事实后仍可完整解码',()=>{
  const facts={protocolVersion:3,events:[{eventId:'event-1',note:samples.escaped,
    fieldSources:{absent:undefined,mixed:[null,undefined,'相同字典']}}],
    raw:[{rowId:'row-1',fields:{value:samples.boundary}}],sources:[],update:{version:7,status:'review'}}
  const original=structuredClone(facts)
  // Object properties with undefined were always omitted; array positions remain.
  delete original.events[0].fieldSources.absent
  const packed=protocol.splitTextParts(codec.encodeTextParts(facts,{consume:true}))
  assert.deepEqual(facts,{})
  assert.equal(packed.bytes,587827)
  assert.equal(packed.digest,'ae412a49a192004327e600a7b0fea20a530132d6a6d568f1094134d7da22dcdb')
  const text=packed.parts.map(part=>part.content).join('')
  assert.equal(text.length,479817)
  assert.equal(createHash('sha256').update(text).digest('hex'),'36b19bb8e8bb909dee9c372e05ec980280d939503be06cde518381d1667df2ca')
  const decoded=codec.decodeParts(packed.parts.map(part=>part.content))
  for(const key of ['protocolVersion','events','raw','sources','update'])assert.deepEqual(decoded[key],original[key])
})
