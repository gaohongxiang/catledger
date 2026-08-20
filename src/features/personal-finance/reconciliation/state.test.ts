import { describe, expect, test, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
    listPersonalFinanceReconciliationCases: vi.fn(),
    decidePersonalFinanceReconciliationCase: vi.fn(),
    getPersonalFinanceReconciliationUndoImpact: vi.fn()
}));

vi.mock('@/lib/services.ts', () => ({ default: serviceMocks }));

import { CategoryType } from '@/core/category.ts';
import { TransactionType } from '@/core/transaction.ts';

import type { ReconciliationCaseDetail, ReconciliationDecisionComposition, ReconciliationEvidenceCard } from './models.ts';
import {
    buildReconciliationDecisionRequest,
    buildReconciliationUndoRequest,
    canDecideReconciliationCase,
    canInspectReconciliationUndo,
    ReconciliationDecisionValidationError
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
        candidateRuleVersion: 'reconciliation-candidate-v5',
        explanationVersion: 'reconciliation-explanation-v5',
        reasonCodes: [{ code: 'amount_currency_exact', value: 40 }],
        createdUnixTime: 100,
        lastEvaluatedUnixTime: 101,
        updatedUnixTime: 102,
        evidence: [],
        ...overrides
    };
}

function evidence(order: 1 | 2, overrides: Partial<ReconciliationEvidenceCard> = {}): ReconciliationEvidenceCard {
    return {
        order,
        kind: 'source_identity',
        role: 'evidence',
        sourceType: order === 1 ? 'alipay' : 'bank',
        maskedSourceAccount: order === 1 ? '支付宝 ·· 12' : '银行卡 ·· 34',
        evidenceLimitReached: false,
        normalizedAmount: '8800',
        currency: 'CNY',
        normalizedDirection: order === 1 ? 'expense' : 'income',
        normalizedUnixTime: 100,
        normalizedTimezoneUtcOffset: 480,
        normalizedTransactionType: 'payment',
        economicEffect: 'normal',
        parseState: 'valid',
        identityState: 'new',
        disposition: 'postable',
        processingState: 'pending',
        transactionCount: 0,
        ...overrides
    };
}

const buildContext = {
    accountCurrencies: { account1: 'CNY', account2: 'CNY', usd: 'USD' },
    categoryTypes: {
        expense: CategoryType.Expense,
        income: CategoryType.Income,
        transfer: CategoryType.Transfer
    }
};

