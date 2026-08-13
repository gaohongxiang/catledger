import { CategoryType } from '@/core/category.ts';
import { TransactionType } from '@/core/transaction.ts';

import type {
    ReconciliationCaseDetail,
    ReconciliationCaseStatus,
    ReconciliationDecisionComposition,
    ReconciliationDraftForm,
    ReconciliationDecisionRequest,
    ReconciliationDecisionType,
    ReconciliationEvidenceCard,
    ReconciliationMemberOrder,
    ReconciliationUndoRequest
} from './models.ts';

export type ReconciliationDecisionValidationCode =
    'field_source_required' |
    'refund_original_required' |
    'evidence_incomplete' |
    'currency_mismatch' |
    'draft_required' |
    'transaction_type_required' |
    'category_invalid' |
    'account_invalid' |
    'transfer_accounts_must_differ' |
    'refund_types_must_be_opposite';

export interface ReconciliationDecisionBuildContext {
    readonly accountCurrencies: Readonly<Record<string, string>>;
    readonly categoryTypes: Readonly<Record<string, CategoryType>>;
}

export class ReconciliationDecisionValidationError extends Error {
    public readonly code: ReconciliationDecisionValidationCode;

    public constructor(code: ReconciliationDecisionValidationCode) {
        super(code);
        this.code = code;
    }
}

export const reconciliationDecisionTypes: readonly ReconciliationDecisionType[] = [
    'same_event',
    'internal_transfer',
    'refund_reversal',
    'independent',
    'defer'
];

export const reconciliationCaseStatuses: readonly ReconciliationCaseStatus[] = [
    'open',
    'action_required',
    'deferred',
    'resolved'
];

export function canDecideReconciliationCase(reconciliationCase: ReconciliationCaseDetail | null): boolean {
    return reconciliationCase?.status === 'open';
}

export function canInspectReconciliationUndo(reconciliationCase: ReconciliationCaseDetail | null): boolean {
    return !!reconciliationCase?.currentDecisionId && reconciliationCase.status !== 'open';
}

export function buildReconciliationDecisionRequest(params: {
    reconciliationCase: ReconciliationCaseDetail;
    composition: ReconciliationDecisionComposition;
    context: ReconciliationDecisionBuildContext;
    idempotencyKey: string;
}): ReconciliationDecisionRequest {
    const { reconciliationCase, composition, context } = params;
    if (!reconciliationDecisionTypes.includes(composition.decisionType) || reconciliationCase.version < 1 || !params.idempotencyKey) {
        throw new Error('invalid_reconciliation_decision');
    }

    const members = getDecisionMembers(reconciliationCase.evidence);
    requireSelectedMember(members, composition.fieldSelection.accountAmountMemberOrder, 'field_source_required');
    requireSelectedMember(members, composition.fieldSelection.merchantItemMemberOrder, 'field_source_required');

    if (composition.decisionType === 'refund_reversal') {
        requireSelectedMember(members, composition.fieldSelection.refundOriginalMemberOrder, 'refund_original_required');
    }

    const request: ReconciliationDecisionRequest = {
        caseId: reconciliationCase.id,
        expectedCaseVersion: reconciliationCase.version,
        idempotencyKey: params.idempotencyKey,
        decisionType: composition.decisionType,
        fieldSelection: composition.fieldSelection
    };

    if (composition.decisionType === 'independent' || composition.decisionType === 'defer') {
        return request;
    }

    const memberEvidence = [...members.values()];
    validateMatchingCurrencies(memberEvidence);

    if (composition.decisionType === 'same_event' || composition.decisionType === 'internal_transfer') {
        if (memberEvidence.some(member => hasFormalTransaction(member))) {
            return request;
        }
        const evidence = requireSelectedMember(members, composition.fieldSelection.accountAmountMemberOrder, 'evidence_incomplete');
        return {
            ...request,
            primaryDraft: buildPostingDraft(evidence, composition.primaryDraft, context,
                composition.decisionType === 'internal_transfer'
                    ? TransactionType.Transfer
                    : resolveOrdinaryType(evidence, composition.primaryDraft))
        };
    }

    const originalOrder = composition.fieldSelection.refundOriginalMemberOrder;
    const originalEvidence = requireSelectedMember(members, originalOrder, 'refund_original_required');
    const refundEntry = [...members.entries()].find(([order]) => order !== originalOrder);
    if (!refundEntry) {
        throw new ReconciliationDecisionValidationError('evidence_incomplete');
    }
    const refundEvidence = refundEntry[1];
    const originalHasTransaction = hasFormalTransaction(originalEvidence);
    const refundHasTransaction = hasFormalTransaction(refundEvidence);
    const originalType = resolveOrdinaryType(originalEvidence, composition.refundOriginalDraft);
    const refundType = resolveOrdinaryType(refundEvidence, composition.refundTransactionDraft);

    if (!originalHasTransaction && !refundHasTransaction && (!originalType || !refundType || originalType === refundType)) {
        throw new ReconciliationDecisionValidationError('refund_types_must_be_opposite');
    }
    if (!originalHasTransaction && refundType && originalType === refundType) {
        throw new ReconciliationDecisionValidationError('refund_types_must_be_opposite');
    }
    if (!refundHasTransaction && originalType && originalType === refundType) {
        throw new ReconciliationDecisionValidationError('refund_types_must_be_opposite');
    }

    return {
        ...request,
        ...(!originalHasTransaction ? {
            refundOriginalDraft: buildPostingDraft(originalEvidence, composition.refundOriginalDraft, context, originalType)
        } : {}),
        ...(!refundHasTransaction ? {
            refundTransactionDraft: buildPostingDraft(refundEvidence, composition.refundTransactionDraft, context, refundType)
        } : {})
    };
}

