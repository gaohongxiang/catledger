const model = require('./model')
const presentation = require('./presentation')

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
  const records = selected.map(event => {
    const view = model.eventView(event)
    const leaf = view.categoryName || ''
    const parent = view.parentCategoryName || ''
    const categoryName = !leaf ? '' : !parent || leaf === parent || leaf.startsWith(parent + ' / ') ? leaf : parent + ' / ' + leaf
    const categoryKind = event.economicNature === 'income' ? 'income' : ['expense', 'fee'].includes(event.economicNature) ? 'expense' : ''
    return Object.assign({}, view, {
      categoryName,
      accountText: model.eventAccountIds(event).map(id => names.get(id) || '未命名账户').join('、'),
      // 确认页的未分类就地补分类。性质未定的仍回第三步，避免猜错收入或支出目录。
      ...(kind === 'uncategorized' && categoryKind && event.version ? { version: event.version, categoryKind } : {})
    })
  }).sort((a, b) => String(a.localAt || '').localeCompare(String(b.localAt || '')) || String(a.eventId).localeCompare(String(b.eventId)))
  return { kind, accountId: accountId || '', title: kind === 'account' ? names.get(accountId) || TITLES.account : TITLES[kind],
    mode: 'records', count: records.length, records, accounts: [] }
}

function presentAccountRows(items) {
  return (items || []).map(account => ({
    accountId: account.accountId,
    name: account.name || '未命名账户',
    typeLabel: ACCOUNT_TYPES[account.type] || account.typeLabel || '账户',
    isDraft: Boolean(account.isDraft),
    count: Number(account.count) || 0
  }))
}

// 列表投影会丢掉版本和分类方向，未分类行要留着，才能在确认页直接选。
function presentFinalRecord(event) {
  const row = presentation.record(event)
  if (!event.categoryKind || !event.version) return row
  return Object.assign({}, row, { version: event.version, categoryKind: event.categoryKind })
}

module.exports = { buildFinalDetail, presentAccountRows, presentFinalRecord, TITLES }
