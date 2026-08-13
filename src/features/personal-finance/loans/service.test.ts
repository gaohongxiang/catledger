import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
    calculatePersonalFinanceLoan: vi.fn(),
    listPersonalFinanceLoanContracts: vi.fn(),
    getPersonalFinanceLoanContract: vi.fn(),
    createPersonalFinanceLoanContract: vi.fn(),
    revisePersonalFinanceLoanContract: vi.fn(),
    closePersonalFinanceLoanContract: vi.fn(),
    reopenPersonalFinanceLoanContract: vi.fn(),
    cancelPersonalFinanceLoanContract: vi.fn(),
    listPersonalFinanceLoanSettlementCandidates: vi.fn(),
    applyPersonalFinanceLoanSettlement: vi.fn(),
    getPersonalFinanceLoanSettlementUndoImpact: vi.fn(),
    undoPersonalFinanceLoanSettlement: vi.fn()
}));

vi.mock('@/lib/services.ts', () => ({ default: serviceMocks }));

import type { LoanCalculationInput } from './models.ts';
import {
    loanApi,
    loanApiPaths,
    LoanProtocolError
} from './service.ts';

function apiResponse(result: unknown): unknown {
    return { data: { success: true, result } };
}

function calculationInput(overrides: Partial<LoanCalculationInput> = {}): LoanCalculationInput {
    return {
        fundingType: 'cash_disbursement',
        inputMode: 'rate',
        repaymentMethod: 'equal_payment',
        rateQuoteType: 'annual',
        effectiveDate: '2026-08-14',
        contractDate: '2026-08-13',
        firstDueDate: '2026-09-13',
        principalAmount: 5000000,
        actualDisbursementAmount: 4900000,
        upfrontFeeAmount: 100000,
        perPeriodFeeAmount: 1000,
        termCount: 12,
        quotedRatePptr: '120000000000',
        discountType: 'none',
        discountAmount: 0,
        ...overrides
    };
}

function calculationSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        preDiscountTotalPaymentAmount: 5452000,
        preDiscountTotalCostAmount: 552000,
        totalPaymentAmount: 5452000,
        totalInterestAmount: 440000,
        totalFeeAmount: 112000,
        totalDiscountAmount: 0,
        totalCostAmount: 552000,
        costRatioPptr: '110400000000',
        irrStatus: 'solved',
        monthlyIrrPptr: '10000000000',
        simpleAprPptr: '120000000000',
        effectiveAprPptr: '126825030132',
        ...overrides
    };
}

function calculatedInstallment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        installmentNumber: 1,
        dueDate: '2026-09-13',
        beginningPrincipalAmount: 5000000,
        principalAmount: 400000,
        interestAmount: 50000,
        feeAmount: 1000,
        discountAmount: 0,
        paymentAmount: 451000,
        endingPrincipalAmount: 4600000,
        preDiscountInterestAmount: 50000,
        preDiscountFeeAmount: 1000,
        preDiscountPaymentAmount: 451000,
        ...overrides
    };
}

function calculationResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        calculationVersion: 'loan-calculation-v1',
        roundingVersion: 'loan-rounding-half-up-v1',
        irrVersion: 'periodic-irr-v1',
        summary: calculationSummary(),
        installments: [calculatedInstallment()],
        scheduleDigest: 'must-not-enter-browser-model',
        uid: 'must-not-enter-browser-model',
        ...overrides
    };
}

function contract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: '101',
        name: '脱敏合同',
        lenderName: '脱敏机构',
        contractType: 'bank_loan',
        status: 'active',
        closeReason: null,
        liabilityAccountId: '1001',
        defaultPaymentAccountId: '1002',
        currency: 'CNY',
        note: '',
        version: 7,
        currentRevisionId: '201',
        createdUnixTime: 1000,
        updatedUnixTime: 1001,
        closedUnixTime: null,
        uid: 'private',
        internalDigest: 'private',
        ...overrides
    };
}

