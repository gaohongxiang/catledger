<template>
    <v-row class="match-height">
        <v-col cols="12">
            <v-card class="workbench-card overflow-hidden">
                <div class="workbench-hero pa-6 pa-lg-8">
                    <div class="d-flex flex-wrap align-center ga-4">
                        <div>
                            <div class="text-overline text-primary">{{ tt('personalFinance.eyebrow') }}</div>
                            <h2 class="text-h4 font-weight-bold mt-1">{{ tt('personalFinance.title') }}</h2>
                            <p class="text-body-large text-medium-emphasis mt-2 mb-0">
                                {{ tt('personalFinance.subtitle') }}
                            </p>
                        </div>
                        <v-spacer />
                        <v-btn
                            color="primary"
                            size="large"
                            :prepend-icon="mdiTrayArrowUp"
                            :loading="personalFinanceStore.submitting"
                            @click="fileInput?.click()"
                        >
                            {{ tt('personalFinance.upload') }}
                        </v-btn>
                        <v-btn
                            variant="tonal"
                            size="large"
                            :icon="mdiRefresh"
                            :loading="personalFinanceStore.loadingBatches"
                            @click="reload"
                        >
                            <v-tooltip activator="parent">{{ tt('Refresh') }}</v-tooltip>
                        </v-btn>
                    </div>
                </div>

                <input ref="fileInput" type="file" class="d-none" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" @change="upload" />

                <v-divider />

                <v-row class="ma-0">
                    <v-col cols="12" lg="4" class="history-column pa-0">
                        <div class="d-flex align-center px-5 py-4">
                            <div>
                                <div class="text-subtitle-1 font-weight-bold">{{ tt('personalFinance.history') }}</div>
                                <div class="text-body-small text-medium-emphasis">
                                    {{ tt('personalFinance.batchCount', { count: personalFinanceStore.totalBatchCount }) }}
                                </div>
                            </div>
                        </div>

                        <v-divider />

                        <v-skeleton-loader type="list-item-three-line@4" v-if="personalFinanceStore.loadingBatches && personalFinanceStore.batches.length < 1" />

                        <v-list class="history-list pa-0" lines="three" v-else-if="personalFinanceStore.batches.length">
                            <template :key="batch.id" v-for="(batch, index) in personalFinanceStore.batches">
                                <v-list-item
                                    class="history-item px-5 py-3"
                                    :active="personalFinanceStore.selectedBatch?.id === batch.id"
                                    color="primary"
                                    @click="selectBatch(batch.id)"
                                >
                                    <template #prepend>
                                        <v-avatar :color="getBatchStatusColor(batch.status)" variant="tonal">
                                            <v-icon :icon="batch.sourceType === 'alipay' ? mdiWalletOutline : mdiChatOutline" />
                                        </v-avatar>
                                    </template>
                                    <v-list-item-title class="font-weight-medium">
                                        {{ batch.file?.originalFileName || tt(getSourceTypeKey(batch.sourceType)) }}
                                    </v-list-item-title>
                                    <v-list-item-subtitle class="mt-1">
                                        {{ tt(getSourceTypeKey(batch.sourceType)) }} · {{ formatTime(batch.createdUnixTime) }}
                                    </v-list-item-subtitle>
                                    <v-list-item-subtitle class="mt-1">
                                        <v-chip size="x-small" :color="getBatchStatusColor(batch.status)" variant="tonal">
                                            {{ tt(getBatchStatusKey(batch.status)) }}
                                        </v-chip>
                                        <span class="ms-2">{{ tt('personalFinance.pendingCount', { count: batch.pendingRowCount }) }}</span>
                                    </v-list-item-subtitle>
                                </v-list-item>
                                <v-divider v-if="index < personalFinanceStore.batches.length - 1" />
                            </template>
                        </v-list>

                        <div class="empty-state pa-8 text-center" v-else>
                            <v-icon color="medium-emphasis" size="48" :icon="mdiFileDocumentOutline" />
                            <div class="font-weight-medium mt-3">{{ tt('personalFinance.noHistory') }}</div>
                            <div class="text-body-small text-medium-emphasis mt-1">{{ tt('personalFinance.noHistoryHint') }}</div>
                        </div>

                        <v-pagination
                            density="comfortable"
                            class="my-3"
                            :length="batchPageCount"
                            v-model="batchPage"
                            v-if="batchPageCount > 1"
                        />
                    </v-col>

                    <v-divider vertical class="d-none d-lg-block" />

                    <v-col cols="12" lg="8" class="detail-column pa-0">
                        <v-skeleton-loader class="pa-5" type="heading, paragraph, table" v-if="personalFinanceStore.loadingRows && !personalFinanceStore.selectedBatch" />

                        <div class="empty-state pa-10 text-center" v-else-if="!personalFinanceStore.selectedBatch">
                            <v-icon color="medium-emphasis" size="56" :icon="mdiFileSearchOutline" />
                            <div class="text-h6 mt-4">{{ tt('personalFinance.selectBatch') }}</div>
                            <div class="text-body-medium text-medium-emphasis mt-1">{{ tt('personalFinance.selectBatchHint') }}</div>
                        </div>

                        <template v-else>
                            <div class="pa-5 pa-lg-6">
                                <div class="d-flex flex-wrap align-start ga-3">
                                    <div>
                                        <div class="d-flex align-center flex-wrap ga-2">
                                            <h3 class="text-h6">{{ personalFinanceStore.selectedBatch.file?.originalFileName || tt('personalFinance.batch') }}</h3>
                                            <v-chip size="small" :color="getBatchStatusColor(personalFinanceStore.selectedBatch.status)" variant="tonal">
                                                {{ tt(getBatchStatusKey(personalFinanceStore.selectedBatch.status)) }}
                                            </v-chip>
                                        </div>
                                        <div class="text-body-small text-medium-emphasis mt-1">
                                            {{ tt(getSourceTypeKey(personalFinanceStore.selectedBatch.sourceType)) }} ·
                                            {{ personalFinanceStore.selectedBatch.parserName }} ·
                                            {{ formatTime(personalFinanceStore.selectedBatch.createdUnixTime) }}
                                        </div>
                                    </div>
                                    <v-spacer />
                                    <v-btn
                                        variant="tonal"
                                        :prepend-icon="mdiReload"
                                        :disabled="personalFinanceStore.selectedBatch.file?.contentState !== 'available' || personalFinanceStore.submitting"
                                        @click="reparseSelectedBatch"
                                    >
                                        {{ tt('personalFinance.reparse') }}
                                    </v-btn>
									<v-btn
										variant="tonal"
										:prepend-icon="mdiInformationOutline"
										:disabled="personalFinanceStore.submitting"
										@click="showUndoImpact"
									>
										{{ tt('personalFinance.operations.undoImpact') }}
									</v-btn>
									<v-btn
										variant="tonal"
										color="warning"
										:prepend-icon="mdiCancel"
										:disabled="!canDiscardSelectedBatch || personalFinanceStore.submitting"
										@click="discardSelectedBatch"
									>
										{{ tt('personalFinance.operations.discard') }}
									</v-btn>
									<v-btn
										variant="tonal"
										color="error"
										:prepend-icon="mdiDeleteOutline"
										:disabled="!canDeleteSelectedFile || personalFinanceStore.submitting"
										@click="deleteSelectedFileContent"
									>
										{{ tt('personalFinance.operations.deleteContent') }}
									</v-btn>
                                </div>

                                <v-row class="mt-4">
                                    <v-col cols="6" sm="4" xl="2" :key="metric.label" v-for="metric in batchMetrics">
                                        <div class="metric-tile pa-3 rounded-lg">
                                            <div class="text-h6 font-weight-bold" :class="metric.class">{{ metric.value }}</div>
                                            <div class="text-body-small text-medium-emphasis">{{ tt(metric.label) }}</div>
                                        </div>
                                    </v-col>
                                </v-row>

                                <v-alert
                                    class="mt-4"
                                    type="warning"
                                    variant="tonal"
                                    v-if="personalFinanceStore.selectedBatch.issues?.length"
                                >
                                    <div class="font-weight-medium">{{ tt('personalFinance.documentIssues') }}</div>
                                    <div class="text-body-small mt-1" :key="`${issue.code}-${index}`" v-for="(issue, index) in personalFinanceStore.selectedBatch.issues">
                                        {{ tt(`personalFinance.issue.${issue.code}`) }}<span v-if="issue.field"> · {{ issue.field }}</span>
                                    </div>
                                </v-alert>
                            </div>

                            <v-divider />

                            <div class="d-flex align-center px-5 py-4">
                                <div>
                                    <div class="text-subtitle-1 font-weight-bold">{{ tt('personalFinance.preview') }}</div>
                                    <div class="text-body-small text-medium-emphasis">{{ tt('personalFinance.previewHint') }}</div>
                                </div>
                            </div>

                            <div class="rows-table-wrapper">
                                <v-table class="rows-table" density="comfortable" hover>
                                    <thead>
                                    <tr>
                                        <th>{{ tt('personalFinance.rowNumber') }}</th>
                                        <th>{{ tt('personalFinance.transaction') }}</th>
                                        <th>{{ tt('Amount') }}</th>
                                        <th>{{ tt('Status') }}</th>
                                        <th class="text-end">{{ tt('Operation') }}</th>
                                    </tr>
                                    </thead>
                                    <tbody>
                                    <tr v-if="personalFinanceStore.loadingRows">
                                        <td colspan="5"><v-progress-linear indeterminate /></td>
                                    </tr>
                                    <tr v-else-if="personalFinanceStore.rows.length < 1">
                                        <td colspan="5" class="text-center text-medium-emphasis py-8">{{ tt('personalFinance.noRows') }}</td>
                                    </tr>
                                    <tr :key="row.id" v-for="row in personalFinanceStore.rows">
                                        <td class="text-medium-emphasis">#{{ row.rowNumber }}</td>
                                        <td>
                                            <div class="font-weight-medium text-truncate row-summary">{{ row.rawCounterparty || row.rawItem || tt('Unknown') }}</div>
                                            <div class="text-body-small text-medium-emphasis text-truncate row-summary">
                                                {{ row.rawTransactionTime || formatTime(row.normalizedUnixTime) }} · {{ row.rawTransactionType || row.normalizedTransactionType }}
                                            </div>
                                        </td>
                                        <td class="text-no-wrap">{{ formatAmount(row.normalizedAmount, row.currency, row.rawAmount) }}</td>
                                        <td>
                                            <v-chip size="x-small" :color="row.identityState === 'identity_conflict' ? 'error' : (row.identityState === 'exact_duplicate' ? 'warning' : 'primary')" variant="tonal">
                                                {{ tt(getIdentityStateKey(row.identityState)) }}
                                            </v-chip>
                                            <div class="text-body-small text-medium-emphasis mt-1 row-explanation">
                                                {{ tt(getRowExplanationKey(row)) }}
                                            </div>
                                        </td>
                                        <td class="text-end">
                                            <v-btn
                                                size="small"
                                                color="primary"
                                                variant="tonal"
                                                :disabled="personalFinanceStore.submitting"
                                                @click="openPosting(row)"
                                                v-if="getRowAction(row) !== 'blocked'"
                                            >
                                                {{ getRowAction(row) === 'create_or_reuse' ? tt('personalFinance.confirmDuplicate') : tt('personalFinance.confirmRow') }}
                                            </v-btn>
                                            <span class="text-body-small text-medium-emphasis" v-else>—</span>
                                        </td>
                                    </tr>
                                    </tbody>
                                </v-table>
                            </div>

                            <v-pagination
                                density="comfortable"
                                class="my-4"
                                :length="rowPageCount"
                                v-model="rowPage"
                                v-if="rowPageCount > 1"
                            />
                        </template>
                    </v-col>
                </v-row>
            </v-card>
        </v-col>
    </v-row>

    <v-dialog width="560" v-model="showDuplicateDialog">
        <v-card>
            <v-card-title class="pa-5">{{ tt('personalFinance.duplicateDialog.title') }}</v-card-title>
            <v-card-text class="px-5 pb-5">{{ tt('personalFinance.duplicateDialog.message') }}</v-card-text>
            <v-card-actions class="px-5 pb-5">
                <v-spacer />
                <v-btn variant="text" @click="showDuplicateDialog = false">{{ tt('Cancel') }}</v-btn>
                <v-btn variant="tonal" @click="openLatestDuplicate">{{ tt('personalFinance.duplicateDialog.openLatest') }}</v-btn>
                <v-btn color="primary" @click="reparseDuplicate">{{ tt('personalFinance.duplicateDialog.reparse') }}</v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>

	<v-dialog width="620" v-model="showUndoImpactDialog">
		<v-card>
			<v-card-title class="pa-5">{{ tt('personalFinance.operations.undoImpactTitle') }}</v-card-title>
			<v-card-text class="px-5 pb-5">
				<v-alert type="info" variant="tonal">{{ tt('personalFinance.operations.noAutomaticUndo') }}</v-alert>
				<v-list density="compact" class="mt-3" v-if="undoImpact">
					<v-list-item :title="tt('personalFinance.operations.linkedTransactions')" :subtitle="String(undoImpact.linkedTransactionCount)" />
					<v-list-item :title="tt('personalFinance.operations.createdTransactions')" :subtitle="String(undoImpact.postingCreatedCount)" />
					<v-list-item :title="tt('personalFinance.operations.reusedTransactions')" :subtitle="String(undoImpact.postingReusedCount)" />
					<v-list-item :title="tt('personalFinance.operations.modifiedOrMissing')" :subtitle="String(undoImpact.modifiedTransactionCount + undoImpact.missingTransactionCount)" />
					<v-list-item :title="tt('personalFinance.operations.sharedTransactions')" :subtitle="String(undoImpact.sharedTransactionCount)" />
				</v-list>
				<v-progress-linear indeterminate class="mt-4" v-else />
			</v-card-text>
			<v-card-actions class="px-5 pb-5"><v-spacer /><v-btn @click="showUndoImpactDialog = false">{{ tt('Close') }}</v-btn></v-card-actions>
		</v-card>
	</v-dialog>

    <source-account-dialog ref="sourceAccountDialog" @parsed="onParsed" />
    <posting-dialog ref="postingDialog" @posted="onPosted" />
	<confirm-dialog ref="confirmDialog" />
    <snack-bar ref="snackbar" />
