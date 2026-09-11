const bankSuggestion = require('./bank-suggestion')

const ISSUE_LABELS = Object.freeze({
  account_mapping: '确认账户归属',
  category_assignment: '交易分类待确认',
  shared_fields: '补全共同字段',
  same_event: '判断是否同一笔',
  refund_relation: '退款关系待确认',
  transfer_accounts: '确认资金流转账户',
  identity_conflict: '核对来源身份冲突',
  field_conflict: '裁决字段冲突',
  installment_origin: '确认分期本金来源'
})

const ISSUE_HELP = Object.freeze({
  account_mapping: '选择这笔记录应归属的账本账户',
  category_assignment: '为这些同类收支选择一个分类',
  shared_fields: '补全这些记录共同缺少的信息',
  same_event: '确认不同来源记录是不是同一笔交易',
  refund_relation: '选择这笔退款对应的原消费',
  transfer_accounts: '确认资金从哪个账户转到哪个账户',
  identity_conflict: '来源编号相同，但记录内容存在冲突',
  field_conflict: '不同来源对同一笔交易的描述不一致',
  installment_origin: '确认分期交易对应的本金记录'
})

const ACCOUNT_ISSUE_TYPES = Object.freeze(['account_mapping'])
const ISSUE_GROUP_ORDER = Object.freeze([
  'refund_relation', 'same_event', 'transfer_accounts', 'category_assignment', 'field_conflict',
  'shared_fields', 'identity_conflict', 'installment_origin'
])
const ISSUE_GROUP_LABELS = Object.freeze({
  refund_relation: '退款关系',
  same_event: '重复与同笔判断',
  transfer_accounts: '资金流转',
  category_assignment: '交易分类',
  field_conflict: '字段冲突',
  shared_fields: '信息补全',
  identity_conflict: '来源冲突',
  installment_origin: '分期来源'
})
const PAYMENT_ACCOUNT_GENERIC_NAME_TOKENS = Object.freeze([
  '信用卡', '贷记卡', '借记卡', '储蓄卡', '银行卡', '银行', '账户', '账号', '支付', '付款'
])
const PAYMENT_ACCOUNT_UNSUPPORTED_CHARACTER_RE = /[^0-9a-z\u3400-\u4dbf\u4e00-\u9fff]+/g
const ACCOUNT_TYPE_LABELS = Object.freeze({
  cash: '现金',
  bank: '银行卡',
  wallet: '平台钱包',
  credit: '信用卡 / 消费信贷',
  other_asset: '其他资产',
  other_liability: '其他负债'
})

function accountChoiceOptions(accounts, accountDrafts, allowPermanentIgnore) {
  const options = [{ value: 'pending', name: '请选择账户归属' }, { value: 'create', name: '创建新账户' }]
    .concat((accounts || []).map(function (account) {
      return { value: 'account:' + account.accountId, name: account.name }
    }))
    .concat((accountDrafts || []).map(function (account) {
      return { value: 'account:' + account.accountId, name: account.name + '（本批新建）' }
    }))
    .concat([{ value: 'ignore', name: '仅本次不计入' }])
  if (allowPermanentIgnore) options.push({ value: 'ignore_future', name: '以后不计入' })
  return options
}

function accountSelectorOptions(accounts, accountDrafts) {
  return (accounts || []).map(function (account) {
    const presentation = accountSelectorPresentation(account)
    return {
      value: 'account:' + account.accountId,
      accountId: account.accountId,
      name: account.name,
      detail: ACCOUNT_TYPE_LABELS[account.type] || '账本账户',
      iconText: presentation.iconText,
      iconClass: presentation.iconClass,
      draft: false
    }
  }).concat((accountDrafts || []).map(function (account) {
    const presentation = accountSelectorPresentation(account)
    return {
      value: 'account:' + account.accountId,
      accountId: account.accountId,
      name: account.name + '（本批新建）',
      detail: ACCOUNT_TYPE_LABELS[account.type] || '本批账户草稿',
      iconText: presentation.iconText,
      iconClass: presentation.iconClass,
      draft: true
    }
  }))
}

function accountSelectorPresentation(account) {
  const name = String(account && account.name || '')
  if (name.includes('支付宝')) return { iconText: '支', iconClass: 'account-platform-alipay' }
  if (name.includes('微信')) return { iconText: '微', iconClass: 'account-platform-wechat' }
  if (account && (account.type === 'bank' || account.type === 'credit')) {
    return { iconText: '银', iconClass: 'account-platform-bank' }
  }
  if (account && account.type === 'cash') return { iconText: '现', iconClass: 'account-platform-cash' }
  return { iconText: '账', iconClass: 'account-platform-generic' }
}

function filterAccountSelectorOptions(options, query, excludedAccountId) {
  const search = normalizePaymentAccountName(query)
  return (options || []).filter(function (option) {
    if (excludedAccountId && option.accountId === excludedAccountId) return false
    if (!search) return true
    return normalizePaymentAccountName(option.name + ' ' + option.detail).includes(search)
  })
}

async function runWithConcurrency(items, concurrency, worker) {
  const values = Array.isArray(items) ? items : []
  const width = Math.max(1, Math.min(values.length || 1, Math.floor(Number(concurrency)) || 1))
  let cursor = 0
  async function consume() {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      await worker(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: width }, consume))
}

function normalizePaymentAccountName(value) {
  let normalized = String(value || '')
  normalized = normalized.replace(/\u3000/g, ' ').replace(/[\uff01-\uff5e]/g, function (character) {
    return String.fromCharCode(character.charCodeAt(0) - 0xfee0)
  })
  if (typeof normalized.normalize === 'function') {
    try {
      normalized = normalized.normalize('NFKC')
    } catch (_) {}
  }
  normalized = normalized.replace(/^\s+|\s+$/g, '').toLowerCase()
  normalized = normalized.replace(/(?:末四位|后四位|尾号|卡号)/g, '')
  normalized = normalized.replace(/[xX*＊•·]{2,}/g, '')
  normalized = normalized.replace(/\d{8,}/g, function (digits) { return digits.slice(-4) })
  return normalized.replace(PAYMENT_ACCOUNT_UNSUPPORTED_CHARACTER_RE, '')
}

