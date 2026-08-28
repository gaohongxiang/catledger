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

const PPTR_PER_PERCENT = 10000000000n;
const MAX_LOAN_PPTR = 9223372036854775807n;

export type LoanEditableAmountField =
    'principalAmount' |
    'upfrontFeeAmount' |
    'perPeriodFeeAmount' |
    'paymentBasisAmount' |
    'discountAmount';

export function normalizeLoanPercentageTextInput(value: string): string {
    return value
        .replace(/[０-９]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
        .replace(/[。．，,]/g, '.');
}

export function updateLoanCalculationAmount(
    input: LoanCalculationInput,
    field: LoanEditableAmountField,
    amount: number
): LoanCalculationInput {
    const updated = { ...input, [field]: amount };
    if (field === 'principalAmount' || field === 'upfrontFeeAmount') {
        updated.actualDisbursementAmount = updated.principalAmount - updated.upfrontFeeAmount;
    }
    return updated;
}

export function parseLoanPercentageToPptr(
    value: string,
    maximumPptr: string = MAX_LOAN_PPTR.toString(),
    maximumFractionDigits: number = 10
): string | undefined {
    const match = /^\s*(\d+)(?:\.(\d{0,10}))?\s*$/.exec(normalizeLoanPercentageTextInput(value));
    const wholeText = match?.[1];
    const fractionText = match?.[2] ?? '';
    if (!wholeText || wholeText.length > 10 || !Number.isSafeInteger(maximumFractionDigits) ||
        maximumFractionDigits < 0 || maximumFractionDigits > 10 || fractionText.length > maximumFractionDigits ||
        !/^(0|[1-9]\d*)$/.test(maximumPptr)) {
        return undefined;
    }

    const whole = BigInt(wholeText);
    const fraction = fractionText.padEnd(10, '0');
    const pptr = whole * PPTR_PER_PERCENT + BigInt(fraction || '0');
    if (pptr > BigInt(maximumPptr)) {
        return undefined;
    }
    return pptr.toString();
}

export function normalizeLoanPercentageInput(
    value: string,
    maximumPptr: string = MAX_LOAN_PPTR.toString(),
    allowZero: boolean = true,
    maximumFractionDigits: number = 10
): string {
    const parsed = parseLoanPercentageToPptr(value, maximumPptr, maximumFractionDigits);
    if (typeof parsed === 'undefined' || (!allowZero && parsed === '0')) {
        return '';
    }
    return parsed;
}

export function formatLoanPptrAsPercentage(value?: string, fixedFractionDigits?: number): string {
    if (!value || !/^(0|[1-9]\d*)$/.test(value) || BigInt(value) > MAX_LOAN_PPTR) {
        return '';
    }

    const pptr = BigInt(value);
    if (typeof fixedFractionDigits !== 'undefined') {
        if (!Number.isSafeInteger(fixedFractionDigits) || fixedFractionDigits < 0 || fixedFractionDigits > 10) return '';
        const precisionDivisor = 10n ** BigInt(10 - fixedFractionDigits);
        const rounded = (pptr + precisionDivisor / 2n) / precisionDivisor;
        if (fixedFractionDigits === 0) return rounded.toString();
        const displayScale = 10n ** BigInt(fixedFractionDigits);
        const whole = rounded / displayScale;
        const fraction = (rounded % displayScale).toString().padStart(fixedFractionDigits, '0');
        return `${whole}.${fraction}`;
    }

    const whole = pptr / PPTR_PER_PERCENT;
    const fraction = (pptr % PPTR_PER_PERCENT).toString().padStart(10, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
}

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

export function getLoanSettlementDraftDate(
    detail: LoanContractDetail,
    installmentId: string | undefined,
    componentType: LoanComponentType
): string {
    if (!installmentId && (componentType === 'disbursement' || componentType === 'fee')) {
        return detail.currentRevision.input.effectiveDate;
    }
    return detail.installments.find(item => item.id === installmentId)?.dueDate ?? '';
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
    const allowedTypes = params.installmentId
        ? new Set<LoanComponentType>(['principal', 'interest', 'fee'])
        : new Set<LoanComponentType>(['disbursement', 'fee']);

    const components = params.components.map(component => {
        if (componentTypes.has(component.componentType)) {
            throw new LoanValidationError('component_duplicate');
        }
        if (!allowedTypes.has(component.componentType)) {
            throw new LoanValidationError('component_context_mismatch');
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
        if (!isPptr(input.discountRatePptr) || BigInt(input.discountRatePptr) < 1n || BigInt(input.discountRatePptr) > 1000000000000n || input.discountAmount !== 0) {
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
