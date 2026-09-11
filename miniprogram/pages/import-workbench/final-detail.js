const model = require('./model')

const TITLES = {
  expense: '本批支出', income: '本批收入', refund: '本批退款',
  internal_transfer: '内部转账', borrow: '借款', repayment: '还款',
  new_accounts: '新建账户', affected_accounts: '受影响账户', all: '本次入账',
  categorized: '已分类', uncategorized: '未分类', no_category: '无需分类', account: '账户关联交易'
}
const ACCOUNT_TYPES = { cash: '现金', bank: '银行卡', wallet: '平台钱包', credit: '信用卡 / 消费信贷',
  other_asset: '其他资产', other_liability: '其他负债' }

function buildFinalDetail(kind, data, accountId) {
  if (!TITLES[kind]) return null
  const events = data.events || []
  const ready = events.filter(event => event.status === 'ready')
  const drafts = data.accountDrafts || []
  const accounts = [...(data.accounts || []), ...drafts]
  const names = new Map(accounts.map(account => [account.accountId, account.name]))
  const affected = new Set(ready.flatMap(model.eventAccountIds))
  if (kind === 'new_accounts' || kind === 'affected_accounts') {
    const unique = new Map((kind === 'new_accounts' ? drafts : accounts.filter(account => affected.has(account.accountId)))
      .map(account => [account.accountId, account]))
    // 账户已归档或暂不在选项中时也保留对应项，使列表数量与汇总一致。
    if (kind === 'affected_accounts') affected.forEach(id => { if (!unique.has(id)) unique.set(id, { accountId: id, name: '未命名账户' }) })
    const rows = [...unique.values()].map(account => ({ accountId: account.accountId, name: account.name,
      typeLabel: ACCOUNT_TYPES[account.type] || '账户', isDraft: drafts.some(draft => draft.accountId === account.accountId),
      count: ready.filter(event => model.eventAccountIds(event).includes(account.accountId)).length }))
    return { kind, title: TITLES[kind], mode: 'accounts', count: rows.length, accounts: rows, records: [] }
  }
  const state = model.organizerRecordState(events, data.issues || [], data.categories || [])
  const annotated = state.reviewedEvents.concat(state.reviewPendingEvents)
  let selected
  if (kind === 'all') selected = annotated
  else if (kind === 'categorized') selected = state.categorizedEvents
  else if (kind === 'uncategorized') selected = annotated.filter(event => event.needsCategory)
  else if (kind === 'no_category') selected = state.noCategoryEvents
  else if (kind === 'account') selected = ready.filter(event => model.eventAccountIds(event).includes(accountId))
  else selected = ready.filter(event => kind === 'expense' ? ['expense', 'fee'].includes(event.economicNature) : event.economicNature === kind)
  const records = selected.map(event => Object.assign({}, model.eventView(event), {
    accountText: model.eventAccountIds(event).map(id => names.get(id) || '未命名账户').join('、')
  })).sort((a, b) => String(a.localAt || '').localeCompare(String(b.localAt || '')) || String(a.eventId).localeCompare(String(b.eventId)))
  return { kind, accountId: accountId || '', title: kind === 'account' ? names.get(accountId) || TITLES.account : TITLES[kind],
    mode: 'records', count: records.length, records, accounts: [] }
}

module.exports = { buildFinalDetail }
