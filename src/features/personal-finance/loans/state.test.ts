import { describe, expect, it } from 'vitest';

import type {
    LoanCalculationInput,
    LoanContractDetail,
    LoanInstallment,
    LoanSettlementComponent
} from './models.ts';
import {
    buildLoanSettlementApplyRequest,
    buildLoanSettlementUndoRequest,
    canCancelLoanContract,
    canReviseLoanContract,
    createDefaultLoanCalculationInput,
    getLoanInstallmentDisplayStatus,
    getLoanSettlementDraftDate,
    formatLoanPptrAsPercentage,
    LoanValidationError,
    normalizeLoanPercentageInput,
    parseLoanPercentageToPptr,
    updateLoanCalculationAmount,
    validateLoanCalculationInput
} from './state.ts';

function calculationInput(overrides: Partial<LoanCalculationInput> = {}): LoanCalculationInput {
    return {
        ...createDefaultLoanCalculationInput(),
        effectiveDate: '2026-08-14',
        contractDate: '2026-08-13',
        firstDueDate: '2026-09-13',
        principalAmount: 5000000,
        actualDisbursementAmount: 4900000,
        upfrontFeeAmount: 100000,
        quotedRatePptr: '120000000000',
        ...overrides
    };
}

function installment(overrides: Partial<LoanInstallment> = {}): LoanInstallment {
    return {
        id: '301',
        revisionId: '201',
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
        progress: {
            settlementStatus: 'unpaid',
            overdue: false,
            openingCompleted: false,
            allocatedPrincipalAmount: 0,
            allocatedInterestAmount: 0,
            allocatedFeeAmount: 0,
            outstandingPrincipalAmount: 400000,
            outstandingInterestAmount: 50000,
            outstandingFeeAmount: 1000,
            outstandingPaymentAmount: 451000,
            actionRequired: false,
            reasonCodes: []
        },
        ...overrides
    };
}

function existingComponent(componentType: 'principal' | 'interest' | 'fee', amount: number): LoanSettlementComponent {
    return {
        componentType,
        allocatedAmount: amount,
        existingTransactionId: componentType === 'principal' ? '101' : componentType === 'interest' ? '102' : '103',
        expectedUpdatedUnixTime: 1000 + amount,
        ...(componentType === 'principal' ? { expectedCounterpartUpdatedUnixTime: 2000 + amount } : {})
    };
}

