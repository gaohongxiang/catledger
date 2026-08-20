import services from '@/lib/services.ts';

import type {
    ReconciliationCandidateGenerateResult,
    ReconciliationCaseCursor,
    ReconciliationCaseDetail,
    ReconciliationEvidenceCard,
    ReconciliationCasePage,
    ReconciliationCaseStatus,
    ReconciliationCaseSummary,
    ReconciliationDecision,
    ReconciliationDecisionRequest,
    ReconciliationDecisionResult,
    ReconciliationDecisionStatus,
    ReconciliationDecisionType,
    ReconciliationReason,
    ReconciliationUndoImpact,
    ReconciliationUndoRequest,
    ReconciliationUndoResult
} from './models.ts';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function field(record: UnknownRecord, ...keys: string[]): unknown {
    for (const key of keys) {
        if (typeof record[key] !== 'undefined') {
            return record[key];
        }
    }
    return undefined;
}

function asString(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function asIdentifier(value: unknown): string {
    if (typeof value === 'string' && value.length > 0) {
        return value;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
        return String(value);
    }
    return '';
}

function asNumber(value: unknown, fallback = 0): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.length > 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
}

function asOptionalNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.length > 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

function asBoolean(value: unknown, fallback = false): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function normalizeReasons(value: unknown): ReconciliationReason[] {
    return asArray(value).flatMap(item => {
        if (typeof item === 'string' && item) {
            return [{ code: item }];
        }
        if (!isRecord(item)) {
            return [];
        }

        const code = asString(field(item, 'code', 'reasonCode'));
        if (!code) {
            return [];
        }
        const rawValue = field(item, 'value', 'reasonValue');
        return typeof rawValue === 'undefined'
            ? [{ code }]
            : [{ code, value: asNumber(rawValue) }];
    });
}

function normalizeCaseStatus(value: unknown): ReconciliationCaseStatus {
    if (value === 'open' || value === 'resolved' || value === 'action_required' || value === 'deferred') {
        return value;
    }
    throw new Error('invalid_reconciliation_case_status');
}

function normalizeDecisionType(value: unknown): ReconciliationDecisionType {
    if (value === 'same_event' || value === 'internal_transfer' || value === 'refund_reversal' || value === 'independent' || value === 'defer') {
        return value;
    }
    throw new Error('invalid_reconciliation_decision_type');
}

function normalizeCurrentDecisionType(value: unknown): ReconciliationDecisionType | 'reopen' {
    if (value === 'reopen') {
        return value;
    }
    return normalizeDecisionType(value);
}

function normalizeDecisionStatus(value: unknown): ReconciliationDecisionStatus {
    if (value === 'ready' || value === 'applying' || value === 'applied' || value === 'action_required' || value === 'deferred' || value === 'failed') {
        return value;
    }
    throw new Error('invalid_reconciliation_decision_status');
}

export function normalizeReconciliationCaseSummary(value: unknown): ReconciliationCaseSummary {
    if (!isRecord(value)) {
        throw new Error('invalid_reconciliation_case');
    }

    const id = asIdentifier(field(value, 'id', 'caseId'));
    const version = asNumber(field(value, 'version', 'caseVersion'));
    if (!id || version < 1) {
        throw new Error('invalid_reconciliation_case');
    }

    return {
        id,
        status: normalizeCaseStatus(field(value, 'status')),
        version,
        suggestedRelationType: normalizeDecisionType(field(value, 'suggestedRelationType', 'suggestedDecisionType')),
        candidateScore: asNumber(field(value, 'candidateScore', 'score')),
        candidateRuleVersion: String(field(value, 'candidateRuleVersion') ?? ''),
        explanationVersion: String(field(value, 'explanationVersion') ?? ''),
        reasonCodes: normalizeReasons(field(value, 'reasonCodes', 'reasons')),
        currentDecisionId: asIdentifier(field(value, 'currentDecisionId')) || undefined,
        currentDecisionType: field(value, 'currentDecisionType') == null ? undefined : normalizeCurrentDecisionType(field(value, 'currentDecisionType')),
        currentDecisionStatus: field(value, 'currentDecisionStatus') == null ? undefined : normalizeDecisionStatus(field(value, 'currentDecisionStatus')),
        createdUnixTime: asNumber(field(value, 'createdUnixTime')),
        lastEvaluatedUnixTime: asNumber(field(value, 'lastEvaluatedUnixTime')),
        updatedUnixTime: asNumber(field(value, 'updatedUnixTime'))
    };
}