</template>

<script setup lang="ts">
import SnackBar from '@/components/desktop/SnackBar.vue';
import ConfirmDialog from '@/components/desktop/ConfirmDialog.vue';
import PostingDialog from '../components/PostingDialog.vue';
import SourceAccountDialog from '../components/SourceAccountDialog.vue';

import { computed, onMounted, ref, useTemplateRef, watch } from 'vue';

import { useI18n } from '@/locales/helpers.ts';
import { useUserStore } from '@/stores/user.ts';

import { getCurrentUnixTime, getTimezoneOffsetMinutes, parseDateTimeFromUnixTimeWithBrowserTimezone } from '@/lib/datetime.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';

import type { PersonalFinanceImportRow, PersonalFinanceImportUploadResult, PersonalFinanceUndoImpact } from '../models.ts';
import {
    getBatchStatusColor,
    getBatchStatusKey,
    getIdentityStateKey,
    getRowExplanationKey,
    getSourceTypeKey
} from '../presentation.ts';
import { canDeleteImportFileContent, canDiscardImportBatch, getRowAction, getUploadAction } from '../state.ts';
import { usePersonalFinanceStore } from '../store.ts';

import {
    mdiChatOutline,
	mdiCancel,
	mdiDeleteOutline,
    mdiFileDocumentOutline,
    mdiFileSearchOutline,
    mdiRefresh,
	mdiInformationOutline,
    mdiReload,
    mdiTrayArrowUp,
    mdiWalletOutline
} from '@mdi/js';

