import { describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/services.ts', () => ({ default: {} }));

import type { ReconciliationCaseDetail } from './models.ts';
import {
    buildReconciliationDecisionRequest,
    buildReconciliationUndoRequest,
    canDecideReconciliationCase,
    canInspectReconciliationUndo
} from './state.ts';
import {
    normalizeReconciliationCaseDetail,
    normalizeReconciliationCaseSummary
} from './service.ts';

function reconciliationCase(overrides: Partial<ReconciliationCaseDetail> = {}): ReconciliationCaseDetail {
    return {
        id: '4101',
        status: 'open',
        version: 7,
        suggestedRelationType: 'same_event',
        candidateScore: 92,
        reasonCodes: [{ code: 'amount_currency_exact', value: 40 }],
        createdUnixTime: 100,
        lastEvaluatedUnixTime: 101,
        updatedUnixTime: 102,
        members: [],
        ...overrides
    };
}

describe('personal finance reconciliation state', () => {
    test('builds versioned and idempotent decision and undo commands', () => {
        const current = reconciliationCase({
            status: 'resolved',
            currentDecision: {
                id: '5101',
                decisionType: 'same_event',
                status: 'applied',
                reasonCodes: [],
                errorCode: '',
                createdUnixTime: 103,
                updatedUnixTime: 104
            }
        });

        expect(buildReconciliationDecisionRequest({
            reconciliationCase: current,
            decisionType: 'independent',
            idempotencyKey: 'decision-key'
        })).toEqual({
            caseId: '4101',
            expectedCaseVersion: 7,
            idempotencyKey: 'decision-key',
            decisionType: 'independent'
        });

        expect(buildReconciliationUndoRequest({
            reconciliationCase: current,
            idempotencyKey: 'undo-key'
        })).toEqual({
            caseId: '4101',
            expectedCaseVersion: 7,
            idempotencyKey: 'undo-key'
        });
    });

    test('keeps resolved decisions read-only and exposes undo only with a persisted decision', () => {
        expect(canDecideReconciliationCase(reconciliationCase())).toBe(true);
        expect(canDecideReconciliationCase(reconciliationCase({ status: 'resolved' }))).toBe(false);
        expect(canInspectReconciliationUndo(reconciliationCase({ status: 'resolved' }))).toBe(false);
        expect(canInspectReconciliationUndo(reconciliationCase({
            status: 'resolved',
            currentDecision: {
                id: '5101',
                decisionType: 'same_event',
                status: 'applied',
                reasonCodes: [],
                errorCode: '',
                createdUnixTime: 103,
                updatedUnixTime: 104
            }
        }))).toBe(true);
    });

    test('normalizes only the safe case and member fields', () => {
        const normalized = normalizeReconciliationCaseDetail({
            case: {
                id: '4101',
                status: 'open',
                version: 7,
                suggestedRelationType: 'internal_transfer',
                candidateScore: 88,
                reasonCodes: [{ code: 'opposite_direction', value: 12 }],
                createdUnixTime: 100,
                lastEvaluatedUnixTime: 101,
                updatedUnixTime: 102,
                caseKey: 'must-not-reach-ui'
            },
            members: [{
                memberOrder: 1,
                sourceType: 'bank',
                sourceAccountDisplayName: '信用卡 ·· 1234',
                normalizedAmount: '8800',
                currency: 'CNY',
                normalizedDirection: 'expense',
                normalizedUnixTime: 100,
                counterpartySummary: '脱敏商户',
                itemSummary: '订单摘要',
                paymentMethodSummary: '信用卡',
                economicEffect: 'normal',
                sourceIdentityKey: 'must-not-reach-ui',
                rawPayload: { account: 'must-not-reach-ui' }
            }]
        });

        expect(normalized.members[0]).toEqual({
            order: 1,
            role: 'evidence',
            sourceType: 'bank',
            sourceDisplayName: '信用卡 ·· 1234',
            normalizedAmount: '8800',
            currency: 'CNY',
            normalizedDirection: 'expense',
            normalizedUnixTime: 100,
            normalizedTimezoneUtcOffset: undefined,
            counterparty: '脱敏商户',
            item: '订单摘要',
            paymentMethod: '信用卡',
            economicEffect: 'normal',
            processingState: undefined
        });
        expect(JSON.stringify(normalized)).not.toContain('must-not-reach-ui');
    });

    test('accepts the frozen candidate-generate response shape', () => {
        expect(normalizeReconciliationCaseSummary({
            id: '4101',
            status: 'open',
            version: 4,
            suggestedRelationType: 'same_event',
            candidateScore: 95,
            reasonCodes: [{ code: 'amount_currency_exact', value: 40 }],
            createdUnixTime: 100,
            lastEvaluatedUnixTime: 101,
            updatedUnixTime: 102
        })).toMatchObject({
            id: '4101',
            version: 4,
            suggestedRelationType: 'same_event',
            candidateScore: 95
        });
    });
});