function paymentAccountTail(value) {
  const match = normalizePaymentAccountName(value).match(/(\d{4})$/)
  return match ? match[1] : ''
}

function paymentAccountBase(value) {
  let normalized = normalizePaymentAccountName(value).replace(/\d+/g, '')
  PAYMENT_ACCOUNT_GENERIC_NAME_TOKENS.forEach(function (token) {
    normalized = normalized.split(token).join('')
  })
  return normalized
}

function stripPaymentPlatform(value, sourceType) {
  let normalized = normalizePaymentAccountName(value)
  if (sourceType === 'wechat') normalized = normalized.replace(/^微信(?:支付)?/, '')
  if (sourceType === 'alipay') normalized = normalized.replace(/^支付宝/, '')
  return normalized === '账户余额' ? '余额' : normalized
}

function paymentAccountMatchScore(context, accountName) {
  const sourceName = normalizePaymentAccountName(context && context.label)
  const candidateName = normalizePaymentAccountName(accountName)
  if (!sourceName || !candidateName) return 0
  if (sourceName === candidateName) return 100

  const sourceTail = paymentAccountTail(context.label)
  const candidateTail = paymentAccountTail(accountName)
  const sourceBase = paymentAccountBase(context.label)
  const candidateBase = paymentAccountBase(accountName)
  if (sourceTail && sourceTail === candidateTail && sourceBase.length >= 2 && candidateBase.length >= 2 &&
      (sourceBase === candidateBase || sourceBase.includes(candidateBase) || candidateBase.includes(sourceBase))) {
    return 90
  }

  const sourceWithoutPlatform = stripPaymentPlatform(context.label, context.sourceType)
  const candidateWithoutPlatform = stripPaymentPlatform(accountName, context.sourceType)
  return sourceWithoutPlatform && sourceWithoutPlatform === candidateWithoutPlatform ? 80 : 0
}

function suggestExistingAccount(context, accounts) {
  if (!context || !context.recognized || !context.label) return null
  const currency = context.currency || 'CNY'
  const candidates = (accounts || []).filter(function (account) {
    return account && account.accountId && account.currency === currency
  }).map(function (account) {
    return { account: account, score: paymentAccountMatchScore(context, account.name) }
  }).filter(function (candidate) {
    return candidate.score > 0
  }).sort(function (left, right) {
    return right.score - left.score || String(left.account.name).localeCompare(String(right.account.name))
  })
  const best = candidates[0]
  if (!best || candidates.filter(function (candidate) { return candidate.score === best.score }).length !== 1) return null
  return best.account
}

// 只初始化本地核对表单；不把推荐结果当作已提交的人工决定。
function paymentResolutionDefaults(event, accounts) {
  const evidence = event && event.primaryEvidence || {}
  const repayment = event && event.economicNature === 'repayment'
  const natureIndex = repayment ? 2 : event && event.economicNature === 'expense' ? 1 : 0
  const rows = (event && event.paymentComponents || []).map(function (part, index) {
    const saved = (event.paymentAccounts || []).find(function (item) { return item.componentIndex === index })
    const matched = saved ? accounts.find(function (account) { return account.accountId === saved.accountId }) : suggestExistingAccount({ recognized: true, label: part.label,
      sourceType: evidence.sourceType, currency: event.currency || 'CNY' }, accounts)
    return { componentIndex: index, componentKind: part.componentKind, label: part.label,
      accountIndex: matched ? accounts.indexOf(matched) + 1 : 0,
      accountId: matched ? matched.accountId : '', amountInput: '' }
  }).filter(function (part) { return part.componentKind === 'financial' })
  // 同一账户不能代表两个独立支付成分；重复命中交回人工核对。
  rows.forEach(function (row) {
    if (row.accountId && rows.filter(function (other) { return other.accountId === row.accountId }).length > 1) {
      row.duplicateMatch = true
    }
  })
  rows.forEach(function (row) {
    if (row.duplicateMatch) { row.accountId = ''; row.accountIndex = 0; delete row.duplicateMatch }
  })
  return { rows: rows, natureIndex: natureIndex }
}

function formatFileSize(value) {
  const bytes = Number(value) || 0
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function amountText(value) {
  if (value == null || !/^\d+$/.test(String(value))) return '金额待补全'
  const minor = String(value).padStart(3, '0')
  return '¥' + minor.slice(0, -2) + '.' + minor.slice(-2)
}

function evidenceValueText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) return value.map(evidenceValueText).filter(Boolean).join('；')
  if (typeof value === 'object') {
    return Object.keys(value).map(function (key) {
      const nested = evidenceValueText(value[key])
      return nested ? key + '：' + nested : ''
    }).filter(Boolean).join('；')
  }
  return String(value)
}

function evidenceFieldText(key, value) {
  const text = evidenceValueText(value)
  if (!/(?:日期|时间)$/.test(key) || !/^\d{5}(?:\.\d+)?$/.test(text)) return text
  const serial = Number(text)
  if (serial < 20000 || serial > 80000) return text
  // Excel 的本地日期序号不带时区；用 UTC 算术避免设备时区改变原始钟面时间。
  const date = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400) * 1000)
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

function evidenceFields(rawFields) {
  if (Array.isArray(rawFields)) {
    return rawFields.map(function (field, index) {
      if (field && typeof field === 'object' && !Array.isArray(field) &&
          Object.prototype.hasOwnProperty.call(field, 'name')) {
        return {
          key: String(field.name || '字段 ' + (index + 1)),
          value: evidenceFieldText(String(field.name || ''), field.value)
        }
      }
      return { key: '字段 ' + (index + 1), value: evidenceValueText(field) }
    })
  }
  if (!rawFields || typeof rawFields !== 'object') return []
  return Object.keys(rawFields).map(function (key) {
    return { key: key, value: evidenceFieldText(key, rawFields[key]) }
  })
}

function fileStateText(state) {
  return {
    queued: '等待上传', preparing: '准备中', uploading: '上传中', parsing: '解析中',
    ready: '解析完成', failed: '解析失败', duplicate: '已经入账', discarded: '已移除'
  }[state] || state
}

function updateFile(files, clientId, patch) {
  return files.map(function (file) {
    return file.clientId === clientId ? Object.assign({}, file, patch) : file
  })
}

