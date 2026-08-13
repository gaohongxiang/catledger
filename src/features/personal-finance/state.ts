import { TransactionType } from '@/core/transaction.ts';

import type {
	PersonalFinanceImportBatch,
	PersonalFinanceImportFile,
    PersonalFinanceImportRow,
    PersonalFinanceImportUploadResult,
    PersonalFinancePostingDraft,
    PersonalFinancePostingRequest,
    PersonalFinanceSourceAccount,
    PersonalFinanceSourceType
} from './models.ts';

export type PersonalFinanceUploadAction = 'reparse' | 'choose_duplicate_action';
export type PersonalFinanceRowAction = 'create' | 'create_or_reuse' | 'blocked';

export function canDiscardImportBatch(batch: PersonalFinanceImportBatch | null): boolean {
	return !!batch && (batch.status === 'awaiting_source_account' || batch.status === 'ready') && batch.postedRowCount === 0;
}

export function canDeleteImportFileContent(file: PersonalFinanceImportFile | undefined): boolean {
	return !!file && file.contentState !== 'pending' && file.contentState !== 'deleted';
}

export function getUploadAction(result: PersonalFinanceImportUploadResult): PersonalFinanceUploadAction {
    if (result.duplicate && result.latestBatch) {
        return 'choose_duplicate_action';
    }

    return 'reparse';
}

export function getCompatibleSourceAccounts(
    accounts: PersonalFinanceSourceAccount[],
    sourceType: PersonalFinanceSourceType
): PersonalFinanceSourceAccount[] {
    return accounts.filter(account => account.sourceType === sourceType && account.status === 'active');
}

export function getRowAction(row: PersonalFinanceImportRow): PersonalFinanceRowAction {
    if (row.parseState !== 'valid' || row.processingState !== 'pending' || !row.identityId ||
        (row.disposition !== 'postable' && row.disposition !== 'review_required') ||
        row.identityState === 'identity_conflict' || row.identityState === 'not_evaluated') {
        return 'blocked';
    }

    if (row.identityState === 'exact_duplicate') {
        return 'create_or_reuse';
    }

    if (row.identityState === 'new' || row.identityState === 'batch_local') {
        return 'create';
    }

    return 'blocked';
}

export function getSuggestedTransactionType(row: PersonalFinanceImportRow): TransactionType {
    if (row.normalizedDirection === 'income') {
        return TransactionType.Income;
    }

    return TransactionType.Expense;
}

export function buildSingleRowPostingRequest(
    row: PersonalFinanceImportRow,
    idempotencyKey: string,
    draft?: PersonalFinancePostingDraft
): PersonalFinancePostingRequest {
    const action = getRowAction(row);

    if (action === 'blocked' || !idempotencyKey || !draft) {
        throw new Error('invalid personal finance row posting request');
    }

    return {
        batchId: row.batchId,
        idempotencyKey,
        commands: [{
            rowIds: [row.id],
            draft
        }]
    };
}