function composition(overrides: Partial<ReconciliationDecisionComposition> = {}): ReconciliationDecisionComposition {
    return {
        decisionType: 'same_event',
        fieldSelection: {
            accountAmountMemberOrder: 1,
            merchantItemMemberOrder: 2,
            refundOriginalMemberOrder: 0
        },
        primaryDraft: {
            type: TransactionType.Expense,
            categoryId: 'expense',
            sourceAccountId: 'account1',
            destinationAccountId: ''
        },
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
            reconciliationCase: reconciliationCase({ evidence: [evidence(1), evidence(2)] }),
            composition: composition({ decisionType: 'independent' }),
            context: buildContext,
            idempotencyKey: 'decision-key'
        })).toEqual({
            caseId: '4101',
            expectedCaseVersion: 7,
            idempotencyKey: 'decision-key',
            decisionType: 'independent',
            fieldSelection: {
                accountAmountMemberOrder: 1,
                merchantItemMemberOrder: 2,
                refundOriginalMemberOrder: 0
            }
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

    test('creates a primary ordinary draft only when same-event has no formal transaction', () => {
        const noEvent = reconciliationCase({ evidence: [evidence(1), evidence(2)] });
        const request = buildReconciliationDecisionRequest({
            reconciliationCase: noEvent,
            composition: composition(),
            context: buildContext,
            idempotencyKey: 'same-event-no-ledger'
        });
        expect(request.primaryDraft).toEqual({
            type: TransactionType.Expense,
            categoryId: 'expense',
            time: 100,
            utcOffset: 480,
            sourceAccountId: 'account1',
            destinationAccountId: '0',
            sourceAmount: 8800,
            destinationAmount: 0,
            hideAmount: false,
            tagIds: [],
            comment: ''
        });

        const oneEvent = reconciliationCase({ evidence: [evidence(1, { transactionCount: 1 }), evidence(2)] });
        expect(buildReconciliationDecisionRequest({
            reconciliationCase: oneEvent,
            composition: composition({ primaryDraft: undefined }),
            context: buildContext,
            idempotencyKey: 'same-event-existing-ledger'
        })).not.toHaveProperty('primaryDraft');
    });

    test('creates an equal-amount internal transfer draft with distinct matching-currency accounts', () => {
        const request = buildReconciliationDecisionRequest({
            reconciliationCase: reconciliationCase({ evidence: [evidence(1), evidence(2)] }),
            composition: composition({
                decisionType: 'internal_transfer',
                primaryDraft: {
                    type: TransactionType.Transfer,
                    categoryId: 'transfer',
                    sourceAccountId: 'account1',
                    destinationAccountId: 'account2'
                }
            }),
            context: buildContext,
            idempotencyKey: 'transfer-no-ledger'
        });
        expect(request.primaryDraft).toMatchObject({
            type: TransactionType.Transfer,
            sourceAmount: 8800,
            destinationAmount: 8800,
            sourceAccountId: 'account1',
            destinationAccountId: 'account2'
        });
    });

    test('creates refund drafts per missing member and records the original member', () => {
        const refundComposition = composition({
            decisionType: 'refund_reversal',
            fieldSelection: {
                accountAmountMemberOrder: 1,
                merchantItemMemberOrder: 2,
                refundOriginalMemberOrder: 1
            },
            primaryDraft: undefined,
            refundOriginalDraft: {
                type: TransactionType.Expense,
                categoryId: 'expense',
                sourceAccountId: 'account1',
                destinationAccountId: ''
            },
            refundTransactionDraft: {
                type: TransactionType.Income,
                categoryId: 'income',
                sourceAccountId: 'account2',
                destinationAccountId: ''
            }
        });
        const bothMissing = buildReconciliationDecisionRequest({
            reconciliationCase: reconciliationCase({ evidence: [evidence(1), evidence(2)] }),
            composition: refundComposition,
            context: buildContext,
            idempotencyKey: 'refund-both-missing'
        });
        expect(bothMissing.fieldSelection.refundOriginalMemberOrder).toBe(1);
        expect(bothMissing.refundOriginalDraft?.type).toBe(TransactionType.Expense);
        expect(bothMissing.refundTransactionDraft?.type).toBe(TransactionType.Income);

        const originalExisting = buildReconciliationDecisionRequest({
            reconciliationCase: reconciliationCase({ evidence: [evidence(1, { transactionCount: 1 }), evidence(2)] }),
            composition: refundComposition,
            context: buildContext,
            idempotencyKey: 'refund-one-missing'
        });
        expect(originalExisting).not.toHaveProperty('refundOriginalDraft');
        expect(originalExisting.refundTransactionDraft?.type).toBe(TransactionType.Income);

        const refundExisting = buildReconciliationDecisionRequest({
            reconciliationCase: reconciliationCase({ evidence: [evidence(1), evidence(2, { transactionCount: 1 })] }),
            composition: refundComposition,
            context: buildContext,
            idempotencyKey: 'refund-other-side-existing'
        });
        expect(refundExisting.refundOriginalDraft?.type).toBe(TransactionType.Expense);
        expect(refundExisting).not.toHaveProperty('refundTransactionDraft');
    });

    test('independent and defer never create ledger drafts', () => {
        for (const decisionType of ['independent', 'defer'] as const) {
            const request = buildReconciliationDecisionRequest({
                reconciliationCase: reconciliationCase({ evidence: [evidence(1), evidence(2)] }),
                composition: composition({ decisionType }),
                context: buildContext,
                idempotencyKey: decisionType
            });
            expect(request).not.toHaveProperty('primaryDraft');
            expect(request).not.toHaveProperty('refundOriginalDraft');
            expect(request).not.toHaveProperty('refundTransactionDraft');
        }
    });

    test('rejects incomplete evidence, currency mismatch, and invalid ledger selections', () => {
        const cases = [
            {
                current: reconciliationCase({ evidence: [evidence(1, { normalizedAmount: '' }), evidence(2)] }),
                currentComposition: composition(),
                code: 'evidence_incomplete'
            },
            {
                current: reconciliationCase({ evidence: [evidence(1, { normalizedUnixTime: 0 }), evidence(2)] }),
                currentComposition: composition(),
                code: 'evidence_incomplete'
            },
            {
                current: reconciliationCase({ evidence: [evidence(1), evidence(2, { currency: 'USD' })] }),
                currentComposition: composition(),
                code: 'currency_mismatch'
            },
            {
                current: reconciliationCase({ evidence: [evidence(1), evidence(2)] }),
                currentComposition: composition({ primaryDraft: { type: TransactionType.Expense, categoryId: '', sourceAccountId: 'account1', destinationAccountId: '' } }),
                code: 'category_invalid'
            },
            {
                current: reconciliationCase({ evidence: [evidence(1), evidence(2)] }),
                currentComposition: composition({ primaryDraft: { type: TransactionType.Expense, categoryId: 'expense', sourceAccountId: 'usd', destinationAccountId: '' } }),
                code: 'account_invalid'
            },
            {
                current: reconciliationCase({ evidence: [evidence(1, { normalizedDirection: 'unknown' }), evidence(2)] }),
                currentComposition: composition({ primaryDraft: { type: null, categoryId: '', sourceAccountId: 'account1', destinationAccountId: '' } }),
                code: 'transaction_type_required'
            },
            {
                current: reconciliationCase({ evidence: [evidence(1), evidence(2)] }),
                currentComposition: composition({
                    decisionType: 'internal_transfer',
                    primaryDraft: { type: TransactionType.Transfer, categoryId: 'transfer', sourceAccountId: 'account1', destinationAccountId: 'account1' }
                }),
                code: 'transfer_accounts_must_differ'
            },
            {
                current: reconciliationCase({ evidence: [evidence(1), evidence(2)] }),
                currentComposition: composition({
                    decisionType: 'refund_reversal',
                    fieldSelection: { accountAmountMemberOrder: 1, merchantItemMemberOrder: 2, refundOriginalMemberOrder: 1 },
                    primaryDraft: undefined,
                    refundOriginalDraft: { type: TransactionType.Expense, categoryId: 'expense', sourceAccountId: 'account1', destinationAccountId: '' },
                    refundTransactionDraft: { type: TransactionType.Expense, categoryId: 'expense', sourceAccountId: 'account2', destinationAccountId: '' }
                }),
                code: 'refund_types_must_be_opposite'
            }
        ];

        for (const item of cases) {
            try {
                buildReconciliationDecisionRequest({
                    reconciliationCase: item.current,
                    composition: item.currentComposition,
                    context: buildContext,
                    idempotencyKey: item.code
                });
                expect.fail('expected reconciliation validation error');
            } catch (error) {
                expect(error).toBeInstanceOf(ReconciliationDecisionValidationError);
                expect((error as ReconciliationDecisionValidationError).code).toBe(item.code);
            }
        }
    });

    test('allows new decisions only for open cases and exposes undo only with a persisted decision', () => {
        expect(canDecideReconciliationCase(reconciliationCase())).toBe(true);
        expect(canDecideReconciliationCase(reconciliationCase({ status: 'action_required' }))).toBe(false);
        expect(canDecideReconciliationCase(reconciliationCase({ status: 'deferred' }))).toBe(false);
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
            decisionType: 'independent',
            fieldSelection: {
                accountAmountMemberOrder: 1,
                merchantItemMemberOrder: 2,
                refundOriginalMemberOrder: 0
            }
        });
        expect(result.case).toBeUndefined();
        expect(result.decision).toMatchObject({ id: '5101', decisionType: 'independent', status: 'applied' });
    });
});