type SnackBarType = InstanceType<typeof SnackBar>;
type PostingDialogType = InstanceType<typeof PostingDialog>;
type SourceAccountDialogType = InstanceType<typeof SourceAccountDialog>;
type ConfirmDialogType = InstanceType<typeof ConfirmDialog>;

const HISTORY_PAGE_SIZE = 20;
const ROW_PAGE_SIZE = 25;

const { tt, formatDateTimeToShortDateTime, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
const userStore = useUserStore();
const personalFinanceStore = usePersonalFinanceStore();

const fileInput = useTemplateRef<HTMLInputElement>('fileInput');
const postingDialog = useTemplateRef<PostingDialogType>('postingDialog');
const sourceAccountDialog = useTemplateRef<SourceAccountDialogType>('sourceAccountDialog');
const snackbar = useTemplateRef<SnackBarType>('snackbar');
const confirmDialog = useTemplateRef<ConfirmDialogType>('confirmDialog');

const batchPage = ref<number>(1);
const rowPage = ref<number>(1);
const showDuplicateDialog = ref<boolean>(false);
const duplicateUpload = ref<PersonalFinanceImportUploadResult | null>(null);
const showUndoImpactDialog = ref<boolean>(false);
const undoImpact = ref<PersonalFinanceUndoImpact | null>(null);

const canDiscardSelectedBatch = computed<boolean>(() => {
	return canDiscardImportBatch(personalFinanceStore.selectedBatch);
});
const canDeleteSelectedFile = computed<boolean>(() => {
	return canDeleteImportFileContent(personalFinanceStore.selectedBatch?.file);
});

const batchPageCount = computed<number>(() => Math.max(1, Math.ceil(personalFinanceStore.totalBatchCount / HISTORY_PAGE_SIZE)));
const rowPageCount = computed<number>(() => Math.max(1, Math.ceil(personalFinanceStore.totalRowCount / ROW_PAGE_SIZE)));
const batchMetrics = computed(() => {
    const batch = personalFinanceStore.selectedBatch;

    if (!batch) {
        return [];
    }

    return [
        { label: 'personalFinance.metric.total', value: batch.totalRowCount, class: '' },
        { label: 'personalFinance.metric.pending', value: batch.pendingRowCount, class: 'text-primary' },
        { label: 'personalFinance.metric.posted', value: batch.postedRowCount, class: 'text-success' },
        { label: 'personalFinance.metric.duplicates', value: batch.exactDuplicateRowCount, class: 'text-warning' },
        { label: 'personalFinance.metric.conflicts', value: batch.identityConflictRowCount, class: 'text-error' },
        { label: 'personalFinance.metric.invalid', value: batch.invalidRowCount, class: 'text-medium-emphasis' }
    ];
});

function formatTime(unixTime?: number): string {
    return unixTime
        ? formatDateTimeToShortDateTime(parseDateTimeFromUnixTimeWithBrowserTimezone(unixTime))
        : tt('Unknown');
}

function formatAmount(amount: string | undefined, currency: string, rawAmount?: string): string {
    return amount
        ? formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(amount), currency)
        : (rawAmount || tt('Unknown'));
}

