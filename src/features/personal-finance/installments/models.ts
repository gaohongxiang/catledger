import type { LoanCalculationInput, LoanContractIdentityInput } from '../loans/models.ts';

export type InstallmentCandidateStatus = 'pending' | 'needs_details' | 'action_required' | 'linked' | 'converted' | 'dismissed';
export type InstallmentCandidateMemberKind = 'raw_row' | 'source_identity';

export interface InstallmentCandidateMember {
    readonly id: string;
    readonly kind: InstallmentCandidateMemberKind;
    readonly refId: string;
    readonly role: string;
    readonly periodNumber?: number;
    readonly createdUnixTime: number;
}

export interface InstallmentCandidate {
    readonly id: string;
    readonly status: InstallmentCandidateStatus;
    readonly version: number;
    readonly liabilityAccountId?: string;
    readonly termCount?: number;
    readonly linkedContractId?: string;
    readonly purchaseRelation: string;
    readonly linkedPurchaseTransactionId?: string;
    readonly principalAmount?: number;
    readonly paymentAmount?: number;
    readonly interestAmount?: number;
    readonly feeAmount?: number;
    readonly repaymentMethod: string;
    readonly firstDueDate: string;
    readonly currentPeriod?: number;
    readonly createdUnixTime: number;
    readonly updatedUnixTime: number;
    readonly members: readonly InstallmentCandidateMember[];
}

export interface InstallmentCandidatePage {
    readonly items: readonly InstallmentCandidate[];
    readonly nextCursor?: { readonly updatedUnixTime: number; readonly candidateId: string };
}

export interface ConfirmInstallmentCandidateRequest {
    readonly candidateId: string;
    readonly expectedVersion: number;
    readonly treatAsInstallment: boolean;
    readonly liabilityAccountId?: string;
    readonly termCount?: number;
    readonly openingCompletedInstallmentCount?: number;
    readonly linkedContractId?: string;
    readonly contract?: LoanContractIdentityInput;
    readonly calculation?: LoanCalculationInput;
}
