import type {
    PersonalFinanceNormalizedDirection,
    PersonalFinanceProcessingState,
    PersonalFinanceSourceType
} from '../models.ts';

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
    readonly createdUnixTime: number;
    readonly lastEvaluatedUnixTime: number;
    readonly updatedUnixTime: number;
}

export interface ReconciliationCaseMember {
    readonly order: number;
    readonly role: string;
    readonly sourceType: PersonalFinanceSourceType;
    readonly sourceDisplayName: string;
    readonly normalizedAmount?: string;
    readonly currency: string;
    readonly normalizedDirection: PersonalFinanceNormalizedDirection;
    readonly normalizedUnixTime?: number;
    readonly normalizedTimezoneUtcOffset?: number;
    readonly counterparty: string;
    readonly item: string;
    readonly paymentMethod: string;
    readonly economicEffect: string;
    readonly processingState?: PersonalFinanceProcessingState;
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
    readonly members: ReconciliationCaseMember[];
    readonly currentDecision?: ReconciliationDecision;
}

export interface ReconciliationCasePage {
    readonly items: ReconciliationCaseSummary[];
    readonly totalCount: number;
    readonly pendingCount: number;
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
}

export interface ReconciliationDecisionResult {
    readonly case?: ReconciliationCaseDetail;
    readonly decision: ReconciliationDecision;
    readonly replayed: boolean;
}

export interface ReconciliationUndoImpact {
    readonly caseId: string;
    readonly expectedCaseVersion: number;
    readonly automaticUndoAllowed: boolean;
    readonly affectedTransactionCount: number;
    readonly createdTransactionCount: number;
    readonly attachedExistingTransactionCount: number;
    readonly modifiedTransactionCount: number;
    readonly missingTransactionCount: number;
    readonly sharedDependencyCount: number;
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