function sameFileMetadata(left, right) {
  if (!left || !right) return false
  return String(left.name || '').trim() === String(right.name || '').trim() &&
    Number(left.size) === Number(right.size)
}

function byteView(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (value && value.buffer instanceof ArrayBuffer) {
    return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength)
  }
  return null
}

function sameFileContent(left, right) {
  const leftBytes = byteView(left)
  const rightBytes = byteView(right)
  if (!leftBytes || !rightBytes || leftBytes.byteLength !== rightBytes.byteLength) return false
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return false
  }
  return true
}

function uploadSummary(files) {
  const failed = files.filter(function (file) { return file.state === 'failed' }).length
  const attention = files.filter(function (file) {
    return ['failed', 'duplicate'].includes(file.state)
  }).length
  return {
    total: files.length,
    queued: files.filter(function (file) { return file.state === 'queued' }).length,
    ready: files.filter(function (file) { return file.state === 'ready' }).length,
    failed: failed,
    attention: attention
  }
}

function buildIssueFieldsDraft(state) {
  const issue = state.currentIssue
  const draft = state.issueDraft || {}
  const invalid = function (reason) { return { valid: false, reason: reason, fields: {} } }
  if (!issue) return invalid('请先打开待核对项目')
  if (issue.issueType === 'category_assignment') {
    const category = (state.issueCategories || [])[draft.categoryIndex]
    return category && category.categoryId && !category.isPlaceholder
      ? { valid: true, fields: { categoryId: category.categoryId } }
      : invalid('请选择交易分类')
  }
  if (!['account_mapping', 'transfer_accounts', 'shared_fields', 'field_conflict'].includes(issue.issueType)) {
    return invalid('请先完成当前确认')
  }
  if (issue.repaymentOwnershipRequired) {
    if (!['self', 'other'].includes(draft.repaymentOwner)) return invalid('请先确认是自己的账户还是替他人还款')
    if (draft.repaymentOwner === 'other') {
      if (!['expense', 'pending'].includes(draft.repaymentOtherTreatment)) return invalid('请选择这笔代还款如何处理')
      return { valid: true, fields: { repaymentOwnership: { owner: 'other', treatment: draft.repaymentOtherTreatment } } }
    }
  }
  const account = (state.accountChoices || [])[draft.accountIndex]
  const missingSide = issue.issueType === 'transfer_accounts' && ['from', 'to'].includes(issue.missingFundsSide)
    ? issue.missingFundsSide : ''
  const fields = {}
  const accountField = missingSide === 'to' ? 'counterpartyLedgerAccountId' : 'ledgerAccountId'
  if (!account || account.isPlaceholder) return invalid('请选择需要确认的账户')
  if (account.accountId) {
    if (account.archived || account.archivedAt || account.unavailable) return invalid('请选择可用账户')
    fields[accountField] = account.accountId
  } else if (account.isCreate) {
    const type = (state.accountTypeOptions || [])[draft.accountTypeIndex]
    const name = String(draft.newAccountName || '').normalize('NFKC').trim()
    if (!type || !type.value || Array.from(name).length < 1 || Array.from(name).length > 32) {
      return invalid('请填写 1～32 字的新账户名称并选择类型')
    }
    fields[missingSide === 'to' ? 'counterpartyLedgerAccountDraft' : 'ledgerAccountDraft'] = {
      name: name, type: type.value, currency: 'CNY'
    }
  } else return invalid('请选择需要确认的账户')
  if (issue.repaymentOwnershipRequired && draft.repaymentOwner === 'self') {
    const type = account.accountId ? account.type : ((state.accountTypeOptions || [])[draft.accountTypeIndex] || {}).value
    if (!['credit', 'other_liability'].includes(type)) return invalid('请选择自己的信用卡或其他负债账户')
    fields.repaymentOwnership = { owner: 'self' }
  }
  if (issue.issueType === 'transfer_accounts') {
    if (!missingSide) {
      const target = (state.counterpartyAccountChoices || [])[draft.counterpartyAccountIndex]
      if (!target || target.isPlaceholder || !target.accountId || target.archived || target.archivedAt || target.unavailable ||
          fields.ledgerAccountId === target.accountId) return invalid('请选择两个不同的转出和转入账户')
      fields.counterpartyLedgerAccountId = target.accountId
    } else {
      const otherField = missingSide === 'to' ? 'ledgerAccountId' : 'counterpartyLedgerAccountId'
      const events = (state.issueEvents || []).concat(issue.subject ? [issue.subject] : [])
      if (account.accountId && events.some(function (event) { return event[otherField] === account.accountId })) {
        return invalid('请选择两个不同的转出和转入账户')
      }
    }
  }
  if (['shared_fields', 'field_conflict'].includes(issue.issueType)) {
    const nature = (state.natureOptions || [])[draft.natureIndex]
    if (!nature || !nature.value || nature.value === 'unknown') return invalid('请选择明确的收支性质')
    fields.economicNature = nature.value
    fields.flowDirection = nature.value === 'income' || nature.value === 'refund' ? 'inflow'
      : ['internal_transfer', 'repayment', 'borrow'].includes(nature.value) ? 'neutral' : 'outflow'
  }
  return { valid: true, fields: fields }
}

