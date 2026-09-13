const { ledgerError } = require('./ledger-errors')
const { parseMinorUnits } = require('./money')
const { parseLocalDateTime } = require('./local-time')
const { validateId, parseVersion, buildManualTransaction } = require('./transaction-domain')
const MAX_ALLOCATIONS = 20
function paymentInput(data) {
  if (data.confirmed !== true || !['drawdown','repayment'].includes(data.kind) || !['new'].includes(data.mode)) throw ledgerError('VALIDATION_ERROR')
  if (!Array.isArray(data.allocations) || !data.allocations.length || data.allocations.length > MAX_ALLOCATIONS) throw ledgerError('VALIDATION_ERROR')
  const totalMinor = parseMinorUnits(data.totalMinor).toString(), ids = new Set()
  const allocations = data.allocations.map(item => {
    const loanId = validateId(item.loanId), version = parseVersion(item.version)
    if (ids.has(loanId)) throw ledgerError('VALIDATION_ERROR')
    ids.add(loanId)
    const value = { loanId, version }
    for (const field of ['principalMinor','interestMinor','feeMinor']) value[field] = parseMinorUnits(item[field], { allowZero: true }).toString()
    if (BigInt(value.principalMinor) + BigInt(value.interestMinor) + BigInt(value.feeMinor) === 0n) throw ledgerError('VALIDATION_ERROR')
    for (const field of ['interest','fee']) {
      const treatment = item[field + 'Treatment']
      if (!['expense','accrued'].includes(treatment)) throw ledgerError('VALIDATION_ERROR')
      value[field + 'Treatment'] = treatment
      value[field + 'CategoryId'] = treatment === 'expense' && value[field + 'Minor'] !== '0' ? validateId(item[field + 'CategoryId']) : null
    }
    if (data.kind === 'drawdown' && (value.interestMinor !== '0' || value.feeMinor !== '0')) throw ledgerError('VALIDATION_ERROR')
    return value
  })
  const sum = allocations.reduce((total, a) => total + BigInt(a.principalMinor) + BigInt(a.interestMinor) + BigInt(a.feeMinor), 0n)
  if (sum !== BigInt(totalMinor)) throw ledgerError('VALIDATION_ERROR')
  return { mode: data.mode, kind: data.kind, totalMinor, assetAccountId: validateId(data.assetAccountId), allocations,
    ...parseLocalDateTime(data.occurredLocalAt, data.timezoneOffsetMinutes) }
}
function paymentDrafts(input, loans) {
  const drafts = []
  const make = (amount, fields) => {
    if (amount === 0n) return
    drafts.push(buildManualTransaction({ ...fields, amountMinor: amount.toString(), occurredLocalAt: input.localAt.replace(' ', 'T'),
      timezoneOffsetMinutes: input.timezoneOffsetMinutes, note: input.kind === 'drawdown' ? '贷款放款' : '贷款还款' }))
  }
  for (const a of input.allocations) {
    const loan = loans.get(a.loanId)
    if (input.kind === 'drawdown') {
      if (loan.kind !== 'borrowing') throw ledgerError('VALIDATION_ERROR')
      make(BigInt(a.principalMinor), { type: 'transfer', sourceAccountId: loan.accountId, destinationAccountId: input.assetAccountId })
      continue
    }
    let transfer = BigInt(a.principalMinor)
    for (const field of ['interest','fee']) {
      if (a[field + 'Treatment'] === 'accrued') transfer += BigInt(a[field + 'Minor'])
      else make(BigInt(a[field + 'Minor']), { type: 'expense', sourceAccountId: input.assetAccountId, categoryId: a[field + 'CategoryId'] })
    }
    make(transfer, { type: 'transfer', sourceAccountId: input.assetAccountId, destinationAccountId: loan.accountId })
  }
  return drafts
}
module.exports = { MAX_ALLOCATIONS, paymentInput, paymentDrafts }
