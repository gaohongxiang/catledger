import services from '@/lib/services.ts';

import type {
    ReconciliationCandidateGenerateResult,
    ReconciliationCaseDetail,
    ReconciliationCaseMember,
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
        reasonCodes: normalizeReasons(field(value, 'reasonCodes', 'reasons')),
        createdUnixTime: asNumber(field(value, 'createdUnixTime')),
        lastEvaluatedUnixTime: asNumber(field(value, 'lastEvaluatedUnixTime')),
        updatedUnixTime: asNumber(field(value, 'updatedUnixTime'))
    };
}

function normalizeMember(value: unknown, index: number): ReconciliationCaseMember | null {
    if (!isRecord(value)) {
        return null;
    }

    const sourceTypeValue = field(value, 'sourceType', 'source');
    if (sourceTypeValue !== 'alipay' && sourceTypeValue !== 'wechat' && sourceTypeValue !== 'bank') {
        return null;
    }
    const sourceType = sourceTypeValue;
    const directionValue = field(value, 'normalizedDirection', 'direction');
    const normalizedDirection = directionValue === 'income' || directionValue === 'expense' || directionValue === 'neutral'
        ? directionValue
        : 'unknown';
    const processingStateValue = field(value, 'processingState');
    const processingState = processingStateValue === 'pending' || processingStateValue === 'linked' || processingStateValue === 'ignored' || processingStateValue === 'failed'
        ? processingStateValue
        : undefined;

    return {
        order: asNumber(field(value, 'order', 'memberOrder'), index + 1),
        role: asString(field(value, 'role', 'memberRole'), 'evidence'),
        sourceType,
        sourceDisplayName: asString(field(value, 'sourceDisplayName', 'sourceAccountDisplayName', 'maskedSourceAccountName')),
        normalizedAmount: asString(field(value, 'normalizedAmount', 'amount')) || undefined,
        currency: asString(field(value, 'currency')),
        normalizedDirection,
        normalizedUnixTime: asNumber(field(value, 'normalizedUnixTime', 'transactionUnixTime')) || undefined,
        normalizedTimezoneUtcOffset: asNumber(field(value, 'normalizedTimezoneUtcOffset', 'timezoneUtcOffset')) || undefined,
        counterparty: asString(field(value, 'counterparty', 'counterpartySummary')),
        item: asString(field(value, 'item', 'itemSummary', 'description')),
        paymentMethod: asString(field(value, 'paymentMethod', 'paymentMethodSummary')),
        economicEffect: asString(field(value, 'economicEffect'), 'unknown'),
        processingState
    };
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
    const membersValue = field(value, 'members', 'evidenceMembers') ?? field(caseValue, 'members', 'evidenceMembers');
    const decisionValue = field(value, 'currentDecision', 'decision') ?? field(caseValue, 'currentDecision', 'decision');

    return {
        ...summary,
        members: asArray(membersValue).map(normalizeMember).filter((member): member is ReconciliationCaseMember => !!member),
        currentDecision: normalizeDecision(decisionValue)
    };
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
    const decision = normalizeDecision(field(value, 'decision', 'currentDecision') ?? value) ?? reconciliationCase?.currentDecision;
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

    async listCases(params: { status?: ReconciliationCaseStatus, page: number, count: number }): Promise<ReconciliationCasePage> {
        const result = unwrapApiResponse(await services.listPersonalFinanceReconciliationCases(params));
        if (!isRecord(result)) {
            throw new Error('invalid_reconciliation_case_page');
        }
        const items = asArray(field(result, 'items', 'cases')).map(normalizeReconciliationCaseSummary);
        return {
            items,
            totalCount: asNumber(field(result, 'totalCount'), items.length),
            pendingCount: asNumber(field(result, 'pendingCount', 'openCount'), items.filter(item => item.status !== 'resolved').length)
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
            expectedCaseVersion: asNumber(field(result, 'expectedCaseVersion', 'caseVersion')),
            automaticUndoAllowed: asBoolean(field(result, 'automaticUndoAllowed', 'canAutomaticallyUndo', 'canUndo')),
            affectedTransactionCount: asNumber(field(result, 'affectedTransactionCount', 'linkedTransactionCount')),
            createdTransactionCount: asNumber(field(result, 'createdTransactionCount', 'reconciliationCreatedCount')),
            attachedExistingTransactionCount: asNumber(field(result, 'attachedExistingTransactionCount', 'attachedExistingCount')),
            modifiedTransactionCount: asNumber(field(result, 'modifiedTransactionCount')),
            missingTransactionCount: asNumber(field(result, 'missingTransactionCount')),
            sharedDependencyCount: asNumber(field(result, 'sharedDependencyCount', 'sharedTransactionCount')),
            reasonCodes: normalizeReasons(field(result, 'reasonCodes', 'blockingReasonCodes'))
        };
    },

    async undo(request: ReconciliationUndoRequest): Promise<ReconciliationUndoResult> {
        return normalizeDecisionResult(unwrapApiResponse(await services.undoPersonalFinanceReconciliationCase(request)));
    }
};
