const { digestParts } = require('./digest')

const VERSION = 'excluded-event-groups-v2'
const UNKNOWN_ACCOUNTS = new Set(['未提供', '未填写', '未注明', '未标明', '未知', '不详', '无', '暂无', '该账户',
  '待确认', '未识别', '未知账户', '未知支付方式', '微信支付方式未标明', '支付宝支付方式未标明', '银行账户未标明', 'na', 'null', 'undefined'])

// 与工作台账户归组沿用同一规范化规则；来源类型仍是账户身份的一部分。
function normalizePaymentAccountName(value) {
  let normalized = String(value || '').replace(/\u3000/g, ' ').replace(/[\uff01-\uff5e]/g,
    character => String.fromCharCode(character.charCodeAt(0) - 0xfee0)).normalize('NFKC').trim().toLowerCase()
  normalized = normalized.replace(/(?:末四位|后四位|尾号|卡号)/g, '').replace(/[xX*＊•·]{2,}/g, '')
  normalized = normalized.replace(/\d{8,}/g, digits => digits.slice(-4))
  return normalized.replace(/[^0-9a-z\u3400-\u4dbf\u4e00-\u9fff]+/g, '')
}

function groupId(key) {
  const digest = digestParts(VERSION, key)
  return digest.slice(0, 8) + '-' + digest.slice(8, 12) + '-5' + digest.slice(13, 16)
    + '-8' + digest.slice(17, 20) + '-' + digest.slice(20, 32)
}

function reasonFor(row) {
  const reasons = new Set(row.reasonCodes || [])
  // 只有整账户排除决定才按账户归组；支付账户名称不能替代自动排除原因。
  if (reasons.has('account_mapping_excluded') || reasons.has('source_account_ignored_default')) {
    for (const candidate of [row.paymentMethod, row.fromLabel, row.toLabel]) {
      const accountName = String(candidate || '').trim(), normalized = normalizePaymentAccountName(accountName)
      if (normalized && !UNKNOWN_ACCOUNTS.has(normalized)) return {
        key: 'account:' + String(row.sourceType || '') + ':' + normalized,
        label: accountName, note: '这些记录按账户排除规则不计入本次账本。'
      }
    }
    return { key: 'account_mapping_excluded', label: '账户已排除', note: '这些记录按账户排除决定不计入本次账本。' }
  }
  if (reasons.has('source_non_financial')) return { key: 'source_non_financial', label: '非资金记录', note: '只保留来源证据，不创建账户或正式账目。' }
  if (reasons.has('transaction_closed')) return { key: 'transaction_closed', label: '交易关闭', note: '账单状态明确为关闭，不会计入账本。' }
  if (reasons.has('transaction_failed')) return { key: 'transaction_failed', label: '交易失败', note: '账单状态明确为失败，不会计入账本。' }
  if (reasons.has('already_posted')) return { key: 'already_posted', label: '已经入账', note: '相同来源交易已经存在，不会重复入账。' }
  if (reasons.has('manual_exclusion')) return { key: 'manual_exclusion', label: '手动排除', note: '整理时选择了不计入本次账本。' }
  return { key: 'other_exclusion', label: '其他排除', note: '这些记录不满足本次入账条件。' }
}

function groupFor(row) {
  const reason = reasonFor(row), id = groupId(reason.key)
  // 摘要仅传账户标题和固定说明；原始记录及完整成员 ID 留在独立分页读取中。
  const label = reason.label.length > 160 ? reason.label.slice(0, 159) + '…' : reason.label
  return { groupId: id, key: id, label, note: reason.note }
}

module.exports = { VERSION, groupFor }