async function selectBatch(batchId: string): Promise<void> {
    rowPage.value = 1;

    try {
        await personalFinanceStore.openBatch(batchId, 0, ROW_PAGE_SIZE);
    } catch {
        snackbar.value?.showMessage('personalFinance.error.operationFailed');
    }
}

async function reload(): Promise<void> {
    try {
        await personalFinanceStore.loadBatches(batchPage.value - 1, HISTORY_PAGE_SIZE);

        if (personalFinanceStore.selectedBatch) {
            await personalFinanceStore.openBatch(personalFinanceStore.selectedBatch.id, rowPage.value - 1, ROW_PAGE_SIZE);
        } else if (personalFinanceStore.batches[0]) {
            await selectBatch(personalFinanceStore.batches[0].id);
        }
    } catch {
        snackbar.value?.showMessage('personalFinance.error.operationFailed');
    }
}

async function discardSelectedBatch(): Promise<void> {
	const batch = personalFinanceStore.selectedBatch;
	const dialog = confirmDialog.value;
	if (!batch || !dialog) return;
	try {
		await dialog.open('personalFinance.operations.discardConfirm', { pending: batch.pendingRowCount, posted: batch.postedRowCount, color: 'warning' });
		await personalFinanceStore.discardBatch(batch.id);
		snackbar.value?.showMessage('personalFinance.operations.discarded');
	} catch (error: unknown) {
		if (error) snackbar.value?.showMessage('personalFinance.error.operationFailed');
	}
}

