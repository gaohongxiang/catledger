const { digestParts } = require('./digest')
const { RELATION_KEY_VERSION } = require('./domain-versions')
const { ECONOMIC_NATURE, EVENT_STATUS, RELATION_TYPE, RELATION_STATUS, unique, evaluatePostability } = require('./organizer-model')
const { timeValue, normalizedText, STRONG_REFERENCE_WINDOW_MS } = require('./evidence-matching')
const { autoReasonCode, candidateReasonCode, createRefundCandidateIndex } = require('./refund-relation-policy')
const SAME_EVENT_CANDIDATE_WINDOW_MS = 48 * 60 * 60 * 1000

function refundRelation(updateId, refund, target, idFactory, status, reasonCode) {
  return {
    relationId: idFactory(),
    updateId,
    relationKey: digestParts(RELATION_KEY_VERSION, RELATION_TYPE.REFUND_OF, refund.eventKey, target.eventKey),
    relationKeyVersion: RELATION_KEY_VERSION,
    relationType: RELATION_TYPE.REFUND_OF,
    status,
    version: 1,
    sourceEventId: refund.eventId,
    targetEventId: target.eventId,
    amountMinor: refund.amountMinor,
    currency: refund.currency,
    manual: false,
    reasonCodes: [reasonCode]
  }
}

function sameEventCandidateGroups(events) {
  const conflicts = new Map()
  events.forEach(event => {
    const key = event.fieldSources && event.fieldSources.evidenceGroupConflictKey
    if (!key || event.status === EVENT_STATUS.EXCLUDED) return
    if (!conflicts.has(key)) conflicts.set(key, [])
    conflicts.get(key).push(event)
  })
  const result = [...conflicts].map(([candidateKey, events]) => {
    events.forEach(event => { event.sameEventCandidateKey = candidateKey })
    return { candidateKey, events }
  })
  const buckets = new Map()
  events.forEach((event) => {
    if (event.status === EVENT_STATUS.EXCLUDED || event.sameEventCandidateKey) return
    const key = `${event.amountMinor || ''}|${event.currency}|${event.flowDirection}`
    const bucket = buckets.get(key) || []
    bucket.push(event)
    buckets.set(key, bucket)
  })
  buckets.forEach((bucket) => {
    // 同来源记录本来就不参与相似候选比较；按来源索引避免同额普通账单的平方扫描。
    const bySource = new Map()
    for (const candidate of bucket) {
      if (!bySource.has(candidate.sourceType)) bySource.set(candidate.sourceType, [])
      bySource.get(candidate.sourceType).push(candidate)
    }
    if (bySource.size < 2) return
    const alternatives = new Map([...bySource.keys()].map(source => [source, bucket.filter(event => event.sourceType !== source)]))
    const facts = new Map(bucket.map(event => [event.eventId, { text: normalizedText(event.display), time: timeValue(event.utcAt) }]))
    const available = new Set(bucket.map((event) => event.eventId))
    for (const event of bucket) {
      if (!available.has(event.eventId)) continue
      const text = facts.get(event.eventId).text
      const currentTime = facts.get(event.eventId).time
      const candidates = alternatives.get(event.sourceType).filter((candidate) => {
        if (!available.has(candidate.eventId) || candidate.eventId === event.eventId) return false
        if (candidate.sourceType === event.sourceType) return false
        const candidateTime = facts.get(candidate.eventId).time
        if (currentTime == null || candidateTime == null || Math.abs(currentTime - candidateTime) > SAME_EVENT_CANDIDATE_WINDOW_MS) return false
        const candidateText = facts.get(candidate.eventId).text
        return text.length >= 2 && candidateText.length >= 2 &&
          (text === candidateText || text.includes(candidateText) || candidateText.includes(text))
      })
      if (candidates.length === 0) continue
      const group = [event, ...candidates]
      group.forEach((candidate) => available.delete(candidate.eventId))
      const candidateKey = digestParts('same-event-candidate-v2', ...group.map((candidate) => candidate.eventKey).sort())
      group.forEach((candidate) => {
        candidate.sameEventCandidateKey = candidateKey
        candidate.status = EVENT_STATUS.NEEDS_ACTION
        candidate.reasonCodes = unique([...candidate.reasonCodes, 'same_event_candidate', 'relation_ambiguous'])
      })
      result.push({ candidateKey, events: group })
    }
  })
  return result
}

