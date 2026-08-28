import type { EconomicEvent, EconomicEventStatus, FinanceUpdate, FinanceUpdateStatus, ReviewIssue } from './models.ts';

export const RESULT_UPDATE_STATUSES: readonly FinanceUpdateStatus[] = [
    'draft', 'organizing', 'review', 'posting', 'posted', 'failed'
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
    return update.readyEventCount > 0 && update.needsActionEventCount === 0 && update.status === 'review';
}

export function canUndoUpdate(update: FinanceUpdate): boolean {
    return update.postedEventCount > 0 && update.status === 'posted';
}

export function canAbandonUpdate(update: FinanceUpdate): boolean {
    return update.postedEventCount === 0 &&
        (update.status === 'draft' || update.status === 'review' || update.status === 'failed');
}

export function eventDisplayLabel(event: EconomicEvent): string {
    return event.counterparty || event.item || event.note;
}

function formatDateParts(year: number, month: number, day: number): string {
    return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

/**
 * Returns the transaction's civil date. An explicit source timezone wins so
 * a late-night statement row cannot move day merely because the browser runs
 * in another timezone.
 */
export function eventCivilDate(event: Pick<EconomicEvent, 'eventUnixTime' | 'timezoneUtcOffset'>): string {
    const instant = new Date((event.eventUnixTime ?? Math.floor(Date.now() / 1000)) * 1000);
    if (event.timezoneUtcOffset !== undefined) {
        const shifted = new Date(instant.getTime() + event.timezoneUtcOffset * 60_000);
        return formatDateParts(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
    }
    return formatDateParts(instant.getFullYear(), instant.getMonth() + 1, instant.getDate());
}

export function inferInstallmentFirstDueDate(statementDate: string, currentPeriod: number): string {
    const [yearText, monthText, dayText] = statementDate.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
        month < 1 || month > 12 || day < 1 || day > 31) return statementDate;

    const target = new Date(Date.UTC(year, month - 1, 1));
    target.setUTCMonth(target.getUTCMonth() + 1 - Math.max(1, Math.trunc(currentPeriod)));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    return formatDateParts(target.getUTCFullYear(), target.getUTCMonth() + 1, Math.min(day, lastDay));
}

/**
 * Infers the opening progress of an existing installment plan. A due date on
 * the statement day is the current installment, so only earlier due dates are
 * treated as completed. The result remains an editable opening baseline; it
 * never creates historical repayment transactions.
 */
export function inferOpeningCompletedInstallmentCount(statementDate: string, firstDueDate: string, termCount: number): number {
    const parse = (value: string): { year: number; month: number; day: number } | undefined => {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
        if (!match) return undefined;
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const instant = new Date(Date.UTC(year, month - 1, day));
        if (instant.getUTCFullYear() !== year || instant.getUTCMonth() + 1 !== month || instant.getUTCDate() !== day) return undefined;
        return { year, month, day };
    };
    const statement = parse(statementDate);
    const firstDue = parse(firstDueDate);
    const terms = Math.max(1, Math.trunc(termCount));
    if (!statement || !firstDue) return 0;

    const statementKey = statementDate;
    const firstDueIsMonthEnd = firstDue.day === new Date(Date.UTC(firstDue.year, firstDue.month, 0)).getUTCDate();
    let completed = 0;
    for (let period = 0; period < terms; period++) {
        const target = new Date(Date.UTC(firstDue.year, firstDue.month - 1 + period, 1));
        const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
        const dueDay = firstDueIsMonthEnd ? lastDay : Math.min(firstDue.day, lastDay);
        const dueDate = formatDateParts(target.getUTCFullYear(), target.getUTCMonth() + 1, dueDay);
        if (dueDate >= statementKey) break;
        completed++;
    }
    return Math.min(completed, terms - 1);
}

/** Removes statement progress markers from the human-facing installment name. */
export function installmentProductName(statementLabel: string): string {
    return statementLabel
        .replace(/(?:按月收|分月)\s*\d+\s*期/gu, '')
        .replace(/第\s*\d+\s*期\s*共\s*\d+\s*期/gu, '')
        .replace(/第\s*\d+\s*[／/]\s*\d+\s*期/gu, '')
        .replace(/(?:^|\s)\d+\s*[／/]\s*\d+\s*期/gu, ' ')
        .replace(/第\s*\d+\s*期/gu, '')
        .replace(/[·・|｜\-—_:：,，;；/／\s]+$/gu, '')
        .replace(/^[·・|｜\-—_:：,，;；/／\s]+/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
}

export function installmentNameWithFirstDueDate(baseName: string, firstDueDate: string): string {
    return firstDueDate ? `${baseName} · ${firstDueDate}` : baseName;
}

/**
 * Keeps every transaction result list on one predictable timeline: oldest
 * transaction first, with the immutable event id as the stable tie-breaker.
 * Updated time is deliberately ignored because reviewing an old transaction
 * must not move it to the top of the ledger-like result lists.
 */
export function sortEconomicEventsOldestFirst(events: readonly EconomicEvent[]): EconomicEvent[] {
    return [...events].sort((left, right) =>
        (left.eventUnixTime ?? Number.MAX_SAFE_INTEGER) - (right.eventUnixTime ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id));
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

export interface ReviewIssuePresentation {
    readonly labelKey: string;
    readonly hintKey: string;
    readonly count: number;
}

function stringArrayFromJson(value: string): string[] {
    try {
        const parsed: unknown = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

function sharedFieldsPresentation(issue: ReviewIssue, events: readonly EconomicEvent[], count: number): ReviewIssuePresentation {
    const reasons = new Set([
        issue.primaryReasonCode,
        ...stringArrayFromJson(issue.reasonCodesJson),
        ...events.flatMap(eventReasonCodes)
    ].filter(Boolean));
    const multiple = count > 1;

    if (reasons.has('economic_nature_required')) {
        return {
            labelKey: multiple ? 'personalFinance.organizerV2.issue.label.sharedMultiple' : 'personalFinance.organizerV2.issue.label.natureRequired',
            hintKey: multiple ? 'personalFinance.organizerV2.issue.hint.sharedMultipleNature' : 'personalFinance.organizerV2.issue.hint.natureRequired',
            count
        };
    }
    if (reasons.has('core_fields_missing')) {
        return {
            labelKey: multiple ? 'personalFinance.organizerV2.issue.label.sharedMultiple' : 'personalFinance.organizerV2.issue.label.coreFieldsRequired',
            hintKey: multiple ? 'personalFinance.organizerV2.issue.hint.sharedMultipleCore' : 'personalFinance.organizerV2.issue.hint.coreFieldsRequired',
            count
        };
    }
    if (reasons.has('postability_direction_conflict')) {
        return {
            labelKey: multiple ? 'personalFinance.organizerV2.issue.label.sharedMultiple' : 'personalFinance.organizerV2.issue.label.directionRequired',
            hintKey: multiple ? 'personalFinance.organizerV2.issue.hint.sharedMultipleDirection' : 'personalFinance.organizerV2.issue.hint.directionRequired',
            count
        };
    }

    return {
        labelKey: multiple ? 'personalFinance.organizerV2.issue.label.sharedMultiple' : 'personalFinance.organizerV2.issue.label.sharedSingle',
        hintKey: multiple ? 'personalFinance.organizerV2.issue.hint.sharedMultipleGeneric' : 'personalFinance.organizerV2.issue.hint.sharedSingle',
        count
    };
}

function accountMappingPresentation(events: readonly EconomicEvent[], count: number): ReviewIssuePresentation {
    const event = events[0];
    if (count === 1 && event?.economicNature === 'income') {
        return { labelKey: 'personalFinance.organizerV2.issue.label.incomeAccount', hintKey: 'personalFinance.organizerV2.issue.hint.incomeAccount', count };
    }
    if (count === 1 && event?.economicNature === 'refund') {
        return { labelKey: 'personalFinance.organizerV2.issue.label.refundAccount', hintKey: 'personalFinance.organizerV2.issue.hint.refundAccount', count };
    }
    if (count === 1 && (event?.economicNature === 'expense' || event?.economicNature === 'fee')) {
        return { labelKey: 'personalFinance.organizerV2.issue.label.expenseAccount', hintKey: 'personalFinance.organizerV2.issue.hint.expenseAccount', count };
    }
    return {
        labelKey: 'personalFinance.organizerV2.issue.label.accountMapping',
        hintKey: count > 1 ? 'personalFinance.organizerV2.issue.hint.accountMappingMany' : 'personalFinance.organizerV2.issue.hint.accountMappingOne',
        count
    };
}

function transferAccountsPresentation(issue: ReviewIssue, events: readonly EconomicEvent[], count: number): ReviewIssuePresentation {
    const event = events[0];
    const reasons = new Set([issue.primaryReasonCode, ...stringArrayFromJson(issue.reasonCodesJson), ...events.flatMap(eventReasonCodes)]);
    if (event?.economicNature === 'repayment' || reasons.has('repayment_account_required')) {
        const description = normalizedDisplayValue([event?.counterparty, event?.item, event?.note].filter(Boolean).join(' '));
        if (description.includes('花呗') && description.includes('信用购')) {
            return { labelKey: 'personalFinance.organizerV2.issue.label.compositeRepaymentTarget', hintKey: 'personalFinance.organizerV2.issue.hint.compositeRepaymentTarget', count };
        }
        if (event?.ledgerAccountId && !event.counterpartyLedgerAccountId) {
            return { labelKey: 'personalFinance.organizerV2.issue.label.repaymentTarget', hintKey: 'personalFinance.organizerV2.issue.hint.repaymentTarget', count };
        }
        if (!event?.ledgerAccountId && event?.counterpartyLedgerAccountId) {
            return { labelKey: 'personalFinance.organizerV2.issue.label.repaymentSource', hintKey: 'personalFinance.organizerV2.issue.hint.repaymentSource', count };
        }
        return { labelKey: 'personalFinance.organizerV2.issue.label.repaymentAccounts', hintKey: 'personalFinance.organizerV2.issue.hint.repaymentAccounts', count };
    }
    if (event?.ledgerAccountId && !event.counterpartyLedgerAccountId) {
        return { labelKey: 'personalFinance.organizerV2.issue.label.transferDestination', hintKey: 'personalFinance.organizerV2.issue.hint.transferDestination', count };
    }
    if (!event?.ledgerAccountId && event?.counterpartyLedgerAccountId) {
        return { labelKey: 'personalFinance.organizerV2.issue.label.transferSource', hintKey: 'personalFinance.organizerV2.issue.hint.transferSource', count };
    }
    return { labelKey: 'personalFinance.organizerV2.issue.label.transferAccounts', hintKey: 'personalFinance.organizerV2.issue.hint.transferAccounts', count };
}

export function reviewIssuePresentation(issue: ReviewIssue | undefined, events: readonly EconomicEvent[] = []): ReviewIssuePresentation {
    if (!issue) {
        return {
            labelKey: 'personalFinance.organizerV2.issue.label.required',
            hintKey: 'personalFinance.organizerV2.issue.hint.required',
            count: 1
        };
    }

    const count = Math.max(events.length || issue.memberCount, 1);
    if (issue.type === 'shared_fields') return sharedFieldsPresentation(issue, events, count);
    if (issue.type === 'account_mapping') return accountMappingPresentation(events, count);
    if (issue.type === 'transfer_accounts') return transferAccountsPresentation(issue, events, count);
    if (issue.type === 'installment_origin') {
        const composition = issue.primaryReasonCode === 'installment_composition_required';
        return {
            labelKey: composition ? 'personalFinance.organizerV2.issue.label.installmentComposition' : 'personalFinance.organizerV2.issue.label.installmentOrigin',
            hintKey: composition ? 'personalFinance.organizerV2.issue.hint.installmentComposition' : 'personalFinance.organizerV2.issue.hint.installmentOrigin',
            count
        };
    }

    const labelKeys: Readonly<Record<Exclude<ReviewIssue['type'], 'shared_fields'>, string>> = {
        account_mapping: 'personalFinance.organizerV2.issue.label.accountMapping',
        same_event: 'personalFinance.organizerV2.issue.label.sameEvent',
        refund_relation: 'personalFinance.organizerV2.issue.label.refundRelation',
        transfer_accounts: 'personalFinance.organizerV2.issue.label.transferAccounts',
        identity_conflict: 'personalFinance.organizerV2.issue.label.identityConflict',
        field_conflict: 'personalFinance.organizerV2.issue.label.fieldConflict',
        installment_origin: 'personalFinance.organizerV2.issue.label.installmentOrigin'
    };
    const hintKeys: Readonly<Record<Exclude<ReviewIssue['type'], 'shared_fields'>, string>> = {
        account_mapping: count > 1 ? 'personalFinance.organizerV2.issue.hint.accountMappingMany' : 'personalFinance.organizerV2.issue.hint.accountMappingOne',
        same_event: 'personalFinance.organizerV2.issue.hint.sameEvent',
        refund_relation: 'personalFinance.organizerV2.issue.hint.refundRelation',
        transfer_accounts: 'personalFinance.organizerV2.issue.hint.transferAccounts',
        identity_conflict: 'personalFinance.organizerV2.issue.hint.identityConflict',
        field_conflict: 'personalFinance.organizerV2.issue.hint.fieldConflict',
        installment_origin: 'personalFinance.organizerV2.issue.hint.installmentOrigin'
    };

    return { labelKey: labelKeys[issue.type], hintKey: hintKeys[issue.type], count };
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
    installment_origin_required: 'personalFinance.organizerV2.reason.installmentOriginRequired',
    installment_composition_required: 'personalFinance.organizerV2.reason.installmentCompositionRequired',
    installment_interest: 'personalFinance.organizerV2.reason.installmentInterest',
    installment_fee: 'personalFinance.organizerV2.reason.installmentFee',
    ledger_account_required: 'personalFinance.organizerV2.reason.ledgerAccountRequired',
    refund_amount_exceeded: 'personalFinance.organizerV2.reason.refundAmountExceeded',
    refund_relation_ambiguous: 'personalFinance.organizerV2.reason.refundRelationAmbiguous',
    refund_relation_required: 'personalFinance.organizerV2.reason.refundRelationRequired',
    refund_relation_unlinked: 'personalFinance.organizerV2.reason.refundRelationUnlinked',
    relation_ambiguous: 'personalFinance.organizerV2.reason.relationAmbiguous',
    repayment_account_required: 'personalFinance.organizerV2.reason.repaymentAccountRequired',
    transfer_account_required: 'personalFinance.organizerV2.reason.transferAccountRequired',
    transaction_closed: 'personalFinance.organizerV2.reason.transactionClosed',
    transaction_failed: 'personalFinance.organizerV2.reason.transactionFailed',
    manual_correction: 'personalFinance.organizerV2.reason.manualCorrection',
    legacy_posted_evidence_backfill: 'personalFinance.organizerV2.reason.legacyPostedEvidenceBackfill'
};

export function eventReasonTranslationKeys(event: EconomicEvent): string[] {
    const reasonCodes = eventReasonCodes(event).filter(code => code !== 'blocking_issue_open');
    const coreValuesPresent = !!event.amount && event.currency.length === 3 && !!event.eventUnixTime;
    const displayCodes = coreValuesPresent && reasonCodes.includes('ledger_account_required')
        ? reasonCodes.filter(code => code !== 'core_fields_missing')
        : reasonCodes;
    const keys = displayCodes.map(code => {
        if (code.startsWith('manual_field_mask:')) {
            return 'personalFinance.organizerV2.reason.manualCorrection';
        }

        return EVENT_REASON_TRANSLATION_KEYS[code] || 'personalFinance.organizerV2.reason.generic';
    });

    return [...new Set(keys)];
}
