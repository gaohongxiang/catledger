import type {
    PersonalFinanceDisposition,
    PersonalFinanceIdentityState,
    PersonalFinanceNormalizedDirection,
    PersonalFinanceParseState,
    PersonalFinanceProcessingState,
    PersonalFinanceSourceTransactionType,
    PersonalFinanceSourceType
} from '../models.ts';
import type { PersonalFinancePostingDraft } from '../models.ts';
import type { TransactionType } from '@/core/transaction.ts';

export type ReconciliationCaseStatus = 'open' | 'resolved' | 'action_required' | 'deferred';
export type ReconciliationDecisionType = 'same_event' | 'internal_transfer' | 'refund_reversal' | 'independent' | 'defer';
export type ReconciliationDecisionStatus = 'ready' | 'applying' | 'applied' | 'action_required' | 'deferred' | 'failed';

export interface ReconciliationReason {
    readonly code: string;
    readonly value?: number;
}

export interface ReconciliationCaseSummary {
    readonly id: string;
    readonly status: ReconciliationCaseStatus;
    readonly version: number;
    readonly suggestedRelationType: ReconciliationDecisionType;
    readonly candidateScore: number;
    readonly reasonCodes: ReconciliationReason[];
    readonly currentDecisionId?: string;
    readonly createdUnixTime: number;
    readonly lastEvaluatedUnixTime: number;
    readonly updatedUnixTime: number;
}

export interface ReconciliationEvidenceCard {
    readonly order: number;
    readonly kind: string;
    readonly role: string;
    readonly sourceType: PersonalFinanceSourceType;
    readonly maskedSourceAccount: string;
    readonly evidenceLimitReached: boolean;
    readonly normalizedAmount: string;
    readonly currency: string;
    readonly normalizedDirection: PersonalFinanceNormalizedDirection;
    readonly normalizedUnixTime: number;
    readonly normalizedTimezoneUtcOffset: number;
    readonly normalizedTransactionType: PersonalFinanceSourceTransactionType;
    readonly economicEffect: string;
    readonly parseState: PersonalFinanceParseState;
    readonly identityState: PersonalFinanceIdentityState;
    readonly disposition: PersonalFinanceDisposition;
    readonly processingState: PersonalFinanceProcessingState;
    readonly transactionCount: number;
}

export interface ReconciliationDecision {
    readonly id: string;
    readonly decisionType: ReconciliationDecisionType | 'reopen';
    readonly status: ReconciliationDecisionStatus;
    readonly appliedCaseVersion?: number;
    readonly reasonCodes: ReconciliationReason[];
    readonly errorCode: string;
    readonly createdUnixTime: number;
    readonly updatedUnixTime: number;
}

export interface ReconciliationCaseDetail extends ReconciliationCaseSummary {
    readonly evidence: ReconciliationEvidenceCard[];
}

export interface ReconciliationCaseCursor {
    readonly updatedUnixTime: number;
    readonly caseId: string;
}

export interface ReconciliationCasePage {
    readonly items: ReconciliationCaseSummary[];
    readonly nextCursor?: ReconciliationCaseCursor;
}

export interface ReconciliationCandidateGenerateResult {
    readonly cases: ReconciliationCaseSummary[];
    readonly evaluatedAnchorCount: number;
    readonly limitReached: boolean;
}

export interface ReconciliationDecisionRequest {
    readonly caseId: string;
    readonly expectedCaseVersion: number;
    readonly idempotencyKey: string;
    readonly decisionType: ReconciliationDecisionType;
    readonly fieldSelection: ReconciliationFieldSelection;
    readonly primaryDraft?: PersonalFinancePostingDraft;
    readonly refundOriginalDraft?: PersonalFinancePostingDraft;
    readonly refundTransactionDraft?: PersonalFinancePostingDraft;
}

export type ReconciliationMemberOrder = 0 | 1 | 2;

export interface ReconciliationFieldSelection {
    readonly accountAmountMemberOrder: ReconciliationMemberOrder;
    readonly merchantItemMemberOrder: ReconciliationMemberOrder;
    readonly refundOriginalMemberOrder: ReconciliationMemberOrder;
}

export interface ReconciliationDraftForm {
    type: TransactionType | null;
    categoryId: string;
    sourceAccountId: string;
    destinationAccountId: string;
}

export interface ReconciliationDecisionComposition {
    readonly decisionType: ReconciliationDecisionType;
    readonly fieldSelection: ReconciliationFieldSelection;
    readonly primaryDraft?: ReconciliationDraftForm;
    readonly refundOriginalDraft?: ReconciliationDraftForm;
    readonly refundTransactionDraft?: ReconciliationDraftForm;
}

export interface ReconciliationDecisionResult {
    readonly case?: ReconciliationCaseDetail;
    readonly decision: ReconciliationDecision;
    readonly replayed: boolean;
}

export interface ReconciliationUndoImpact {
    readonly caseId: string;
    readonly decisionId: string;
    readonly attachedExistingCount: number;
    readonly reconciliationCreatedCount: number;
    readonly transactionCount: number;
    readonly modifiedTransactionCount: number;
    readonly missingTransactionCount: number;
    readonly sharedTransactionCount: number;
    readonly batchRelationCount: number;
    readonly incompleteTransferPairCount: number;
    readonly canReopen: boolean;
    readonly canAutomaticallyDelete: boolean;
    readonly reasonCodes: ReconciliationReason[];
}

export interface ReconciliationUndoRequest {
    readonly caseId: string;
    readonly expectedCaseVersion: number;
    readonly idempotencyKey: string;
}

export interface ReconciliationUndoResult {
    readonly case?: ReconciliationCaseDetail;
    readonly decision: ReconciliationDecision;
    readonly replayed: boolean;
}