function buildRelations(updateId, events, idFactory) {
  const relations = []
  const chronological = [...events].sort((left, right) => (timeValue(left.utcAt) || 0) - (timeValue(right.utcAt) || 0))
  const uniqueRefundMatches = []
  const refundIndex = chronological.some(event => event.economicNature === ECONOMIC_NATURE.REFUND) ? createRefundCandidateIndex() : null
  chronological.forEach((event) => {
    if (event.status === EVENT_STATUS.EXCLUDED) return
    if (event.economicNature === ECONOMIC_NATURE.REFUND) {
      const selection = refundIndex.select(event)
      const candidates = selection.candidates
      if (candidates.length === 0) {
        event.status = EVENT_STATUS.NEEDS_ACTION
        event.reasonCodes = unique([...event.reasonCodes, 'refund_relation_required'])
      } else if (selection.autoConfirm) {
        uniqueRefundMatches.push({ refund: event, target: candidates[0].event, matchKind: candidates[0].matchKind })
      } else {
        candidates.forEach((candidate) => {
          relations.push(refundRelation(updateId, event, candidate.event, idFactory, RELATION_STATUS.PROPOSED,
            candidateReasonCode(candidate.matchKind)))
        })
        event.status = EVENT_STATUS.NEEDS_ACTION
        event.reasonCodes = unique([...event.reasonCodes,
          candidates.length > 1 ? 'refund_relation_ambiguous' : 'refund_relation_required'])
      }
    }
    if (refundIndex) refundIndex.add(event)
  })

  const refundsByOriginal = new Map()
  uniqueRefundMatches.forEach((match) => {
    const matches = refundsByOriginal.get(match.target.eventId) || []
    matches.push(match)
    refundsByOriginal.set(match.target.eventId, matches)
  })
  refundsByOriginal.forEach((matches) => {
    const target = matches[0].target
    const total = matches.reduce((sum, match) => sum + BigInt(match.refund.amountMinor), 0n)
    const safe = target.amountMinor != null && total <= BigInt(target.amountMinor)
    matches.forEach((match) => {
      if (!safe) {
        relations.push(refundRelation(updateId, match.refund, match.target, idFactory, RELATION_STATUS.PROPOSED, 'refund_amount_exceeded'))
        match.refund.status = EVENT_STATUS.NEEDS_ACTION
        match.refund.reasonCodes = unique([...match.refund.reasonCodes, 'refund_amount_exceeded'])
        return
      }
      const relation = refundRelation(updateId, match.refund, match.target, idFactory, RELATION_STATUS.CONFIRMED,
        autoReasonCode(match.matchKind))
      relations.push(relation)
      match.refund.reasonCodes = unique(match.refund.reasonCodes
        .filter((reason) => !['refund_relation_required', 'refund_relation_ambiguous', 'relation_ambiguous'].includes(reason))
        .concat(autoReasonCode(match.matchKind)))
      const evaluated = evaluatePostability(match.refund, { relations: [relation] })
      match.refund.status = evaluated.status
      match.refund.reasonCodes = unique([...match.refund.reasonCodes, ...evaluated.reasonCodes])
    })
  })

  const movementEvents = chronological.filter((event) => (
    [ECONOMIC_NATURE.INTERNAL_TRANSFER, ECONOMIC_NATURE.REPAYMENT, ECONOMIC_NATURE.BORROW].includes(event.economicNature) &&
    event.status !== EVENT_STATUS.EXCLUDED
  ))
  const nextByAmount = new Map(), movementCandidates = new Map()
  // 已按时间排序；同币种/金额的首个后续有效时间即原 find 的候选，超窗后更晚记录也不合格。
  for (let index = movementEvents.length - 1; index >= 0; index--) {
    const event = movementEvents[index], time = timeValue(event.utcAt)
    if (time == null) continue
    const key = JSON.stringify([event.currency, String(event.amountMinor)])
    const next = nextByAmount.get(key)
    if (next && Math.abs(time - next.time) <= STRONG_REFERENCE_WINDOW_MS) movementCandidates.set(event, next.event)
    nextByAmount.set(key, { event, time })
  }
  movementEvents.forEach((event) => {
    const candidate = movementCandidates.get(event)
    if (!candidate) return
    const relationType = event.economicNature === ECONOMIC_NATURE.REPAYMENT || candidate.economicNature === ECONOMIC_NATURE.REPAYMENT
      ? RELATION_TYPE.REPAYMENT_OF
      : RELATION_TYPE.TRANSFER_BETWEEN
    relations.push({
      relationId: idFactory(),
      updateId,
      relationKey: digestParts(RELATION_KEY_VERSION, relationType, ...[event.eventKey, candidate.eventKey].sort()),
      relationKeyVersion: RELATION_KEY_VERSION,
      relationType,
      status: RELATION_STATUS.PROPOSED,
      version: 1,
      sourceEventId: event.eventId,
      targetEventId: candidate.eventId,
      amountMinor: event.amountMinor,
      currency: event.currency,
      manual: false,
      reasonCodes: ['relation_candidate']
    })
    ;[event, candidate].forEach((item) => {
      item.status = EVENT_STATUS.NEEDS_ACTION
      item.reasonCodes = unique([...item.reasonCodes, 'relation_ambiguous'])
    })
  })
  return relations
}

module.exports = { sameEventCandidateGroups, buildRelations }
