import { describe, expect, it } from 'vitest';

import type { EconomicEvent, FinanceUpdate, ReviewIssue } from './models.ts';
import { canAbandonUpdate, canPostUpdate, eventCivilDate, eventDisplayLabel, eventReasonCodes, eventReasonTranslationKeys, groupVisuallyIdenticalEvents, inferInstallmentFirstDueDate, inferOpeningCompletedInstallmentCount, installmentNameWithFirstDueDate, installmentProductName, reviewIssuePresentation, selectCurrentUpdate, sortEconomicEventsOldestFirst, updateConservationHolds } from './state.ts';

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

    it('posts only complete ready batches from review state', () => {
        expect(canPostUpdate(update({ needsActionEventCount: 0, readyEventCount: 6 }))).toBe(true);
        expect(canPostUpdate(update())).toBe(false);
        expect(canPostUpdate(update({ readyEventCount: 0 }))).toBe(false);
        expect(canPostUpdate(update({ status: 'posted' }))).toBe(false);
    });

    it('abandons only unposted draft, review, or failed rounds', () => {
        expect(canAbandonUpdate(update({ postedEventCount: 0 }))).toBe(true);
        expect(canAbandonUpdate(update({ status: 'draft', postedEventCount: 0 }))).toBe(true);
        expect(canAbandonUpdate(update({ status: 'failed', postedEventCount: 0 }))).toBe(true);
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

    it('infers the first installment due date from the statement date and current period', () => {
        expect(inferInstallmentFirstDueDate('2026-07-13', 7)).toBe('2026-01-13');
        expect(inferInstallmentFirstDueDate('2026-08-31', 7)).toBe('2026-02-28');
        expect(inferOpeningCompletedInstallmentCount('2026-07-13', '2026-01-13', 12)).toBe(6);
        expect(inferOpeningCompletedInstallmentCount('2026-08-31', '2026-02-28', 12)).toBe(6);
        expect(inferOpeningCompletedInstallmentCount('2026-07-12', '2026-07-13', 12)).toBe(0);
        expect(inferOpeningCompletedInstallmentCount('invalid', '2026-01-13', 12)).toBe(0);
        expect(installmentNameWithFirstDueDate('电销现分', '2026-01-13'))
            .toBe('电销现分 · 2026-01-13');
    });

    it('keeps only the product identity in a default installment name', () => {
        expect(installmentProductName('电销现分按月收12期第7期共12期')).toBe('电销现分');
        expect(installmentProductName('电销总账分月36期第27期共36期')).toBe('电销总账');
        expect(installmentProductName('花呗月月付 第2/12期')).toBe('花呗月月付');
        expect(installmentProductName('信用卡分期 3/6期')).toBe('信用卡分期');
        expect(installmentProductName('分期付款利息第11期共12期')).toBe('分期付款利息');
    });

    it('keeps the source civil date when the browser timezone differs', () => {
        expect(eventCivilDate({ eventUnixTime: Date.UTC(2026, 6, 12, 17, 30) / 1000, timezoneUtcOffset: 480 }))
            .toBe('2026-07-13');
    });

    it('sorts transaction result rows by event date rather than review time', () => {
        const events = [
            { id: 'event-2', eventUnixTime: 200, updatedUnixTime: 10 },
            { id: 'event-3', eventUnixTime: 100, updatedUnixTime: 30 },
            { id: 'event-1', eventUnixTime: 200, updatedUnixTime: 20 },
            { id: 'event-4', eventUnixTime: undefined, updatedUnixTime: 40 }
        ] as EconomicEvent[];

        expect(sortEconomicEventsOldestFirst(events).map(event => event.id)).toEqual([
            'event-3', 'event-1', 'event-2', 'event-4'
        ]);
        expect(events.map(event => event.id)).toEqual(['event-2', 'event-3', 'event-1', 'event-4']);
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

    it('describes a single shared-field issue by its actual blocker instead of calling it multiple records', () => {
        const issue = {
            type: 'shared_fields', memberCount: 1, primaryReasonCode: 'economic_nature_required', reasonCodesJson: '[]'
        } as ReviewIssue;
        const event = { reasonCodesJson: '["economic_nature_required","category_unclassified"]' } as EconomicEvent;

        expect(reviewIssuePresentation(issue, [event])).toEqual({
            labelKey: 'personalFinance.organizerV2.issue.label.natureRequired',
            hintKey: 'personalFinance.organizerV2.issue.hint.natureRequired',
            count: 1
        });
    });

    it('uses batch wording only when a shared-field issue really contains multiple events', () => {
        const issue = {
            type: 'shared_fields', memberCount: 2, primaryReasonCode: 'economic_nature_required', reasonCodesJson: '[]'
        } as ReviewIssue;
        const events = [
            { id: '1', reasonCodesJson: '["economic_nature_required"]' },
            { id: '2', reasonCodesJson: '["economic_nature_required"]' }
        ] as EconomicEvent[];

        expect(reviewIssuePresentation(issue, events)).toEqual({
            labelKey: 'personalFinance.organizerV2.issue.label.sharedMultiple',
            hintKey: 'personalFinance.organizerV2.issue.hint.sharedMultipleNature',
            count: 2
        });
    });

    it('describes the exact missing side of a repayment', () => {
        const issue = {
            type: 'transfer_accounts', memberCount: 1, primaryReasonCode: 'repayment_account_required', reasonCodesJson: '[]'
        } as ReviewIssue;
        const event = {
            economicNature: 'repayment', ledgerAccountId: '10', counterpartyLedgerAccountId: '', reasonCodesJson: '["repayment_account_required"]'
        } as EconomicEvent;

        expect(reviewIssuePresentation(issue, [event])).toEqual({
            labelKey: 'personalFinance.organizerV2.issue.label.repaymentTarget',
            hintKey: 'personalFinance.organizerV2.issue.hint.repaymentTarget',
            count: 1
        });
    });

    it('asks only for the repayment source when the credit account is already known', () => {
        const issue = {
            type: 'transfer_accounts', memberCount: 1, primaryReasonCode: 'repayment_account_required', reasonCodesJson: '[]'
        } as ReviewIssue;
        const event = {
            economicNature: 'repayment', ledgerAccountId: '', counterpartyLedgerAccountId: '20', reasonCodesJson: '["repayment_account_required"]'
        } as EconomicEvent;

        expect(reviewIssuePresentation(issue, [event])).toEqual({
            labelKey: 'personalFinance.organizerV2.issue.label.repaymentSource',
            hintKey: 'personalFinance.organizerV2.issue.hint.repaymentSource',
            count: 1
        });
    });

    it('explains a combined Huabei and Credit Purchase repayment target', () => {
        const issue = {
            type: 'transfer_accounts', memberCount: 1, primaryReasonCode: 'repayment_account_required', reasonCodesJson: '[]'
        } as ReviewIssue;
        const event = {
            economicNature: 'repayment', ledgerAccountId: '10', counterparty: '花呗|信用购', reasonCodesJson: '["repayment_account_required"]'
        } as EconomicEvent;

        expect(reviewIssuePresentation(issue, [event])).toEqual({
            labelKey: 'personalFinance.organizerV2.issue.label.compositeRepaymentTarget',
            hintKey: 'personalFinance.organizerV2.issue.hint.compositeRepaymentTarget',
            count: 1
        });
    });

    it('separates installment principal origin from an unclear composite charge', () => {
        const principal = {
            type: 'installment_origin', memberCount: 1, primaryReasonCode: 'installment_origin_required', reasonCodesJson: '[]'
        } as ReviewIssue;
        const composite = {
            type: 'installment_origin', memberCount: 1, primaryReasonCode: 'installment_composition_required', reasonCodesJson: '[]'
        } as ReviewIssue;

        expect(reviewIssuePresentation(principal, [{} as EconomicEvent])).toEqual({
            labelKey: 'personalFinance.organizerV2.issue.label.installmentOrigin',
            hintKey: 'personalFinance.organizerV2.issue.hint.installmentOrigin',
            count: 1
        });
        expect(reviewIssuePresentation(composite, [{} as EconomicEvent])).toEqual({
            labelKey: 'personalFinance.organizerV2.issue.label.installmentComposition',
            hintKey: 'personalFinance.organizerV2.issue.hint.installmentComposition',
            count: 1
        });
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
