const test = require('node:test')
const assert = require('node:assert/strict')
const { inlineSnapshot } = require('../cloudfunctions/catledger-import/src/local-review-objects')

test('单块内联只返回预算内的完整分块，超出预算或多块回退下载', () => {
  const part = { index: 0, bytes: 1024, digest: 'a'.repeat(64), content: 'x'.repeat(1024) }
  const inline = inlineSnapshot({ chunkCount: 1, parts: [part] }, 'object-id', 3)
  assert.deepEqual(inline, { objectId: 'object-id', baseVersion: 3, index: 0, bytes: 1024,
    digest: part.digest, content: part.content })
  assert.equal(inlineSnapshot({ chunkCount: 2, parts: [part, { ...part, index: 1 }] }, 'object-id', 3), null)
  assert.equal(inlineSnapshot({ chunkCount: 1, parts: [{ ...part, bytes: 200 * 1024 + 1 }] }, 'object-id', 3), null)
  assert.equal(inlineSnapshot({ chunkCount: 1, parts: [{ ...part, content: 'x'.repeat(200 * 1024) }] }, 'object-id', 3), null)
})
