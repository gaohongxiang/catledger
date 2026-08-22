import { describe, expect, it } from 'vitest';

import type { EconomicEvent, FinanceUpdate } from './models.ts';
import { canPostUpdate, eventDisplayLabel, eventReasonCodes, eventReasonTranslationKeys, selectCurrentUpdate, updateConservationHolds } from './state.ts';

function update(overrides: Partial<FinanceUpdate> = {}): FinanceUpdate {
    return {
        id: '1', status: 'review', version: 1, planVersion: 'v1', sourceCount: 1,
        validEvidenceCount: 10, duplicateEvidenceCount: 2, finalEventCount: 8,
        postedEventCount: 1, readyEventCount: 5, needsActionEventCount: 1, excludedEventCount: 1,
        errorCode: '', createdUnixTime: 10, updatedUnixTime: 20, ...overrides
    };
}

describe('organizer result state', () => {
    it('selects the newest active update', () => {
        expect(selectCurrentUpdate([[update({ id: '1', updatedUnixTime: 10 })], [update({ id: '2', updatedUnixTime: 30 })]])?.id).toBe('2');
    });

    it('enforces both conservation equations', () => {
        expect(updateConservationHolds(update())).toBe(true);
        expect(updateConservationHolds(update({ duplicateEvidenceCount: 1 }))).toBe(false);
        expect(updateConservationHolds(update({ excludedEventCount: 0 }))).toBe(false);
    });

    it('posts only ready events from review or partial-post states', () => {
        expect(canPostUpdate(update({ needsActionEventCount: 0, readyEventCount: 6 }))).toBe(true);
        expect(canPostUpdate(update())).toBe(false);
        expect(canPostUpdate(update({ readyEventCount: 0 }))).toBe(false);
        expect(canPostUpdate(update({ status: 'posted' }))).toBe(false);
    });

    it('reads display labels and reason codes defensively', () => {
        const event = { fieldSourcesJson: '{"counterparty":"Coffee"}', reasonCodesJson: '["unknown_nature"]', economicNature: 'expense' } as EconomicEvent;
        expect(eventDisplayLabel(event)).toBe('Coffee');
        expect(eventReasonCodes(event)).toEqual(['unknown_nature']);
        expect(eventReasonTranslationKeys(event)).toEqual(['personalFinance.organizerV2.reason.generic']);
        expect(eventReasonCodes({ ...event, reasonCodesJson: 'broken' })).toEqual([]);
    });

    it('never exposes internal enum and reason-code fallbacks as display copy', () => {
        const event = {
            fieldSourcesJson: '{}', economicNature: 'unknown',
            reasonCodesJson: '["economic_nature_required","transfer_account_required","future_internal_code"]'
        } as EconomicEvent;
        expect(eventDisplayLabel(event)).toBe('');
        expect(eventReasonTranslationKeys(event)).toEqual([
            'personalFinance.organizerV2.reason.economicNatureRequired',
            'personalFinance.organizerV2.reason.transferAccountRequired',
            'personalFinance.organizerV2.reason.generic'
        ]);
    });
});
