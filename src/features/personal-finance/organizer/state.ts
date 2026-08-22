import type { EconomicEvent, EconomicEventStatus, FinanceUpdate, FinanceUpdateStatus } from './models.ts';

export const RESULT_UPDATE_STATUSES: readonly FinanceUpdateStatus[] = [
    'draft', 'organizing', 'review', 'posting', 'partially_posted', 'posted', 'failed'
];

export const EVENT_FILTERS: readonly EconomicEventStatus[] = [
    'needs_action', 'ready', 'posted', 'excluded', 'corrected'
];

export function selectCurrentUpdate(pages: readonly FinanceUpdate[][]): FinanceUpdate | undefined {
    return pages.flat().sort((left, right) => right.updatedUnixTime - left.updatedUnixTime)[0];
}

export function updateConservationHolds(update: FinanceUpdate): boolean {
    return update.validEvidenceCount - update.duplicateEvidenceCount === update.finalEventCount &&
        update.finalEventCount === update.postedEventCount + update.readyEventCount +
            update.needsActionEventCount + update.excludedEventCount;
}

export function canOrganizeUpdate(status: FinanceUpdateStatus): boolean {
    return status === 'draft' || status === 'review' || status === 'failed';
}

export function canPostUpdate(update: FinanceUpdate): boolean {
    return update.readyEventCount > 0 && update.needsActionEventCount === 0 &&
        (update.status === 'review' || update.status === 'partially_posted');
}

export function canUndoUpdate(update: FinanceUpdate): boolean {
    return update.postedEventCount > 0 && (update.status === 'posted' || update.status === 'partially_posted');
}

export function eventDisplayLabel(event: EconomicEvent): string {
    return parseFirstString(event.fieldSourcesJson, ['counterparty', 'item', 'note']) || event.economicNature;
}

export function eventReasonCodes(event: EconomicEvent): string[] {
    try {
        const value: unknown = JSON.parse(event.reasonCodesJson || '[]');
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

function parseFirstString(value: string, keys: readonly string[]): string {
    try {
        const parsed: unknown = JSON.parse(value || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
        const item = parsed as Record<string, unknown>;
        for (const key of keys) {
            if (typeof item[key] === 'string' && item[key]) return item[key];
        }
    } catch {
        return '';
    }
    return '';
}
