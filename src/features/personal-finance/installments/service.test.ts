import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
    listPersonalFinanceInstallmentCandidates: vi.fn(),
    confirmPersonalFinanceInstallmentCandidate: vi.fn()
}));

vi.mock('@/lib/services.ts', () => ({ default: serviceMocks }));

import { installmentApi } from './service.ts';

function apiResponse(result: unknown): unknown {
    return { data: { success: true, result } };
}

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: '101', status: 'needs_details', version: 2, liabilityAccountId: '201', termCount: 36,
        linkedContractId: null, purchaseRelation: '', linkedPurchaseTransactionId: null,
        principalAmount: null, paymentAmount: 52125, interestAmount: 0, feeAmount: 0,
        repaymentMethod: '', firstDueDate: '', currentPeriod: 27,
        createdUnixTime: 1000, updatedUnixTime: 1001,
        members: [{ id: '301', kind: 'raw_row', refId: '401', role: 'principal', periodNumber: 27, createdUnixTime: 1000 }],
        ...overrides
    };
}

describe('installmentApi', () => {
    beforeEach(() => vi.clearAllMocks());

    it('normalizes candidates and preserves pagination without exposing unknown fields', async () => {
        serviceMocks.listPersonalFinanceInstallmentCandidates.mockResolvedValue(apiResponse({
            items: [candidate({ uid: 'private' })],
            nextCursor: { updatedUnixTime: 1001, candidateId: '101' }
        }));

        const page = await installmentApi.listCandidates('needs_details');

        expect(page.items[0]).toEqual(expect.objectContaining({ id: '101', termCount: 36, currentPeriod: 27 }));
        expect(page.items[0]).not.toHaveProperty('uid');
        expect(page.nextCursor).toEqual({ updatedUnixTime: 1001, candidateId: '101' });
    });

    it('submits the existing loan contract and calculation contract unchanged', async () => {
        serviceMocks.confirmPersonalFinanceInstallmentCandidate.mockResolvedValue(apiResponse(candidate({ status: 'converted', version: 3, linkedContractId: '501' })));
        const request = {
            candidateId: '101', expectedVersion: 2, treatAsInstallment: true, liabilityAccountId: '201', termCount: 36,
            contract: { name: '36 期分期计划', lenderName: '信用卡', contractType: 'credit_card_installment' as const, liabilityAccountId: '201', currency: 'CNY', note: '' },
            calculation: {
                fundingType: 'purchase_installment' as const, inputMode: 'rate' as const, repaymentMethod: 'flat' as const,
                rateQuoteType: 'installment' as const, effectiveDate: '2026-01-01', contractDate: '2026-01-01', firstDueDate: '2026-02-01',
                principalAmount: 100000, actualDisbursementAmount: 100000, upfrontFeeAmount: 0, perPeriodFeeAmount: 0,
                termCount: 36, quotedRatePptr: '0', discountType: 'none' as const, discountAmount: 0
            }
        };

        const result = await installmentApi.confirmCandidate(request);

        expect(serviceMocks.confirmPersonalFinanceInstallmentCandidate).toHaveBeenCalledWith(request);
        expect(result).toEqual(expect.objectContaining({ status: 'converted', linkedContractId: '501', version: 3 }));
    });
});
