import { inject, provide } from 'vue';
import type { InjectionKey } from 'vue';

import services from '@/lib/services.ts';

import type {
    LoanActionResult,
    LoanAllocationCreationMethod,
    LoanAllocationStatus,
    LoanCalculatedInstallment,
    LoanCalculationInput,
    LoanCalculationResult,
    LoanCalculationSummary,
    LoanCloseContractRequest,
    LoanCloseReason,
    LoanComponentType,
    LoanContract,
    LoanContractDetail,
    LoanContractIdentityInput,
    LoanContractLifecycleRequest,
    LoanContractPage,
    LoanContractStatus,
    LoanContractSummary,
    LoanContractType,
    LoanCreateContractRequest,
    LoanDiscountType,
    LoanFundingType,
    LoanInputMode,
    LoanInstallment,
    LoanInstallmentProgress,
    LoanInstallmentSettlementStatus,
    LoanIrrStatus,
    LoanLedgerDraft,
    LoanLiabilityComparison,
    LoanPptr,
    LoanRateQuoteType,
    LoanReason,
    LoanRepaymentMethod,
    LoanRevision,
    LoanReviseContractRequest,
    LoanSettlementAllocation,
    LoanSettlementApplyRequest,
    LoanSettlementCandidate,
    LoanSettlementCandidateGroup,
    LoanSettlementCandidatesRequest,
    LoanSettlementCandidatesResult,
    LoanSettlementComponent,
    LoanSettlementUndoImpact,
    LoanSettlementUndoImpactRequest,
    LoanSettlementUndoRequest
} from './models.ts';
import {
    buildLoanSettlementApplyRequest,
    buildLoanSettlementUndoRequest,
    validateLoanCalculationInput
} from './state.ts';

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

export type LoanProtocolErrorCode =
    'invalid_loan_response' |
    'invalid_loan_identifier' |
    'invalid_loan_enum' |
    'invalid_loan_integer' |
    'invalid_loan_pptr' |
    'invalid_loan_date' |
    'invalid_loan_array' |
    'invalid_loan_nullable' |
    'invalid_loan_reason' |
    'duplicate_loan_reason' |
    'invalid_loan_transfer_snapshot' |
    'invalid_loan_action';

export class LoanProtocolError extends Error {
    public readonly code: LoanProtocolErrorCode;

    public constructor(code: LoanProtocolErrorCode) {
        super(code);
        this.code = code;
    }
}

type UnknownRecord = Record<string, unknown>;

function fail(code: LoanProtocolErrorCode): never {
    throw new LoanProtocolError(code);
}

function asRecord(value: unknown, code: LoanProtocolErrorCode = 'invalid_loan_response'): UnknownRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(code);
    }
    return value as UnknownRecord;
}

function asArray(value: unknown): unknown[] {
    if (!Array.isArray(value)) {
        fail('invalid_loan_array');
    }
    return value;
}

function asString(value: unknown): string {
    if (typeof value !== 'string') {
        fail('invalid_loan_response');
    }
    return value;
}

function asBoolean(value: unknown): boolean {
    if (typeof value !== 'boolean') {
        fail('invalid_loan_response');
    }
    return value;
}

function asIdentifier(value: unknown): string {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || BigInt(value) > 9223372036854775807n) {
        fail('invalid_loan_identifier');
    }
    return value;
}

function asOptionalIdentifier(value: unknown): string | undefined {
    if (value === null || typeof value === 'undefined') {
        return undefined;
    }
    return asIdentifier(value);
}

function asSafeInteger(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        fail('invalid_loan_integer');
    }
    return value;
}

function asNonNegativeInteger(value: unknown): number {
    const integer = asSafeInteger(value);
    if (integer < 0) {
        fail('invalid_loan_integer');
    }
    return integer;
}

function asPositiveInteger(value: unknown): number {
    const integer = asSafeInteger(value);
    if (integer < 1) {
        fail('invalid_loan_integer');
    }
    return integer;
}

function asOptionalNonNegativeInteger(value: unknown): number | undefined {
    if (value === null || typeof value === 'undefined') {
        return undefined;
    }
    return asNonNegativeInteger(value);
}

function asCivilDate(value: unknown): string {
    if (typeof value !== 'string') {
        fail('invalid_loan_date');
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
        fail('invalid_loan_date');
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        fail('invalid_loan_date');
    }
    return value;
}

function asPptr(value: unknown): LoanPptr {
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
        fail('invalid_loan_pptr');
    }
    return value;
}