function normalizeEvidenceCard(value: unknown, member: UnknownRecord, evidenceIndex: number): ReconciliationEvidenceCard | null {
    if (!isRecord(value)) {
        return null;
    }

    const sourceTypeValue = field(member, 'sourceType');
    if (sourceTypeValue !== 'alipay' && sourceTypeValue !== 'wechat' && sourceTypeValue !== 'bank') {
        return null;
    }
    const directionValue = field(value, 'normalizedDirection');
    const normalizedDirection = directionValue === 'income' || directionValue === 'expense' || directionValue === 'neutral'
        ? directionValue
        : 'unknown';
    const processingStateValue = field(value, 'processingState');
    if (processingStateValue !== 'pending' && processingStateValue !== 'linked' && processingStateValue !== 'ignored' && processingStateValue !== 'failed') {
        return null;
    }
    const parseStateValue = field(value, 'parseState');
    const identityStateValue = field(value, 'identityState');
    const dispositionValue = field(value, 'disposition');
    const transactionTypeValue = field(value, 'normalizedTransactionType');
    const economicEffectValue = field(value, 'economicEffect');
    if ((parseStateValue !== 'valid' && parseStateValue !== 'invalid') ||
        (identityStateValue !== 'not_evaluated' && identityStateValue !== 'new' && identityStateValue !== 'exact_duplicate' &&
            identityStateValue !== 'identity_conflict' && identityStateValue !== 'batch_local') ||
        (dispositionValue !== 'postable' && dispositionValue !== 'review_required' && dispositionValue !== 'non_postable') ||
        (transactionTypeValue !== 'payment' && transactionTypeValue !== 'transfer' && transactionTypeValue !== 'top_up' &&
            transactionTypeValue !== 'withdrawal' && transactionTypeValue !== 'fee' && transactionTypeValue !== 'other' && transactionTypeValue !== 'unknown') ||
        (economicEffectValue !== 'normal' && economicEffectValue !== 'refund' && economicEffectValue !== 'closed' &&
            economicEffectValue !== 'failed' && economicEffectValue !== 'unknown')) {
        return null;
    }

    return {
        order: asNumber(field(member, 'order'), evidenceIndex + 1),
        kind: asString(field(member, 'kind')),
        role: asString(field(member, 'role')),
        sourceType: sourceTypeValue,
        maskedSourceAccount: asString(field(member, 'maskedSourceAccount')),
        evidenceLimitReached: asBoolean(field(member, 'evidenceLimitReached')),
        normalizedAmount: asString(field(value, 'normalizedAmount')),
        currency: asString(field(value, 'currency')),
        normalizedDirection,
        normalizedUnixTime: asNumber(field(value, 'normalizedUnixTime')),
        normalizedTimezoneUtcOffset: asNumber(field(value, 'normalizedTimezoneUtcOffset')),
        normalizedTransactionType: transactionTypeValue,
        economicEffect: economicEffectValue,
        parseState: parseStateValue,
        identityState: identityStateValue,
        disposition: dispositionValue,
        processingState: processingStateValue,
        transactionCount: asArray(field(value, 'transactions')).length
    };
}

function normalizeMemberEvidence(value: unknown): ReconciliationEvidenceCard[] {
    if (!isRecord(value)) {
        return [];
    }
    return asArray(field(value, 'evidence'))
        .map((evidence, evidenceIndex) => normalizeEvidenceCard(evidence, value, evidenceIndex))
        .filter((evidence): evidence is ReconciliationEvidenceCard => !!evidence);
}

function normalizeDecision(value: unknown): ReconciliationDecision | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const id = asIdentifier(field(value, 'id', 'decisionId'));
    const decisionTypeValue = field(value, 'decisionType', 'type');
    const decisionType = decisionTypeValue === 'reopen' ? 'reopen' : normalizeDecisionType(decisionTypeValue);
    if (!id) {
        return undefined;
    }

    return {
        id,
        decisionType,
        status: normalizeDecisionStatus(field(value, 'status')),
        appliedCaseVersion: asNumber(field(value, 'appliedCaseVersion')) || undefined,
        reasonCodes: normalizeReasons(field(value, 'reasonCodes', 'reasons')),
        errorCode: asString(field(value, 'errorCode')),
        createdUnixTime: asNumber(field(value, 'createdUnixTime')),
        updatedUnixTime: asNumber(field(value, 'updatedUnixTime'))
    };
}

export function normalizeReconciliationCaseDetail(value: unknown): ReconciliationCaseDetail {
    if (!isRecord(value)) {
        throw new Error('invalid_reconciliation_case_detail');
    }

    const caseValue = isRecord(value['case']) ? value['case'] : value;
    const summary = normalizeReconciliationCaseSummary(caseValue);
    const membersValue = field(caseValue, 'members');

    return {
        ...summary,
        evidence: asArray(membersValue).flatMap(normalizeMemberEvidence)
    };
}

