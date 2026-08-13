import type {
    ReconciliationCaseDetail,
    ReconciliationCaseStatus,
    ReconciliationDecisionRequest,
    ReconciliationDecisionType,
    ReconciliationUndoRequest
} from './models.ts';

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
    return !!reconciliationCase && reconciliationCase.status !== 'resolved';
}

export function canInspectReconciliationUndo(reconciliationCase: ReconciliationCaseDetail | null): boolean {
    return !!reconciliationCase?.currentDecision && reconciliationCase.status !== 'open';
}

export function buildReconciliationDecisionRequest(params: {
    reconciliationCase: ReconciliationCaseDetail;
    decisionType: ReconciliationDecisionType;
    idempotencyKey: string;
}): ReconciliationDecisionRequest {
    if (!reconciliationDecisionTypes.includes(params.decisionType) || params.reconciliationCase.version < 1 || !params.idempotencyKey) {
        throw new Error('invalid_reconciliation_decision');
    }

    return {
        caseId: params.reconciliationCase.id,
        expectedCaseVersion: params.reconciliationCase.version,
        idempotencyKey: params.idempotencyKey,
        decisionType: params.decisionType
    };
}

export function buildReconciliationUndoRequest(params: {
    reconciliationCase: ReconciliationCaseDetail;
    idempotencyKey: string;
}): ReconciliationUndoRequest {
    if (!params.reconciliationCase.currentDecision || params.reconciliationCase.version < 1 || !params.idempotencyKey) {
        throw new Error('invalid_reconciliation_undo');
    }

    return {
        caseId: params.reconciliationCase.id,
        expectedCaseVersion: params.reconciliationCase.version,
        idempotencyKey: params.idempotencyKey
    };
}
