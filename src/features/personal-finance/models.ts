import type { TransactionType } from '@/core/transaction.ts';

export type PersonalFinanceSourceType = 'alipay' | 'wechat' | 'bank';
export type PersonalFinanceBatchStatus = 'receiving' | 'parsing' | 'awaiting_source_account' | 'ready' | 'posting' | 'partially_posted' | 'completed' | 'failed' | 'discarded';
export type PersonalFinanceParseState = 'valid' | 'invalid';
export type PersonalFinanceIdentityState = 'not_evaluated' | 'new' | 'exact_duplicate' | 'identity_conflict' | 'batch_local';
export type PersonalFinanceDisposition = 'postable' | 'review_required' | 'non_postable';
export type PersonalFinanceProcessingState = 'pending' | 'linked' | 'ignored' | 'failed';
export type PersonalFinanceNormalizedDirection = 'income' | 'expense' | 'neutral' | 'unknown';
export type PersonalFinanceSourceTransactionType = 'payment' | 'transfer' | 'top_up' | 'withdrawal' | 'fee' | 'other' | 'unknown';

export interface PersonalFinanceImportFile {
    readonly id: string;
    readonly originalFileName: string;
    readonly fileSize: string;
    readonly mimeType: string;
    readonly fileExtension: string;
    readonly contentState: 'pending' | 'available' | 'missing' | 'failed' | 'deleted';
    readonly createdUnixTime: number;
    readonly updatedUnixTime: number;
    readonly contentDeletedUnixTime?: number;
}

export interface PersonalFinanceBatchIssue {
    readonly code: string;
    readonly severity: 'info' | 'warning' | 'error';
    readonly field?: string;
}

export interface PersonalFinanceImportBatch {
    readonly id: string;
    readonly fileId: string;
    readonly sourceAccountId?: string;
    readonly status: PersonalFinanceBatchStatus;
    readonly sourceType: PersonalFinanceSourceType;
    readonly ledgerAccountId?: string;
    readonly parserName: string;
    readonly parserVersion: string;
    readonly normalizationVersion: string;
    readonly identityKeyVersion: string;
    readonly coreDigestVersion: string;
    readonly fingerprintVersion: string;
    readonly rawSnapshotVersion: string;
    readonly reparseReasonCode: string;
    readonly statementStartUnixTime?: number;
    readonly statementEndUnixTime?: number;
    readonly statementTimezoneUtcOffset?: number;
    readonly statementDate?: string;
    readonly dueDate?: string;
    readonly creditLimitAmount?: string;
    readonly creditLimitCurrency?: string;
    readonly totalRowCount: number;
    readonly validRowCount: number;
    readonly invalidRowCount: number;
    readonly exactDuplicateRowCount: number;
    readonly identityConflictRowCount: number;
    readonly pendingRowCount: number;
    readonly postedRowCount: number;
    readonly errorCode: string;
    readonly errorSummary: string;
    readonly createdUnixTime: number;
    readonly startedUnixTime?: number;
    readonly completedUnixTime?: number;
    readonly updatedUnixTime: number;
    readonly file?: PersonalFinanceImportFile;
    readonly issues?: PersonalFinanceBatchIssue[];
}

export interface PersonalFinanceImportBatchPage {
    readonly items: PersonalFinanceImportBatch[];
    readonly totalCount: number;
}

export interface PersonalFinanceImportRow {
    readonly id: string;
    readonly batchId: string;
    readonly rowNumber: number;
    readonly sourceLocator: string;
    readonly identityId?: string;
    readonly rawTransactionTime: string;
    readonly rawAmount: string;
    readonly rawDirection: string;
    readonly rawStatus: string;
    readonly rawTransactionType: string;
    readonly rawCounterparty: string;
    readonly rawItem: string;
    readonly rawPaymentMethod: string;
    readonly normalizedUnixTime?: number;
    readonly normalizedTimezoneUtcOffset?: number;
    readonly normalizedAmount?: string;
    readonly currency: string;
    readonly normalizedDirection: PersonalFinanceNormalizedDirection;
    readonly normalizedTransactionType: PersonalFinanceSourceTransactionType;
    readonly economicEffect: 'normal' | 'refund' | 'closed' | 'failed' | 'unknown';
    readonly ledgerAccountId?: string;
    readonly primaryIssueCode: string;
    readonly semanticEligibility: PersonalFinanceDisposition;
    readonly parseState: PersonalFinanceParseState;
    readonly identityState: PersonalFinanceIdentityState;
    readonly disposition: PersonalFinanceDisposition;
    readonly processingState: PersonalFinanceProcessingState;
    readonly createdUnixTime: number;
}

