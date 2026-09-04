const ERROR_MESSAGES = Object.freeze({
  AUTH_REQUIRED: '未取得可信微信身份',
  CONFLICT: '导入状态已发生变化，请刷新后重试',
  CSV_COLUMN_LIMIT_EXCEEDED: '账单列结构超出支持范围',
  CSV_RECORD_LIMIT_EXCEEDED: '账单记录数量超出支持范围',
  FILE_ENCODING_INVALID: '账单文件编码无法识别',
  FILE_FORMAT_UNSUPPORTED: '暂不支持这种账单格式',
  FILE_NOT_UPLOADED: '账单文件尚未上传完成',
  FILE_SIZE_INVALID: '账单文件大小不符合要求',
  IDEMPOTENCY_CONFLICT: '重复请求与首次内容不一致',
  INSUFFICIENT_CASH_BALANCE: '现金账户余额不足，请调整账户或先校正余额',
  IDENTITY_CONFLICT: '来源记录身份冲突，需要人工核对',
  INITIALIZATION_REQUIRED: '请先初始化招财猫记账本',
  INTERNAL_ERROR: '这一步暂时没完成，已解析账单不会丢失，请重试',
  INVALID_REQUEST: '请求中不能包含用户身份',
  NOT_FOUND: '未找到可用的导入任务',
  SERVICE_NOT_CONFIGURED: '招财猫记账本数据库尚未配置',
  SERVICE_TEMPORARY_UNAVAILABLE: '连接暂时中断，已解析账单不会丢失，请重试',
  UNRESOLVED_IMPORT: '仍有账目需要处理后才能入账',
  UNSUPPORTED_ACTION: '导入服务版本过旧，请更新后重试',
  VALIDATION_ERROR: '请检查导入信息'
})

const PUBLIC_ERROR_CODES = new Set(Object.keys(ERROR_MESSAGES).filter((code) => (
  code !== 'AUTH_REQUIRED' && code !== 'INTERNAL_ERROR' && code !== 'INVALID_REQUEST' &&
  code !== 'UNSUPPORTED_ACTION'
)))

function importError(publicCode, cause) {
  const error = new Error(publicCode)
  error.name = 'CatledgerImportError'
  error.publicCode = publicCode
  if (cause) error.cause = cause
  return error
}

function failure(code) {
  return {
    ok: false,
    error: {
      code,
      message: ERROR_MESSAGES[code] || ERROR_MESSAGES.INTERNAL_ERROR
    }
  }
}

module.exports = {
  PUBLIC_ERROR_CODES,
  failure,
  importError
}
