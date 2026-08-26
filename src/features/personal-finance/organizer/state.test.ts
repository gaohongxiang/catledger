import { describe, expect, it } from 'vitest';

import type { EconomicEvent, FinanceUpdate } from './models.ts';
import { canAbandonUpdate, canPostUpdate, eventDisplayLabel, eventReasonCodes, eventReasonTranslationKeys, groupVisuallyIdenticalEvents, selectCurrentUpdate, updateConservationHolds } from './state.ts';

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

    it('abandons only unposted draft, review, or failed rounds', () => {
        expect(canAbandonUpdate(update({ postedEventCount: 0 }))).toBe(true);
        expect(canAbandonUpdate(update({ status: 'draft', postedEventCount: 0 }))).toBe(true);
        expect(canAbandonUpdate(update({ status: 'failed', postedEventCount: 0 }))).toBe(true);
        expect(canAbandonUpdate(update({ status: 'partially_posted', postedEventCount: 1 }))).toBe(false);
        expect(canAbandonUpdate(update({ status: 'posted', postedEventCount: 1 }))).toBe(false);
        expect(canAbandonUpdate(update({ status: 'abandoned', postedEventCount: 0 }))).toBe(false);
    });

    it('reads display labels and reason codes defensively', () => {
        const event = { counterparty: 'Coffee', item: '', note: '', reasonCodesJson: '["unknown_nature"]', economicNature: 'expense' } as EconomicEvent;
        expect(eventDisplayLabel(event)).toBe('Coffee');
        expect(eventReasonCodes(event)).toEqual(['unknown_nature']);
        expect(eventReasonTranslationKeys(event)).toEqual(['personalFinance.organizerV2.reason.generic']);
        expect(eventReasonCodes({ ...event, reasonCodesJson: 'broken' })).toEqual([]);
    });

    it('never exposes internal enum and reason-code fallbacks as display copy', () => {
        const event = {
            counterparty: '', item: '', note: '', economicNature: 'unknown',
            reasonCodesJson: '["economic_nature_required","transfer_account_required","future_internal_code"]'
        } as EconomicEvent;
        expect(eventDisplayLabel(event)).toBe('');
        expect(eventReasonTranslationKeys(event)).toEqual([
            'personalFinance.organizerV2.reason.economicNatureRequired',
            'personalFinance.organizerV2.reason.transferAccountRequired',
            'personalFinance.organizerV2.reason.generic'
        ]);
    });

    it('does not claim parsed core values are missing when only the account needs confirmation', () => {
        const event = {
            amount: '57.77', currency: 'CNY', eventUnixTime: 1_783_756_800,
            counterparty: '平台商户', item: '', note: '', economicNature: 'expense',
            reasonCodesJson: '["blocking_issue_open","core_fields_missing","ledger_account_required"]'
        } as EconomicEvent;

        expect(eventReasonTranslationKeys(event)).toEqual([
            'personalFinance.organizerV2.reason.ledgerAccountRequired'
        ]);
    });

    it('groups only visually identical rows without merging their identities', () => {
        const base = {
            status: 'needs_action', eventUnixTime: 1_700_000_000, timezoneUtcOffset: 480,
            amount: '43.50', currency: 'CNY', flowDirection: 'outflow', economicNature: 'expense',
            ledgerAccountId: '10', categoryId: '', counterparty: '1688 平台商家', item: '钱包',
            paymentMethod: '信用卡', note: '', reasonCodesJson: '["relation_ambiguous"]'
        } as EconomicEvent;
        const first = { ...base, id: 'event-1' };
        const second = { ...base, id: 'event-2', counterparty: '  1688 平台商家  ' };
        const independent = { ...base, id: 'event-3', eventUnixTime: base.eventUnixTime! + 86_400 };

        const groups = groupVisuallyIdenticalEvents([first, second, independent]);

        expect(groups).toHaveLength(2);
        expect(groups[0]?.map(event => event.id)).toEqual(['event-1', 'event-2']);
        expect(groups[1]?.map(event => event.id)).toEqual(['event-3']);
    });
});