function issueView(issue) {
  const context = issue.accountContext || {}
  const subject = issue.subject ? eventView(issue.subject) : null
  const projected = issue.subject && issue.subject.fundsProjection
  const aggregateRepayment = Boolean(issue.issueType === 'transfer_accounts' && projected &&
    projected.to && projected.to.referenceKind === 'aggregate')
  const missingFundsSide = issue.issueType === 'transfer_accounts' && projected
    ? aggregateRepayment
      ? 'allocation'
      : !issue.subject.ledgerAccountId && issue.subject.counterpartyLedgerAccountId
      ? 'from'
      : issue.subject.ledgerAccountId && !issue.subject.counterpartyLedgerAccountId
        ? 'to'
        : 'both'
    : ''
  let label = ISSUE_LABELS[issue.issueType] || '需要确认'
  if (issue.issueType === 'account_mapping' && context.label) label = context.label
  if (issue.issueType === 'transfer_accounts' && context.label) label = '资金流转 · ' + context.label
  if (aggregateRepayment) label = '还款分配待确认'
  if (missingFundsSide === 'from') label = '转出账户待确认'
  if (missingFundsSide === 'to') label = '转入账户待确认'
  const groupedAccount = issue.issueType === 'account_mapping' && /^payment_(component_\d+|target)$/.test(context.fundsSide || '')
  const paymentNeedsReview = Boolean(!groupedAccount && subject && (issue.reasonCodes || []).concat(subject.reasonCodes || []).includes('payment_components_ambiguous') && !subject.paymentResolution)
  if (paymentNeedsReview) label = '组合支付待核对'
  const repaymentOwnershipRequired = Boolean(issue.issueType === 'transfer_accounts' && !paymentNeedsReview && subject && subject.repaymentOwnershipRequired)
  if (repaymentOwnershipRequired) label = subject.repaymentOwnership && subject.repaymentOwnership.owner === 'other'
    ? '代他人还款待核对' : '还款账户归属待确认'
  return Object.assign({}, issue, {
    label: label,
    repaymentOwnershipRequired: repaymentOwnershipRequired,
    paymentNeedsReview: paymentNeedsReview,
    paymentAccountsOnly: paymentNeedsReview && issue.issueType === 'account_mapping',
    aggregateRepayment: aggregateRepayment,
    missingFundsSide: missingFundsSide,
    fundsProjection: projected || null,
    missingAccountLabel: missingFundsSide === 'to' ? '转入账户' : '转出账户',
    reasonText: ISSUE_HELP[issue.issueType] || '请核对相关记录后作出选择',
    subjectTitle: subject ? subject.displayTitle : label,
    subjectMeta: subject ? subject.displayMeta : '',
    subjectAmountText: subject ? subject.amountText : '',
    subjectDirectionClass: subject ? subject.directionClass : '',
    decisionText: repaymentOwnershipRequired
      ? '银行名称不能确认账户归属，请核对这笔钱是替谁还的'
      : paymentNeedsReview
      ? issue.issueType === 'account_mapping' ? '确认这些付款方式对应的账本账户' : '核对各账户实际支付金额，并确认这笔是支出还是还款'
      : issue.issueType === 'refund_relation'
      ? Number(issue.candidateCount) > 0
        ? Number(issue.candidateCount) + ' 笔候选待核对'
        : '未找到可确认的原消费'
      : aggregateRepayment
        ? '确认这笔合并账单分别还给哪些真实账户'
        : missingFundsSide === 'from'
        ? '转入账户已确定，只需选择资金从哪个账户转出'
        : missingFundsSide === 'to'
          ? '转出账户已确定，只需选择资金转入哪个账户'
          : ISSUE_HELP[issue.issueType] || '请核对相关记录后作出选择'
  })
}

function repaymentAllocationOptions(accounts, accountDrafts, projection, context) {
  const eligible = (accounts || []).concat(accountDrafts || []).filter(function (account) {
    return account && account.accountId && ['credit', 'other_liability'].includes(account.type) && account.archivedAt == null &&
      (!context || ((!context.currency || account.currency === context.currency) && account.accountId !== context.ledgerAccountId))
  })
  const recommended = new Set((projection && projection.to && projection.to.candidates || []).map(function (item) { return item.accountId }))
  const byId = new Map(eligible.map(function (account) { return [account.accountId, account] }))
  const ids = Array.from(recommended).filter(function (id) { return byId.has(id) })
    .concat(Array.from(byId.keys()).filter(function (id) { return !recommended.has(id) }))
  return ids.map(function (id) {
    return Object.assign({}, byId.get(id), { recommended: recommended.has(id), amountInput: '' })
  })
}

function yuanInputToMinor(value) {
  const text = String(value == null ? '' : value).trim()
  if (!text || !/^\d{1,12}(?:\.\d{0,2})?$/.test(text)) return text ? null : '0'
  const parts = text.split('.')
  return (parts[0].replace(/^0+(?=\d)/u, '') + (parts[1] || '').padEnd(2, '0'))
    .replace(/^0+(?=\d)/u, '')
}

function addMinor(left, right) {
  const a = String(left || '0')
  const b = String(right || '0')
  let carry = 0
  let result = ''
  for (let offset = 1; offset <= Math.max(a.length, b.length); offset += 1) {
    const value = Number(a[a.length - offset] || 0) + Number(b[b.length - offset] || 0) + carry
    result = String(value % 10) + result
    carry = Math.floor(value / 10)
  }
  return ((carry ? String(carry) : '') + result).replace(/^0+(?=\d)/u, '')
}

function compareMinor(left, right) {
  const a = String(left || '0').replace(/^0+(?=\d)/u, '')
  const b = String(right || '0').replace(/^0+(?=\d)/u, '')
  return a.length === b.length ? a.localeCompare(b) : a.length < b.length ? -1 : 1
}

function subtractMinor(left, right) {
  if (compareMinor(left, right) < 0) return '-' + subtractMinor(right, left)
  const a = String(left || '0')
  const b = String(right || '0')
  let borrow = 0
  let result = ''
  for (let offset = 1; offset <= a.length; offset += 1) {
    let value = Number(a[a.length - offset] || 0) - Number(b[b.length - offset] || 0) - borrow
    if (value < 0) { value += 10; borrow = 1 } else borrow = 0
    result = String(value) + result
  }
  return result.replace(/^0+(?=\d)/u, '')
}

function paymentAmountInput(amountMinor) {
  const value = String(amountMinor).padStart(3, '0')
  return value.slice(0, -2) + '.' + value.slice(-2)
}

function updatePaymentAmounts(rows, index, value, total, fillAll) {
  if (!Number.isInteger(index) || index < 0 || index >= rows.length || !/^[1-9]\d{0,18}$/.test(String(total || ''))) return rows
  if (fillAll) return rows.map(function (row, i) {
    return Object.assign({}, row, { amountInput: paymentAmountInput(i === index ? total : '0') })
  })
  const input = String(value == null ? '' : value)
  const minor = yuanInputToMinor(input)
  const otherInput = input.trim() && minor != null && compareMinor(minor, total) <= 0
    ? paymentAmountInput(subtractMinor(total, minor)) : ''
  return rows.map(function (row, i) {
    return i === index ? Object.assign({}, row, { amountInput: input })
      : rows.length === 2 ? Object.assign({}, row, { amountInput: otherInput }) : row
  })
}