function normalizeCursor(value: unknown): ReconciliationCaseCursor | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const updatedUnixTime = asOptionalNumber(field(value, 'updatedUnixTime'));
    const caseId = asIdentifier(field(value, 'caseId'));
    if (typeof updatedUnixTime === 'undefined' || !caseId) {
        throw new Error('invalid_reconciliation_case_cursor');
    }
    return { updatedUnixTime, caseId };
}

function unwrapApiResponse(response: unknown): unknown {
    if (!isRecord(response) || !isRecord(response['data']) || response['data']['success'] !== true || typeof response['data']['result'] === 'undefined' || response['data']['result'] === null) {
        throw new Error('invalid_reconciliation_response');
    }
    return response['data']['result'];
}

function normalizeDecisionResult(value: unknown): ReconciliationDecisionResult {
    if (!isRecord(value)) {
        throw new Error('invalid_reconciliation_decision_result');
    }

    const caseValue = field(value, 'case', 'reconciliationCase');
    const reconciliationCase = isRecord(caseValue) ? normalizeReconciliationCaseDetail(caseValue) : undefined;
    const decision = normalizeDecision(field(value, 'decision', 'currentDecision') ?? value);
    if (!decision) {
        throw new Error('invalid_reconciliation_decision_result');
    }

    return {
        case: reconciliationCase,
        decision,
        replayed: asBoolean(field(value, 'replayed'))
    };
}

export const reconciliationApi = {
    async generateCandidates(batchId: string): Promise<ReconciliationCandidateGenerateResult> {
        const result = unwrapApiResponse(await services.generatePersonalFinanceReconciliationCandidates({ batchId }));
        if (!isRecord(result)) {
            throw new Error('invalid_reconciliation_candidate_result');
        }
        return {
            cases: asArray(field(result, 'cases', 'items')).map(normalizeReconciliationCaseSummary),
            evaluatedAnchorCount: asNumber(field(result, 'evaluatedAnchorCount')),
            limitReached: asBoolean(field(result, 'limitReached'))
        };
    },

    async listCases(params: { status: ReconciliationCaseStatus, cursor?: ReconciliationCaseCursor, limit: number }): Promise<ReconciliationCasePage> {
        const result = unwrapApiResponse(await services.listPersonalFinanceReconciliationCases(params));
        if (!isRecord(result)) {
            throw new Error('invalid_reconciliation_case_page');
        }
        const items = asArray(field(result, 'items')).map(normalizeReconciliationCaseSummary);
        return {
            items,
            nextCursor: normalizeCursor(field(result, 'nextCursor'))
        };
    },

    async getCase(caseId: string): Promise<ReconciliationCaseDetail> {
        return normalizeReconciliationCaseDetail(unwrapApiResponse(await services.getPersonalFinanceReconciliationCase({ caseId })));
    },

    async decide(request: ReconciliationDecisionRequest): Promise<ReconciliationDecisionResult> {
        return normalizeDecisionResult(unwrapApiResponse(await services.decidePersonalFinanceReconciliationCase(request)));
    },

    async getUndoImpact(caseId: string): Promise<ReconciliationUndoImpact> {
        const result = unwrapApiResponse(await services.getPersonalFinanceReconciliationUndoImpact({ caseId }));
        if (!isRecord(result)) {
            throw new Error('invalid_reconciliation_undo_impact');
        }
        return {
            caseId: asIdentifier(field(result, 'caseId')) || caseId,
            decisionId: asIdentifier(field(result, 'decisionId')),
            attachedExistingCount: asNumber(field(result, 'attachedExistingCount')),
            reconciliationCreatedCount: asNumber(field(result, 'reconciliationCreatedCount')),
            transactionCount: asNumber(field(result, 'transactionCount')),
            modifiedTransactionCount: asNumber(field(result, 'modifiedTransactionCount')),
            missingTransactionCount: asNumber(field(result, 'missingTransactionCount')),
            sharedTransactionCount: asNumber(field(result, 'sharedTransactionCount')),
            batchRelationCount: asNumber(field(result, 'batchRelationCount')),
            incompleteTransferPairCount: asNumber(field(result, 'incompleteTransferPairCount')),
            canReopen: asBoolean(field(result, 'canReopen')),
            canAutomaticallyDelete: asBoolean(field(result, 'canAutomaticallyDelete')),
            reasonCodes: normalizeReasons(field(result, 'reasonCodes'))
        };
    },

    async undo(request: ReconciliationUndoRequest): Promise<ReconciliationUndoResult> {
        return normalizeDecisionResult(unwrapApiResponse(await services.undoPersonalFinanceReconciliationCase(request)));
    }
};
