import type {
    LoanCalculationInput,
    LoanComponentType,
    LoanContractDetail,
    LoanContractSummary,
    LoanInstallment,
    LoanInstallmentDisplayStatus,
    LoanLedgerDraft,
    LoanSettlementApplyRequest,
    LoanSettlementComponent,
    LoanSettlementUndoRequest
} from './models.ts';

export type LoanValidationCode =
    'date_invalid' |
    'amount_invalid' |
    'actual_disbursement_mismatch' |
    'term_invalid' |
    'rate_required' |
    'payment_required' |
    'installment_quote_requires_flat' |
    'discount_invalid' |
    'contract_invalid' |
    'component_required' |
    'component_duplicate' |
    'component_context_mismatch' |
    'component_source_invalid' |
    'ledger_draft_invalid' |
    'ledger_semantics_invalid' |
    'undo_invalid';

export class LoanValidationError extends Error {
    public readonly code: LoanValidationCode;

    public constructor(code: LoanValidationCode) {
        super(code);
        this.code = code;
    }
}

export const loanAccountingBoundaryKeys = [
    'personalFinance.loans.boundary.planIsNotPayment',
    'personalFinance.loans.boundary.principalIsNotExpense',
    'personalFinance.loans.boundary.combinedPaymentMustBeSplit'
] as const;

export function createDefaultLoanCalculationInput(): LoanCalculationInput {
    return {
        fundingType: 'cash_disbursement',
        inputMode: 'rate',
        repaymentMethod: 'equal_payment',
        rateQuoteType: 'annual',
        effectiveDate: '',
        contractDate: '',
        firstDueDate: '',
        principalAmount: 0,
        actualDisbursementAmount: 0,
        upfrontFeeAmount: 0,
        perPeriodFeeAmount: 0,
        termCount: 12,
        quotedRatePptr: '0',
        discountType: 'none',
        discountAmount: 0
    };
}

export function validateLoanCalculationInput(input: LoanCalculationInput): LoanCalculationInput {
    if (!isCivilDate(input.effectiveDate) || !isCivilDate(input.contractDate) || !isCivilDate(input.firstDueDate)) {
        throw new LoanValidationError('date_invalid');
    }
    if (!isPositiveAmount(input.principalAmount) || !isPositiveAmount(input.actualDisbursementAmount) ||
        !isNonNegativeAmount(input.upfrontFeeAmount) || !isNonNegativeAmount(input.perPeriodFeeAmount) ||
        !isNonNegativeAmount(input.discountAmount)) {
        throw new LoanValidationError('amount_invalid');
    }
    if (input.actualDisbursementAmount !== input.principalAmount - input.upfrontFeeAmount) {
        throw new LoanValidationError('actual_disbursement_mismatch');
    }
    if (!Number.isSafeInteger(input.termCount) || input.termCount < 1) {
        throw new LoanValidationError('term_invalid');
    }
    if (input.inputMode === 'rate') {
        if (!isRateQuoteType(input.rateQuoteType) || !isPptr(input.quotedRatePptr) || typeof input.paymentBasisAmount !== 'undefined') {
            throw new LoanValidationError('rate_required');
        }
    } else {
        if (input.inputMode !== 'repayment' || input.rateQuoteType !== '' ||
            !isPositiveAmount(input.paymentBasisAmount) || typeof input.quotedRatePptr !== 'undefined') {
            throw new LoanValidationError('payment_required');
        }
    }
    if (input.rateQuoteType === 'installment' && input.repaymentMethod !== 'flat') {
        throw new LoanValidationError('installment_quote_requires_flat');
    }

    validateDiscount(input);
    return input;
}

export function getLoanInstallmentDisplayStatus(installment: LoanInstallment): LoanInstallmentDisplayStatus {
    if (installment.progress.actionRequired) {
        return 'action_required';
    }
    if (installment.progress.settlementStatus === 'paid') {
        return 'paid';
    }
    if (installment.progress.overdue && installment.progress.outstandingPaymentAmount > 0) {
        return 'overdue';
    }
    return installment.progress.settlementStatus;
}

export function canReviseLoanContract(detail: LoanContractDetail | null): boolean {
    return detail?.contract.status === 'active' && detail.allocations.activeAllocationCount === 0;
}

export function canCancelLoanContract(detail: LoanContractDetail | null): boolean {
    return detail?.contract.status === 'active' && detail.allocations.activeAllocationCount === 0;
}

export function getNextLoanInstallment(summary: LoanContractSummary): LoanInstallment | undefined {
    return summary.nextInstallment?.progress.outstandingPaymentAmount
        ? summary.nextInstallment
        : undefined;
}

export function buildLoanSettlementApplyRequest(params: {
    contractId: string;
    contractVersion: number;
    installmentId?: string;
    idempotencyKey: string;
    components: readonly LoanSettlementComponent[];
}): LoanSettlementApplyRequest {
    if (!isPositiveIdentifier(params.contractId) ||
        (typeof params.installmentId !== 'undefined' && !isPositiveIdentifier(params.installmentId)) ||
        !Number.isSafeInteger(params.contractVersion) || params.contractVersion < 1 || !params.idempotencyKey) {
        throw new LoanValidationError('contract_invalid');
    }
    if (!params.components.length) {
        throw new LoanValidationError('component_required');
    }

    const componentTypes = new Set<LoanComponentType>();
    const hasDisbursement = params.components.some(component => component.componentType === 'disbursement');
    if (hasDisbursement ? !!params.installmentId || params.components.length !== 1 : !params.installmentId) {
        throw new LoanValidationError('component_context_mismatch');
    }

    const components = params.components.map(component => {
        if (componentTypes.has(component.componentType)) {
            throw new LoanValidationError('component_duplicate');
        }
        componentTypes.add(component.componentType);

        if (!isPositiveAmount(component.allocatedAmount)) {
            throw new LoanValidationError('amount_invalid');
        }
        return copySettlementComponent(component);
    });

    return {
        contractId: params.contractId,
        expectedContractVersion: params.contractVersion,
        installmentId: params.installmentId,
        idempotencyKey: params.idempotencyKey,
        components
    };
}