function buildPaymentResolutionDraft(rows, nature, targetAccountId, evidenceNote, total) {
  const state = buildRepaymentAllocationDraft(rows, total)
  const valid = state.valid && rows.length > 1 && rows.every(function (row) { return row.accountId && String(row.amountInput == null ? '' : row.amountInput).trim() && yuanInputToMinor(row.amountInput) != null }) &&
    new Set(rows.map(function (row) { return row.accountId })).size === rows.length &&
    ['expense', 'repayment'].includes(nature) && String(evidenceNote || '').trim() &&
    (nature === 'expense' || (targetAccountId && !rows.some(function (row) { return row.accountId === targetAccountId })))
  return { valid: Boolean(valid), remainingMinor: state.remainingMinor, resolution: {
    version: 'payment-resolution-v2', nature: nature,
    targetAccountId: nature === 'repayment' ? targetAccountId : null,
    allocations: rows.map(function (row) { return { componentIndex: row.componentIndex, accountId: row.accountId, amountMinor: yuanInputToMinor(row.amountInput) } }),
    evidenceNote: String(evidenceNote || '').trim(), confirmedFromDetails: true
  } }
}

function buildRepaymentAllocationDraft(options, totalAmountMinor) {
  if (!/^\d{1,19}$/.test(String(totalAmountMinor || ''))) {
    return { valid: false, reason: '金额不可用', remainingMinor: '0', allocations: [] }
  }
  const allocations = []
  let sum = '0'
  for (const option of options || []) {
    const amountMinor = yuanInputToMinor(option.amountInput)
    if (amountMinor == null) {
      return { valid: false, reason: '金额最多保留两位小数', remainingMinor: subtractMinor(totalAmountMinor, sum), allocations: [] }
    }
    if (amountMinor === '0') continue
    if (option.unavailable || (option.isNew && !String(option.name || '').trim())) {
      return { valid: false, reason: option.unavailable ? '请重新选择失效账户' : '请填写新账户名称', remainingMinor: subtractMinor(totalAmountMinor, sum), allocations: [] }
    }
    allocations.push(option.isNew
      ? { accountDraft: { name: String(option.name).trim(), type: 'credit', currency: 'CNY' }, amountMinor: amountMinor }
      : { accountId: option.accountId, amountMinor: amountMinor })
    sum = addMinor(sum, amountMinor)
  }
  const remaining = subtractMinor(totalAmountMinor, sum)
  return {
    valid: allocations.length > 0 && allocations.length <= 20 && remaining === '0',
    reason: allocations.length === 0
      ? '请填写还款金额'
      : remaining === '0'
        ? ''
        : remaining.startsWith('-')
          ? '分配金额不能超过本笔还款'
          : '分配金额需要等于本笔还款',
    remainingMinor: remaining,
    allocations: allocations
  }
}

function reviewIssueRows(issues) {
  const counts = (issues || []).reduce(function (result, issue) {
    result[issue.issueType] = (result[issue.issueType] || 0) + 1
    return result
  }, {})
  const order = new Map(ISSUE_GROUP_ORDER.map(function (type, index) { return [type, index] }))
  let previousType = ''
  return [...(issues || [])].sort(function (left, right) {
    const leftOrder = order.has(left.issueType) ? order.get(left.issueType) : ISSUE_GROUP_ORDER.length
    const rightOrder = order.has(right.issueType) ? order.get(right.issueType) : ISSUE_GROUP_ORDER.length
    return leftOrder - rightOrder || String(left.subject && left.subject.localAt || '').localeCompare(String(right.subject && right.subject.localAt || '')) ||
      String(left.issueId).localeCompare(String(right.issueId))
  }).map(function (issue) {
    const view = issueView(issue)
    const groupStart = issue.issueType !== previousType
    previousType = issue.issueType
    return Object.assign({}, view, {
      groupStart,
      groupLabel: ISSUE_GROUP_LABELS[issue.issueType] || view.label,
      groupCount: counts[issue.issueType] || 0
    })
  })
}

function reviewIssueGroups(issues) {
  const rows = reviewIssueRows(issues)
  const groups = []
  rows.forEach(function (issue) {
    let group = groups[groups.length - 1]
    if (!group || group.issueType !== issue.issueType) {
      group = {
        issueType: issue.issueType,
        label: issue.groupLabel,
        count: issue.groupCount,
        issues: []
      }
      groups.push(group)
    }
    const subjects = (issue.subjects || (issue.subject ? [issue.subject] : []))
      .slice(0, 3)
      .map(eventView)
    const subjectCount = Number(issue.subjectCount || Math.max(1, Number(issue.memberCount || 1) - Number(issue.candidateCount || 0)))
    group.issues.push(Object.assign({}, issue, {
      subjects: subjects,
      primarySubject: subjects[0] || null,
      subjectCount: subjectCount,
      hiddenSubjectCount: Math.max(0, subjectCount - subjects.length),
      batchDecision: subjectCount > 1 ? '批量处理 ' + subjectCount + ' 笔' : '处理'
    }))
  })
  return groups
}

// 商户仅组织展示；每张卡片仍对应服务端冻结的一个问题组。
function categoryIssueCards(issues, query) {
  const keyword = String(query || '').trim().toLowerCase()
  const completeSubjects = new Map((issues || []).map(function (issue) {
    return [issue.issueId, (issue.subjects || (issue.subject ? [issue.subject] : [])).map(eventView)]
  }))
  return reviewIssueGroups((issues || []).filter(function (issue) {
    return issue.issueType === 'category_assignment'
  })).reduce(function (all, group) { return all.concat(group.issues) }, []).map(function (issue) {
    const subject = issue.subject || issue.subjects[0] || {}
    const evidence = subject.primaryEvidence || {}
    const merchant = evidence.counterparty || evidence.item || '未提供商户'
    const allSubjects = completeSubjects.get(issue.issueId) || issue.subjects
    const matchingSubjects = keyword ? allSubjects.filter(function (event) {
      return (event.displayTitle + ' ' + event.displayMeta).toLowerCase().includes(keyword)
    }) : allSubjects
    const previews = (matchingSubjects.length ? matchingSubjects : allSubjects).slice(0, 3)
    return Object.assign({}, issue, {
      subjects: previews,
      hiddenSubjectCount: Math.max(0, issue.subjectCount - previews.length),
      merchant: merchant + (issue.subjectCount > 1 ? '等 · 同类交易' : ''),
      natureLabel: subject.economicNature === 'income' ? '收入' : '支出',
      searchText: [merchant].concat(allSubjects.map(function (event) {
        return event.displayTitle + ' ' + event.displayMeta
      })).join(' ').toLowerCase()
    })
  }).filter(function (issue) { return !keyword || issue.searchText.includes(keyword) })
    .sort(function (a, b) { return a.merchant.localeCompare(b.merchant) || a.issueId.localeCompare(b.issueId) })
}

