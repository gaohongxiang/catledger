import { ref } from 'vue';
import { defineStore } from 'pinia';

import { generateRandomUUID } from '@/lib/misc.ts';

import { reconciliationApi } from './service.ts';
import { buildReconciliationDecisionRequest, buildReconciliationUndoRequest } from './state.ts';
import type {
    ReconciliationCandidateGenerateResult,
    ReconciliationCaseCursor,
    ReconciliationCaseDetail,
    ReconciliationCasePage,
    ReconciliationCaseStatus,
    ReconciliationCaseSummary,
    ReconciliationDecisionResult,
    ReconciliationDecisionType,
    ReconciliationUndoImpact,
    ReconciliationUndoResult
} from './models.ts';

export const useReconciliationStore = defineStore('personalFinanceReconciliation', () => {
    const cases = ref<ReconciliationCaseSummary[]>([]);
    const nextCursor = ref<ReconciliationCaseCursor | undefined>(undefined);
    const selectedCase = ref<ReconciliationCaseDetail | null>(null);
    const loadingCases = ref<boolean>(false);
    const loadingDetail = ref<boolean>(false);
    const submitting = ref<boolean>(false);

    async function loadCases(params: {
        status: ReconciliationCaseStatus;
        append?: boolean;
        limit?: number;
    }): Promise<ReconciliationCasePage> {
        loadingCases.value = true;
        try {
            const result = await reconciliationApi.listCases({
                status: params.status,
                cursor: params.append ? nextCursor.value : undefined,
                limit: params.limit ?? 100
            });
            cases.value = params.append ? [...cases.value, ...result.items] : result.items;
            nextCursor.value = result.nextCursor;
            return result;
        } finally {
            loadingCases.value = false;
        }
    }

    async function openCase(caseId: string): Promise<ReconciliationCaseDetail> {
        loadingDetail.value = true;
        try {
            const result = await reconciliationApi.getCase(caseId);
            selectedCase.value = result;
            return result;
        } finally {
            loadingDetail.value = false;
        }
    }

    async function generateCandidates(batchId: string): Promise<ReconciliationCandidateGenerateResult> {
        submitting.value = true;
        try {
            return await reconciliationApi.generateCandidates(batchId);
        } finally {
            submitting.value = false;
        }
    }

    async function decide(decisionType: ReconciliationDecisionType): Promise<ReconciliationDecisionResult> {
        if (!selectedCase.value) {
            throw new Error('reconciliation_case_required');
        }

        submitting.value = true;
        try {
            const result = await reconciliationApi.decide(buildReconciliationDecisionRequest({
                reconciliationCase: selectedCase.value,
                decisionType,
                idempotencyKey: `pf-rec-ui-v1:${generateRandomUUID()}`
            }));
            const refreshedCase = result.case ?? await reconciliationApi.getCase(selectedCase.value.id);
            selectedCase.value = refreshedCase;
            return { ...result, case: refreshedCase };
        } finally {
            submitting.value = false;
        }
    }

    async function getUndoImpact(): Promise<ReconciliationUndoImpact> {
        if (!selectedCase.value) {
            throw new Error('reconciliation_case_required');
        }
        return reconciliationApi.getUndoImpact(selectedCase.value.id);
    }

    async function undo(): Promise<ReconciliationUndoResult> {
        if (!selectedCase.value) {
            throw new Error('reconciliation_case_required');
        }

        submitting.value = true;
        try {
            const result = await reconciliationApi.undo(buildReconciliationUndoRequest({
                reconciliationCase: selectedCase.value,
                idempotencyKey: `pf-rec-undo-ui-v1:${generateRandomUUID()}`
            }));
            const refreshedCase = result.case ?? await reconciliationApi.getCase(selectedCase.value.id);
            selectedCase.value = refreshedCase;
            return { ...result, case: refreshedCase };
        } finally {
            submitting.value = false;
        }
    }

    function clearSelection(): void {
        selectedCase.value = null;
    }

    return {
        cases,
        nextCursor,
        selectedCase,
        loadingCases,
        loadingDetail,
        submitting,
        loadCases,
        openCase,
        generateCandidates,
        decide,
        getUndoImpact,
        undo,
        clearSelection
    };
});
