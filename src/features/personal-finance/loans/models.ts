export type LoanContractType = 'credit_card_installment' | 'bank_loan' | 'consumer_loan' | 'personal_loan';
export type LoanFundingType = 'cash_disbursement' | 'purchase_installment';
export type LoanInputMode = 'rate' | 'repayment';
export type LoanRepaymentMethod = 'flat' | 'equal_payment' | 'equal_principal' | 'interest_only';
export type LoanRateQuoteType = 'annual' | 'monthly' | 'daily' | 'installment';
export type LoanDiscountType = 'none' | 'interest_rate' | 'per_period' | 'total';
export type LoanIrrStatus = 'solved' | 'solved_zero' | 'no_nonnegative_root' | 'insufficient_cashflows' | 'out_of_range';
export type LoanContractStatus = 'active' | 'closed' | 'cancelled';
export type LoanCloseReason = 'paid_off' | 'manual_close' | 'written_off';
export type LoanActionStatus = 'ready' | 'applying' | 'applied' | 'action_required' | 'failed';
export type LoanInstallmentSettlementStatus = 'unpaid' | 'partial' | 'paid';
export type LoanInstallmentDisplayStatus = LoanInstallmentSettlementStatus | 'overdue' | 'action_required';
export type LoanComponentType = 'disbursement' | 'principal' | 'interest' | 'fee';
export type LoanAllocationStatus = 'active' | 'reversed' | 'action_required';
export type LoanAllocationCreationMethod = 'attached_existing' | 'loan_created';

export interface LoanReason {
    readonly code: string;
    readonly count?: number;
}

/**
 * The API represents pptr values as decimal strings because 1.0 = 10^12 may
 * exceed the range that callers can safely manipulate as JavaScript numbers.
 */
export type LoanPptr = string;

export interface LoanCalculationInput {
    readonly fundingType: LoanFundingType;
    readonly inputMode: LoanInputMode;
    readonly repaymentMethod: LoanRepaymentMethod;
    readonly rateQuoteType: LoanRateQuoteType | '';
    readonly effectiveDate: string;
    readonly contractDate: string;
    readonly firstDueDate: string;
    readonly principalAmount: number;
    readonly actualDisbursementAmount: number;
    readonly upfrontFeeAmount: number;
    readonly perPeriodFeeAmount: number;
    readonly termCount: number;
    readonly quotedRatePptr?: LoanPptr;
    readonly paymentBasisAmount?: number;
    readonly discountType: LoanDiscountType;
    readonly discountRatePptr?: LoanPptr;
    readonly discountAmount: number;
}

export interface LoanCalculationSummary {
    readonly preDiscountTotalPaymentAmount: number;
    readonly preDiscountTotalCostAmount: number;
    readonly totalPaymentAmount: number;
    readonly totalInterestAmount: number;
    readonly totalFeeAmount: number;
    readonly totalDiscountAmount: number;
    readonly totalCostAmount: number;
    readonly costRatioPptr: LoanPptr;
    readonly irrStatus: LoanIrrStatus;
    readonly monthlyIrrPptr?: LoanPptr;
    readonly simpleAprPptr?: LoanPptr;
    readonly effectiveAprPptr?: LoanPptr;
}

export interface LoanCalculatedInstallment {
    readonly installmentNumber: number;
    readonly dueDate: string;
    readonly beginningPrincipalAmount: number;
    readonly principalAmount: number;
    readonly interestAmount: number;
    readonly feeAmount: number;
    readonly discountAmount: number;
    readonly paymentAmount: number;
    readonly endingPrincipalAmount: number;
    readonly preDiscountInterestAmount: number;
    readonly preDiscountFeeAmount: number;
    readonly preDiscountPaymentAmount: number;
}

export interface LoanCalculationResult {
    readonly calculationVersion: 'loan-calculation-v1';
    readonly roundingVersion: 'loan-rounding-half-up-v1';
    readonly irrVersion: 'periodic-irr-v1';
    readonly summary: LoanCalculationSummary;
    readonly installments: LoanCalculatedInstallment[];
}