function categorizedEventRows(events, categories, query) {
  const keyword = String(query || '').trim().toLowerCase()
  const names = new Map((categories || []).map(function (category) { return [category.categoryId, category.name] }))
  return (events || []).filter(function (event) {
    return event.categoryId && ['income', 'expense', 'fee'].includes(event.economicNature) &&
      ['ready', 'needs_action', 'posted', 'corrected'].includes(event.status)
  }).map(function (event) {
    return Object.assign({}, eventView(event), {
      categoryName: names.get(event.categoryId) || '分类已设置',
      natureLabel: event.economicNature === 'income' ? '收入' : '支出'
    })
  }).filter(function (event) {
    return !keyword || [event.displayTitle, event.displayMeta, event.categoryName].join(' ').toLowerCase().includes(keyword)
  }).sort(function (a, b) {
    return String(a.localAt || '').localeCompare(String(b.localAt || '')) || String(a.eventId).localeCompare(String(b.eventId))
  })
}

function partitionOpenIssues(issues) {
  return issues.reduce(function (groups, issue) {
    const target = ACCOUNT_ISSUE_TYPES.includes(issue.issueType) ? groups.account : groups.review
    target.push(issue)
    return groups
  }, { account: [], review: [] })
}

// 两个整理视角共享事件集合。问题组和退款比对候选不能替代交易笔数。
function organizerRecordState(events, issues, categories, query) {
  const byId = new Map((events || []).map(function (event) { return [event.eventId, eventView(event)] }))
  const rows = [...byId.values()]
  const active = rows.filter(function (event) { return ['ready', 'needs_action', 'posted'].includes(event.status) })
  const excluded = rows.filter(function (event) { return event.status === 'excluded' })
  const activeIds = new Set(active.map(function (event) { return event.eventId }))
  const open = reviewIssueRows((issues || []).filter(function (issue) {
    return issue.status === 'open' && (issue.blocking || issue.issueType === 'category_assignment')
  }))
  const verificationById = new Map()
  const categoryById = new Map()
  const hydratedIssues = open.map(function (issue) {
    const ids = issue.subjectEventIds && issue.subjectEventIds.length ? issue.subjectEventIds
      : (issue.subjects || (issue.subject ? [issue.subject] : [])).map(function (event) { return event.eventId })
    const subjectIds = [...new Set(ids)].filter(function (id) { return activeIds.has(id) })
    const target = issue.issueType === 'category_assignment' ? categoryById : verificationById
    subjectIds.forEach(function (id) { if (!target.has(id)) target.set(id, issue.issueId) })
    return Object.assign({}, issue, { subjects: subjectIds.map(function (id) { return byId.get(id) }), subjectCount: subjectIds.length })
  })
  const keyword = String(query || '').trim().toLowerCase()
  const matches = function (event) { return !keyword || [event.displayTitle, event.displayMeta, event.categoryName].join(' ').toLowerCase().includes(keyword) }
  const categoryRequired = function (event) { return ['income', 'expense', 'fee', 'unknown'].includes(event.economicNature) || !event.economicNature }
  const names = new Map((categories || []).map(function (category) { return [category.categoryId, category.name] }))
  const annotated = active.map(function (event) {
    const reviewIssueId = verificationById.get(event.eventId) || ''
    const categoryIssueId = categoryById.get(event.eventId) || ''
    const pendingReview = Boolean(reviewIssueId || (event.status === 'needs_action' && !categoryIssueId && !event.localReviewConfirmed))
    const needsCategory = categoryRequired(event) && (!event.categoryId || event.economicNature === 'unknown')
    return Object.assign({}, event, { reviewIssueId: reviewIssueId, categoryIssueId: categoryIssueId,
      pendingReview: pendingReview, needsCategory: needsCategory,
      categoryName: names.get(event.categoryId) || '分类已设置',
      natureLabel: { income: '收入', expense: '支出', fee: '手续费', repayment: '还款', internal_transfer: '内部转账',
        refund: '退款', borrow: '借款', balance_adjustment: '余额调整', unknown: '性质待确认' }[event.economicNature] || '性质待确认'
    })
  })
  const reviewPending = annotated.filter(function (event) { return event.pendingReview })
  const reviewCompleted = annotated.filter(function (event) { return !event.pendingReview })
  const categoryPending = annotated.filter(function (event) { return event.needsCategory })
  const categoryCompleted = annotated.filter(function (event) { return !event.needsCategory && categoryRequired(event) })
  const categoryNone = annotated.filter(function (event) { return !categoryRequired(event) })
  const blockedCategoryIssues = new Set(annotated.filter(function (event) {
    return event.categoryIssueId && event.pendingReview
  }).map(function (event) { return event.categoryIssueId }))
  const duplicateCandidates = rows.filter(function (event) { return event.duplicateEvidenceCount > 0 })
  const duplicateCount = duplicateCandidates.reduce(function (sum, event) { return sum + Number(event.duplicateEvidenceCount) }, 0)
  const summary = { activeCount: active.length, excludedCount: excluded.length, duplicateCount: duplicateCount,
    totalCount: active.length + excluded.length + duplicateCount }
  return {
    summary: summary,
    reviewPendingEvents: reviewPending,
    reviewedEvents: reviewCompleted,
    categoryWaitingEvents: categoryPending.filter(function (event) { return !event.categoryIssueId || blockedCategoryIssues.has(event.categoryIssueId) }).filter(matches),
    categoryDecisionIssues: hydratedIssues.filter(function (issue) {
      return issue.issueType === 'category_assignment' && issue.subjectCount > 0 && !blockedCategoryIssues.has(issue.issueId)
    }),
    categorizedEvents: categoryCompleted.filter(matches),
    noCategoryEvents: categoryNone.filter(matches),
    categoryEventCount: categoryPending.length,
    categorizedEventCount: categoryCompleted.length,
    duplicateCandidates: duplicateCandidates,
    hydratedIssues: hydratedIssues,
    reviewStatusTabs: [
      { value: 'pending', label: '待核对', count: reviewPending.length },
      { value: 'completed', label: '已核对', count: reviewCompleted.length },
      { value: 'excluded', label: '已排除', count: excluded.length },
      { value: 'duplicate', label: '重复', count: duplicateCount }
    ],
    categoryStatusTabs: [
      { value: 'pending', label: '待分类', count: categoryPending.length },
      { value: 'completed', label: '已分类', count: categoryCompleted.length },
      { value: 'none', label: '无需分类', count: categoryNone.length }
    ]
  }
}