function progress(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        settlementStatus: 'unpaid',
        overdue: false,
        allocatedPrincipalAmount: 0,
        allocatedInterestAmount: 0,
        allocatedFeeAmount: 0,
        outstandingPrincipalAmount: 400000,
        outstandingInterestAmount: 50000,
        outstandingFeeAmount: 1000,
        outstandingPaymentAmount: 451000,
        actionRequired: false,
        reasonCodes: [],
        ...overrides
    };
}

function installment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: '301',
        revisionId: '201',
        ...calculatedInstallment(),
        progress: progress(),
        ...overrides
    };
}

function contractSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        contract: contract(),
        calculation: calculationSummary(),
        paidInstallmentCount: 0,
        partialInstallmentCount: 0,
        totalInstallmentCount: 12,
        outstandingPrincipalAmount: 5000000,
        outstandingPaymentAmount: 5452000,
        nextInstallment: installment(),
        actionRequired: false,
        reasonCodes: [],
        ...overrides
    };
}

function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const input = calculationInput();
    return {
        contract: contract(),
        currentRevision: {
            id: '201',
            revisionNumber: 1,
            previousRevisionId: null,
            effectiveDate: input.effectiveDate,
            input,
            calculation: calculationResult(),
            createdUnixTime: 1000
        },
        installments: [installment()],
        allocations: {
            activeAllocationCount: 0,
            actionRequiredAllocationCount: 0,
            allocatedDisbursementAmount: 0,
            allocatedPrincipalAmount: 0,
            allocatedInterestAmount: 0,
            allocatedFeeAmount: 0
        },
        liabilityComparison: {
            plannedOutstandingPrincipalAmount: 5000000,
            ledgerOutstandingLiabilityAmount: 5000000,
            differenceAmount: 0,
            actionRequired: false,
            reasonCodes: []
        },
        asOfDate: '2026-08-14',
        transactionComment: 'must-not-enter-browser-model',
        ...overrides
    };
}

function actionResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        actionId: '501',
        status: 'applied',
        contract: null,
        allocations: [],
        replayed: false,
        reasonCodes: [],
        errorCode: 'must-not-enter-browser-model',
        idempotencyKey: 'must-not-enter-browser-model',
        ...overrides
    };
}

