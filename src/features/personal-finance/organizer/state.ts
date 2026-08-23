import type { EconomicEvent, EconomicEventStatus, FinanceUpdate, FinanceUpdateStatus } from './models.ts';

export const RESULT_UPDATE_STATUSES: readonly FinanceUpdateStatus[] = [
    'draft', 'organizing', 'review', 'posting', 'partially_posted', 'posted', 'failed'
];

export const EVENT_FILTERS: readonly EconomicEventStatus[] = [
    'needs_action', 'ready', 'posted', 'excluded', 'corrected'
];

export type EconomicEventDisplayGroup = readonly [EconomicEvent, ...EconomicEvent[]];

export function selectCurrentUpdate(pages: readonly FinanceUpdate[][]): FinanceUpdate | undefined {
    return pages.flat().sort((left, right) => right.updatedUnixTime - left.updatedUnixTime)[0];
}

export function updateConservationHolds(update: FinanceUpdate): boolean {
    return update.validEvidenceCount - update.duplicateEvidenceCount === update.finalEventCount &&
        update.finalEventCount === update.postedEventCount + update.readyEventCount +
            update.needsActionEventCount + update.excludedEventCount;
}

export function canPostUpdate(update: FinanceUpdate): boolean {
    return update.readyEventCount > 0 && update.needsActionEventCount === 0 &&
        (update.status === 'review' || update.status === 'partially_posted');
}

export function canUndoUpdate(update: FinanceUpdate): boolean {
    return update.postedEventCount > 0 && (update.status === 'posted' || update.status === 'partially_posted');
}

export function canAbandonUpdate(update: FinanceUpdate): boolean {
    return update.postedEventCount === 0 &&
        (update.status === 'draft' || update.status === 'review' || update.status === 'failed');
}

export function eventDisplayLabel(event: EconomicEvent): string {
    return event.counterparty || event.item || event.note;
}

function normalizedDisplayValue(value: string | undefined): string {
    return (value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function eventDisplayGroupKey(event: EconomicEvent): string {
    const eventDay = event.eventUnixTime
        ? Math.floor((event.eventUnixTime + (event.timezoneUtcOffset || 0) * 60) / 86_400)
        : 0;
    return [
        eventDay,
        event.amount || '',
        event.currency,
        event.flowDirection,
        event.economicNature,
        event.ledgerAccountId || '',
        event.categoryId || '',
        normalizedDisplayValue(event.counterparty),
        normalizedDisplayValue(event.item),
        normalizedDisplayValue(event.paymentMethod),
        normalizedDisplayValue(event.note),
        event.evidenceCount,
        [...eventReasonCodes(event)].sort().join(',')
    ].join('\u001f');
}

/**
 * Groups only rows that would look identical in the organizer. This is a
 * presentation convenience: every event keeps its own identity and actions.
 */
export function groupVisuallyIdenticalEvents(events: readonly EconomicEvent[]): readonly EconomicEventDisplayGroup[] {
    const groups = new Map<string, EconomicEvent[]>();

    for (const event of events) {
        const key = eventDisplayGroupKey(event);
        const group = groups.get(key);
        if (group) {
            group.push(event);
        } else {
            groups.set(key, [event]);
        }
    }

    const result: EconomicEventDisplayGroup[] = [];
    for (const group of groups.values()) {
        const first = group[0];
        if (first) result.push([first, ...group.slice(1)]);
    }
    return result;
}

export function eventReasonCodes(event: EconomicEvent): string[] {
    try {
        const value: unknown = JSON.parse(event.reasonCodesJson || '[]');
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

const EVENT_REASON_TRANSLATION_KEYS: Readonly<Record<string, string>> = {
    already_posted: 'personalFinance.organizerV2.reason.alreadyPosted',
    auto_refund_relation: 'personalFinance.organizerV2.reason.autoRefundRelation',
    auto_repayment_pair: 'personalFinance.organizerV2.reason.autoRepaymentPair',
    auto_same_event: 'personalFinance.organizerV2.reason.autoSameEvent',
    auto_transfer_pair: 'personalFinance.organizerV2.reason.autoTransferPair',
    category_unclassified: 'personalFinance.organizerV2.reason.categoryUnclassified',
    core_fields_conflict: 'personalFinance.organizerV2.reason.coreFieldsConflict',
    core_fields_missing: 'personalFinance.organizerV2.reason.coreFieldsMissing',
    economic_nature_required: 'personalFinance.organizerV2.reason.economicNatureRequired',
    evidence_excluded: 'personalFinance.organizerV2.reason.evidenceExcluded',
    identity_conflict: 'personalFinance.organizerV2.reason.identityConflict',
    identity_review_required: 'personalFinance.organizerV2.reason.identityReviewRequired',
    ledger_account_required: 'personalFinance.organizerV2.reason.ledgerAccountRequired',
    refund_amount_exceeded: 'personalFinance.organizerV2.reason.refundAmountExceeded',
    refund_relation_ambiguous: 'personalFinance.organizerV2.reason.refundRelationAmbiguous',
    refund_relation_required: 'personalFinance.organizerV2.reason.refundRelationRequired',
    relation_ambiguous: 'personalFinance.organizerV2.reason.relationAmbiguous',
    repayment_account_required: 'personalFinance.organizerV2.reason.repaymentAccountRequired',
    transfer_account_required: 'personalFinance.organizerV2.reason.transferAccountRequired',
    manual_correction: 'personalFinance.organizerV2.reason.manualCorrection',
    legacy_posted_evidence_backfill: 'personalFinance.organizerV2.reason.legacyPostedEvidenceBackfill'
};

export function eventReasonTranslationKeys(event: EconomicEvent): string[] {
    const keys = eventReasonCodes(event).map(code => {
        if (code.startsWith('manual_field_mask:')) {
            return 'personalFinance.organizerV2.reason.manualCorrection';
        }

        return EVENT_REASON_TRANSLATION_KEYS[code] || 'personalFinance.organizerV2.reason.generic';
    });

    return [...new Set(keys)];
}