function workflowPosition(status, groups) {
  if (status === 'posted' || status === 'undone' || status === 'abandoned') return { currentStep: 4, unlockedStep: 4 }
  if (groups.account.length > 0) return { currentStep: 2, unlockedStep: 2 }
  if (groups.review.length > 0) return { currentStep: 3,
    unlockedStep: groups.review.some(function (issue) { return issue.issueType !== 'category_assignment' && issue.blocking !== false }) ? 3 : 4 }
  return { currentStep: 4, unlockedStep: 4 }
}

function eventView(event) {
  const evidence = event.primaryEvidence || {}
  const displayTitle = [evidence.item, evidence.counterparty].find(function (value) {
    return value && !/^(?:[\s/／—-]+|不详|未知)$/.test(value)
  }) || ({ repayment: '信用卡还款', internal_transfer: '账户转账', refund: '退款', expense: '支出', income: '收入' }[event.economicNature]) || '待确认事件'
  const localAt = String(event.localAt || '')
  const dateText = localAt.slice(0, 16).replace(/^\d{4}-/u, '').replace(' ', ' · ')
  const sourceText = { alipay: '支付宝', wechat: '微信', bank: '银行' }[evidence.sourceType] || ''
  const detailText = evidence.counterparty && evidence.counterparty !== displayTitle ? evidence.counterparty : ''
  return Object.assign({}, event, {
    amountText: amountText(event.amountMinor),
    displayTitle: displayTitle,
    displayMeta: [dateText, detailText, sourceText].filter(Boolean).join(' · '),
    displayDay: /^\d{4}-\d{2}-\d{2}/u.test(localAt) ? localAt.slice(8, 10) : '',
    displayMonth: /^\d{4}-\d{2}-\d{2}/u.test(localAt) ? Number(localAt.slice(5, 7)) + '月' : '',
    displayDetailMeta: [detailText, sourceText].filter(Boolean).join(' · '),
    directionClass: event.flowDirection === 'inflow' ? 'row-income' : event.flowDirection === 'outflow' ? 'row-expense' : ''
  })
}

function accountEvidenceView(event) {
  const view = eventView(event)
  const source = event.primaryEvidence || {}
  return Object.assign({}, view, {
    sourceTime: String(event.localAt || '').slice(0, 16) || '时间待核对',
    sourceParty: source.counterparty || '交易对方未提供',
    sourcePayment: source.paymentMethod || '未标明',
    sourceStatus: source.status || '',
    flowText: { inflow: '流入', outflow: '流出', neutral: '不计收支' }[event.flowDirection] || '方向待核对'
  })
}

function accountRecordList(members) {
  const byId = new Map()
  ;(members || []).forEach(function (member) {
    if (member.event && member.event.eventId) byId.set(member.event.eventId, accountEvidenceView(member.event))
  })
  const records = [...byId.values()].sort(function (a, b) {
    return String(a.localAt || '').localeCompare(String(b.localAt || '')) || a.eventId.localeCompare(b.eventId)
  })
  const dates = records.map(function (record) { return String(record.localAt || '').slice(0, 10) }).filter(Boolean)
  return { records: records, dateRange: dates.length ? dates[0] + (dates[0] === dates[dates.length - 1] ? '' : ' 至 ' + dates[dates.length - 1]) : '时间范围待核对' }
}

function excludedReason(event) {
  const reasons = new Set(event && event.reasonCodes || [])
  if (reasons.has('source_non_financial')) {
    return { key: 'source_non_financial', label: '非资金记录', note: '只保留来源证据，不创建账户或正式账目。', order: 5 }
  }
  if (reasons.has('transaction_closed')) {
    return { key: 'transaction_closed', label: '交易已关闭', note: '账单状态明确为关闭，不会计入账本。', order: 20 }
  }
  if (reasons.has('transaction_failed')) {
    return { key: 'transaction_failed', label: '交易失败', note: '账单状态明确为失败，不会计入账本。', order: 30 }
  }
  if (reasons.has('already_posted')) {
    return { key: 'already_posted', label: '已经入账', note: '相同来源交易已经存在，不会重复入账。', order: 40 }
  }
  if (reasons.has('account_mapping_excluded') || reasons.has('source_account_ignored_default')) {
    const evidence = event && event.primaryEvidence || {}
    const projection = event && event.fundsProjection || {}
    const projectedAccount = projection.from && projection.from.label || projection.to && projection.to.label || ''
    const accountName = String(evidence.paymentMethod || projectedAccount || '该账户').trim()
    return {
      key: 'account:' + String(evidence.sourceType || '') + ':' + normalizePaymentAccountName(accountName),
      label: accountName + '已排除',
      note: '该账户下的这些交易不计入本次账本。',
      order: 10
    }
  }
  if (reasons.has('manual_exclusion')) {
    return { key: 'manual_exclusion', label: '手动排除', note: '整理时选择了不计入本次账本。', order: 50 }
  }
  return { key: 'other_exclusion', label: '其他排除', note: '这些记录不满足本次入账条件。', order: 60 }
}