async function deleteSelectedFileContent(): Promise<void> {
	const batch = personalFinanceStore.selectedBatch;
	const dialog = confirmDialog.value;
	if (!batch?.file || !dialog) return;
	try {
		await dialog.open('personalFinance.operations.deleteContentConfirm', { pending: batch.pendingRowCount, posted: batch.postedRowCount, color: 'error' });
		await personalFinanceStore.deleteFileContent(batch.file.id, batch.id);
		snackbar.value?.showMessage('personalFinance.operations.contentDeleted');
	} catch (error: unknown) {
		if (error) snackbar.value?.showMessage('personalFinance.error.operationFailed');
	}
}

async function showUndoImpact(): Promise<void> {
	const batch = personalFinanceStore.selectedBatch;
	if (!batch) return;
	undoImpact.value = null;
	showUndoImpactDialog.value = true;
	try {
		undoImpact.value = await personalFinanceStore.getUndoImpact(batch.id);
	} catch {
		showUndoImpactDialog.value = false;
		snackbar.value?.showMessage('personalFinance.error.operationFailed');
	}
}

async function upload(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';

    if (!file) {
        return;
    }

    try {
        const result = await personalFinanceStore.uploadFile(file);

        if (getUploadAction(result) === 'choose_duplicate_action') {
            duplicateUpload.value = result;
            showDuplicateDialog.value = true;
            return;
        }

        await reparseFile(result.file.id, 'initial_upload');
    } catch {
        snackbar.value?.showMessage('personalFinance.error.operationFailed');
    }
}