function asOptionalPptr(value: unknown): LoanPptr | undefined {
    if (value === null || typeof value === 'undefined') {
        return undefined;
    }
    return asPptr(value);
}

function asEnum<T extends string>(value: unknown, values: readonly T[]): T {
    if (typeof value !== 'string' || !values.includes(value as T)) {
        fail('invalid_loan_enum');
    }
    return value as T;
}

function normalizeReasons(value: unknown): LoanReason[] {
    const seen = new Set<string>();
    return asArray(value).map(item => {
        const reason = asRecord(item, 'invalid_loan_reason');
        const code = reason['code'];
        if (typeof code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(code)) {
            fail('invalid_loan_reason');
        }
        if (seen.has(code)) {
            fail('duplicate_loan_reason');
        }
        seen.add(code);
        const count = asOptionalNonNegativeInteger(reason['count']);
        return typeof count === 'undefined' ? { code } : { code, count };
    });
}

const contractTypes = ['credit_card_installment', 'bank_loan', 'consumer_loan', 'personal_loan'] as const;
const fundingTypes = ['cash_disbursement', 'purchase_installment'] as const;
const inputModes = ['rate', 'repayment'] as const;
const repaymentMethods = ['flat', 'equal_payment', 'equal_principal', 'interest_only'] as const;
const rateQuoteTypes = ['annual', 'monthly', 'daily', 'installment'] as const;
const discountTypes = ['none', 'interest_rate', 'per_period', 'total'] as const;
const irrStatuses = ['solved', 'solved_zero', 'no_nonnegative_root', 'insufficient_cashflows', 'out_of_range'] as const;
const contractStatuses = ['active', 'closed', 'cancelled'] as const;
const closeReasons = ['paid_off', 'manual_close', 'written_off'] as const;
const actionStatuses = ['ready', 'applying', 'applied', 'action_required', 'failed'] as const;
const settlementStatuses = ['unpaid', 'partial', 'paid'] as const;
const componentTypes = ['disbursement', 'principal', 'interest', 'fee'] as const;
const allocationStatuses = ['active', 'reversed', 'action_required'] as const;
const allocationCreationMethods = ['attached_existing', 'loan_created'] as const;

function projectCalculationInput(input: LoanCalculationInput): LoanCalculationInput {
    validateLoanCalculationInput(input);
    const inputMode = asEnum<LoanInputMode>(input.inputMode, inputModes);
    const projected: LoanCalculationInput = {
        fundingType: asEnum<LoanFundingType>(input.fundingType, fundingTypes),
        inputMode,
        repaymentMethod: asEnum<LoanRepaymentMethod>(input.repaymentMethod, repaymentMethods),
        rateQuoteType: normalizeRateQuoteType(input.rateQuoteType, inputMode),
        effectiveDate: asCivilDate(input.effectiveDate),
        contractDate: asCivilDate(input.contractDate),
        firstDueDate: asCivilDate(input.firstDueDate),
        principalAmount: asNonNegativeInteger(input.principalAmount),
        actualDisbursementAmount: asNonNegativeInteger(input.actualDisbursementAmount),
        upfrontFeeAmount: asNonNegativeInteger(input.upfrontFeeAmount),
        perPeriodFeeAmount: asNonNegativeInteger(input.perPeriodFeeAmount),
        termCount: asPositiveInteger(input.termCount),
        discountType: asEnum<LoanDiscountType>(input.discountType, discountTypes),
        discountAmount: asNonNegativeInteger(input.discountAmount),
        ...(typeof input.quotedRatePptr === 'undefined' ? {} : { quotedRatePptr: asPptr(input.quotedRatePptr) }),
        ...(typeof input.paymentBasisAmount === 'undefined' ? {} : { paymentBasisAmount: asNonNegativeInteger(input.paymentBasisAmount) }),
        ...(typeof input.discountRatePptr === 'undefined' ? {} : { discountRatePptr: asPptr(input.discountRatePptr) })
    };
    return projected;
}

