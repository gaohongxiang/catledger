async function nativePageCheck() {
  var page = getCurrentPages().slice(-1)[0]
  await Promise.all(['_prepareLoad', '_transactionsLoad', '_statisticsLoad', '_profileLoad', '_catalogLoad', '_accountsLoad', '_loadTask']
    .map(function(key) { return page[key] }).filter(function(value) { return value && typeof value.then === 'function' })
    .map(function(value) { return value.catch(function() {}) }))
  var data = page.data, errors = {}
  Object.keys(data).forEach(function(key) { if (/error/i.test(key) && typeof data[key] === 'string' && data[key]) errors[key] = data[key] })
  return { route: page.route, errors: errors, loading: !!data.loading, preparing: !!data.preparing, hasLoaded: data.hasLoaded,
    pageDataBytes: unescape(encodeURIComponent(JSON.stringify(data))).length,
    accounts: Array.isArray(data.accounts) ? data.accounts.length : undefined,
    transactions: Array.isArray(data.transactions) ? data.transactions.length : undefined,
    formReady: data.formReady, catalogReady: data.catalogReady,
    trendEndMonth: data.cashFlowTrend && data.cashFlowTrend.length ? data.cashFlowTrend[data.cashFlowTrend.length - 1].month : undefined,
    month: data.month }
}
