import type { PersonalFinanceSourceType } from '../models.ts';

export type FinanceUpdateStatus =
    'draft' | 'organizing' | 'review' | 'posting' | 'posted' | 'failed' | 'undone' | 'abandoned';

export type EconomicEventStatus = 'ready' | 'needs_action' | 'excluded' | 'posted' | 'corrected';
export type EconomicFlowDirection = 'inflow' | 'outflow' | 'neutral';
export type EconomicNature =
    'income' | 'expense' | 'internal_transfer' | 'borrow' | 'repayment' |
    'refund' | 'fee' | 'balance_adjustment' | 'unknown';

export type ReviewIssueStatus = 'open' | 'resolved' | 'superseded';
export type ReviewIssueType =
    'account_mapping' | 'shared_fields' | 'same_event' | 'refund_relation' |
    'transfer_accounts' | 'identity_conflict' | 'field_conflict' | 'installment_origin';
export type ReviewIssueMemberRole = 'subject' | 'candidate' | 'supporting';
export type ReviewObjectType = 'event' | 'evidence' | 'relation' | 'transaction' | 'source_account';
export type ReviewIssueDecision =
    'apply_fields' | 'confirm_distinct' | 'confirm_same' | 'exclude_events' |
    'discard_evidence' | 'link_refund' | 'link_existing_transaction' |
    'confirm_installment_principal';

export interface FinanceUpdateSource {
    readonly id: string;
    readonly fileId: string;
    readonly batchId: string;
    readonly sourceOrder: number;
    readonly sourceAccountId?: string;
    readonly sourceType: PersonalFinanceSourceType;
    readonly parserVersion: string;
    readonly normalizationVersion: string;
    readonly identityKeyVersion: string;
}

export interface FinanceUpdate {
    readonly id: string;
    readonly status: FinanceUpdateStatus;
    readonly version: number;
    readonly planVersion: string;
    readonly currentActionId?: string;
    readonly sourceCount: number;
    readonly validEvidenceCount: number;
    readonly duplicateEvidenceCount: number;
    readonly finalEventCount: number;
    readonly postedEventCount: number;
    readonly readyEventCount: number;
    readonly needsActionEventCount: number;
    readonly excludedEventCount: number;
    readonly errorCode: string;
    readonly createdUnixTime: number;
    readonly updatedUnixTime: number;
    readonly sources?: readonly FinanceUpdateSource[];
}

export interface FinanceUpdatePage {
    readonly items: readonly FinanceUpdate[];
    readonly nextCursor?: { readonly updatedUnixTime: number; readonly updateId: string };
}

export interface EconomicEvent {
    readonly id: string;
    readonly updateId: string;
    readonly status: EconomicEventStatus;
    readonly version: number;
    readonly flowDirection: EconomicFlowDirection;
    readonly economicNature: EconomicNature;
    readonly ledgerAccountId?: string;
    readonly counterpartyLedgerAccountId?: string;
    readonly eventUnixTime?: number;
    readonly timezoneUtcOffset?: number;
    readonly amount?: string;
    readonly currency: string;
    readonly categoryId?: string;
    readonly manualFieldMask: number;
    readonly fieldSourcesJson: string;
    readonly reasonCodesJson: string;
    readonly createdUnixTime: number;
    readonly updatedUnixTime: number;
    readonly counterparty: string;
    readonly item: string;
    readonly paymentMethod: string;
    readonly note: string;
    readonly evidenceCount: number;
}

export interface EconomicEventPage {
    readonly items: readonly EconomicEvent[];
    readonly nextCursor?: { readonly updatedUnixTime: number; readonly eventId: string };
}

export interface FinanceAction {
    readonly id: string;
    readonly updateId: string;
    readonly actionType: string;
    readonly status: string;
    readonly appliedUpdateVersion: number;
    readonly reasonCodesJson: string;
    readonly errorCode: string;
    readonly createdUnixTime: number;
    readonly updatedUnixTime: number;
}

export interface OrganizerImpact {
    readonly safeToApply: boolean;
    readonly postedEventCount: number;
    readonly transactionCount: number;
    readonly missingTransactionCount: number;
    readonly modifiedTransactionCount: number;
    readonly sharedTransactionCount: number;
    readonly batchRelationCount: number;
    readonly debtRelationCount: number;
    readonly incompleteTransferPairCount: number;
    readonly reasonCodes: readonly string[];
}

export interface OrganizerMutation {
    readonly update: FinanceUpdate;
    readonly event?: EconomicEvent;
    readonly events?: readonly EconomicEvent[];
    readonly action: FinanceAction;
    readonly impact?: OrganizerImpact;
    readonly replayed: boolean;
}