function normalizeCalculationInput(value: unknown): LoanCalculationInput {
    const input = asRecord(value);
    try {
        const inputMode = asEnum<LoanInputMode>(input['inputMode'], inputModes);
        return projectCalculationInput({
            fundingType: asEnum<LoanFundingType>(input['fundingType'], fundingTypes),
            inputMode,
            repaymentMethod: asEnum<LoanRepaymentMethod>(input['repaymentMethod'], repaymentMethods),
            rateQuoteType: normalizeRateQuoteType(input['rateQuoteType'], inputMode),
            effectiveDate: asCivilDate(input['effectiveDate']),
            contractDate: asCivilDate(input['contractDate']),
            firstDueDate: asCivilDate(input['firstDueDate']),
            principalAmount: asNonNegativeInteger(input['principalAmount']),
            actualDisbursementAmount: asNonNegativeInteger(input['actualDisbursementAmount']),
            upfrontFeeAmount: asNonNegativeInteger(input['upfrontFeeAmount']),
            perPeriodFeeAmount: asNonNegativeInteger(input['perPeriodFeeAmount']),
            termCount: asPositiveInteger(input['termCount']),
            quotedRatePptr: asOptionalPptr(input['quotedRatePptr']),
            paymentBasisAmount: asOptionalNonNegativeInteger(input['paymentBasisAmount']),
            discountType: asEnum<LoanDiscountType>(input['discountType'], discountTypes),
            discountRatePptr: asOptionalPptr(input['discountRatePptr']),
            discountAmount: asNonNegativeInteger(input['discountAmount'])
        });
    } catch (error) {
        if (error instanceof LoanProtocolError) {
            throw error;
        }
        fail('invalid_loan_response');
    }
}

function normalizeRateQuoteType(value: unknown, inputMode: LoanInputMode): LoanRateQuoteType | '' {
    if (inputMode === 'repayment') {
        if (value !== '') {
            fail('invalid_loan_enum');
        }
        return '';
    }
    return asEnum<LoanRateQuoteType>(value, rateQuoteTypes);
}

function normalizeCalculationSummary(value: unknown): LoanCalculationSummary {
    const summary = asRecord(value);
    const irrStatus = asEnum<LoanIrrStatus>(summary['irrStatus'], irrStatuses);
    const monthlyIrrPptr = asOptionalPptr(summary['monthlyIrrPptr']);
    const simpleAprPptr = asOptionalPptr(summary['simpleAprPptr']);
    const effectiveAprPptr = asOptionalPptr(summary['effectiveAprPptr']);
    const solved = irrStatus === 'solved' || irrStatus === 'solved_zero';
    if (solved !== (!!monthlyIrrPptr && !!simpleAprPptr && !!effectiveAprPptr)) {
        fail('invalid_loan_nullable');
    }
    return {
        preDiscountTotalPaymentAmount: asNonNegativeInteger(summary['preDiscountTotalPaymentAmount']),
        preDiscountTotalCostAmount: asNonNegativeInteger(summary['preDiscountTotalCostAmount']),
        totalPaymentAmount: asNonNegativeInteger(summary['totalPaymentAmount']),
        totalInterestAmount: asNonNegativeInteger(summary['totalInterestAmount']),
        totalFeeAmount: asNonNegativeInteger(summary['totalFeeAmount']),
        totalDiscountAmount: asNonNegativeInteger(summary['totalDiscountAmount']),
        totalCostAmount: asNonNegativeInteger(summary['totalCostAmount']),
        costRatioPptr: asPptr(summary['costRatioPptr']),
        irrStatus,
        ...(typeof monthlyIrrPptr === 'undefined' ? {} : { monthlyIrrPptr }),
        ...(typeof simpleAprPptr === 'undefined' ? {} : { simpleAprPptr }),
        ...(typeof effectiveAprPptr === 'undefined' ? {} : { effectiveAprPptr })
    };
}

function normalizeCalculatedInstallment(value: unknown): LoanCalculatedInstallment {
    const installment = asRecord(value);
    return {
        installmentNumber: asPositiveInteger(installment['installmentNumber']),
        dueDate: asCivilDate(installment['dueDate']),
        beginningPrincipalAmount: asNonNegativeInteger(installment['beginningPrincipalAmount']),
        principalAmount: asNonNegativeInteger(installment['principalAmount']),
        interestAmount: asNonNegativeInteger(installment['interestAmount']),
        feeAmount: asNonNegativeInteger(installment['feeAmount']),
        discountAmount: asNonNegativeInteger(installment['discountAmount']),
        paymentAmount: asNonNegativeInteger(installment['paymentAmount']),
        endingPrincipalAmount: asNonNegativeInteger(installment['endingPrincipalAmount']),
        preDiscountInterestAmount: asNonNegativeInteger(installment['preDiscountInterestAmount']),
        preDiscountFeeAmount: asNonNegativeInteger(installment['preDiscountFeeAmount']),
        preDiscountPaymentAmount: asNonNegativeInteger(installment['preDiscountPaymentAmount'])
    };
}

