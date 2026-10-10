// 已持久化的人工字段位；调整存放位置不能改变既有位值。
const FIELD_MASK = Object.freeze({
  ledgerAccountId: 1 << 0,
  counterpartyLedgerAccountId: 1 << 1,
  flowDirection: 1 << 2,
  economicNature: 1 << 3,
  occurredLocalAt: 1 << 4,
  amountMinor: 1 << 5,
  currency: 1 << 6,
  categoryId: 1 << 7,
  repaymentAllocations: 1 << 8,
  paymentResolution: 1 << 9,
  paymentAccounts: 1 << 10,
  repaymentOwnership: 1 << 11,
  counterparty: 1 << 12,
  note: 1 << 13,
  sourceCorrection: 1 << 14
})

module.exports = { FIELD_MASK }
