import type {
    ReconciliationCaseStatus,
    ReconciliationDecisionType
} from './models.ts';

const caseStatusKeys: Record<ReconciliationCaseStatus, string> = {
    open: 'personalFinance.reconciliation.status.open',
    resolved: 'personalFinance.reconciliation.status.resolved',
    action_required: 'personalFinance.reconciliation.status.actionRequired',
    deferred: 'personalFinance.reconciliation.status.deferred'
};

const decisionTypeKeys: Record<ReconciliationDecisionType | 'reopen', string> = {
    same_event: 'personalFinance.reconciliation.decision.sameEvent',
    internal_transfer: 'personalFinance.reconciliation.decision.internalTransfer',
    refund_reversal: 'personalFinance.reconciliation.decision.refundReversal',
    independent: 'personalFinance.reconciliation.decision.independent',
    defer: 'personalFinance.reconciliation.decision.defer',
    reopen: 'personalFinance.reconciliation.decision.reopen'
};

const reasonKeys: Record<string, string> = {
    amount_currency_exact: 'personalFinance.reconciliation.reason.amountCurrencyExact',
    identifier_match: 'personalFinance.reconciliation.reason.identifierMatch',
    ledger_account_match: 'personalFinance.reconciliation.reason.ledgerAccountMatch',
    opposite_direction: 'personalFinance.reconciliation.reason.oppositeDirection',
    payment_method_match: 'personalFinance.reconciliation.reason.paymentMethodMatch',
    refund_signal: 'personalFinance.reconciliation.reason.refundSignal',
    same_direction: 'personalFinance.reconciliation.reason.sameDirection',
    text_similarity: 'personalFinance.reconciliation.reason.textSimilarity',
    time_distance_seconds: 'personalFinance.reconciliation.reason.timeDistance',
    time_proximity: 'personalFinance.reconciliation.reason.timeProximity',
    transfer_signal: 'personalFinance.reconciliation.reason.transferSignal',
    transaction_modified: 'personalFinance.reconciliation.reason.transactionModified',
    transaction_missing: 'personalFinance.reconciliation.reason.transactionMissing',
    shared_dependency: 'personalFinance.reconciliation.reason.sharedDependency',
    multiple_ledger_events: 'personalFinance.reconciliation.reason.multipleLedgerEvents',
    transfer_pair_incomplete: 'personalFinance.reconciliation.reason.transferPairIncomplete',
    loan_dependency: 'personalFinance.reconciliation.reason.loanDependency',
    other_active_case: 'personalFinance.reconciliation.reason.otherActiveCase'
};

export function getReconciliationCaseStatusKey(status: ReconciliationCaseStatus): string {
    return caseStatusKeys[status];
}

export function getReconciliationCaseStatusColor(status: ReconciliationCaseStatus): string {
    if (status === 'resolved') {
        return 'success';
    }
    if (status === 'action_required') {
        return 'error';
    }
    if (status === 'deferred') {
        return 'warning';
    }
    return 'primary';
}

export function getReconciliationDecisionTypeKey(decisionType: ReconciliationDecisionType | 'reopen'): string {
    return decisionTypeKeys[decisionType];
}

export function getReconciliationReasonKey(code: string): string {
    return reasonKeys[code] ?? 'personalFinance.reconciliation.reason.unknown';
}
