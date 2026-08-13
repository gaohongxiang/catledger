import { describe, expect, test, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
    listPersonalFinanceReconciliationCases: vi.fn(),
    decidePersonalFinanceReconciliationCase: vi.fn(),
    getPersonalFinanceReconciliationUndoImpact: vi.fn()
}));

vi.mock('@/lib/services.ts', () => ({ default: serviceMocks }));

import type { ReconciliationCaseDetail } from './models.ts';
import {
    buildReconciliationDecisionRequest,
    buildReconciliationUndoRequest,
    canDecideReconciliationCase,
    canInspectReconciliationUndo
} from './state.ts';
import {
    normalizeReconciliationCaseDetail,
    normalizeReconciliationCaseSummary,
    reconciliationApi
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
        evidence: [],
        ...overrides
    };
}

describe('personal finance reconciliation state', () => {
    test('builds versioned and idempotent decision and undo commands', () => {
        const current = reconciliationCase({
            status: 'resolved',
            currentDecisionId: '5101'
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
            currentDecisionId: '5101'
        }))).toBe(true);
    });

    test('flattens the frozen member evidence shape and keeps only safe fields', () => {
        const normalized = normalizeReconciliationCaseDetail({
            id: '4101',
            status: 'resolved',
            version: 7,
            suggestedRelationType: 'internal_transfer',
            candidateScore: 88,
            reasonCodes: [{ code: 'opposite_direction', value: 12 }],
            currentDecisionId: '5101',
            createdUnixTime: 100,
            lastEvaluatedUnixTime: 101,
            updatedUnixTime: 102,
            caseKey: 'must-not-reach-ui',
            members: [{
                order: 1,
                kind: 'source_identity',
                role: 'evidence',
                sourceType: 'bank',
                maskedSourceAccount: '信用卡 ·· 1234',
                evidenceLimitReached: true,
                evidence: [{
                    normalizedAmount: '8800',
                    currency: 'CNY',
                    normalizedDirection: 'expense',
                    normalizedUnixTime: 100,
                    normalizedTimezoneUtcOffset: 0,
                    normalizedTransactionType: 'payment',
                    economicEffect: 'normal',
                    parseState: 'valid',
                    identityState: 'new',
                    disposition: 'postable',
                    processingState: 'linked',
                    transactions: [{ id: '6101', internalHash: 'must-not-reach-ui' }],
                    rawPayload: { account: 'must-not-reach-ui' }
                }, {
                    normalizedAmount: '8800',
                    currency: 'CNY',
                    normalizedDirection: 'expense',
                    normalizedUnixTime: 101,
                    normalizedTimezoneUtcOffset: 480,
                    normalizedTransactionType: 'payment',
                    economicEffect: 'normal',
                    parseState: 'valid',
                    identityState: 'exact_duplicate',
                    disposition: 'non_postable',
                    processingState: 'linked',
                    transactions: []
                }],
                sourceIdentityKey: 'must-not-reach-ui',
                rawPayload: { account: 'must-not-reach-ui' }
            }]
        });

        expect(normalized.currentDecisionId).toBe('5101');
        expect(normalized.evidence).toHaveLength(2);
        expect(normalized.evidence[0]).toEqual({
            order: 1,
            kind: 'source_identity',
            role: 'evidence',
            sourceType: 'bank',
            maskedSourceAccount: '信用卡 ·· 1234',
            evidenceLimitReached: true,
            normalizedAmount: '8800',
            currency: 'CNY',
            normalizedDirection: 'expense',
            normalizedUnixTime: 100,
            normalizedTimezoneUtcOffset: 0,
            normalizedTransactionType: 'payment',
            economicEffect: 'normal',
            parseState: 'valid',
            identityState: 'new',
            disposition: 'postable',
            processingState: 'linked',
            transactionCount: 1
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

    test('uses the frozen required-status cursor contract without totals', async () => {
        serviceMocks.listPersonalFinanceReconciliationCases.mockResolvedValueOnce({
            data: {
                success: true,
                result: {
                    items: [{
                        id: '4101',
                        status: 'open',
                        version: 4,
                        suggestedRelationType: 'same_event',
                        candidateScore: 95,
                        reasonCodes: [],
                        createdUnixTime: 100,
                        lastEvaluatedUnixTime: 101,
                        updatedUnixTime: 102
                    }],
                    nextCursor: { updatedUnixTime: 102, caseId: '4101' }
                }
            }
        });

        const result = await reconciliationApi.listCases({
            status: 'open',
            cursor: { updatedUnixTime: 90, caseId: '4001' },
            limit: 100
        });

        expect(serviceMocks.listPersonalFinanceReconciliationCases).toHaveBeenCalledWith({
            status: 'open',
            cursor: { updatedUnixTime: 90, caseId: '4001' },
            limit: 100
        });
        expect(result).toEqual({
            items: [expect.objectContaining({ id: '4101', status: 'open' })],
            nextCursor: { updatedUnixTime: 102, caseId: '4101' }
        });
    });

    test('keeps undo delete, reopen, and action-required signals distinct', async () => {
        serviceMocks.getPersonalFinanceReconciliationUndoImpact.mockResolvedValueOnce({
            data: {
                success: true,
                result: {
                    caseId: '4101',
                    decisionId: '5101',
                    attachedExistingCount: 1,
                    reconciliationCreatedCount: 2,
                    transactionCount: 3,
                    missingTransactionCount: 0,
                    modifiedTransactionCount: 1,
                    sharedTransactionCount: 1,
                    batchRelationCount: 2,
                    incompleteTransferPairCount: 0,
                    canReopen: true,
                    canAutomaticallyDelete: false,
                    reasonCodes: ['transaction_modified']
                }
            }
        });

        await expect(reconciliationApi.getUndoImpact('4101')).resolves.toEqual({
            caseId: '4101',
            decisionId: '5101',
            attachedExistingCount: 1,
            reconciliationCreatedCount: 2,
            transactionCount: 3,
            missingTransactionCount: 0,
            modifiedTransactionCount: 1,
            sharedTransactionCount: 1,
            batchRelationCount: 2,
            incompleteTransferPairCount: 0,
            canReopen: true,
            canAutomaticallyDelete: false,
            reasonCodes: [{ code: 'transaction_modified' }]
        });
    });

    test('accepts a top-level decision response without a case wrapper', async () => {
        serviceMocks.decidePersonalFinanceReconciliationCase.mockResolvedValueOnce({
            data: {
                success: true,
                result: {
                    id: '5101',
                    decisionType: 'independent',
                    status: 'applied',
                    appliedCaseVersion: 8,
                    reasonCodes: [],
                    errorCode: '',
                    createdUnixTime: 103,
                    updatedUnixTime: 104,
                    replayed: false
                }
            }
        });

        const result = await reconciliationApi.decide({
            caseId: '4101',
            expectedCaseVersion: 7,
            idempotencyKey: 'decision-key',
            decisionType: 'independent'
        });
        expect(result.case).toBeUndefined();
        expect(result.decision).toMatchObject({ id: '5101', decisionType: 'independent', status: 'applied' });
    });
});
