const assert = require('node:assert/strict')
const test = require('node:test')

const { createHandler, inspectClientData } = require('../src/handler')
const { MAX_FILES_PER_UPDATE } = require('../src/import-service')
const { objectKeyFromFileId } = require('../src/storage-gateway')
const { normalizeFileName, validateDeclaredSize } = require('../src/validation')

test('一次财务更新最多接收五份账单', () => {
  assert.equal(MAX_FILES_PER_UPDATE, 5)
})

test('身份形状字段在嵌套结构中也会被拒绝', () => {
  assert.equal(inspectClientData({ decisions: [{ metadata: { openId: 'forged' } }] }), 'identity')
  assert.equal(inspectClientData({ decisions: [{ eventId: 'safe' }] }), null)
})

test('公开错误不回显请求、OpenID 或异常正文', async () => {
  const logs = []
  const handler = createHandler({
    getWxContext: () => ({ OPENID: 'private-openid' }),
    services: {
      'imports.get': async () => {
        const error = new Error('raw bill row and SQL bindings')
        error.code = 'ER_PARSE_ERROR'
        throw error
      }
    },
    logger: { error: (entry) => logs.push(entry) }
  })
  const result = await handler({ action: 'imports.get', data: { importId: 'private-import' } })
  assert.deepEqual(result, {
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: '这一步暂时没完成，已解析账单不会丢失，请重试' }
  })
  const serialized = JSON.stringify({ result, logs })
  assert.equal(serialized.includes('private-openid'), false)
  assert.equal(serialized.includes('private-import'), false)
  assert.equal(serialized.includes('raw bill row'), false)
})

test('瞬时数据库故障返回稳定重试码并记录非敏感追踪信息', async () => {
  const logs = []
  const handler = createHandler({
    getWxContext: () => ({ OPENID: 'private-openid' }),
    services: {
      'imports.get': async () => {
        const error = new Error('private SQL and row')
        error.code = 'ETIMEDOUT'
        throw error
      }
    },
    logger: { error: (entry) => logs.push(entry) },
    now: () => 50
  })

  const result = await handler(
    { action: 'imports.get', data: { importId: 'private-import' } },
    { request_id: 'trace-import-1' }
  )

  assert.equal(result.error.code, 'SERVICE_TEMPORARY_UNAVAILABLE')
  assert.deepEqual(logs, [{
    event: 'catledger-import-failure',
    action: 'imports.get',
    traceId: 'trace-import-1',
    code: 'SERVICE_TEMPORARY_UNAVAILABLE',
    databaseCode: 'ETIMEDOUT',
    elapsedMs: 0
  }])
  assert.doesNotMatch(JSON.stringify(logs), /private-openid|private-import|private SQL/)
})

test('解析失败日志只记录固定诊断阶段', async () => {
  const logs = []
  const handler = createHandler({
    getWxContext: () => ({ OPENID: 'private-openid' }),
    services: {
      'imports.parseFile': async () => {
        const error = new Error('private bill content')
        error.diagnosticPhase = 'persist_file'
        throw error
      }
    },
    logger: { error: (entry) => logs.push(entry) }
  })

  await handler({ action: 'imports.parseFile', data: { fileID: 'private-file' } })
  assert.equal(logs[0].phase, 'persist_file')
  assert.doesNotMatch(JSON.stringify(logs), /private-file|private bill content|private-openid/)
})

test('云文件 ID 必须解析为完全一致的对象路径', () => {
  assert.equal(
    objectKeyFromFileId('cloud://env.bucket/catledger-import/scope/file.csv'),
    'catledger-import/scope/file.csv'
  )
  assert.equal(objectKeyFromFileId('https://example.invalid/file.csv'), null)
  assert.equal(objectKeyFromFileId('cloud://env.bucket/file.csv?token=secret'), null)
})

test('文件名与大小边界只接受当前格式', () => {
  assert.deepEqual(normalizeFileName(' 微信账单.CSV '), { fileName: '微信账单.CSV', extension: 'csv' })
  assert.throws(() => normalizeFileName('账单.zip'), { publicCode: 'FILE_FORMAT_UNSUPPORTED' })
  assert.throws(() => validateDeclaredSize(0), { publicCode: 'FILE_SIZE_INVALID' })
})
