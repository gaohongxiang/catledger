const { digestParts } = require('./digest')
const { paymentAccountDetails } = require('./payment-account')

const IDENTITY_VERSION = 'source-identity-v1'
const PHYSICAL_IDENTITY_VERSION = 'physical-identity-v1'
const CORE_DIGEST_VERSION = 'source-core-v1'
const PAYMENT_METHOD_VERSION = 'payment-method-v1'
const SOURCE_PROFILE_VERSION = 'source-profile-v1'

function normalizeIdentifier(value) {
  return String(value || '').normalize('NFKC').trim().replace(/^'+/, '')
}

function looksMasked(value) {
  return /[*＊•·xX]{2,}/.test(value)
}

function stableIdentity(row) {
  const transactionId = normalizeIdentifier(row.identifiers.transactionId)
  if (transactionId && !looksMasked(transactionId)) {
    return { kind: 'source_transaction_id', values: [transactionId] }
  }

  const orderId = normalizeIdentifier(row.identifiers.orderId)
  const merchantOrderId = normalizeIdentifier(row.identifiers.merchantOrderId)
  if (orderId && merchantOrderId && !looksMasked(orderId) && !looksMasked(merchantOrderId)) {
    return { kind: 'order_combination', values: [orderId, merchantOrderId] }
  }
  return null
}

function buildSourceProfile({ sourceType, candidate }) {
  const normalized = normalizeIdentifier(candidate && candidate.identifier)
  const displayName = normalizeIdentifier(candidate && candidate.displayName).slice(0, 128)
  const material = candidate && candidate.kind === 'stable_identifier' && normalized
    ? normalized
    : 'unbound'
  return {
    profileKey: digestParts(SOURCE_PROFILE_VERSION, sourceType, material),
    keyVersion: SOURCE_PROFILE_VERSION,
    maskedDisplayName: displayName || null
  }
}

function buildRowIdentity({ sourceType, sourceProfileKey, fileSha256, row }) {
  const stable = stableIdentity(row)
  const kind = stable ? stable.kind : 'physical_record'
  const version = stable ? IDENTITY_VERSION : PHYSICAL_IDENTITY_VERSION
  const values = stable ? stable.values : [fileSha256, row.sourceLocator]
  const identityKey = digestParts(version, sourceType, sourceProfileKey, kind, ...values)
  const coreDigest = digestParts(
    CORE_DIGEST_VERSION,
    row.normalized.amountMinor,
    row.normalized.currency,
    row.normalized.direction,
    row.normalized.economicEffect
  )
  return {
    kind,
    identityKey,
    coreDigest,
    identityVersion: version,
    coreDigestVersion: CORE_DIGEST_VERSION
  }
}

function buildPaymentMethodKey(sourceType, paymentMethod) {
  const account = paymentAccountDetails(sourceType, paymentMethod)
  if (!account.identityMaterial) return null
  return digestParts(PAYMENT_METHOD_VERSION, sourceType, account.identityMaterial)
}

module.exports = {
  buildPaymentMethodKey,
  buildRowIdentity,
  buildSourceProfile,
  normalizeIdentifier
}