describe('personal finance loan shell state', () => {
    it('keeps displayed currency amounts in internal integers and derives net disbursement atomically', () => {
        const principal = updateLoanCalculationAmount(calculationInput(), 'principalAmount', 5000000);
        expect(principal.principalAmount).toBe(5000000); // AmountInput emits 50000.00 as 5000000.
        expect(principal.actualDisbursementAmount).toBe(4900000);

        const withFee = updateLoanCalculationAmount(principal, 'upfrontFeeAmount', 125000);
        expect(withFee.actualDisbursementAmount).toBe(4875000);
        expect(validateLoanCalculationInput(withFee).actualDisbursementAmount).toBe(4875000);
    });

    it('converts ordinary decimal percentages to exact fixed-point strings in both directions', () => {
        expect(parseLoanPercentageToPptr('12')).toBe('120000000000');
        expect(formatLoanPptrAsPercentage('120000000000')).toBe('12');
        expect(parseLoanPercentageToPptr('70', '1000000000000')).toBe('700000000000');
        expect(formatLoanPptrAsPercentage('700000000000')).toBe('70');
        expect(parseLoanPercentageToPptr('12.1234567890')).toBe('121234567890');
        expect(parseLoanPercentageToPptr('12.12345678901')).toBeUndefined();
        expect(parseLoanPercentageToPptr('100.0000000001', '1000000000000')).toBeUndefined();
        expect(parseLoanPercentageToPptr('0.4167', undefined, 4)).toBe('4167000000');
        expect(parseLoanPercentageToPptr('０。４１６７', undefined, 4)).toBe('4167000000');
        expect(parseLoanPercentageToPptr('0，4167', undefined, 4)).toBe('4167000000');
        expect(parseLoanPercentageToPptr('0.41671', undefined, 4)).toBeUndefined();
        expect(formatLoanPptrAsPercentage('91042732511', 2)).toBe('9.10');
        expect(formatLoanPptrAsPercentage('47999824815', 2)).toBe('4.80');
    });

    it('invalidates stale percentage input and rejects a zero interest-rate discount', () => {
        expect(normalizeLoanPercentageInput('12')).toBe('120000000000');
        expect(normalizeLoanPercentageInput('')).toBe('');
        expect(normalizeLoanPercentageInput('invalid')).toBe('');
        expect(normalizeLoanPercentageInput('0', '1000000000000', false)).toBe('');
        expectValidationCode(calculationInput({
            discountType: 'interest_rate', discountRatePptr: '0'
        }), 'discount_invalid');
    });

    it('validates the frozen rate and repayment input modes without converting pptr to number', () => {
        expect(validateLoanCalculationInput(calculationInput()).quotedRatePptr).toBe('120000000000');
        expect(validateLoanCalculationInput(calculationInput({
            inputMode: 'repayment',
            rateQuoteType: '',
            quotedRatePptr: undefined,
            paymentBasisAmount: 446059
        })).paymentBasisAmount).toBe(446059);
        expectValidationCode(calculationInput({
            inputMode: 'repayment',
            quotedRatePptr: undefined,
            paymentBasisAmount: 446059
        }), 'payment_required');
        expectValidationCode(calculationInput({ rateQuoteType: '' }), 'rate_required');
    });

    it('requires all three explicit civil dates without inventing relative ordering', () => {
        expectValidationCode(calculationInput({ effectiveDate: '' }), 'date_invalid');
        expectValidationCode(calculationInput({ contractDate: '2026-02-30' }), 'date_invalid');
        expectValidationCode(calculationInput({ firstDueDate: 'not-a-date' }), 'date_invalid');
        expect(validateLoanCalculationInput(calculationInput({
            effectiveDate: '2026-08-20',
            contractDate: '2026-09-20',
            firstDueDate: '2026-08-20'
        })).firstDueDate).toBe('2026-08-20');
    });

    it('keeps net disbursement and first-version quote rules explicit', () => {
        expect(validateLoanCalculationInput(calculationInput({ quotedRatePptr: '9223372036854775807' })).quotedRatePptr)
            .toBe('9223372036854775807');
        expectValidationCode(calculationInput({ quotedRatePptr: '9223372036854775808' }), 'rate_required');
        expectValidationCode(calculationInput({ actualDisbursementAmount: 5000000 }), 'actual_disbursement_mismatch');
        expectValidationCode(calculationInput({
            rateQuoteType: 'installment',
            repaymentMethod: 'equal_payment'
        }), 'installment_quote_requires_flat');
        expect(validateLoanCalculationInput(calculationInput({
            rateQuoteType: 'installment',
            repaymentMethod: 'flat'
        })).rateQuoteType).toBe('installment');
    });

    it('uses the effective date for nil-installment disbursement and upfront-fee drafts', () => {
        const detail = {
            currentRevision: { input: calculationInput() },
            installments: [installment()]
        } as LoanContractDetail;
        expect(getLoanSettlementDraftDate(detail, undefined, 'disbursement')).toBe('2026-08-14');
        expect(getLoanSettlementDraftDate(detail, undefined, 'fee')).toBe('2026-08-14');
        expect(getLoanSettlementDraftDate(detail, '301', 'fee')).toBe('2026-09-13');
    });

    it('derives payment state from allocations and never marks a due plan paid by date alone', () => {
        expect(getLoanInstallmentDisplayStatus(installment({
            progress: { ...installment().progress, overdue: true }
        }))).toBe('overdue');
        expect(getLoanInstallmentDisplayStatus(installment({
            progress: { ...installment().progress, settlementStatus: 'partial', overdue: false }
        }))).toBe('partial');
        expect(getLoanInstallmentDisplayStatus(installment({
            progress: {
                ...installment().progress,
                settlementStatus: 'paid',
                overdue: true,
                outstandingPaymentAmount: 0
            }
        }))).toBe('paid');
        expect(getLoanInstallmentDisplayStatus(installment({
            progress: { ...installment().progress, actionRequired: true }
        }))).toBe('action_required');
    });

    it('builds one atomic installment command with separately typed principal, interest and fee components', () => {
        const request = buildLoanSettlementApplyRequest({
            contractId: '101',
            contractVersion: 7,
            installmentId: '301',
            idempotencyKey: 'pf-loan-settlement-ui-v1:test',
            components: [
                existingComponent('principal', 400000),
                existingComponent('interest', 50000),
                existingComponent('fee', 1000)
            ]
        });

        expect(request.expectedContractVersion).toBe(7);
        expect(request.components.map(component => component.componentType)).toEqual(['principal', 'interest', 'fee']);
        expect(request.components[0]).toMatchObject({
            existingTransactionId: '101',
            expectedUpdatedUnixTime: 401000,
            expectedCounterpartUpdatedUnixTime: 402000
        });
    });

    it('requires principal to use transfer semantics and interest or fee to use expense semantics', () => {
        expectLoanValidationCode(() => buildLoanSettlementApplyRequest({
            contractId: '101',
            contractVersion: 7,
            installmentId: '301',
            idempotencyKey: 'key',
            components: [{
                componentType: 'principal',
                allocatedAmount: 400000,
                ledgerDraft: {
                    transactionType: 'expense',
                    transactionDate: '2026-09-13',
                    sourceAccountId: '1001',
                    categoryId: '2001',
                    amount: 400000,
                    currency: 'CNY'
                }
            }]
        }), 'ledger_semantics_invalid');

        expect(buildLoanSettlementApplyRequest({
            contractId: '101',
            contractVersion: 7,
            installmentId: '301',
            idempotencyKey: 'key',
            components: [{
                componentType: 'interest',
                allocatedAmount: 50000,
                ledgerDraft: {
                    transactionType: 'expense',
                    transactionDate: '2026-09-13',
                    sourceAccountId: '1001',
                    categoryId: '2001',
                    amount: 50000,
                    currency: 'CNY'
                }
            }]
        }).components[0]?.componentType).toBe('interest');
    });

    it('allows only disbursement and upfront fee without an installment and keeps installment components separate', () => {
        expectLoanValidationCode(() => buildLoanSettlementApplyRequest({
            contractId: '101',
            contractVersion: 7,
            installmentId: '301',
            idempotencyKey: 'key',
            components: [{
                componentType: 'disbursement',
                allocatedAmount: 4900000,
                existingTransactionId: '104',
                expectedUpdatedUnixTime: 1000,
                expectedCounterpartUpdatedUnixTime: 1001
            }]
        }), 'component_context_mismatch');

        const funding = buildLoanSettlementApplyRequest({
            contractId: '101',
            contractVersion: 7,
            idempotencyKey: 'key',
            components: [{
                componentType: 'disbursement',
                allocatedAmount: 5000000,
                existingTransactionId: '104',
                expectedUpdatedUnixTime: 1000,
                expectedCounterpartUpdatedUnixTime: 1001
            }, {
                componentType: 'fee',
                allocatedAmount: 100000,
                existingTransactionId: '105',
                expectedUpdatedUnixTime: 1002
            }]
        });
        expect(funding.components.map(component => component.componentType)).toEqual(['disbursement', 'fee']);

        expectLoanValidationCode(() => buildLoanSettlementApplyRequest({
            contractId: '101',
            contractVersion: 7,
            idempotencyKey: 'key',
            components: [existingComponent('principal', 200000)]
        }), 'component_context_mismatch');

        expectLoanValidationCode(() => buildLoanSettlementApplyRequest({
            contractId: '101',
            contractVersion: 7,
            installmentId: '301',
            idempotencyKey: 'key',
            components: [existingComponent('principal', 200000), existingComponent('principal', 200000)]
        }), 'component_duplicate');
    });

    it('requires complete existing snapshots and keeps draft and existing sources strictly exclusive', () => {
        const base = {
            contractId: '101',
            contractVersion: 7,
            installmentId: '301',
            idempotencyKey: 'key'
        };
        expectLoanValidationCode(() => buildLoanSettlementApplyRequest({
            ...base,
            components: [{
                componentType: 'interest',
                allocatedAmount: 50000,
                existingTransactionId: '102'
            } as unknown as LoanSettlementComponent]
        }), 'component_source_invalid');
        expectLoanValidationCode(() => buildLoanSettlementApplyRequest({
            ...base,
            components: [{
                componentType: 'interest',
                allocatedAmount: 50000,
                existingTransactionId: '102',
                expectedUpdatedUnixTime: 0
            }]
        }), 'component_source_invalid');
        expectLoanValidationCode(() => buildLoanSettlementApplyRequest({
            ...base,
            components: [{
                componentType: 'principal',
                allocatedAmount: 400000,
                existingTransactionId: '101',
                expectedUpdatedUnixTime: 1000
            }]
        }), 'component_source_invalid');
        expectLoanValidationCode(() => buildLoanSettlementApplyRequest({
            ...base,
            components: [{
                componentType: 'interest',
                allocatedAmount: 50000,
                existingTransactionId: '102',
                expectedUpdatedUnixTime: 1000,
                expectedCounterpartUpdatedUnixTime: 1001
            }]
        }), 'component_source_invalid');
        expectLoanValidationCode(() => buildLoanSettlementApplyRequest({
            ...base,
            components: [{
                componentType: 'interest',
                allocatedAmount: 50000,
                existingTransactionId: '102',
                expectedUpdatedUnixTime: 1000,
                ledgerDraft: {
                    transactionType: 'expense',
                    transactionDate: '2026-09-13',
                    sourceAccountId: '1001',
                    categoryId: '2001',
                    amount: 50000,
                    currency: 'CNY'
                }
            } as unknown as LoanSettlementComponent]
        }), 'component_source_invalid');

        const request = buildLoanSettlementApplyRequest({
            ...base,
            components: [{
                componentType: 'interest',
                allocatedAmount: 50000,
                ledgerDraft: {
                    transactionType: 'expense',
                    transactionDate: '2026-09-13',
                    sourceAccountId: '1001',
                    categoryId: '2001',
                    amount: 50000,
                    currency: 'CNY'
                }
            }]
        });
        expect(request.components[0]).not.toHaveProperty('expectedUpdatedUnixTime');
        expect(request.components[0]).not.toHaveProperty('expectedCounterpartUpdatedUnixTime');
    });

    it('requires positive int64 IDs and an explicit transfer category in ledger drafts', () => {
        expectLoanValidationCode(() => buildLoanSettlementApplyRequest({
            contractId: 'not-an-id',
            contractVersion: 7,
            idempotencyKey: 'key',
            components: []
        }), 'contract_invalid');
        expectLoanValidationCode(() => buildLoanSettlementApplyRequest({
            contractId: '101',
            contractVersion: 7,
            installmentId: '9223372036854775808',
            idempotencyKey: 'key',
            components: [existingComponent('principal', 400000)]
        }), 'contract_invalid');

        const request = buildLoanSettlementApplyRequest({
            contractId: '101',
            contractVersion: 7,
            idempotencyKey: 'key',
            components: [{
                componentType: 'disbursement',
                allocatedAmount: 5000000,
                ledgerDraft: {
                    transactionType: 'transfer',
                    transactionDate: '2026-08-14',
                    sourceAccountId: '1001',
                    destinationAccountId: '1002',
                    categoryId: '2002',
                    amount: 5000000,
                    currency: 'CNY'
                }
            }]
        });
        expect(request.components[0]?.ledgerDraft).toMatchObject({
            sourceAccountId: '1001',
            destinationAccountId: '1002',
            categoryId: '2002'
        });
    });

    it('only permits revision and cancellation before any active ledger allocation', () => {
        const detail = {
            contract: { status: 'active' },
            allocations: { activeAllocationCount: 0 }
        } as LoanContractDetail;

        expect(canReviseLoanContract(detail)).toBe(true);
        expect(canCancelLoanContract(detail)).toBe(true);
        expect(canReviseLoanContract({
            ...detail,
            allocations: { ...detail.allocations, activeAllocationCount: 1 }
        })).toBe(false);
    });

    it('builds an additive undo command with contract CAS context', () => {
        expect(buildLoanSettlementUndoRequest({
            contractId: '101',
            contractVersion: 8,
            actionId: '501',
            idempotencyKey: 'pf-loan-undo-ui-v1:test'
        })).toEqual({
            contractId: '101',
            actionId: '501',
            expectedContractVersion: 8,
            idempotencyKey: 'pf-loan-undo-ui-v1:test'
        });
    });
});

function expectValidationCode(input: LoanCalculationInput, code: string): void {
    try {
        validateLoanCalculationInput(input);
        throw new Error('expected_validation_error');
    } catch (error) {
        expect(error).toBeInstanceOf(LoanValidationError);
        expect((error as LoanValidationError).code).toBe(code);
    }
}

function expectLoanValidationCode(action: () => unknown, code: string): void {
    try {
        action();
        throw new Error('expected_validation_error');
    } catch (error) {
        expect(error).toBeInstanceOf(LoanValidationError);
        expect((error as LoanValidationError).code).toBe(code);
    }
}
