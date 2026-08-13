import { inject, provide } from 'vue';
import type { InjectionKey } from 'vue';

import type {
    LoanActionResult,
    LoanCalculationInput,
    LoanCalculationResult,
    LoanCloseContractRequest,
    LoanContractDetail,
    LoanContractLifecycleRequest,
    LoanContractPage,
    LoanContractStatus,
    LoanCreateContractRequest,
    LoanReviseContractRequest,
    LoanSettlementApplyRequest,
    LoanSettlementCandidatesRequest,
    LoanSettlementCandidatesResult,
    LoanSettlementUndoImpact,
    LoanSettlementUndoImpactRequest,
    LoanSettlementUndoRequest
} from './models.ts';

export const loanApiPaths = {
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
} as const;

export interface LoanService {
    calculate(input: LoanCalculationInput): Promise<LoanCalculationResult>;
    listContracts(params: {
        status: LoanContractStatus;
        cursor?: { updatedUnixTime: number; contractId: string };
        limit: number;
    }): Promise<LoanContractPage>;
    getContract(contractId: string): Promise<LoanContractDetail>;
    createContract(request: LoanCreateContractRequest): Promise<LoanActionResult>;
    reviseContract(request: LoanReviseContractRequest): Promise<LoanActionResult>;
    closeContract(request: LoanCloseContractRequest): Promise<LoanActionResult>;
    reopenContract(request: LoanContractLifecycleRequest): Promise<LoanActionResult>;
    cancelContract(request: LoanContractLifecycleRequest): Promise<LoanActionResult>;
    listSettlementCandidates(request: LoanSettlementCandidatesRequest): Promise<LoanSettlementCandidatesResult>;
    applySettlement(request: LoanSettlementApplyRequest): Promise<LoanActionResult>;
    getSettlementUndoImpact(request: LoanSettlementUndoImpactRequest): Promise<LoanSettlementUndoImpact>;
    undoSettlement(request: LoanSettlementUndoRequest): Promise<LoanActionResult>;
}

export const loanServiceKey: InjectionKey<LoanService> = Symbol('personal-finance-loan-service');

export function provideLoanService(service: LoanService): void {
    provide(loanServiceKey, service);
}

export function useLoanService(): LoanService {
    const service = inject(loanServiceKey);
    if (!service) {
        throw new Error('loan_service_not_provided');
    }
    return service;
}
