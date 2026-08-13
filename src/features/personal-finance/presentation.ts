import type {
    PersonalFinanceBatchStatus,
    PersonalFinanceIdentityState,
    PersonalFinanceImportRow,
    PersonalFinanceSourceType
} from './models.ts';

const batchStatusKeys: Record<PersonalFinanceBatchStatus, string> = {
    receiving: 'personalFinance.status.receiving',
    parsing: 'personalFinance.status.parsing',
    awaiting_source_account: 'personalFinance.status.awaitingSourceAccount',
    ready: 'personalFinance.status.ready',
    posting: 'personalFinance.status.posting',
    partially_posted: 'personalFinance.status.partiallyPosted',
    completed: 'personalFinance.status.completed',
    failed: 'personalFinance.status.failed',
    discarded: 'personalFinance.status.discarded'
};

const identityStateKeys: Record<PersonalFinanceIdentityState, string> = {
    not_evaluated: 'personalFinance.identity.notEvaluated',
    new: 'personalFinance.identity.new',
    exact_duplicate: 'personalFinance.identity.exactDuplicate',
    identity_conflict: 'personalFinance.identity.conflict',
    batch_local: 'personalFinance.identity.batchLocal'
};

export function getBatchStatusKey(status: PersonalFinanceBatchStatus): string {
    return batchStatusKeys[status];
}

export function getBatchStatusColor(status: PersonalFinanceBatchStatus): string {
    if (status === 'completed') {
        return 'success';
    }

    if (status === 'failed' || status === 'discarded') {
        return 'error';
    }

    if (status === 'ready' || status === 'partially_posted') {
        return 'primary';
    }

    return 'secondary';
}

export function getSourceTypeKey(sourceType: PersonalFinanceSourceType): string {
    return sourceType === 'alipay' ? 'personalFinance.source.alipay' : 'personalFinance.source.wechat';
}

export function getIdentityStateKey(identityState: PersonalFinanceIdentityState): string {
    return identityStateKeys[identityState];
}

export function getRowExplanationKey(row: PersonalFinanceImportRow): string {
    if (row.processingState === 'linked') {
        return 'personalFinance.row.linkedExplanation';
    }

    if (row.parseState === 'invalid') {
        return 'personalFinance.row.invalidExplanation';
    }

    if (row.identityState === 'identity_conflict') {
        return 'personalFinance.row.conflictExplanation';
    }

    if (row.identityState === 'exact_duplicate') {
        return 'personalFinance.row.duplicateExplanation';
    }

    if (row.identityState === 'batch_local' || row.disposition === 'review_required') {
        return 'personalFinance.row.reviewExplanation';
    }

    if (row.disposition === 'non_postable') {
        return 'personalFinance.row.nonPostableExplanation';
    }

    return 'personalFinance.row.newExplanation';
}