export function normalizeLoanCalculationResult(value: unknown): LoanCalculationResult {
    const result = asRecord(value);
    if (result['calculationVersion'] !== 'loan-calculation-v1' ||
        result['roundingVersion'] !== 'loan-rounding-half-up-v1' || result['irrVersion'] !== 'periodic-irr-v1') {
        fail('invalid_loan_enum');
    }
    return {
        calculationVersion: 'loan-calculation-v1',
        roundingVersion: 'loan-rounding-half-up-v1',
        irrVersion: 'periodic-irr-v1',
        summary: normalizeCalculationSummary(result['summary']),
        installments: asArray(result['installments']).map(normalizeCalculatedInstallment)
    };
}

function normalizeContract(value: unknown): LoanContract {
    const contract = asRecord(value);
    const closeReasonValue = contract['closeReason'];
    const defaultPaymentAccountId = asOptionalIdentifier(contract['defaultPaymentAccountId']);
    const closedUnixTime = asOptionalNonNegativeInteger(contract['closedUnixTime']);
    return {
        id: asIdentifier(contract['id']),
        name: asString(contract['name']),
        lenderName: asString(contract['lenderName']),
        contractType: asEnum<LoanContractType>(contract['contractType'], contractTypes),
        status: asEnum<LoanContractStatus>(contract['status'], contractStatuses),
        ...(closeReasonValue === null || typeof closeReasonValue === 'undefined'
            ? {}
            : { closeReason: asEnum<LoanCloseReason>(closeReasonValue, closeReasons) }),
        liabilityAccountId: asIdentifier(contract['liabilityAccountId']),
        ...(typeof defaultPaymentAccountId === 'undefined' ? {} : { defaultPaymentAccountId }),
        currency: normalizeCurrency(contract['currency']),
        note: asString(contract['note']),
        version: asPositiveInteger(contract['version']),
        currentRevisionId: asIdentifier(contract['currentRevisionId']),
        createdUnixTime: asNonNegativeInteger(contract['createdUnixTime']),
        updatedUnixTime: asNonNegativeInteger(contract['updatedUnixTime']),
        ...(typeof closedUnixTime === 'undefined' ? {} : { closedUnixTime })
    };
}

function normalizeRevision(value: unknown): LoanRevision {
    const revision = asRecord(value);
    const previousRevisionId = asOptionalIdentifier(revision['previousRevisionId']);
    const effectiveDate = asCivilDate(revision['effectiveDate']);
    const input = normalizeCalculationInput(revision['input']);
    if (input.effectiveDate !== effectiveDate) {
        fail('invalid_loan_date');
    }
    return {
        id: asIdentifier(revision['id']),
        revisionNumber: asPositiveInteger(revision['revisionNumber']),
        ...(typeof previousRevisionId === 'undefined' ? {} : { previousRevisionId }),
        effectiveDate,
        input,
        calculation: normalizeLoanCalculationResult(revision['calculation']),
        createdUnixTime: asNonNegativeInteger(revision['createdUnixTime'])
    };
}

function normalizeInstallmentProgress(value: unknown): LoanInstallmentProgress {
    const progress = asRecord(value);
    return {
        settlementStatus: asEnum<LoanInstallmentSettlementStatus>(progress['settlementStatus'], settlementStatuses),
        overdue: asBoolean(progress['overdue']),
        allocatedPrincipalAmount: asNonNegativeInteger(progress['allocatedPrincipalAmount']),
        allocatedInterestAmount: asNonNegativeInteger(progress['allocatedInterestAmount']),
        allocatedFeeAmount: asNonNegativeInteger(progress['allocatedFeeAmount']),
        outstandingPrincipalAmount: asNonNegativeInteger(progress['outstandingPrincipalAmount']),
        outstandingInterestAmount: asNonNegativeInteger(progress['outstandingInterestAmount']),
        outstandingFeeAmount: asNonNegativeInteger(progress['outstandingFeeAmount']),
        outstandingPaymentAmount: asNonNegativeInteger(progress['outstandingPaymentAmount']),
        actionRequired: asBoolean(progress['actionRequired']),
        reasonCodes: normalizeReasons(progress['reasonCodes'])
    };
}

function normalizeInstallment(value: unknown): LoanInstallment {
    const installment = asRecord(value);
    return {
        id: asIdentifier(installment['id']),
        revisionId: asIdentifier(installment['revisionId']),
        ...normalizeCalculatedInstallment(installment),
        progress: normalizeInstallmentProgress(installment['progress'])
    };
}