export interface OrganizerRawRow {
    readonly id: string;
    readonly batchId: string;
    readonly rowNumber: number;
    readonly sourceLocator: string;
    readonly unixTime?: number;
    readonly amount?: string;
    readonly currency: string;
    readonly direction: string;
    readonly transactionType: string;
    readonly counterparty: string;
    readonly item: string;
    readonly paymentMethod: string;
    readonly note: string;
    readonly rawFields: readonly OrganizerRawField[];
}

export interface OrganizerRawField {
    readonly name: string;
    readonly value: string;
}

export interface OrganizerEvidenceItem {
    readonly id: string;
    readonly rowId: string;
    readonly evidenceRole: string;
    readonly fieldMask: number;
    readonly row: OrganizerRawRow;
}

export interface OrganizerRelation {
    readonly id: string;
    readonly type: string;
    readonly status: string;
    readonly version: number;
    readonly sourceEventId: string;
    readonly targetEventId: string;
    readonly amount?: string;
    readonly currency: string;
    readonly manual: boolean;
    readonly reasonCodesJson: string;
}

export interface OrganizerTransactionLink {
    readonly id: string;
    readonly transactionId: string;
    readonly role: string;
    readonly transactionUpdatedUnixTime: number;
}

export interface OrganizerEventEvidence {
    readonly event: EconomicEvent;
    readonly evidence: readonly OrganizerEvidenceItem[];
    readonly relations: readonly OrganizerRelation[];
    readonly transactions: readonly OrganizerTransactionLink[];
}

export interface OrganizerCorrectRequest {
    readonly updateId: string;
    readonly eventId: string;
    readonly expectedUpdateVersion: number;
    readonly expectedEventVersion: number;
    readonly idempotencyKey: string;
    readonly categoryScope?: 'single' | 'matching_uncategorized';
    readonly fieldMask: number;
    readonly status?: EconomicEventStatus;
    readonly flowDirection?: EconomicFlowDirection;
    readonly economicNature?: EconomicNature;
    readonly ledgerAccountId?: string;
    readonly counterpartyLedgerAccountId?: string;
    readonly eventUnixTime?: number;
    readonly timezoneUtcOffset?: number;
    readonly amount?: string;
    readonly currency?: string;
    readonly categoryId?: string;
}

export interface CategoryCorrectionScopePreview {
	readonly matchingEventCount: number;
}

export interface ReviewIssue {
    readonly id: string;
    readonly updateId: string;
    readonly status: ReviewIssueStatus;
    readonly type: ReviewIssueType;
    readonly version: number;
    readonly blocking: boolean;
    readonly primaryReasonCode: string;
    readonly memberCount: number;
    readonly candidateCount: number;
    readonly resolvedActionId?: string;
    readonly reasonCodesJson: string;
    readonly createdUnixTime: number;
    readonly updatedUnixTime: number;
}

export interface ReviewIssueMember {
    readonly id: string;
    readonly issueId: string;
    readonly role: ReviewIssueMemberRole;
    readonly objectType: ReviewObjectType;
    readonly objectId: string;
    readonly objectVersion: number;
    readonly sortOrder: number;
    readonly score: number;
    readonly reasonCodesJson: string;
}

export interface ReviewIssuePage {
    readonly items: readonly ReviewIssue[];
    readonly members: readonly ReviewIssueMember[];
    readonly nextCursor?: { readonly updatedUnixTime: number; readonly issueId: string };
}

export interface ReviewIssueDetail {
    readonly issue: ReviewIssue;
    readonly members: readonly ReviewIssueMember[];
    readonly events: readonly EconomicEvent[];
    readonly relations: readonly OrganizerRelation[];
    readonly transactions: readonly OrganizerTransactionLink[];
}

export interface ResolveReviewIssueRequest {
    readonly updateId: string;
    readonly issueId: string;
    readonly expectedUpdateVersion: number;
    readonly expectedIssueVersion: number;
    readonly idempotencyKey: string;
    readonly decision: ReviewIssueDecision;
    readonly fieldMask?: number;
    readonly flowDirection?: EconomicFlowDirection;
    readonly economicNature?: EconomicNature;
    readonly ledgerAccountId?: string;
    readonly counterpartyLedgerAccountId?: string;
    readonly eventUnixTime?: number;
    readonly timezoneUtcOffset?: number;
    readonly amount?: string;
    readonly currency?: string;
    readonly categoryId?: string;
    readonly primaryEventId?: string;
    readonly eventIds?: readonly string[];
    readonly evidenceId?: string;
    readonly targetEventId?: string;
    readonly transactionId?: string;
    readonly installmentCandidateId?: string;
}

export interface ReviewIssueMutation extends ReviewIssueDetail {
    readonly update: FinanceUpdate;
    readonly action: FinanceAction;
    readonly replayed: boolean;
}