function undoImpact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        contractId: '101',
        actionId: '501',
        activeAllocationCount: 2,
        relationshipCount: 3,
        affectedTransactionCount: 3,
        loanCreatedTransactionCount: 0,
        modifiedTransactionCount: 0,
        missingTransactionCount: 0,
        incompleteTransferPairCount: 0,
        canUndoRelationships: true,
        reasonCodes: [],
        ...overrides
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('personal finance loan HTTP service', () => {
    it('keeps all twelve frozen endpoint paths', () => {
        expect(loanApiPaths).toEqual({
            calculate: '/api/v1/personal_finance/loans/calculate.json',
            listContracts: '/api/v1/personal_finance/loans/contracts/list.json',
            getContract: '/api/v1/personal_finance/loans/contracts/get.json',
            createContract: '/api/v1/personal_finance/loans/contracts/create.json',
            reviseContract: '/api/v1/personal_finance/loans/contracts/revise.json',
            closeContract: '/api/v1/personal_finance/loans/contracts/close.json',
            reopenContract: '/api/v1/personal_finance/loans/contracts/reopen.json',
            cancelContract: '/api/v1/personal_finance/loans/contracts/cancel.json',
            listSettlementCandidates: '/api/v1/personal_finance/loans/settlements/candidates.json',
            applySettlement: '/api/v1/personal_finance/loans/settlements/apply.json',
            getSettlementUndoImpact: '/api/v1/personal_finance/loans/settlements/undo_impact.json',
            undoSettlement: '/api/v1/personal_finance/loans/settlements/undo.json'
        });
    });

    it('projects calculate input with explicit effectiveDate and decimal pptr, then strips sensitive extras', async () => {
        serviceMocks.calculatePersonalFinanceLoan.mockResolvedValue(apiResponse(calculationResult()));
        const input = { ...calculationInput(), uid: 'private', amountAsBigInt: 1n } as LoanCalculationInput;

        const result = await loanApi.calculate(input);

        expect(serviceMocks.calculatePersonalFinanceLoan).toHaveBeenCalledWith(calculationInput());
        expect(serviceMocks.calculatePersonalFinanceLoan.mock.calls[0]?.[0]).not.toHaveProperty('uid');
        expect(serviceMocks.calculatePersonalFinanceLoan.mock.calls[0]?.[0]).not.toHaveProperty('amountAsBigInt');
        expect(result).not.toHaveProperty('uid');
        expect(result).not.toHaveProperty('scheduleDigest');
        expect(result.installments).toHaveLength(1);
        expect(result.summary.costRatioPptr).toBe('110400000000');
    });

    it('preserves the repayment-mode empty rate quote sentinel in requests and validates it in responses', async () => {
        const repayment = calculationInput({
            inputMode: 'repayment',
            rateQuoteType: '',
            quotedRatePptr: undefined,
            paymentBasisAmount: 446059
        });
        serviceMocks.calculatePersonalFinanceLoan.mockResolvedValue(apiResponse(calculationResult()));
        await loanApi.calculate(repayment);
        expect(serviceMocks.calculatePersonalFinanceLoan).toHaveBeenCalledWith(repayment);

        serviceMocks.getPersonalFinanceLoanContract.mockResolvedValue(apiResponse(detail({
            currentRevision: {
                id: '201',
                revisionNumber: 1,
                previousRevisionId: null,
                effectiveDate: repayment.effectiveDate,
                input: repayment,
                calculation: calculationResult(),
                createdUnixTime: 1000
            }
        })));
        expect((await loanApi.getContract('101')).currentRevision.input.rateQuoteType).toBe('');

        serviceMocks.getPersonalFinanceLoanContract.mockResolvedValue(apiResponse(detail({
            currentRevision: {
                id: '201',
                revisionNumber: 1,
                previousRevisionId: null,
                effectiveDate: repayment.effectiveDate,
                input: { ...repayment, rateQuoteType: 'annual' },
                calculation: calculationResult(),
                createdUnixTime: 1000
            }
        })));
        await expect(loanApi.getContract('101')).rejects.toMatchObject({ code: 'invalid_loan_enum' });
    });

    it('normalizes list and detail with string IDs, cursors, nullable fields and empty lists', async () => {
        serviceMocks.listPersonalFinanceLoanContracts.mockResolvedValue(apiResponse({
            items: [contractSummary()],
            nextCursor: { status: 'active', updatedUnixTime: 1001, contractId: '101' }
        }));
        serviceMocks.getPersonalFinanceLoanContract.mockResolvedValue(apiResponse(detail({ installments: [] })));

        const page = await loanApi.listContracts({
            status: 'active',
            cursor: { updatedUnixTime: 1000, contractId: '100' },
            limit: 20
        });
        const current = await loanApi.getContract('101');

        expect(serviceMocks.listPersonalFinanceLoanContracts).toHaveBeenCalledWith({
            status: 'active',
            cursor: { updatedUnixTime: 1000, contractId: '100' },
            limit: 20
        });
        expect(serviceMocks.getPersonalFinanceLoanContract).toHaveBeenCalledWith({ contractId: '101' });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]?.nextInstallment?.id).toBe('301');
        expect(page.nextCursor?.contractId).toBe('101');
        expect(current.installments).toEqual([]);
        expect(current.contract).not.toHaveProperty('uid');
        expect(current).not.toHaveProperty('transactionComment');
    });

    it('sends create, revise, close, reopen and cancel through their exact thin methods', async () => {
        for (const mock of [
            serviceMocks.createPersonalFinanceLoanContract,
            serviceMocks.revisePersonalFinanceLoanContract,
            serviceMocks.closePersonalFinanceLoanContract,
            serviceMocks.reopenPersonalFinanceLoanContract,
            serviceMocks.cancelPersonalFinanceLoanContract
        ]) {
            mock.mockResolvedValue(apiResponse(actionResult()));
        }
        const identity = {
            name: '脱敏合同',
            lenderName: '脱敏机构',
            contractType: 'bank_loan' as const,
            liabilityAccountId: '1001',
            defaultPaymentAccountId: '1002',
            currency: 'CNY',
            note: ''
        };
        await loanApi.createContract({ contract: identity, calculation: calculationInput(), idempotencyKey: 'create-key' });
        await loanApi.reviseContract({ contractId: '101', expectedContractVersion: 7, calculation: calculationInput(), idempotencyKey: 'revise-key' });
        await loanApi.closeContract({ contractId: '101', expectedContractVersion: 8, closeReason: 'manual_close', idempotencyKey: 'close-key' });
        await loanApi.reopenContract({ contractId: '101', expectedContractVersion: 9, idempotencyKey: 'reopen-key' });
        const result = await loanApi.cancelContract({ contractId: '101', expectedContractVersion: 10, idempotencyKey: 'cancel-key' });

        expect(serviceMocks.createPersonalFinanceLoanContract).toHaveBeenCalledWith({ contract: identity, calculation: calculationInput(), idempotencyKey: 'create-key' });
        expect(serviceMocks.revisePersonalFinanceLoanContract).toHaveBeenCalledWith({ contractId: '101', expectedContractVersion: 7, calculation: calculationInput(), idempotencyKey: 'revise-key' });
        expect(serviceMocks.closePersonalFinanceLoanContract).toHaveBeenCalledWith({ contractId: '101', expectedContractVersion: 8, closeReason: 'manual_close', idempotencyKey: 'close-key' });
        expect(serviceMocks.reopenPersonalFinanceLoanContract).toHaveBeenCalledWith({ contractId: '101', expectedContractVersion: 9, idempotencyKey: 'reopen-key' });
        expect(serviceMocks.cancelPersonalFinanceLoanContract).toHaveBeenCalledWith({ contractId: '101', expectedContractVersion: 10, idempotencyKey: 'cancel-key' });
        expect(result).not.toHaveProperty('errorCode');
        expect(result).not.toHaveProperty('idempotencyKey');
        expect(result.allocations).toEqual([]);
    });

    it('normalizes candidate transfer snapshots and rejects impossible expense snapshots', async () => {
        serviceMocks.listPersonalFinanceLoanSettlementCandidates.mockResolvedValue(apiResponse({
            contractId: '101',
            installmentId: '301',
            groups: [{
                componentType: 'principal',
                expectedAmount: 400000,
                outstandingAmount: 400000,
                candidates: [{
                    transactionId: '401',
                    transactionType: 'transfer',
                    transactionDate: '2026-09-13',
                    amount: 400000,
                    currency: 'CNY',
                    maskedSourceAccount: '账户 ·· 01',
                    maskedDestinationAccount: '账户 ·· 02',
                    eligible: true,
                    reasonCodes: [],
                    updatedUnixTime: 1000,
                    counterpartUpdatedUnixTime: 1001,
                    comment: 'must-not-enter-browser-model'
                }, {
                    transactionId: '403',
                    transactionType: 'transfer',
                    transactionDate: '2026-09-13',
                    amount: 400000,
                    currency: 'CNY',
                    maskedSourceAccount: '账户 ·· 03',
                    maskedDestinationAccount: null,
                    eligible: false,
                    reasonCodes: [{ code: 'incomplete_transfer_pair' }],
                    updatedUnixTime: 1002,
                    counterpartUpdatedUnixTime: null
                }],
                limitReached: false
            }]
        }));

        const result = await loanApi.listSettlementCandidates({
            contractId: '101',
            installmentId: '301',
            componentType: 'principal'
        });
        expect(serviceMocks.listPersonalFinanceLoanSettlementCandidates).toHaveBeenCalledWith({
            contractId: '101',
            installmentId: '301',
            componentType: 'principal'
        });
        expect(result.groups[0]?.candidates[0]).toMatchObject({
            transactionId: '401',
            updatedUnixTime: 1000,
            counterpartUpdatedUnixTime: 1001
        });
        expect(result.groups[0]?.candidates[0]).not.toHaveProperty('comment');
        expect(result.groups[0]?.candidates[1]).not.toHaveProperty('counterpartUpdatedUnixTime');

        serviceMocks.listPersonalFinanceLoanSettlementCandidates.mockResolvedValue(apiResponse({
            contractId: '101',
            installmentId: '301',
            groups: [{
                componentType: 'interest',
                expectedAmount: 50000,
                outstandingAmount: 50000,
                candidates: [{
                    transactionId: '402',
                    transactionType: 'expense',
                    transactionDate: '2026-09-13',
                    amount: 50000,
                    currency: 'CNY',
                    maskedSourceAccount: '账户 ·· 01',
                    eligible: true,
                    reasonCodes: [],
                    updatedUnixTime: 1000,
                    counterpartUpdatedUnixTime: 1001
                }],
                limitReached: false
            }]
        }));
        await expect(loanApi.listSettlementCandidates({
            contractId: '101',
            installmentId: '301',
            componentType: 'interest'
        })).rejects.toMatchObject({ code: 'invalid_loan_transfer_snapshot' });
    });

    it('preserves existing snapshots and explicit transfer category while applying settlement', async () => {
        serviceMocks.applyPersonalFinanceLoanSettlement.mockResolvedValue(apiResponse(actionResult({
            allocations: [{
                id: '601',
                installmentId: '301',
                componentType: 'principal',
                allocatedAmount: 400000,
                creationMethod: 'attached_existing',
                status: 'active',
                transactionId: '401',
                counterpartTransactionId: '402',
                reasonCodes: [],
                createdUnixTime: 1000,
                updatedUnixTime: 1000
            }]
        })));
        const request = {
            contractId: '101',
            expectedContractVersion: 7,
            installmentId: '301',
            idempotencyKey: 'apply-key',
            components: [{
                componentType: 'principal' as const,
                allocatedAmount: 400000,
                existingTransactionId: '401',
                expectedUpdatedUnixTime: 1000,
                expectedCounterpartUpdatedUnixTime: 1001
            }, {
                componentType: 'interest' as const,
                allocatedAmount: 50000,
                ledgerDraft: {
                    transactionType: 'expense' as const,
                    transactionDate: '2026-09-13',
                    sourceAccountId: '1002',
                    categoryId: '2001',
                    amount: 50000,
                    currency: 'CNY'
                }
            }]
        };

        const result = await loanApi.applySettlement(request);
        expect(serviceMocks.applyPersonalFinanceLoanSettlement).toHaveBeenCalledWith(request);
        expect(result.allocations[0]?.counterpartTransactionId).toBe('402');

        serviceMocks.applyPersonalFinanceLoanSettlement.mockResolvedValue(apiResponse(actionResult()));
        const disbursement = {
            contractId: '101',
            expectedContractVersion: 8,
            idempotencyKey: 'disbursement-key',
            components: [{
                componentType: 'disbursement' as const,
                allocatedAmount: 4900000,
                ledgerDraft: {
                    transactionType: 'transfer' as const,
                    transactionDate: '2026-08-14',
                    sourceAccountId: '1001',
                    destinationAccountId: '1002',
                    categoryId: '2002',
                    amount: 4900000,
                    currency: 'CNY'
                }
            }]
        };
        await loanApi.applySettlement(disbursement);
        expect(serviceMocks.applyPersonalFinanceLoanSettlement).toHaveBeenLastCalledWith(disbursement);
    });

    it('normalizes undo impact and sends additive undo with action and contract CAS IDs', async () => {
        serviceMocks.getPersonalFinanceLoanSettlementUndoImpact.mockResolvedValue(apiResponse(undoImpact()));
        serviceMocks.undoPersonalFinanceLoanSettlement.mockResolvedValue(apiResponse(actionResult()));

        const impact = await loanApi.getSettlementUndoImpact({ contractId: '101', actionId: '501' });
        await loanApi.undoSettlement({
            contractId: '101',
            actionId: '501',
            expectedContractVersion: 8,
            idempotencyKey: 'undo-key'
        });

        expect(serviceMocks.getPersonalFinanceLoanSettlementUndoImpact).toHaveBeenCalledWith({ contractId: '101', actionId: '501' });
        expect(serviceMocks.undoPersonalFinanceLoanSettlement).toHaveBeenCalledWith({
            contractId: '101',
            actionId: '501',
            expectedContractVersion: 8,
            idempotencyKey: 'undo-key'
        });
        expect(impact.activeAllocationCount).toBe(2);
        expect(impact.reasonCodes).toEqual([]);
    });

    it('rejects unknown enums, malformed allocations, duplicate reasons, non-string IDs and number pptr with stable errors', async () => {
        const invalidResults = [
            calculationResult({ summary: calculationSummary({ irrStatus: 'future_status' }) }),
            calculationResult({ installments: [calculatedInstallment({ installmentNumber: -1 })] }),
            calculationResult({ summary: calculationSummary({ costRatioPptr: 110400000000 }) })
        ];
        for (const value of invalidResults) {
            serviceMocks.calculatePersonalFinanceLoan.mockResolvedValueOnce(apiResponse(value));
            await expect(loanApi.calculate(calculationInput())).rejects.toBeInstanceOf(LoanProtocolError);
        }

        serviceMocks.cancelPersonalFinanceLoanContract.mockResolvedValue(apiResponse(actionResult({
            reasonCodes: [{ code: 'conflict' }, { code: 'conflict' }]
        })));
        await expect(loanApi.cancelContract({
            contractId: '101',
            expectedContractVersion: 7,
            idempotencyKey: 'cancel-key'
        })).rejects.toMatchObject({ code: 'duplicate_loan_reason' });

        serviceMocks.cancelPersonalFinanceLoanContract.mockResolvedValue(apiResponse(actionResult({ status: 'future_status' })));
        await expect(loanApi.cancelContract({
            contractId: '101',
            expectedContractVersion: 7,
            idempotencyKey: 'cancel-key'
        })).rejects.toMatchObject({ code: 'invalid_loan_enum' });

        serviceMocks.cancelPersonalFinanceLoanContract.mockResolvedValue(apiResponse(actionResult({
            allocations: [{
                id: '601',
                installmentId: '301',
                componentType: 'interest',
                allocatedAmount: 50000,
                creationMethod: 'attached_existing',
                status: 'future_status',
                transactionId: '401',
                counterpartTransactionId: null,
                reasonCodes: [],
                createdUnixTime: 1000,
                updatedUnixTime: 1000
            }]
        })));
        await expect(loanApi.cancelContract({
            contractId: '101',
            expectedContractVersion: 7,
            idempotencyKey: 'cancel-key'
        })).rejects.toMatchObject({ code: 'invalid_loan_enum' });

        serviceMocks.cancelPersonalFinanceLoanContract.mockResolvedValue(apiResponse(actionResult({ reasonCodes: ['conflict'] })));
        await expect(loanApi.cancelContract({
            contractId: '101',
            expectedContractVersion: 7,
            idempotencyKey: 'cancel-key'
        })).rejects.toMatchObject({ code: 'invalid_loan_reason' });

        serviceMocks.getPersonalFinanceLoanContract.mockResolvedValue(apiResponse(detail({
            contract: contract({ id: 101 })
        })));
        await expect(loanApi.getContract('101')).rejects.toMatchObject({ code: 'invalid_loan_identifier' });

        serviceMocks.getPersonalFinanceLoanContract.mockResolvedValue({ data: { success: false } });
        await expect(loanApi.getContract('101')).rejects.toMatchObject({ code: 'invalid_loan_response' });
    });

    it('does not wrap network failures from the existing error layer', async () => {
        const networkError = new Error('network-layer-error');
        serviceMocks.getPersonalFinanceLoanContract.mockRejectedValue(networkError);
        await expect(loanApi.getContract('101')).rejects.toBe(networkError);
    });
});