function normalizeLiabilityComparison(value: unknown): LoanLiabilityComparison {
    const comparison = asRecord(value);
    return {
        plannedOutstandingPrincipalAmount: asNonNegativeInteger(comparison['plannedOutstandingPrincipalAmount']),
        ledgerOutstandingLiabilityAmount: asNonNegativeInteger(comparison['ledgerOutstandingLiabilityAmount']),
        differenceAmount: asSafeInteger(comparison['differenceAmount']),
        actionRequired: asBoolean(comparison['actionRequired']),
        reasonCodes: normalizeReasons(comparison['reasonCodes'])
    };
}

function normalizeAllocationSummary(value: unknown) {
    const allocations = asRecord(value);
    return {
        activeAllocationCount: asNonNegativeInteger(allocations['activeAllocationCount']),
        actionRequiredAllocationCount: asNonNegativeInteger(allocations['actionRequiredAllocationCount']),
        allocatedDisbursementAmount: asNonNegativeInteger(allocations['allocatedDisbursementAmount']),
        allocatedPrincipalAmount: asNonNegativeInteger(allocations['allocatedPrincipalAmount']),
        allocatedInterestAmount: asNonNegativeInteger(allocations['allocatedInterestAmount']),
        allocatedFeeAmount: asNonNegativeInteger(allocations['allocatedFeeAmount'])
    };
}

export function normalizeLoanContractDetail(value: unknown): LoanContractDetail {
    const detail = asRecord(value);
    return {
        contract: normalizeContract(detail['contract']),
        currentRevision: normalizeRevision(detail['currentRevision']),
        installments: asArray(detail['installments']).map(normalizeInstallment),
        allocations: normalizeAllocationSummary(detail['allocations']),
        liabilityComparison: normalizeLiabilityComparison(detail['liabilityComparison']),
        asOfDate: asCivilDate(detail['asOfDate'])
    };
}

function normalizeContractSummary(value: unknown): LoanContractSummary {
    const summary = asRecord(value);
    const nextInstallmentValue = summary['nextInstallment'];
    return {
        contract: normalizeContract(summary['contract']),
        calculation: normalizeCalculationSummary(summary['calculation']),
        paidInstallmentCount: asNonNegativeInteger(summary['paidInstallmentCount']),
        partialInstallmentCount: asNonNegativeInteger(summary['partialInstallmentCount']),
        totalInstallmentCount: asNonNegativeInteger(summary['totalInstallmentCount']),
        outstandingPrincipalAmount: asNonNegativeInteger(summary['outstandingPrincipalAmount']),
        outstandingPaymentAmount: asNonNegativeInteger(summary['outstandingPaymentAmount']),
        ...(nextInstallmentValue === null || typeof nextInstallmentValue === 'undefined'
            ? {}
            : { nextInstallment: normalizeInstallment(nextInstallmentValue) }),
        actionRequired: asBoolean(summary['actionRequired']),
        reasonCodes: normalizeReasons(summary['reasonCodes'])
    };
}

function normalizeContractPage(value: unknown): LoanContractPage {
    const page = asRecord(value);
    const cursorValue = page['nextCursor'];
    return {
        items: asArray(page['items']).map(normalizeContractSummary),
        ...(cursorValue === null || typeof cursorValue === 'undefined' ? {} : {
            nextCursor: (() => {
                const cursor = asRecord(cursorValue);
                return {
                    status: asEnum<LoanContractStatus>(cursor['status'], contractStatuses),
                    updatedUnixTime: asNonNegativeInteger(cursor['updatedUnixTime']),
                    contractId: asIdentifier(cursor['contractId'])
                };
            })()
        })
    };
}