export interface LoanContractIdentityInput {
    readonly name: string;
    readonly lenderName: string;
    readonly contractType: LoanContractType;
    readonly liabilityAccountId: string;
    readonly defaultPaymentAccountId?: string;
    readonly currency: string;
    readonly note: string;
}

export interface LoanContract {
    readonly id: string;
    readonly name: string;
    readonly lenderName: string;
    readonly contractType: LoanContractType;
    readonly status: LoanContractStatus;
    readonly closeReason?: LoanCloseReason;
    readonly liabilityAccountId: string;
    readonly defaultPaymentAccountId?: string;
    readonly currency: string;
    readonly note: string;
    readonly version: number;
    readonly currentRevisionId: string;
    readonly createdUnixTime: number;
    readonly updatedUnixTime: number;
    readonly closedUnixTime?: number;
}

export interface LoanRevision {
    readonly id: string;
    readonly revisionNumber: number;
    readonly previousRevisionId?: string;
    readonly effectiveDate: string;
    readonly input: LoanCalculationInput;
    readonly calculation: LoanCalculationResult;
    readonly createdUnixTime: number;
}

export interface LoanInstallmentProgress {
    readonly settlementStatus: LoanInstallmentSettlementStatus;
    readonly overdue: boolean;
    readonly allocatedPrincipalAmount: number;
    readonly allocatedInterestAmount: number;
    readonly allocatedFeeAmount: number;
    readonly outstandingPrincipalAmount: number;
    readonly outstandingInterestAmount: number;
    readonly outstandingFeeAmount: number;
    readonly outstandingPaymentAmount: number;
    readonly actionRequired: boolean;
    readonly reasonCodes: LoanReason[];
}

export interface LoanInstallment extends LoanCalculatedInstallment {
    readonly id: string;
    readonly revisionId: string;
    readonly progress: LoanInstallmentProgress;
}

export interface LoanLiabilityComparison {
    readonly plannedOutstandingPrincipalAmount: number;
    readonly ledgerOutstandingLiabilityAmount: number;
    readonly differenceAmount: number;
    readonly actionRequired: boolean;
    readonly reasonCodes: LoanReason[];
}

export interface LoanAllocationSummary {
    readonly activeAllocationCount: number;
    readonly actionRequiredAllocationCount: number;
    readonly allocatedDisbursementAmount: number;
    readonly allocatedPrincipalAmount: number;
    readonly allocatedInterestAmount: number;
    readonly allocatedFeeAmount: number;
}

export interface LoanContractSummary {
    readonly contract: LoanContract;
    readonly calculation: LoanCalculationSummary;
    readonly paidInstallmentCount: number;
    readonly partialInstallmentCount: number;
    readonly totalInstallmentCount: number;
    readonly outstandingPrincipalAmount: number;
    readonly outstandingPaymentAmount: number;
    readonly nextInstallment?: LoanInstallment;
    readonly actionRequired: boolean;
    readonly reasonCodes: LoanReason[];
}

export interface LoanContractDetail {
    readonly contract: LoanContract;
    readonly currentRevision: LoanRevision;
    readonly installments: LoanInstallment[];
    readonly allocations: LoanAllocationSummary;
    readonly liabilityComparison: LoanLiabilityComparison;
    readonly asOfDate: string;
}

export interface LoanContractCursor {
    readonly status: LoanContractStatus;
    readonly updatedUnixTime: number;
    readonly contractId: string;
}

export interface LoanContractPage {
    readonly items: LoanContractSummary[];
    readonly nextCursor?: LoanContractCursor;
}

export interface LoanTransferLedgerDraft {
    readonly transactionType: 'transfer';
    readonly transactionDate: string;
    readonly sourceAccountId: string;
    readonly destinationAccountId: string;
    readonly categoryId: string;
    readonly amount: number;
    readonly currency: string;
}

export interface LoanExpenseLedgerDraft {
    readonly transactionType: 'expense';
    readonly transactionDate: string;
    readonly sourceAccountId: string;
    readonly categoryId: string;
    readonly amount: number;
    readonly currency: string;
}

export type LoanLedgerDraft = LoanTransferLedgerDraft | LoanExpenseLedgerDraft;