export function buildLoanSettlementUndoRequest(params: {
    contractId: string;
    contractVersion: number;
    actionId: string;
    idempotencyKey: string;
}): LoanSettlementUndoRequest {
    if (!isPositiveIdentifier(params.contractId) || !isPositiveIdentifier(params.actionId) || !params.idempotencyKey ||
        !Number.isSafeInteger(params.contractVersion) || params.contractVersion < 1) {
        throw new LoanValidationError('undo_invalid');
    }
    return {
        contractId: params.contractId,
        actionId: params.actionId,
        expectedContractVersion: params.contractVersion,
        idempotencyKey: params.idempotencyKey
    };
}

function validateDiscount(input: LoanCalculationInput): void {
    if (input.discountType === 'none') {
        if (typeof input.discountRatePptr !== 'undefined' || input.discountAmount !== 0) {
            throw new LoanValidationError('discount_invalid');
        }
        return;
    }
    if (input.discountType === 'interest_rate') {
        if (!isPptr(input.discountRatePptr) || BigInt(input.discountRatePptr) > 1000000000000n || input.discountAmount !== 0) {
            throw new LoanValidationError('discount_invalid');
        }
        return;
    }
    if (typeof input.discountRatePptr !== 'undefined' || !isPositiveAmount(input.discountAmount)) {
        throw new LoanValidationError('discount_invalid');
    }
}

function validateSettlementSource(component: LoanSettlementComponent): void {
    const hasExisting = typeof component.existingTransactionId === 'string' && isPositiveIdentifier(component.existingTransactionId);
    const hasDraft = typeof component.ledgerDraft !== 'undefined';
    if (hasExisting === hasDraft) {
        throw new LoanValidationError('component_source_invalid');
    }
    if (hasExisting) {
        const requiresTransfer = component.componentType === 'disbursement' || component.componentType === 'principal';
        const hasCounterpartSnapshot = typeof component.expectedCounterpartUpdatedUnixTime !== 'undefined';
        if (!isPositiveAmount(component.expectedUpdatedUnixTime) || requiresTransfer !== hasCounterpartSnapshot ||
            (hasCounterpartSnapshot && !isPositiveAmount(component.expectedCounterpartUpdatedUnixTime))) {
            throw new LoanValidationError('component_source_invalid');
        }
    } else if (typeof component.expectedUpdatedUnixTime !== 'undefined' ||
        typeof component.expectedCounterpartUpdatedUnixTime !== 'undefined') {
        throw new LoanValidationError('component_source_invalid');
    }
    if (component.ledgerDraft) {
        validateLedgerDraft(component.componentType, component.allocatedAmount, component.ledgerDraft);
    }
}

function copySettlementComponent(component: LoanSettlementComponent): LoanSettlementComponent {
    validateSettlementSource(component);
    if (component.ledgerDraft) {
        return {
            componentType: component.componentType,
            allocatedAmount: component.allocatedAmount,
            ledgerDraft: { ...component.ledgerDraft }
        };
    }
    return {
        componentType: component.componentType,
        allocatedAmount: component.allocatedAmount,
        existingTransactionId: component.existingTransactionId,
        expectedUpdatedUnixTime: component.expectedUpdatedUnixTime,
        ...(typeof component.expectedCounterpartUpdatedUnixTime === 'undefined'
            ? {}
            : { expectedCounterpartUpdatedUnixTime: component.expectedCounterpartUpdatedUnixTime })
    };
}

function validateLedgerDraft(componentType: LoanComponentType, amount: number, draft: LoanLedgerDraft): void {
    if (!isCivilDate(draft.transactionDate) || !isPositiveAmount(draft.amount) || draft.amount !== amount ||
        !/^[A-Z]{3}$/.test(draft.currency) || !isPositiveIdentifier(draft.sourceAccountId) ||
        !isPositiveIdentifier(draft.categoryId)) {
        throw new LoanValidationError('ledger_draft_invalid');
    }
    const requiresTransfer = componentType === 'disbursement' || componentType === 'principal';
    if (requiresTransfer) {
        if (draft.transactionType !== 'transfer' || !isPositiveIdentifier(draft.destinationAccountId) || draft.destinationAccountId === draft.sourceAccountId) {
            throw new LoanValidationError('ledger_semantics_invalid');
        }
        return;
    }
    if (draft.transactionType !== 'expense' || !draft.categoryId) {
        throw new LoanValidationError('ledger_semantics_invalid');
    }
}

function isCivilDate(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
        return false;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isPptr(value?: string): value is string {
    return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

function isRateQuoteType(value: string): boolean {
    return value === 'annual' || value === 'monthly' || value === 'daily' || value === 'installment';
}

function isPositiveAmount(value?: number): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeAmount(value?: number): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveIdentifier(value: string): boolean {
    return /^[1-9]\d*$/.test(value) && BigInt(value) <= 9223372036854775807n;
}