function normalizeCandidate(value: unknown): LoanSettlementCandidate {
    const candidate = asRecord(value);
    const transactionType = asEnum(candidate['transactionType'], ['transfer', 'expense'] as const);
    const counterpartUpdatedUnixTime = asOptionalNonNegativeInteger(candidate['counterpartUpdatedUnixTime']);
    if (transactionType === 'expense' && typeof counterpartUpdatedUnixTime !== 'undefined') {
        fail('invalid_loan_transfer_snapshot');
    }
    const maskedDestinationAccount = candidate['maskedDestinationAccount'];
    return {
        transactionId: asIdentifier(candidate['transactionId']),
        transactionType,
        transactionDate: asCivilDate(candidate['transactionDate']),
        amount: asNonNegativeInteger(candidate['amount']),
        currency: normalizeCurrency(candidate['currency']),
        maskedSourceAccount: asString(candidate['maskedSourceAccount']),
        ...(maskedDestinationAccount === null || typeof maskedDestinationAccount === 'undefined'
            ? {}
            : { maskedDestinationAccount: asString(maskedDestinationAccount) }),
        eligible: asBoolean(candidate['eligible']),
        reasonCodes: normalizeReasons(candidate['reasonCodes']),
        updatedUnixTime: asNonNegativeInteger(candidate['updatedUnixTime']),
        ...(typeof counterpartUpdatedUnixTime === 'undefined' ? {} : { counterpartUpdatedUnixTime })
    };
}

function normalizeCandidateGroup(value: unknown): LoanSettlementCandidateGroup {
    const group = asRecord(value);
    return {
        componentType: asEnum<LoanComponentType>(group['componentType'], componentTypes),
        expectedAmount: asNonNegativeInteger(group['expectedAmount']),
        outstandingAmount: asNonNegativeInteger(group['outstandingAmount']),
        candidates: asArray(group['candidates']).map(normalizeCandidate),
        limitReached: asBoolean(group['limitReached'])
    };
}

export function normalizeLoanSettlementCandidates(value: unknown): LoanSettlementCandidatesResult {
    const result = asRecord(value);
    const installmentId = asOptionalIdentifier(result['installmentId']);
    return {
        contractId: asIdentifier(result['contractId']),
        ...(typeof installmentId === 'undefined' ? {} : { installmentId }),
        groups: asArray(result['groups']).map(normalizeCandidateGroup)
    };
}

function normalizeAllocation(value: unknown): LoanSettlementAllocation {
    const allocation = asRecord(value);
    const installmentId = asOptionalIdentifier(allocation['installmentId']);
    const counterpartTransactionId = asOptionalIdentifier(allocation['counterpartTransactionId']);
    const componentType = asEnum<LoanComponentType>(allocation['componentType'], componentTypes);
    const transferComponent = componentType === 'disbursement' || componentType === 'principal';
    if (transferComponent !== (typeof counterpartTransactionId !== 'undefined')) {
        fail('invalid_loan_transfer_snapshot');
    }
    return {
        id: asIdentifier(allocation['id']),
        ...(typeof installmentId === 'undefined' ? {} : { installmentId }),
        componentType,
        allocatedAmount: asNonNegativeInteger(allocation['allocatedAmount']),
        creationMethod: asEnum<LoanAllocationCreationMethod>(allocation['creationMethod'], allocationCreationMethods),
        status: asEnum<LoanAllocationStatus>(allocation['status'], allocationStatuses),
        transactionId: asIdentifier(allocation['transactionId']),
        ...(typeof counterpartTransactionId === 'undefined' ? {} : { counterpartTransactionId }),
        reasonCodes: normalizeReasons(allocation['reasonCodes']),
        createdUnixTime: asNonNegativeInteger(allocation['createdUnixTime']),
        updatedUnixTime: asNonNegativeInteger(allocation['updatedUnixTime'])
    };
}

export function normalizeLoanActionResult(value: unknown): LoanActionResult {
    const result = asRecord(value, 'invalid_loan_action');
    const contractValue = result['contract'];
    return {
        actionId: asIdentifier(result['actionId']),
        status: asEnum(result['status'], actionStatuses),
        ...(contractValue === null || typeof contractValue === 'undefined'
            ? {}
            : { contract: normalizeLoanContractDetail(contractValue) }),
        allocations: asArray(result['allocations']).map(normalizeAllocation),
        replayed: asBoolean(result['replayed']),
        reasonCodes: normalizeReasons(result['reasonCodes'])
    };
}

export function normalizeLoanSettlementUndoImpact(value: unknown): LoanSettlementUndoImpact {
    const impact = asRecord(value);
    return {
        contractId: asIdentifier(impact['contractId']),
        actionId: asIdentifier(impact['actionId']),
        activeAllocationCount: asNonNegativeInteger(impact['activeAllocationCount']),
        relationshipCount: asNonNegativeInteger(impact['relationshipCount']),
        affectedTransactionCount: asNonNegativeInteger(impact['affectedTransactionCount']),
        loanCreatedTransactionCount: asNonNegativeInteger(impact['loanCreatedTransactionCount']),
        modifiedTransactionCount: asNonNegativeInteger(impact['modifiedTransactionCount']),
        missingTransactionCount: asNonNegativeInteger(impact['missingTransactionCount']),
        incompleteTransferPairCount: asNonNegativeInteger(impact['incompleteTransferPairCount']),
        canUndoRelationships: asBoolean(impact['canUndoRelationships']),
        reasonCodes: normalizeReasons(impact['reasonCodes'])
    };
}

