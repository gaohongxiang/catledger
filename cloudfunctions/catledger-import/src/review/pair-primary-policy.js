const { VERSION, bankChannelPair } = require('../bank-channel-matching')
const { importError } = require('../errors')
function ordinaryPrimary(hydrated, requestedId, actionId, accountContexts = null) {
  const platforms = hydrated.filter(event => ['wechat', 'alipay'].includes(event.sourceType))
  const banks = hydrated.filter(event => event.sourceType === 'bank')
  // 还款通过专用配对合并保留到账与扣款两侧事实，不能沿用普通消费的等额合并。
  if (hydrated.some(event => event.economicNature === 'repayment')) throw importError('VALIDATION_ERROR')
  // 多个平台或多笔银行候选不能一次合成一笔；交给独立记录裁决。
  if (platforms.length !== 1 || banks.length !== 1 || hydrated.length !== 2 || !bankChannelPair(banks[0], platforms[0])) throw importError('VALIDATION_ERROR')
  const primary = require('../editor-fields').mergeText(platforms[0], hydrated)
  accountContexts = accountContexts || { ...primary.fieldSources.bankChannelAccountContexts }
  if (primary.eventId !== requestedId) throw importError('VALIDATION_ERROR')
  const bankCategoryChosen = Boolean(banks[0].manualFieldMask & 128)
  if (bankCategoryChosen && (primary.manualFieldMask & 128) && banks[0].categoryId !== primary.categoryId) throw importError('VALIDATION_ERROR')
  if (banks[0].economicNature !== 'unknown' && banks[0].economicNature !== primary.economicNature) throw importError('VALIDATION_ERROR')
  const primaryRows = primary.relationEvidence.rows
  const bankRows = banks[0].relationEvidence.rows
  return { ...primary, categoryId: bankCategoryChosen ? banks[0].categoryId : primary.categoryId || banks[0].categoryId,
    manualFieldMask: primary.manualFieldMask | (banks[0].manualFieldMask & 128),
    fieldSources: { ...primary.fieldSources, bankChannelCandidate: undefined,
    mergeOrigins: require('./merge-origins').mergeOrigins(hydrated),
    bankChannelAccountContexts: accountContexts,
    rowIds: primaryRows.concat(bankRows).map(row => row.rowId),
    bankChannelResolution: { version: VERSION, actionId, ledgerAccountId: primary.ledgerAccountId,
      primaryRowId: primaryRows[0].rowId, explainedBankRowIds: bankRows.map(row => row.rowId) } } }
}
const channel = require('../repayment-channel')
const { mergeText } = require('../editor-fields')
const { FIELD_MASK } = require('../manual-field-mask')
const { mergeOrigins } = require('./merge-origins')
function repaymentPrimary(pair, actionId) {
  const facts = channel.pairFacts(pair.bank, pair.platform)
  if (!facts) throw importError('VALIDATION_ERROR')
  const bankRows = pair.bank.relationEvidence.rows, platformRows = pair.platform.relationEvidence.rows
  const primary = mergeText(pair.platform, [pair.bank, pair.platform])
  const projection = primary.fieldSources.fundsProjection
  const bankReference = pair.bank.fieldSources.ledgerAccountReference
  if (!projection || !projection.from || !bankReference || !bankReference.paymentMethodKey) throw importError('VALIDATION_ERROR')
  const resolution = { version: channel.VERSION, confirmedBy: 'user', repaymentConfirmed: false, actionId,
    totalMinor: facts.totalMinor, repaymentMinor: facts.repaymentMinor, feeMinor: facts.feeMinor,
    targetAccountId: facts.targetAccountId, feeCategoryId: null,
    localAt: primary.localAt, utcAt: primary.utcAt, platformType: platformRows[0].sourceType,
    platformTargetReference: projection.to || null,
    bankRowIds: bankRows.map(row => row.rowId), platformRowIds: platformRows.map(row => row.rowId),
    basisDigest: channel.evidenceDigest(bankRows.concat(platformRows)) }
  const next = { ...primary, counterpartyLedgerAccountId: facts.targetAccountId,
    manualFieldMask: primary.manualFieldMask | FIELD_MASK.counterpartyLedgerAccountId | FIELD_MASK.repaymentOwnership,
    fieldSources: { ...primary.fieldSources, bankChannelCandidate: undefined,
      mergeOrigins: mergeOrigins([pair.bank, pair.platform]),
      rowIds: platformRows.concat(bankRows).map(row => row.rowId),
      fundsProjection: { ...projection, to: { ...bankReference, role: 'repayment_target' } },
      repaymentOwnership: { version: 'repayment-ownership-v2', confirmedBy: 'user', owner: 'self' },
      repaymentChannelResolution: resolution },
    reasonCodes: primary.reasonCodes.filter(reason => !['repayment_account_required', 'repayment_ownership_required'].includes(reason)) }
  if (!channel.evidenceValid(next, bankRows.concat(platformRows))) throw importError('VALIDATION_ERROR')
  return next
}
module.exports = { ordinaryPrimary, repaymentPrimary }
