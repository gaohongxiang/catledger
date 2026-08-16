export type BillflowTaskStatus =
    'receiving' |
    'accounts_pending' |
    'processing' |
    'awaiting_confirm' |
    'ready' |
    'failed';

export type BillflowConfirmPolicy = 'confirm_then_post' | 'auto_post';

export type BillflowTodoKind =
    'unresolved_payment_account' |
    'identity_conflict' |
    'core_field_conflict' |
    'ledger_mismatch' |
    'cross_source_ambiguous' |
    'transfer_unclear' |
    'refund_unclear' |
    'repayment_unclear' |
    'installment_candidate' |
    'uncategorized';

export type BillflowTodoStatus = 'open' | 'resolved' | 'dismissed';

export type BillflowSubjectKind =
    'raw_row' |
    'source_identity' |
    'reconciliation_case' |
    'installment_candidate' |
    'payment_alias' |
    'transaction';

export type BillflowSourceType = 'alipay' | 'wechat' | 'bank';

export interface BillflowTaskMember {
    readonly id: string;
    readonly fileId: string;
    readonly batchId: string;
    readonly memberOrder: number;
}

export interface BillflowTask {
    readonly id: string;
    readonly status: BillflowTaskStatus;
    readonly confirmPolicy: BillflowConfirmPolicy;
    readonly version: number;
    readonly createdAccountCount: number;
    readonly reusedMappingCount: number;
    readonly autoPostedCount: number;
    readonly todoOpenCount: number;
    readonly errorCode: string;
    readonly createdUnixTime: number;
    readonly updatedUnixTime: number;
    readonly members: readonly BillflowTaskMember[];
}

export interface BillflowTaskPage {
    readonly items: readonly BillflowTask[];
    readonly nextCursor?: { readonly updatedUnixTime: number; readonly taskId: string };
}

export interface BillflowAccountGroup {
    readonly sourceType: BillflowSourceType;
    readonly currency: string;
    readonly displayName: string;
    readonly rowCount: number;
    readonly pendingRowCount: number;
    readonly sampleRowId: string;
    readonly ledgerAccountId?: string;
    readonly suggestedType: 'credit_card' | 'virtual';
    readonly mapped: boolean;
    readonly excluded: boolean;
    readonly statementDate?: string;
    readonly dueDate?: string;
    readonly creditLimitAmount?: string;
    readonly creditLimitCurrency?: string;
}

export interface BillflowAccountRow {
    readonly id: string;
    readonly batchId: string;
    readonly unixTime?: number;
    readonly amount: string;
    readonly currency: string;
    readonly direction: string;
    readonly label: string;
    readonly skipped: boolean;
}

export interface BillflowAccounts {
    readonly needsCreate: readonly BillflowAccountGroup[];
    readonly reused: readonly BillflowAccountGroup[];
    readonly excluded: readonly BillflowAccountGroup[];
}

export interface BillflowTodo {
    readonly id: string;
    readonly todoKind: BillflowTodoKind;
    readonly status: BillflowTodoStatus;
    readonly subjectKind: BillflowSubjectKind;
    readonly subjectId: string;
    readonly reasonCodes: readonly string[];
    readonly label: string;
    readonly item: string;
    readonly billType: string;
    readonly amount: string;
    readonly currency: string;
    readonly unixTime?: number;
    readonly direction: string;
    readonly sourceType?: BillflowSourceType;
    readonly account?: string;
    readonly categoryId?: string;
    readonly orderId?: string;
    readonly merchantOrderId?: string;
    readonly version: number;
    readonly createdUnixTime: number;
    readonly updatedUnixTime: number;
    readonly matches: readonly BillflowTodoMatch[];
}

export interface BillflowTodoMatch {
    readonly sourceType: BillflowSourceType;
    readonly account: string;
    readonly label: string;
    readonly item: string;
    readonly billType: string;
    readonly amount: string;
    readonly currency: string;
    readonly unixTime?: number;
    readonly direction: string;
    readonly orderId?: string;
    readonly merchantOrderId?: string;
}

export interface BillflowClassifiedRow {
    readonly id: string;
    readonly todoId?: string;
    readonly version?: number;
    readonly label: string;
    readonly item: string;
    readonly billType: string;
    readonly amount: string;
    readonly currency: string;
    readonly unixTime?: number;
    readonly direction: string;
    readonly categoryId: string;
}

export interface BillflowTodoPage {
    readonly items: readonly BillflowTodo[];
    readonly nextCursor?: { readonly updatedUnixTime: number; readonly todoId: string };
}

export interface BillflowUndoImpact {
    readonly canReverse: boolean;
    readonly autoPostedCount: number;
    readonly reusedLinkCount: number;
    readonly reasonCodes: readonly string[];
}

export type InstallmentCandidateStatus = 'pending' | 'incomplete' | 'confirmed' | 'dismissed';
export type InstallmentPurchaseRelation = 'unresolved' | 'link_existing' | 'missing_candidate';

export interface InstallmentCandidate {
    readonly id: string;
    readonly status: InstallmentCandidateStatus;
    readonly version: number;
    readonly liabilityAccountId?: string;
    readonly termCount?: number;
    readonly purchaseRelation: InstallmentPurchaseRelation;
    readonly linkedPurchaseTransactionId?: string;
}

export type CardMonthStatus = 'provisional' | 'confirmed';
export type CardBalanceReviewStatus = 'unverified' | 'verified';

export interface CardCycleAccount {
    readonly ledgerAccountId: string;
    readonly displayName: string;
    readonly currency: string;
    readonly monthStatus: CardMonthStatus;
    readonly balanceReview?: {
        readonly id: string;
        readonly status: CardBalanceReviewStatus;
        readonly asOfDate: string;
        readonly version: number;
    };
}

export interface BillflowTaskSummary {
    readonly createdAccountCount: number;
    readonly reusedMappingCount: number;
    readonly autoPostedCount: number;
    readonly todoOpenCount: number;
}

export type DashboardHeadlineCode =
    'provisional_month' |
    'uncategorized_count' |
    'todo_open_count' |
    'balance_unverified_count';

export interface DashboardHeadlineItem {
    readonly code: DashboardHeadlineCode;
    readonly count: number;
}