function normalizeCurrency(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
        fail('invalid_loan_response');
    }
    return value;
}

function unwrapApiResponse(response: unknown): unknown {
    const outer = asRecord(response);
    const data = asRecord(outer['data']);
    if (data['success'] !== true || data['result'] === null || typeof data['result'] === 'undefined') {
        fail('invalid_loan_response');
    }
    return data['result'];
}

function projectContractIdentity(contract: LoanContractIdentityInput): LoanContractIdentityInput {
    return {
        name: asString(contract.name),
        lenderName: asString(contract.lenderName),
        contractType: asEnum<LoanContractType>(contract.contractType, contractTypes),
        liabilityAccountId: asIdentifier(contract.liabilityAccountId),
        ...(typeof contract.defaultPaymentAccountId === 'undefined'
            ? {}
            : { defaultPaymentAccountId: asIdentifier(contract.defaultPaymentAccountId) }),
        currency: normalizeCurrency(contract.currency),
        note: asString(contract.note)
    };
}

function projectLifecycleRequest(request: LoanContractLifecycleRequest): LoanContractLifecycleRequest {
    return {
        contractId: asIdentifier(request.contractId),
        expectedContractVersion: asPositiveInteger(request.expectedContractVersion),
        idempotencyKey: requireIdempotencyKey(request.idempotencyKey)
    };
}

function projectSettlementComponent(component: LoanSettlementComponent): LoanSettlementComponent {
    if (component.ledgerDraft) {
        return {
            componentType: asEnum<LoanComponentType>(component.componentType, componentTypes),
            allocatedAmount: asPositiveInteger(component.allocatedAmount),
            ledgerDraft: projectLedgerDraft(component.ledgerDraft)
        };
    }
    return {
        componentType: asEnum<LoanComponentType>(component.componentType, componentTypes),
        allocatedAmount: asPositiveInteger(component.allocatedAmount),
        existingTransactionId: asIdentifier(component.existingTransactionId),
        expectedUpdatedUnixTime: asPositiveInteger(component.expectedUpdatedUnixTime),
        ...(typeof component.expectedCounterpartUpdatedUnixTime === 'undefined' ? {} : {
            expectedCounterpartUpdatedUnixTime: asPositiveInteger(component.expectedCounterpartUpdatedUnixTime)
        })
    };
}

function projectLedgerDraft(draft: LoanLedgerDraft): LoanLedgerDraft {
    if (draft.transactionType === 'transfer') {
        return {
            transactionType: 'transfer',
            transactionDate: asCivilDate(draft.transactionDate),
            sourceAccountId: asIdentifier(draft.sourceAccountId),
            destinationAccountId: asIdentifier(draft.destinationAccountId),
            categoryId: asIdentifier(draft.categoryId),
            amount: asPositiveInteger(draft.amount),
            currency: normalizeCurrency(draft.currency)
        };
    }
    if (draft.transactionType === 'expense') {
        return {
            transactionType: 'expense',
            transactionDate: asCivilDate(draft.transactionDate),
            sourceAccountId: asIdentifier(draft.sourceAccountId),
            categoryId: asIdentifier(draft.categoryId),
            amount: asPositiveInteger(draft.amount),
            currency: normalizeCurrency(draft.currency)
        };
    }
    fail('invalid_loan_enum');
}

function requireIdempotencyKey(value: unknown): string {
    if (typeof value !== 'string' || value.length < 1) {
        fail('invalid_loan_response');
    }
    return value;
}