async function reparseFile(fileId: string, reasonCode: string): Promise<void> {
    const timezoneUtcOffset = getTimezoneOffsetMinutes(getCurrentUnixTime());
    const result = await personalFinanceStore.reparseFile({
        fileId,
        currency: userStore.currentUserDefaultCurrency,
        timezoneUtcOffset,
        reasonCode
    });

    if (result.requiresSourceAccount && result.discovery) {
        sourceAccountDialog.value?.open({
            fileId,
            discovery: result.discovery,
            currency: userStore.currentUserDefaultCurrency,
            timezoneUtcOffset
        });
        return;
    }

    snackbar.value?.showMessage('personalFinance.parseCompleted');
}

async function openLatestDuplicate(): Promise<void> {
    const latestBatch = duplicateUpload.value?.latestBatch;
    showDuplicateDialog.value = false;

    if (!latestBatch) {
        return;
    }

    await personalFinanceStore.loadBatches(0, HISTORY_PAGE_SIZE);
    await selectBatch(latestBatch.id);
}

async function reparseDuplicate(): Promise<void> {
    const fileId = duplicateUpload.value?.file.id;
    showDuplicateDialog.value = false;

    if (!fileId) {
        return;
    }

    try {
        await reparseFile(fileId, 'duplicate_upload_reparse');
    } catch {
        snackbar.value?.showMessage('personalFinance.error.operationFailed');
    }
}

async function reparseSelectedBatch(): Promise<void> {
    const file = personalFinanceStore.selectedBatch?.file;

    if (!file || file.contentState !== 'available') {
        return;
    }

    try {
        await reparseFile(file.id, 'user_requested');
    } catch {
        snackbar.value?.showMessage('personalFinance.error.operationFailed');
    }
}

function openPosting(row: PersonalFinanceImportRow): void {
    if (!personalFinanceStore.selectedBatch) {
        return;
    }

    postingDialog.value?.open(row, personalFinanceStore.selectedBatch);
}

function onParsed(): void {
    snackbar.value?.showMessage('personalFinance.parseCompleted');
}

function onPosted(): void {
    snackbar.value?.showMessage('personalFinance.posting.completed');
}

watch(batchPage, () => {
    personalFinanceStore.loadBatches(batchPage.value - 1, HISTORY_PAGE_SIZE)
        .catch(() => snackbar.value?.showMessage('personalFinance.error.operationFailed'));
});

watch(rowPage, () => {
    const batchId = personalFinanceStore.selectedBatch?.id;

    if (batchId) {
        personalFinanceStore.openBatch(batchId, rowPage.value - 1, ROW_PAGE_SIZE)
            .catch(() => snackbar.value?.showMessage('personalFinance.error.operationFailed'));
    }
});

onMounted(reload);
</script>

<style scoped>
.workbench-card {
    min-height: 720px;
}

.workbench-hero {
    background:
        radial-gradient(circle at 90% 20%, rgba(var(--v-theme-primary), 0.12), transparent 32%),
        linear-gradient(135deg, rgba(var(--v-theme-surface-variant), 0.58), rgba(var(--v-theme-surface), 0));
}

.history-column,
.detail-column {
    min-height: 590px;
}

.history-list {
    background: transparent;
}

.history-item {
    min-height: 92px;
}

.metric-tile {
    height: 100%;
    background: rgba(var(--v-theme-surface-variant), 0.55);
}

.rows-table-wrapper {
    overflow-x: auto;
}

.rows-table {
    min-width: 820px;
}

.row-summary {
    max-width: 260px;
}

.row-explanation {
    max-width: 280px;
    white-space: normal;
}

.empty-state {
    display: grid;
    min-height: 300px;
    place-content: center;
}

@media (min-width: 1280px) {
    .history-column {
        max-width: calc(33.333% - 1px);
    }
}
</style>