function excludedEventGroups(events, expandedKeys) {
  const expanded = expandedKeys instanceof Set ? expandedKeys : new Set(expandedKeys || [])
  const groups = new Map()
  ;(events || []).forEach(function (event) {
    const view = eventView(event)
    const reason = excludedReason(view)
    let group = groups.get(reason.key)
    if (!group) {
      group = Object.assign({}, reason, { events: [] })
      groups.set(reason.key, group)
    }
    group.events.push(view)
  })
  return [...groups.values()].sort(function (left, right) {
    return left.order - right.order || left.label.localeCompare(right.label)
  }).map(function (group) {
    group.events.sort(function (left, right) {
      return String(left.localAt || '').localeCompare(String(right.localAt || '')) ||
        String(left.eventId || '').localeCompare(String(right.eventId || ''))
    })
    return Object.assign({}, group, {
      count: group.events.length,
      expanded: expanded.has(group.key)
    })
  })
}

function relationChoiceView(event, relation) {
  const target = eventView(event || {})
  const reasons = relation && relation.reasonCodes || []
  const matchLabel = reasons.includes('refund_exact_reference_candidate')
    ? '订单匹配'
    : reasons.includes('refund_explicit_evidence_candidate')
      ? '退款凭据'
      : reasons.includes('refund_item_evidence_candidate')
        ? '商品匹配待核对'
      : reasons.includes('refund_merchant_evidence_candidate')
        ? '同商户待核对'
        : ''
  return {
    targetEventId: event && event.eventId || relation && relation.targetEventId || '',
    relationId: relation && relation.relationId || '',
    title: target.displayTitle,
    meta: target.displayMeta,
    amountText: target.amountText,
    directionClass: target.directionClass,
    matchLabel: matchLabel
  }
}

function categoriesForNature(categories, nature) {
  const kind = nature === 'income' ? 'income' : ['expense', 'fee'].includes(nature) ? 'expense' : null
  return kind ? categories.filter(function (category) { return category.kind === kind }) : []
}

function eventAccountIds(event) {
  return [...new Set([event.ledgerAccountId, event.counterpartyLedgerAccountId,
    ...((event.paymentResolution && event.paymentResolution.allocations) || []).map(part => part.accountId),
    ...(event.repaymentAllocations || []).map(part => part.accountId)].filter(Boolean))]
}

function finalSummary(events, accountDrafts) {
  const ready = (events || []).filter(function (event) { return event.status === 'ready' })
  let expenseMinor = '0'
  let incomeMinor = '0'
  let refundMinor = '0'
  let categorizedCount = 0
  let categoryCount = 0
  let transferCount = 0
  const accountIds = new Set()
  ready.forEach(function (event) {
    eventAccountIds(event).forEach(id => accountIds.add(id))
    if (['expense', 'fee'].includes(event.economicNature)) expenseMinor = addMinor(expenseMinor, event.amountMinor)
    if (event.economicNature === 'income') incomeMinor = addMinor(incomeMinor, event.amountMinor)
    if (event.economicNature === 'refund') refundMinor = addMinor(refundMinor, event.amountMinor)
    if (['internal_transfer', 'repayment', 'borrow'].includes(event.economicNature)) transferCount += 1
    if (['expense', 'fee', 'income'].includes(event.economicNature)) {
      categoryCount += 1
      if (event.categoryId) categorizedCount += 1
    }
  })
  return {
    expenseCount: ready.filter(event => ['expense', 'fee'].includes(event.economicNature)).length,
    incomeCount: ready.filter(event => event.economicNature === 'income').length,
    refundCount: ready.filter(event => event.economicNature === 'refund').length,
    expenseText: amountText(expenseMinor),
    incomeText: amountText(incomeMinor),
    refundText: amountText(refundMinor),
    transferCount,
    categoryCount,
    categorizedCount,
    categoryCoverageText: categoryCount ? `${categorizedCount} / ${categoryCount}` : '无需分类',
    categoryComplete: categorizedCount === categoryCount,
    newAccountCount: (accountDrafts || []).length,
    affectedAccountCount: accountIds.size
  }
}


function fundsFlowSummary(events, accounts) {
  const accountNames = new Map((accounts || []).map(account => [account.accountId, account.name]))
  return [
    { nature: 'internal_transfer', label: '内部转账' },
    { nature: 'borrow', label: '借款' },
    { nature: 'repayment', label: '还款' }
  ].map(group => {
    let totalMinor = '0'
    const records = (events || []).filter(event => event.status === 'ready' && event.economicNature === group.nature)
      .map(event => {
        totalMinor = addMinor(totalMinor, event.amountMinor)
        const ids = eventAccountIds(event)
        return Object.assign({}, eventView(event), {
          accountText: [...ids].map(id => accountNames.get(id) || '未命名账户').join('、')
        })
      }).sort((a, b) => String(a.localAt || '').localeCompare(String(b.localAt || '')) || String(a.eventId).localeCompare(String(b.eventId)))
    return Object.assign({}, group, { amountText: amountText(totalMinor), count: records.length, records })
  })
}

module.exports = {
  eventAccountIds,
  fundsFlowSummary,
  buildIssueFieldsDraft,
  organizerRecordState,
  categoryIssueCards,
  categorizedEventRows,
  buildPaymentResolutionDraft,
  updatePaymentAmounts,
  bankAccountSuggestion: bankSuggestion.suggest,
  accountEvidenceView,
  accountRecordList,
  ISSUE_LABELS,
  accountChoiceOptions,
  accountSelectorOptions,
  buildRepaymentAllocationDraft,
  filterAccountSelectorOptions,
  amountText,
  categoriesForNature,
  evidenceFields,
  eventView,
  finalSummary,
  excludedEventGroups,
  fileStateText,
  formatFileSize,
  issueView,
  normalizePaymentAccountName,
  partitionOpenIssues,
  relationChoiceView,
  repaymentAllocationOptions,
  reviewIssueGroups,
  reviewIssueRows,
  runWithConcurrency,
  sameFileContent,
  sameFileMetadata,
  suggestExistingAccount,
  paymentResolutionDefaults,
  updateFile,
  uploadSummary,
  workflowPosition,
  yuanInputToMinor
}
