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
    PersonalFinancePaymentAccountConfirmRequest,
    PersonalFinancePaymentAccountExcludeRequest,
    PersonalFinancePaymentAccountGroup,
    PersonalFinancePaymentAccountPage,
    PersonalFinancePostingDraft,
    PersonalFinancePostingResult,
    PersonalFinanceUndoImpact,
    PersonalFinanceGenericCsvMapping,
    PersonalFinanceReparseResult,
    PersonalFinanceSourceAccount,
    PersonalFinanceSourceAccountPage,
    PersonalFinanceSourceAccountSaveRequest
} from './models.ts';
import { buildPersonalFinanceReparseRequest, buildSingleRowPostingRequest } from './state.ts';

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
    const paymentAccounts = ref<PersonalFinancePaymentAccountGroup[]>([]);
    const loadingBatches = ref<boolean>(false);
    const loadingRows = ref<boolean>(false);
    const loadingPaymentAccounts = ref<boolean>(false);
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
            const [batch, rowPageResult, paymentAccountPage] = await Promise.all([
                unwrapResponse(
                    services.getPersonalFinanceImportBatch({ batchId }),
                    'Unable to retrieve personal finance import batch'
                ),
                unwrapResponse(
                    services.listPersonalFinanceImportRows({ batchId, page: rowPage, count: rowCount }),
                    'Unable to retrieve personal finance import rows'
                ),
                unwrapResponse(
                    services.listPersonalFinancePaymentAccounts({ batchId }),
                    'Unable to retrieve personal finance payment accounts'
                )
            ]);
            selectedBatch.value = batch;
            rows.value = rowPageResult.items;
            totalRowCount.value = rowPageResult.totalCount;
            paymentAccounts.value = paymentAccountPage.items;
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
        parserName?: string;
        currency: string;
        timezoneUtcOffset: number;
        reasonCode?: string;
        genericCsvMapping?: PersonalFinanceGenericCsvMapping;
    }): Promise<PersonalFinanceReparseResult> {
        submitting.value = true;

        try {
            const result = await unwrapResponse(
                services.reparsePersonalFinanceImportFile(buildPersonalFinanceReparseRequest({
                    fileId: params.fileId,
                    sourceAccountId: params.sourceAccountId,
                    parserName: params.parserName,
                    currency: params.currency,
                    timezoneUtcOffset: params.timezoneUtcOffset,
                    reasonCode: params.reasonCode ?? 'user_requested',
                    genericCsvMapping: params.genericCsvMapping
                })),
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

    async function loadPaymentAccounts(batchId: string): Promise<PersonalFinancePaymentAccountGroup[]> {
        loadingPaymentAccounts.value = true;

        try {
            const result: PersonalFinancePaymentAccountPage = await unwrapResponse(
                services.listPersonalFinancePaymentAccounts({ batchId }),
                'Unable to retrieve personal finance payment accounts'
            );
            paymentAccounts.value = result.items;
            return result.items;
        } finally {
            loadingPaymentAccounts.value = false;
        }
    }

    async function confirmPaymentAccount(request: PersonalFinancePaymentAccountConfirmRequest): Promise<PersonalFinancePaymentAccountGroup> {
        submitting.value = true;

        try {
            const result = await unwrapResponse(
                services.confirmPersonalFinancePaymentAccount(request),
                'Unable to confirm personal finance payment account'
            );
            const existingIndex = paymentAccounts.value.findIndex(group => group.sampleRowId === request.rowId);

            if (existingIndex >= 0) {
                paymentAccounts.value.splice(existingIndex, 1, result);
            } else {
                await loadPaymentAccounts(request.batchId);
            }
            return result;
        } finally {
            submitting.value = false;
        }
    }

    async function excludePaymentAccount(request: PersonalFinancePaymentAccountExcludeRequest): Promise<PersonalFinancePaymentAccountGroup> {
        submitting.value = true;

        try {
            return await unwrapResponse(
                services.excludePersonalFinancePaymentAccount(request),
                'Unable to exclude personal finance payment account'
            );
        } finally {
            submitting.value = false;
        }
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

	async function discardBatch(batchId: string): Promise<void> {
		submitting.value = true;
		try {
			await unwrapResponse(services.discardPersonalFinanceImportBatch({ batchId }), 'Unable to discard personal finance import batch');
			await Promise.allSettled([loadBatches(), openBatch(batchId)]);
		} finally {
			submitting.value = false;
		}
	}

	async function deleteFileContent(fileId: string, batchId: string): Promise<void> {
		submitting.value = true;
		try {
			await unwrapResponse(services.deletePersonalFinanceImportFileContent({ fileId }), 'Unable to delete personal finance import file content');
			await Promise.allSettled([loadBatches(), openBatch(batchId)]);
		} finally {
			submitting.value = false;
		}
	}

	async function getUndoImpact(batchId: string): Promise<PersonalFinanceUndoImpact> {
		return unwrapResponse(services.getPersonalFinanceImportBatchUndoImpact({ batchId }), 'Unable to retrieve undo impact');
	}

    function clearSelection(): void {
        selectedBatch.value = null;
        rows.value = [];
        totalRowCount.value = 0;
        paymentAccounts.value = [];
    }

    return {
        batches,
        totalBatchCount,
        selectedBatch,
        rows,
        totalRowCount,
        sourceAccounts,
        paymentAccounts,
        loadingBatches,
        loadingRows,
        loadingPaymentAccounts,
        submitting,
        loadBatches,
        openBatch,
        uploadFile,
        reparseFile,
        loadSourceAccounts,
        saveSourceAccount,
        loadPaymentAccounts,
        confirmPaymentAccount,
        excludePaymentAccount,
        postRow,
		discardBatch,
		deleteFileContent,
		getUndoImpact,
        clearSelection
    };
});
