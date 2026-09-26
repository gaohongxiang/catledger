const ERROR_MESSAGES = Object.freeze({
  HISTORY_REVIEW_REQUIRED: '发现尚未核对的历史相似账目，请先确认是否重复；本次没有入账',
  HISTORY_MATCH_LIMIT_EXCEEDED: '历史同额候选过多，请缩短本次账单时间范围后核对；本次没有入账',
  LOAN_COVERAGE_REQUIRED: '请先确认已有费用覆盖',
  LOAN_CHARGE_DIFFERENCE: '本期费用与已记金额不同，请到贷款详情预览并确认差额',
  LOAN_CHARGE_PAUSED: '本期费用已覆盖、暂停或删除，请先核对',
  LOAN_CHARGE_COVERAGE: '已计费用需要关联尚未清偿的收费项',
  LOAN_SOURCE_MISMATCH: '这期账单与已确认分期不一致，请核对所属分期、期数和金额',
  BANK_MAPPING_REQUIRED: '请确认银行账单的列和收支方向',
  BANK_ROWS_INVALID: '部分行的日期、金额、收支或币种无法识别，请检查所选列；仅支持人民币且不接受公式',
  LOAN_PRINCIPAL_UNCONFIRMED: '请先确认贷款本金基线，再关联还款',
  LOAN_PRINCIPAL_EXCEEDED: '还款本金超过该时点的贷款余额，请核对',
  LOAN_TRANSACTION_LOCKED: '这组交易已关联贷款，请前往贷款管理整组处理',
  INSTALLMENT_CONFIRMATION_UNAVAILABLE: '分期本金尚无已确认原消费关系，请保留待核对并从贷款管理登记',
  OPERATION_UNCONFIRMED: '原操作结果尚未确认，请保留草稿并核对原请求',
  RECEIPT_RECONCILIATION_REQUIRED: '历史操作事实需核对，请保留原请求和草稿',
  REQUEST_TOO_LARGE: '本次选择过多，请分批保存草稿',
  PAGINATION_REQUIRED: '此批次需要新版分页读取，请更新后重试',
  INVALID_CURSOR: '分页位置无效，请重新读取',
  STALE_VIEW: '账目已更新，请刷新当前列表',
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
  PAYMENT_REFUND_ALLOCATION_REQUIRED: '原消费由多个账户支付，需核对退款分项；可先暂记待关联退款',
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