export const loanApi: LoanService = {
    async calculate(input): Promise<LoanCalculationResult> {
        return normalizeLoanCalculationResult(unwrapApiResponse(
            await services.calculatePersonalFinanceLoan(projectCalculationInput(input))
        ));
    },

    async listContracts(params): Promise<LoanContractPage> {
        const request = {
            status: asEnum<LoanContractStatus>(params.status, contractStatuses),
            limit: asPositiveInteger(params.limit),
            ...(typeof params.cursor === 'undefined' ? {} : {
                cursor: {
                    updatedUnixTime: asNonNegativeInteger(params.cursor.updatedUnixTime),
                    contractId: asIdentifier(params.cursor.contractId)
                }
            })
        };
        return normalizeContractPage(unwrapApiResponse(await services.listPersonalFinanceLoanContracts(request)));
    },

    async getContract(contractId): Promise<LoanContractDetail> {
        return normalizeLoanContractDetail(unwrapApiResponse(
            await services.getPersonalFinanceLoanContract({ contractId: asIdentifier(contractId) })
        ));
    },

    async createContract(request): Promise<LoanActionResult> {
        const projected: LoanCreateContractRequest = {
            contract: projectContractIdentity(request.contract),
            calculation: projectCalculationInput(request.calculation),
            idempotencyKey: requireIdempotencyKey(request.idempotencyKey)
        };
        return normalizeLoanActionResult(unwrapApiResponse(await services.createPersonalFinanceLoanContract(projected)));
    },

    async reviseContract(request): Promise<LoanActionResult> {
        const projected: LoanReviseContractRequest = {
            contractId: asIdentifier(request.contractId),
            expectedContractVersion: asPositiveInteger(request.expectedContractVersion),
            calculation: projectCalculationInput(request.calculation),
            idempotencyKey: requireIdempotencyKey(request.idempotencyKey)
        };
        return normalizeLoanActionResult(unwrapApiResponse(await services.revisePersonalFinanceLoanContract(projected)));
    },

    async closeContract(request): Promise<LoanActionResult> {
        const projected: LoanCloseContractRequest = {
            ...projectLifecycleRequest(request),
            closeReason: asEnum<LoanCloseReason>(request.closeReason, closeReasons)
        };
        return normalizeLoanActionResult(unwrapApiResponse(await services.closePersonalFinanceLoanContract(projected)));
    },

    async reopenContract(request): Promise<LoanActionResult> {
        return normalizeLoanActionResult(unwrapApiResponse(
            await services.reopenPersonalFinanceLoanContract(projectLifecycleRequest(request))
        ));
    },

    async cancelContract(request): Promise<LoanActionResult> {
        return normalizeLoanActionResult(unwrapApiResponse(
            await services.cancelPersonalFinanceLoanContract(projectLifecycleRequest(request))
        ));
    },

    async listSettlementCandidates(request): Promise<LoanSettlementCandidatesResult> {
        const projected: LoanSettlementCandidatesRequest = {
            contractId: asIdentifier(request.contractId),
            componentType: asEnum<LoanComponentType>(request.componentType, componentTypes),
            ...(typeof request.installmentId === 'undefined' ? {} : { installmentId: asIdentifier(request.installmentId) })
        };
        return normalizeLoanSettlementCandidates(unwrapApiResponse(
            await services.listPersonalFinanceLoanSettlementCandidates(projected)
        ));
    },

    async applySettlement(request): Promise<LoanActionResult> {
        const validated = buildLoanSettlementApplyRequest({
            contractId: asIdentifier(request.contractId),
            contractVersion: asPositiveInteger(request.expectedContractVersion),
            installmentId: typeof request.installmentId === 'undefined' ? undefined : asIdentifier(request.installmentId),
            idempotencyKey: requireIdempotencyKey(request.idempotencyKey),
            components: request.components
        });
        const projected = buildLoanSettlementApplyRequest({
            contractId: validated.contractId,
            contractVersion: validated.expectedContractVersion,
            installmentId: validated.installmentId,
            idempotencyKey: validated.idempotencyKey,
            components: validated.components.map(projectSettlementComponent)
        });
        return normalizeLoanActionResult(unwrapApiResponse(await services.applyPersonalFinanceLoanSettlement(projected)));
    },

    async getSettlementUndoImpact(request): Promise<LoanSettlementUndoImpact> {
        const projected = {
            contractId: asIdentifier(request.contractId),
            actionId: asIdentifier(request.actionId)
        };
        return normalizeLoanSettlementUndoImpact(unwrapApiResponse(
            await services.getPersonalFinanceLoanSettlementUndoImpact(projected)
        ));
    },

    async undoSettlement(request): Promise<LoanActionResult> {
        const projected = buildLoanSettlementUndoRequest({
            contractId: asIdentifier(request.contractId),
            contractVersion: asPositiveInteger(request.expectedContractVersion),
            actionId: asIdentifier(request.actionId),
            idempotencyKey: requireIdempotencyKey(request.idempotencyKey)
        });
        return normalizeLoanActionResult(unwrapApiResponse(await services.undoPersonalFinanceLoanSettlement(projected)));
    }
};

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