export interface PersonalFinanceImportRowPage {
    readonly batch: PersonalFinanceImportBatch;
    readonly items: PersonalFinanceImportRow[];
    readonly totalCount: number;
}

export interface PersonalFinanceImportUploadResult {
    readonly file: PersonalFinanceImportFile;
    readonly latestBatch?: PersonalFinanceImportBatch;
    readonly duplicate: boolean;
    readonly recovered: boolean;
}

export interface PersonalFinanceSourceAccount {
    readonly id: string;
    readonly sourceType: PersonalFinanceSourceType;
    readonly ledgerAccountId?: string;
    readonly status: 'active' | 'disabled';
    readonly displayName: string;
    readonly discoveryMethod: string;
    readonly createdUnixTime: number;
    readonly updatedUnixTime: number;
}

export interface PersonalFinanceSourceAccountPage {
    readonly items: PersonalFinanceSourceAccount[];
}

export interface PersonalFinancePaymentAccountGroup {
    readonly sourceType: PersonalFinanceSourceType;
    readonly currency: string;
    readonly displayName: string;
    readonly rowCount: number;
    readonly pendingRowCount: number;
    readonly sampleRowId: string;
    readonly ledgerAccountId?: string;
    readonly mapped: boolean;
    readonly excluded?: boolean;
}

export interface PersonalFinancePaymentAccountPage {
    readonly items: PersonalFinancePaymentAccountGroup[];
}

export interface PersonalFinancePaymentAccountConfirmRequest {
    readonly batchId: string;
    readonly rowId: string;
    readonly ledgerAccountId: string;
}

export interface PersonalFinancePaymentAccountExcludeRequest {
    readonly batchId: string;
    readonly rowId: string;
}

export interface PersonalFinanceSourceAccountDiscovery {
    readonly sourceType: PersonalFinanceSourceType;
    readonly evidenceKind: 'stable_identifier' | 'masked_display_only' | 'display_only' | 'missing';
    readonly displayName: string;
    readonly discoveryMethod: string;
}

export interface PersonalFinanceReparseRequest {
    readonly fileId: string;
    readonly sourceAccountId?: string;
    readonly parserName?: string;
    readonly currency: string;
    readonly timezoneUtcOffset: number;
    readonly reasonCode: string;
    readonly genericBankMapping?: PersonalFinanceGenericBankMapping;
}

export type PersonalFinanceGenericCsvEncoding = 'utf8' | 'gb18030' | 'gbk';
export type PersonalFinanceGenericCsvDelimiter = 'comma' | 'tab';
export type PersonalFinanceGenericCsvAmountMode = 'signed' | 'amount_direction' | 'income_expense';
export type PersonalFinanceGenericCsvTimeFormat =
    '2006-01-02 15:04:05' |
    '2006-01-02 15:04' |
    '2006/01/02 15:04:05' |
    '2006/01/02 15:04' |
    '2006-01-02' |
    '2006/01/02';

export interface PersonalFinanceGenericBankMapping {
    readonly encoding: PersonalFinanceGenericCsvEncoding;
    readonly delimiter: PersonalFinanceGenericCsvDelimiter;
	readonly sheetIndex: number;
    readonly headerRow: number;
    readonly timeFormat: PersonalFinanceGenericCsvTimeFormat;
    readonly amountMode: PersonalFinanceGenericCsvAmountMode;
    readonly signedPositiveDirection: 'income' | 'expense' | '';
    readonly timeColumn: number;
    readonly amountColumn: number;
    readonly directionColumn: number;
    readonly incomeColumn: number;
    readonly expenseColumn: number;
    readonly currencyColumn: number;
    readonly transactionIdColumn: number;
    readonly orderIdColumn: number;
    readonly merchantOrderIdColumn: number;
    readonly counterpartyColumn: number;
    readonly itemColumn: number;
    readonly paymentMethodColumn: number;
    readonly statusColumn: number;
    readonly transactionTypeColumn: number;
    readonly noteColumn: number;
    readonly incomeValues: string[];
    readonly expenseValues: string[];
}

export interface PersonalFinanceGenericBankMappingForm {
    encoding: PersonalFinanceGenericCsvEncoding;
    delimiter: PersonalFinanceGenericCsvDelimiter;
	sheetNumber: number | null;
    headerRow: number | null;
    timeFormat: PersonalFinanceGenericCsvTimeFormat;
    amountMode: PersonalFinanceGenericCsvAmountMode;
    signedPositiveDirection: 'income' | 'expense';
    timeColumn: number | null;
    amountColumn: number | null;
    directionColumn: number | null;
    incomeColumn: number | null;
    expenseColumn: number | null;
    currencyColumn: number | null;
    transactionIdColumn: number | null;
    orderIdColumn: number | null;
    merchantOrderIdColumn: number | null;
    counterpartyColumn: number | null;
    itemColumn: number | null;
    paymentMethodColumn: number | null;
    statusColumn: number | null;
    transactionTypeColumn: number | null;
    noteColumn: number | null;
    incomeValues: string[];
    expenseValues: string[];
}

