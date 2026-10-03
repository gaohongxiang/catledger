// 服务端保存合并前人工字段；原始账单仍只在来源表，快照不向列表返回。
function mergeOrigins(events) {
  return events.flatMap(event => event.fieldSources.mergeOrigins || [{
    rowIds: event.relationEvidence ? event.relationEvidence.rows.map(row => row.rowId) : event.fieldSources.rowIds || [],
    event: Object.fromEntries(['flowDirection', 'economicNature', 'ledgerAccountId', 'counterpartyLedgerAccountId',
      'localDate', 'localAt', 'utcAt', 'timezoneOffsetMinutes', 'amountMinor', 'currency', 'categoryId',
      'manualFieldMask', 'fieldSources', 'reasonCodes'].map(key => [key, event[key]]))
  }])
}

module.exports = { mergeOrigins }
