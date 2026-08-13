import { describe, expect, it, vi } from 'vitest';

import type {
    LoanActionResult,
    LoanCalculationInput,
    LoanCalculationResult,
    LoanContractDetail,
    LoanContractPage,
    LoanContractSummary
} from './models.ts';
import type { LoanService } from './service.ts';
import { createLoanWorkbenchController } from './controller.ts';

const input: LoanCalculationInput = {
    fundingType: 'cash_disbursement', inputMode: 'rate', repaymentMethod: 'equal_payment', rateQuoteType: 'annual',
    effectiveDate: '2026-08-14', contractDate: '2026-08-13', firstDueDate: '2026-09-13', principalAmount: 5000000,
    actualDisbursementAmount: 4900000, upfrontFeeAmount: 100000, perPeriodFeeAmount: 1000, termCount: 12,
    quotedRatePptr: '120000000000', discountType: 'none', discountAmount: 0
};

const calculation: LoanCalculationResult = {
    calculationVersion: 'loan-calculation-v1', roundingVersion: 'loan-rounding-half-up-v1', irrVersion: 'periodic-irr-v1',
    summary: {
        preDiscountTotalPaymentAmount: 5400000, preDiscountTotalCostAmount: 400000, totalPaymentAmount: 5400000,
        totalInterestAmount: 288000, totalFeeAmount: 112000, totalDiscountAmount: 0, totalCostAmount: 400000,
        costRatioPptr: '80000000000', irrStatus: 'solved', monthlyIrrPptr: '10000000000', simpleAprPptr: '120000000000',
        effectiveAprPptr: '126825030131'
    },
    installments: [{
        installmentNumber: 1, dueDate: '2026-09-13', beginningPrincipalAmount: 5000000, principalAmount: 400000,
        interestAmount: 24000, feeAmount: 1000, discountAmount: 0, paymentAmount: 425000, endingPrincipalAmount: 4600000,
        preDiscountInterestAmount: 24000, preDiscountFeeAmount: 1000, preDiscountPaymentAmount: 425000
    }]
};

const detail: LoanContractDetail = {
    contract: {
        id: '101', name: 'Mortgage', lenderName: 'Bank', contractType: 'bank_loan', status: 'active', liabilityAccountId: '11',
        defaultPaymentAccountId: '12', currency: 'CNY', note: '', version: 7, currentRevisionId: '201', createdUnixTime: 1, updatedUnixTime: 2
    },
    currentRevision: { id: '201', revisionNumber: 1, effectiveDate: input.effectiveDate, input, calculation, createdUnixTime: 1 },
    installments: [{
        id: '301', revisionId: '201', ...calculation.installments[0]!, progress: {
            settlementStatus: 'unpaid', overdue: false, allocatedPrincipalAmount: 0, allocatedInterestAmount: 0, allocatedFeeAmount: 0,
            outstandingPrincipalAmount: 400000, outstandingInterestAmount: 24000, outstandingFeeAmount: 1000,
            outstandingPaymentAmount: 425000, actionRequired: false, reasonCodes: []
        }
    }],
    allocations: { activeAllocationCount: 0, actionRequiredAllocationCount: 0, allocatedDisbursementAmount: 0, allocatedPrincipalAmount: 0, allocatedInterestAmount: 0, allocatedFeeAmount: 0 },
    liabilityComparison: { plannedOutstandingPrincipalAmount: 5000000, ledgerOutstandingLiabilityAmount: 0, differenceAmount: 5000000, actionRequired: false, reasonCodes: [] },
    asOfDate: '2026-08-14', actionRequired: false, reasonCodes: []
};

const summary: LoanContractSummary = {
    contract: detail.contract, calculation: calculation.summary, paidInstallmentCount: 0, partialInstallmentCount: 0,
    totalInstallmentCount: 1, outstandingPrincipalAmount: 5000000, outstandingPaymentAmount: 5400000,
    nextInstallment: detail.installments[0], actionRequired: false, reasonCodes: []
};

const page: LoanContractPage = { items: [summary] };
const action: LoanActionResult = { actionId: '501', status: 'applied', allocations: [], replayed: false, reasonCodes: [] };

function mockService(): LoanService {
    return {
        calculate: vi.fn().mockResolvedValue(calculation),
        listContracts: vi.fn().mockResolvedValue(page),
        getContract: vi.fn().mockResolvedValue(detail),
        createContract: vi.fn().mockResolvedValue(action),
        reviseContract: vi.fn().mockResolvedValue(action),
        closeContract: vi.fn().mockResolvedValue(action),
        reopenContract: vi.fn().mockResolvedValue(action),
        cancelContract: vi.fn().mockResolvedValue(action),
        listSettlementCandidates: vi.fn().mockImplementation(request => Promise.resolve({
            contractId: '101', ...(request.installmentId ? { installmentId: request.installmentId } : {}), groups: [{
                componentType: request.componentType,
                expectedAmount: request.componentType === 'disbursement' ? 5000000 : 100000,
                outstandingAmount: request.componentType === 'disbursement' ? 5000000 : 100000,
                candidates: [{
                    transactionId: request.componentType === 'disbursement' ? '401' : '402',
                    transactionType: request.componentType === 'disbursement' ? 'transfer' : 'expense',
                    transactionDate: '2026-08-14', amount: request.componentType === 'disbursement' ? 5000000 : 100000,
                    currency: 'CNY', maskedSourceAccount: 'Liability', eligible: true, reasonCodes: [], updatedUnixTime: 10,
                    ...(request.componentType === 'disbursement' ? { counterpartUpdatedUnixTime: 11 } : {})
                }], limitReached: false
            }]
        })),
        applySettlement: vi.fn().mockResolvedValue(action),
        getSettlementUndoImpact: vi.fn().mockResolvedValue({
            contractId: '101', actionId: '501', activeAllocationCount: 2, relationshipCount: 3, affectedTransactionCount: 3,
            loanCreatedTransactionCount: 0, modifiedTransactionCount: 0, missingTransactionCount: 0, incompleteTransferPairCount: 0,
            canUndoRelationships: true, reasonCodes: []
        }),
        undoSettlement: vi.fn().mockResolvedValue(action)
    };
}