export interface PersonalFinanceReparseResult {
    readonly batch?: PersonalFinanceImportBatch;
    readonly sourceAccount?: PersonalFinanceSourceAccount;
    readonly discovery?: PersonalFinanceSourceAccountDiscovery;
    readonly requiresSourceAccount: boolean;
    readonly parserName: string;
    readonly sourceType: PersonalFinanceSourceType;
    readonly format: string;
}

export interface PersonalFinanceSourceAccountSaveRequest {
    readonly id?: string;
    readonly sourceType: PersonalFinanceSourceType;
    readonly displayName: string;
    readonly ledgerAccountId: string;
    readonly status: 'active' | 'disabled';
}

export interface PersonalFinancePostingDraft {
    readonly type: TransactionType;
    readonly categoryId: string;
    readonly time: number;
    readonly utcOffset: number;
    readonly sourceAccountId: string;
    readonly destinationAccountId: string;
    readonly sourceAmount: number;
    readonly destinationAmount: number;
    readonly hideAmount: boolean;
    readonly tagIds: string[];
    readonly comment: string;
}

export interface PersonalFinancePostingRequest {
    readonly batchId: string;
    readonly idempotencyKey: string;
    readonly commands: Array<{
        readonly rowIds: string[];
        readonly draft?: PersonalFinancePostingDraft;
    }>;
}

export interface PersonalFinancePostingResult {
    readonly id: string;
    readonly batchId: string;
    readonly status: 'ready' | 'posting' | 'completed' | 'failed';
    readonly selectedRowCount: number;
    readonly createdTransactionCount: number;
    readonly reusedTransactionCount: number;
    readonly createdUnixTime: number;
    readonly startedUnixTime?: number;
    readonly completedUnixTime?: number;
    readonly failedUnixTime?: number;
    readonly replayed: boolean;
}

export interface PersonalFinanceEvidenceItem {
    readonly rowId: string;
    readonly batchId: string;
    readonly fileId: string;
    readonly rowNumber: number;
    readonly sourceType: PersonalFinanceSourceType;
    readonly fileExtension: string;
    readonly normalizedUnixTime?: number;
    readonly normalizedTimezoneUtcOffset?: number;
    readonly normalizedAmount?: string;
    readonly currency: string;
    readonly normalizedDirection: PersonalFinanceNormalizedDirection;
    readonly normalizedTransactionType: PersonalFinanceSourceTransactionType;
    readonly economicEffect: string;
    readonly primaryIssueCode: string;
    readonly parseState: PersonalFinanceParseState;
    readonly identityState: PersonalFinanceIdentityState;
    readonly disposition: PersonalFinanceDisposition;
    readonly processingState: PersonalFinanceProcessingState;
    readonly relationRole: 'primary' | 'transfer_counterpart';
    readonly creationMethod: 'posting_created' | 'exact_identity_reused';
    readonly ruleVersion: string;
    readonly transactionUpdatedUnixTime: number;
    readonly linkedUnixTime: number;
}

export interface PersonalFinanceEvidenceResult {
    readonly transactionId: string;
    readonly items: PersonalFinanceEvidenceItem[];
}

export interface PersonalFinanceUndoImpact {
	readonly batchId: string;
	readonly linkedTransactionCount: number;
	readonly postingCreatedCount: number;
	readonly postingReusedCount: number;
	readonly modifiedTransactionCount: number;
	readonly missingTransactionCount: number;
	readonly sharedTransactionCount: number;
	readonly reasonCodes: string[];
}

export interface PersonalFinanceConsistencyReport {
	readonly importFileCount: number;
	readonly importBatchCount: number;
	readonly rawImportRowCount: number;
	readonly batchCountMismatchCount: number;
	readonly orphanBatchCount: number;
	readonly orphanRawRowCount: number;
	readonly orphanSourceIdentityCount: number;
	readonly orphanPostingCount: number;
	readonly orphanBatchIssueCount: number;
	readonly orphanEvidenceLinkCount: number;
	readonly missingOrDeletedTransactionCount: number;
	readonly fileContentMismatchCount: number;
	readonly fileContentCheckFailureCount: number;
}
