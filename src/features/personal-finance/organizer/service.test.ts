import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services.ts', () => ({ default: {} }));

import { normalizeEconomicEvent, normalizeFinanceUpdate, OrganizerProtocolError } from './service.ts';

function update(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: '9007199254740993', status: 'review', version: 2, planVersion: 'organizer-plan-v1', currentActionId: null,
        sourceCount: 2, validEvidenceCount: 12, duplicateEvidenceCount: 2, finalEventCount: 10,
        postedEventCount: 0, readyEventCount: 8, needsActionEventCount: 2, excludedEventCount: 0,
        errorCode: '', createdUnixTime: 1787000000, updatedUnixTime: 1787000010,
        sources: [{ id: '11', fileId: '12', batchId: '13', sourceOrder: 0, sourceAccountId: null, sourceType: 'alipay', parserVersion: 'v1', normalizationVersion: 'v1', identityKeyVersion: 'v1' }],
        ...overrides
    };
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: '21', updateId: '9007199254740993', status: 'needs_action', version: 1,
        flowDirection: 'outflow', economicNature: 'unknown', ledgerAccountId: '31', counterpartyLedgerAccountId: null,
        eventUnixTime: 1787000010, timezoneUtcOffset: 480, amount: '9007199254740993', currency: 'CNY', categoryId: null,
        manualFieldMask: 0, fieldSourcesJson: '{}', reasonCodesJson: '["unknown_nature"]',
        createdUnixTime: 1787000010, updatedUnixTime: 1787000010, ...overrides
    };
}

describe('organizer response protocol', () => {
    it('preserves int64 identifiers and amounts as strings', () => {
        expect(normalizeFinanceUpdate(update()).id).toBe('9007199254740993');
        expect(normalizeEconomicEvent(event()).amount).toBe('9007199254740993');
    });

    it.each([
        update({ id: 1 }), update({ status: 'accounts_pending' }), update({ version: -1 }),
        update({ validEvidenceCount: Number.MAX_SAFE_INTEGER + 1 })
    ])('rejects malformed updates', value => {
        expect(() => normalizeFinanceUpdate(value)).toThrow(OrganizerProtocolError);
    });

    it.each([
        event({ id: '0' }), event({ status: 'open' }), event({ flowDirection: 'expense' }), event({ timezoneUtcOffset: 1.5 })
    ])('rejects malformed events', value => {
        expect(() => normalizeEconomicEvent(value)).toThrow(OrganizerProtocolError);
    });
});