export interface LoanSettlementCandidate {
    readonly transactionId: string;
    readonly transactionType: 'transfer' | 'expense';
    readonly transactionDate: string;
    readonly amount: number;
    readonly currency: string;
    readonly maskedSourceAccount: string;
    readonly maskedDestinationAccount?: string;
    readonly eligible: boolean;
    readonly reasonCodes: LoanReason[];
    readonly updatedUnixTime: number;
    readonly counterpartUpdatedUnixTime?: number;
}

export interface LoanSettlementCandidateGroup {
    readonly componentType: LoanComponentType;
    readonly expectedAmount: number;
    readonly outstandingAmount: number;
    readonly candidates: LoanSettlementCandidate[];
    readonly limitReached: boolean;
}

export interface LoanSettlementCandidatesResult {
    readonly contractId: string;
    readonly installmentId?: string;
    readonly groups: LoanSettlementCandidateGroup[];
}

export type LoanSettlementSource =
    {
        readonly existingTransactionId: string;
        readonly expectedUpdatedUnixTime: number;
        readonly expectedCounterpartUpdatedUnixTime?: number;
        readonly ledgerDraft?: never;
    } |
    {
        readonly existingTransactionId?: never;
        readonly expectedUpdatedUnixTime?: never;
        readonly expectedCounterpartUpdatedUnixTime?: never;
        readonly ledgerDraft: LoanLedgerDraft;
    };

export type LoanSettlementComponent = LoanSettlementSource & {
    readonly componentType: LoanComponentType;
    readonly allocatedAmount: number;
};

export interface LoanSettlementApplyRequest {
    readonly contractId: string;
    readonly expectedContractVersion: number;
    readonly installmentId?: string;
    readonly idempotencyKey: string;
    readonly components: LoanSettlementComponent[];
}

export interface LoanSettlementAllocation {
    readonly id: string;
    readonly installmentId?: string;
    readonly componentType: LoanComponentType;
    readonly allocatedAmount: number;
    readonly creationMethod: LoanAllocationCreationMethod;
    readonly status: LoanAllocationStatus;
    readonly transactionId: string;
    readonly counterpartTransactionId?: string;
    readonly reasonCodes: LoanReason[];
    readonly createdUnixTime: number;
    readonly updatedUnixTime: number;
}

export interface LoanActionResult {
    readonly actionId: string;
    readonly status: LoanActionStatus;
    readonly contract?: LoanContractDetail;
    readonly allocations: LoanSettlementAllocation[];
    readonly replayed: boolean;
    readonly reasonCodes: LoanReason[];
}

export interface LoanSettlementUndoImpact {
    readonly contractId: string;
    readonly actionId: string;
    readonly activeAllocationCount: number;
    readonly relationshipCount: number;
    readonly affectedTransactionCount: number;
    readonly loanCreatedTransactionCount: number;
    readonly modifiedTransactionCount: number;
    readonly missingTransactionCount: number;
    readonly incompleteTransferPairCount: number;
    readonly canUndoRelationships: boolean;
    readonly reasonCodes: LoanReason[];
}

export interface LoanCreateContractRequest {
    readonly contract: LoanContractIdentityInput;
    readonly calculation: LoanCalculationInput;
    readonly idempotencyKey: string;
}

export interface LoanReviseContractRequest {
    readonly contractId: string;
    readonly expectedContractVersion: number;
    readonly calculation: LoanCalculationInput;
    readonly idempotencyKey: string;
}

export interface LoanCloseContractRequest {
    readonly contractId: string;
    readonly expectedContractVersion: number;
    readonly closeReason: LoanCloseReason;
    readonly idempotencyKey: string;
}

export interface LoanContractLifecycleRequest {
    readonly contractId: string;
    readonly expectedContractVersion: number;
    readonly idempotencyKey: string;
}

export interface LoanSettlementCandidatesRequest {
    readonly contractId: string;
    readonly installmentId?: string;
    readonly componentType: LoanComponentType;
}

export interface LoanSettlementUndoImpactRequest {
    readonly contractId: string;
    readonly actionId: string;
}

export interface LoanSettlementUndoRequest extends LoanSettlementUndoImpactRequest {
    readonly expectedContractVersion: number;
    readonly idempotencyKey: string;
}
