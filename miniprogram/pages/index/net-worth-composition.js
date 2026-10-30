// 首页净值卡的资产／负债构成：只做展示派生，不改账务数据，也不参与余额计算。
// 金额一律走 BigInt，避免浮点在占比上抖动；百分比用最大余数法分配，保证总和恰为 100。
const SEGMENT_LIMIT = 5
const OTHER_TONE = 'mix-tone-other'

// 账户名在图例里只有一行的位置：先去尾号括号，再截断到 6 个字。
// 账户全名始终在「账户余额」卡里，这里只求可辨认。
function shortAccountName(name) {
  const text = String(name == null ? '' : name).trim()
  if (!text) return '账户'
  const trimmed = text.replace(/[（(]\s*[0-9]{2,}\s*[)）]\s*$/u, '').trim() || text
  const characters = Array.from(trimmed)
  return characters.length > 6 ? characters.slice(0, 6).join('') + '…' : trimmed
}

function absMinor(value) {
  const text = String(value == null ? '0' : value).trim()
  if (!/^-?\d+$/.test(text)) return 0n
  const parsed = BigInt(text)
  return parsed < 0n ? -parsed : parsed
}

// 最大余数法：先取整，再把剩下的余量按小数部分从大到小补回去。
function distribute(items, total, scale) {
  if (total <= 0n) return items.map(() => 0)
  const unit = BigInt(scale)
  const shares = items.map(item => Number((item.minor * unit) / total))
  const remainders = items.map((item, index) => ({ index: index, rest: (item.minor * unit) % total }))
  remainders.sort((left, right) => (right.rest > left.rest ? 1 : right.rest < left.rest ? -1 : left.index - right.index))
  let left = scale - shares.reduce((sum, share) => sum + share, 0)
  for (let index = 0; left > 0 && index < remainders.length; index += 1, left -= 1) {
    shares[remainders[index].index] += 1
  }
  return shares
}

function side(accounts, isLiability) {
  const items = []
  ;(Array.isArray(accounts) ? accounts : []).forEach(account => {
    if (!account) return
    if ((account.nature === 'liability') !== isLiability) return
    // 0 元账户不进构成条：它既不占据宽度，也不该被算成「其他」里的一个。
    // 归档账户保留——总资产／总负债一直按它们求和，条不能和总额对不上。
    const minor = absMinor(account.bookBalanceMinor)
    if (minor === 0n) return
    items.push({ accountId: account.accountId || account.name, name: shortAccountName(account.name), minor: minor })
  })
  items.sort((left, right) => (right.minor > left.minor ? 1 : right.minor < left.minor ? -1 : 0))

  const total = items.reduce((sum, item) => sum + item.minor, 0n)
  const permille = distribute(items, total, 1000)
  const percent = distribute(items, total, 100)

  const legend = items.map((item, index) => ({
    accountId: item.accountId,
    name: item.name,
    percentText: percent[index] > 0 ? percent[index] + '%' : '<1%',
    tone: index < SEGMENT_LIMIT ? 'mix-tone-' + (index + 1) : OTHER_TONE
  }))

  // 条最多 6 段：前 5 名各占一色，其余并成一段灰；图例仍逐个列出，只是共用灰点。
  const bar = items.slice(0, SEGMENT_LIMIT).map((item, index) => ({
    accountId: item.accountId,
    permille: permille[index],
    tone: 'mix-tone-' + (index + 1)
  }))
  if (items.length > SEGMENT_LIMIT) {
    bar.push({
      accountId: 'other',
      permille: permille.slice(SEGMENT_LIMIT).reduce((sum, share) => sum + share, 0),
      tone: OTHER_TONE
    })
  }

  return { totalMinor: total.toString(), items: legend, bar: bar, empty: items.length === 0 }
}

function composition(accounts) {
  return {
    assets: side(accounts, false),
    liabilities: side(accounts, true)
  }
}

module.exports = { composition, shortAccountName }