function getDecisionMembers(evidence: readonly ReconciliationEvidenceCard[]): Map<ReconciliationMemberOrder, ReconciliationEvidenceCard[]> {
    const members = new Map<ReconciliationMemberOrder, ReconciliationEvidenceCard[]>();

    for (const item of evidence) {
        if (item.order !== 0 && item.order !== 1 && item.order !== 2) {
            continue;
        }
        const order = item.order as ReconciliationMemberOrder;
        const member = members.get(order) ?? [];
        member.push(item);
        members.set(order, member);
    }
    return members;
}

function requireSelectedMember(
    members: ReadonlyMap<ReconciliationMemberOrder, ReconciliationEvidenceCard[]>,
    order: ReconciliationMemberOrder,
    code: ReconciliationDecisionValidationCode
): ReconciliationEvidenceCard[] {
    const member = members.get(order);
    if (!member?.length) {
        throw new ReconciliationDecisionValidationError(code);
    }
    return member;
}

function hasFormalTransaction(evidence: readonly ReconciliationEvidenceCard[]): boolean {
    return evidence.some(item => item.transactionCount > 0);
}

function representativeEvidence(evidence: readonly ReconciliationEvidenceCard[]): ReconciliationEvidenceCard {
    const item = evidence[0];
    if (!item || !item.currency || !item.normalizedAmount || !Number.isSafeInteger(item.normalizedUnixTime) || item.normalizedUnixTime < 1 ||
        !Number.isSafeInteger(item.normalizedTimezoneUtcOffset)) {
        throw new ReconciliationDecisionValidationError('evidence_incomplete');
    }
    return item;
}

function validateMatchingCurrencies(members: readonly ReconciliationEvidenceCard[][]): void {
    const currencies = new Set(members.map(member => representativeEvidence(member).currency));
    if (currencies.size !== 1) {
        throw new ReconciliationDecisionValidationError('currency_mismatch');
    }
}

function resolveOrdinaryType(evidence: readonly ReconciliationEvidenceCard[], form?: ReconciliationDraftForm): TransactionType.Income | TransactionType.Expense | undefined {
    if (form?.type === TransactionType.Income || form?.type === TransactionType.Expense) {
        return form.type;
    }
    const direction = representativeEvidence(evidence).normalizedDirection;
    if (direction === 'income') {
        return TransactionType.Income;
    }
    if (direction === 'expense') {
        return TransactionType.Expense;
    }
    return undefined;
}

function transactionCategoryType(type: TransactionType): CategoryType {
    if (type === TransactionType.Income) {
        return CategoryType.Income;
    }
    if (type === TransactionType.Transfer) {
        return CategoryType.Transfer;
    }
    return CategoryType.Expense;
}

function buildPostingDraft(
    evidenceItems: readonly ReconciliationEvidenceCard[],
    form: ReconciliationDraftForm | undefined,
    context: ReconciliationDecisionBuildContext,
    requiredType?: TransactionType
) {
    if (!form) {
        throw new ReconciliationDecisionValidationError('draft_required');
    }
    const evidence = representativeEvidence(evidenceItems);
    const amount = Number(evidence.normalizedAmount);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new ReconciliationDecisionValidationError('evidence_incomplete');
    }
    const type = requiredType ?? form.type;
    if (type !== TransactionType.Income && type !== TransactionType.Expense && type !== TransactionType.Transfer) {
        throw new ReconciliationDecisionValidationError('transaction_type_required');
    }
    if (form.type !== type) {
        throw new ReconciliationDecisionValidationError('transaction_type_required');
    }
    if (!form.categoryId || context.categoryTypes[form.categoryId] !== transactionCategoryType(type)) {
        throw new ReconciliationDecisionValidationError('category_invalid');
    }
    if (!form.sourceAccountId || context.accountCurrencies[form.sourceAccountId] !== evidence.currency) {
        throw new ReconciliationDecisionValidationError('account_invalid');
    }
    if (type === TransactionType.Transfer) {
        if (!form.destinationAccountId || context.accountCurrencies[form.destinationAccountId] !== evidence.currency) {
            throw new ReconciliationDecisionValidationError('account_invalid');
        }
        if (form.destinationAccountId === form.sourceAccountId) {
            throw new ReconciliationDecisionValidationError('transfer_accounts_must_differ');
        }
    }

    return {
        type,
        categoryId: form.categoryId,
        time: evidence.normalizedUnixTime,
        utcOffset: evidence.normalizedTimezoneUtcOffset,
        sourceAccountId: form.sourceAccountId,
        destinationAccountId: type === TransactionType.Transfer ? form.destinationAccountId : '0',
        sourceAmount: amount,
        destinationAmount: type === TransactionType.Transfer ? amount : 0,
        hideAmount: false,
        tagIds: [],
        comment: ''
    };
}

export function buildReconciliationUndoRequest(params: {
    reconciliationCase: ReconciliationCaseDetail;
    idempotencyKey: string;
}): ReconciliationUndoRequest {
    if (!params.reconciliationCase.currentDecisionId || params.reconciliationCase.version < 1 || !params.idempotencyKey) {
        throw new Error('invalid_reconciliation_undo');
    }

    return {
        caseId: params.reconciliationCase.id,
        expectedCaseVersion: params.reconciliationCase.version,
        idempotencyKey: params.idempotencyKey
    };
}