describe('loan workbench controller', () => {
    it('connects all twelve endpoints and explicitly refreshes list and detail after every action', async () => {
        const service = mockService();
        const controller = createLoanWorkbenchController({ service, createIdempotencyKey: () => 'intent-key' });
        controller.calculationInput.value = input;

        await controller.reload(true);
        await controller.calculate();
        await controller.createContract({ name: 'Mortgage', lenderName: 'Bank', contractType: 'bank_loan', liabilityAccountId: '11', defaultPaymentAccountId: '12', currency: 'CNY', note: '' });
        await controller.reviseContract();
        await controller.closeContract('manual_close');
        await controller.reopenContract();
        await controller.cancelContract();

        controller.selectInstallment(undefined);
        const disbursement = await controller.loadSettlementCandidates('disbursement');
        const fee = await controller.loadSettlementCandidates('fee');
        controller.selectCandidate('disbursement', disbursement.groups[0]!.candidates[0]!, 5000000);
        controller.selectCandidate('fee', fee.groups[0]!.candidates[0]!, 100000);
        await controller.applySettlement();
        await controller.inspectUndo();
        await controller.undoSettlement();

        expect(service.calculate).toHaveBeenCalledOnce();
        expect(service.createContract).toHaveBeenCalledOnce();
        expect(service.reviseContract).toHaveBeenCalledOnce();
        expect(service.closeContract).toHaveBeenCalledOnce();
        expect(service.reopenContract).toHaveBeenCalledOnce();
        expect(service.cancelContract).toHaveBeenCalledOnce();
        expect(service.listSettlementCandidates).toHaveBeenCalledTimes(2);
        expect(service.applySettlement).toHaveBeenCalledWith(expect.objectContaining({
            installmentId: undefined,
            components: [expect.objectContaining({ componentType: 'disbursement', allocatedAmount: 5000000 }), expect.objectContaining({ componentType: 'fee', allocatedAmount: 100000 })]
        }));
        expect(service.getSettlementUndoImpact).toHaveBeenCalledOnce();
        expect(service.undoSettlement).toHaveBeenCalledOnce();
        expect(vi.mocked(service.listContracts).mock.calls.length).toBeGreaterThanOrEqual(8);
        expect(vi.mocked(service.getContract).mock.calls.length).toBeGreaterThanOrEqual(8);
    });

    it('reuses one in-memory idempotency key for a failed intent and rotates it after success', async () => {
        const service = mockService();
        vi.mocked(service.createContract).mockRejectedValueOnce(new Error('temporary')).mockResolvedValue(action);
        const keys = ['key-1', 'key-2'];
        const controller = createLoanWorkbenchController({ service, createIdempotencyKey: () => keys.shift()! });
        controller.calculationInput.value = input;
        const identity = { name: 'Mortgage', lenderName: 'Bank', contractType: 'bank_loan' as const, liabilityAccountId: '11', currency: 'CNY', note: '' };

        await expect(controller.createContract(identity)).rejects.toThrow('temporary');
        await controller.createContract(identity);
        await controller.createContract(identity);

        const requests = vi.mocked(service.createContract).mock.calls.map(call => call[0]);
        expect(requests.map(request => request.idempotencyKey)).toEqual(['key-1', 'key-1', 'key-2']);
    });

    it('rejects over-allocation before calling the service', async () => {
        const service = mockService();
        const controller = createLoanWorkbenchController({ service });
        await controller.reload(true);
        const result = await controller.loadSettlementCandidates('disbursement');
        expect(() => controller.selectCandidate('disbursement', result.groups[0]!.candidates[0]!, 5000001)).toThrow('loan_allocation_amount_invalid');
        expect(service.applySettlement).not.toHaveBeenCalled();
    });

    it('allows only an upfront-fee nil-installment action for purchase installments', async () => {
        const service = mockService();
        const purchaseDetail: LoanContractDetail = {
            ...detail,
            currentRevision: { ...detail.currentRevision, input: { ...detail.currentRevision.input, fundingType: 'purchase_installment' } }
        };
        vi.mocked(service.getContract).mockResolvedValue(purchaseDetail);
        const controller = createLoanWorkbenchController({ service });
        await controller.reload(true);

        await expect(controller.loadSettlementCandidates('disbursement')).rejects.toThrow('loan_disbursement_not_allowed');
        const fee = await controller.loadSettlementCandidates('fee');
        controller.selectCandidate('fee', fee.groups[0]!.candidates[0]!, 100000);
        await controller.applySettlement();

        expect(service.applySettlement).toHaveBeenCalledWith(expect.objectContaining({
            installmentId: undefined,
            components: [expect.objectContaining({ componentType: 'fee', allocatedAmount: 100000 })]
        }));
    });
});
