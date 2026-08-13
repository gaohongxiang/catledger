import { ref } from 'vue';
import { defineStore } from 'pinia';

import services, { type ApiResponsePromise } from '@/lib/services.ts';
import { generateRandomUUID } from '@/lib/misc.ts';

import type {
    PersonalFinanceImportBatch,
    PersonalFinanceImportBatchPage,
    PersonalFinanceImportRow,
    PersonalFinanceImportRowPage,
    PersonalFinanceImportUploadResult,
    PersonalFinancePostingDraft,
    PersonalFinancePostingResult,
    PersonalFinanceReparseResult,
    PersonalFinanceSourceAccount,
    PersonalFinanceSourceAccountPage,
    PersonalFinanceSourceAccountSaveRequest
} from './models.ts';
import { buildSingleRowPostingRequest } from './state.ts';

async function unwrapResponse<T>(request: ApiResponsePromise<T>, fallbackMessage: string): Promise<T> {
    const response = await request;
    const data = response.data;

    if (!data || !data.success || typeof data.result === 'undefined' || data.result === null) {
        throw new Error(fallbackMessage);
    }

    return data.result;
}

export const usePersonalFinanceStore = defineStore('personalFinance', () => {
    const batches = ref<PersonalFinanceImportBatch[]>([]);
    const totalBatchCount = ref<number>(0);
    const selectedBatch = ref<PersonalFinanceImportBatch | null>(null);
    const rows = ref<PersonalFinanceImportRow[]>([]);
    const totalRowCount = ref<number>(0);
    const sourceAccounts = ref<PersonalFinanceSourceAccount[]>([]);
    const loadingBatches = ref<boolean>(false);
    const loadingRows = ref<boolean>(false);
    const submitting = ref<boolean>(false);

    async function loadBatches(page = 0, count = 20): Promise<PersonalFinanceImportBatchPage> {
        loadingBatches.value = true;

        try {
            const result = await unwrapResponse(
                services.listPersonalFinanceImportBatches({ page, count }),
                'Unable to retrieve personal finance import history'
            );
            batches.value = result.items;
            totalBatchCount.value = result.totalCount;
            return result;
        } finally {
            loadingBatches.value = false;
        }
    }

    async function openBatch(batchId: string, rowPage = 0, rowCount = 25): Promise<PersonalFinanceImportRowPage> {
        loadingRows.value = true;

        try {
            const [batch, rowPageResult] = await Promise.all([
                unwrapResponse(
                    services.getPersonalFinanceImportBatch({ batchId }),
                    'Unable to retrieve personal finance import batch'
                ),
                unwrapResponse(
                    services.listPersonalFinanceImportRows({ batchId, page: rowPage, count: rowCount }),
                    'Unable to retrieve personal finance import rows'
                )
            ]);
            selectedBatch.value = batch;
            rows.value = rowPageResult.items;
            totalRowCount.value = rowPageResult.totalCount;
            return rowPageResult;
        } finally {
            loadingRows.value = false;
        }
    }

    async function uploadFile(file: File): Promise<PersonalFinanceImportUploadResult> {
        submitting.value = true;

        try {
            return await unwrapResponse(
                services.uploadPersonalFinanceImportFile({ file }),
                'Unable to upload personal finance import file'
            );
        } finally {
            submitting.value = false;
        }
    }

    async function reparseFile(params: {
        fileId: string;
        sourceAccountId?: string;
        currency: string;
        timezoneUtcOffset: number;
        reasonCode?: string;
    }): Promise<PersonalFinanceReparseResult> {
        submitting.value = true;

        try {
            const result = await unwrapResponse(
                services.reparsePersonalFinanceImportFile({
                    fileId: params.fileId,
                    sourceAccountId: params.sourceAccountId,
                    currency: params.currency,
                    timezoneUtcOffset: params.timezoneUtcOffset,
                    reasonCode: params.reasonCode ?? 'user_requested'
                }),
                'Unable to parse personal finance import file'
            );

            if (result.batch) {
                await Promise.allSettled([
                    loadBatches(),
                    openBatch(result.batch.id)
                ]);
            }

            return result;
        } finally {
            submitting.value = false;
        }
    }

    async function loadSourceAccounts(): Promise<PersonalFinanceSourceAccount[]> {
        const result: PersonalFinanceSourceAccountPage = await unwrapResponse(
            services.listPersonalFinanceSourceAccounts(),
            'Unable to retrieve personal finance source accounts'
        );
        sourceAccounts.value = result.items;
        return result.items;
    }

    async function saveSourceAccount(request: PersonalFinanceSourceAccountSaveRequest): Promise<PersonalFinanceSourceAccount> {
        const result = await unwrapResponse(
            services.savePersonalFinanceSourceAccount(request),
            'Unable to save personal finance source account'
        );
        const existingIndex = sourceAccounts.value.findIndex(account => account.id === result.id);

        if (existingIndex >= 0) {
            sourceAccounts.value.splice(existingIndex, 1, result);
        } else {
            sourceAccounts.value.push(result);
        }

        await loadSourceAccounts().catch(() => undefined);
        return result;
    }

    async function postRow(row: PersonalFinanceImportRow, draft?: PersonalFinancePostingDraft): Promise<PersonalFinancePostingResult> {
        submitting.value = true;

        try {
            const result = await unwrapResponse(
                services.postPersonalFinanceImportBatch(
                    buildSingleRowPostingRequest(row, `pf-ui-v1:${generateRandomUUID()}`, draft)
                ),
                'Unable to post personal finance import row'
            );
            await Promise.allSettled([
                loadBatches(),
                openBatch(row.batchId)
            ]);
            return result;
        } finally {
            submitting.value = false;
        }
    }

    function clearSelection(): void {
        selectedBatch.value = null;
        rows.value = [];
        totalRowCount.value = 0;
    }

    return {
        batches,
        totalBatchCount,
        selectedBatch,
        rows,
        totalRowCount,
        sourceAccounts,
        loadingBatches,
        loadingRows,
        submitting,
        loadBatches,
        openBatch,
        uploadFile,
        reparseFile,
        loadSourceAccounts,
        saveSourceAccount,
        postRow,
        clearSelection
    };
});
