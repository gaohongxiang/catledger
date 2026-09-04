const { ledgerError } = require('./ledger-errors')
const { parseLocalDateTime } = require('./local-time')
const { minorUnitsToString, parseMinorUnits } = require('./money')

const MANUAL_TYPES = new Set(['expense', 'income', 'transfer', 'refund'])

function parseVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw ledgerError('VALIDATION_ERROR')
  }
  return value
}

function normalizeOptionalNote(value) {
  if (value == null || value === '') {
    return null
  }
  if (typeof value !== 'string') {
    throw ledgerError('VALIDATION_ERROR')
  }
  const note = value.normalize('NFKC').trim()
  if (Array.from(note).length > 200) {
    throw ledgerError('VALIDATION_ERROR')
  }
  return note || null
}

function validateId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) {
    throw ledgerError('VALIDATION_ERROR')
  }
  return value
}

function buildManualTransaction(data) {
  if (!MANUAL_TYPES.has(data.type)) {
    throw ledgerError('VALIDATION_ERROR')
  }
  const amount = parseMinorUnits(data.amountMinor)
  const time = parseLocalDateTime(data.occurredLocalAt, data.timezoneOffsetMinutes)
  const note = normalizeOptionalNote(data.note)
  let sourceAccountId = null
  let destinationAccountId = null
  let categoryId = null
  let originalTransactionId = null

  if (data.type === 'expense') {
    sourceAccountId = validateId(data.sourceAccountId)
    categoryId = validateId(data.categoryId)
  } else if (data.type === 'income') {
    destinationAccountId = validateId(data.destinationAccountId)
    categoryId = validateId(data.categoryId)
  } else if (data.type === 'transfer') {
    sourceAccountId = validateId(data.sourceAccountId)
    destinationAccountId = validateId(data.destinationAccountId)
    if (sourceAccountId === destinationAccountId || data.categoryId != null) {
      throw ledgerError('VALIDATION_ERROR')
    }
  } else {
    destinationAccountId = validateId(data.destinationAccountId)
    originalTransactionId = validateId(data.originalTransactionId)
    if (data.sourceAccountId != null || data.categoryId != null) {
      throw ledgerError('VALIDATION_ERROR')
    }
  }

  return {
    type: data.type,
    sourceAccountId,
    destinationAccountId,
    categoryId,
    originalTransactionId,
    amountMinor: amount.toString(),
    note,
    ...time
  }
}

function transactionToPublic(row) {
  return {
    transactionId: row.transactionId,
    type: row.type,
    sourceAccount: row.sourceAccountId == null
      ? null
      : { accountId: row.sourceAccountId, name: row.sourceAccountName || null },
    destinationAccount: row.destinationAccountId == null
      ? null
      : { accountId: row.destinationAccountId, name: row.destinationAccountName || null },
    category: row.categoryId == null
      ? null
      : { categoryId: row.categoryId, name: row.categoryName || null, kind: row.categoryKind || null },
    originalTransaction: row.originalTransactionId == null
      ? null
      : {
          transactionId: row.originalTransactionId,
          amountMinor: row.originalAmountMinor == null ? null : minorUnitsToString(row.originalAmountMinor),
          occurredLocalAt: row.originalOccurredLocalAt == null
            ? null
            : String(row.originalOccurredLocalAt).replace(' ', 'T'),
          note: row.originalNote == null ? null : row.originalNote
        },
    refundLinkStatus: row.type === 'refund'
      ? (row.originalTransactionId == null ? 'pending' : 'linked')
      : null,
    editable: row.origin == null || row.origin === 'manual',
    canLinkRefund: row.type === 'refund' && row.originalTransactionId == null,
    amountMinor: minorUnitsToString(row.amountMinor),
    occurredLocalAt: String(row.occurredLocalAt).replace(' ', 'T'),
    timezoneOffsetMinutes: Number(row.timezoneOffsetMinutes),
    note: row.note == null ? null : row.note,
    version: Number(row.version)
  }
}

module.exports = {
  MANUAL_TYPES,
  buildManualTransaction,
  parseVersion,
  transactionToPublic,
  validateId
}
