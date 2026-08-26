<template>
    <v-row class="match-height">
        <v-col cols="12">
            <v-card class="workbench-card overflow-hidden">
                <div :class="embedded ? 'workbench-toolbar px-5 py-3' : 'workbench-hero pa-6 pa-lg-8'">
                    <div class="d-flex flex-wrap align-center ga-4">
                        <div v-if="!embedded">
                            <div class="text-overline text-primary">{{ tt('personalFinance.eyebrow') }}</div>
                            <h2 class="text-h4 font-weight-bold mt-1">{{ tt('personalFinance.title') }}</h2>
                            <p class="text-body-large text-medium-emphasis mt-2 mb-0">
                                {{ tt('personalFinance.subtitle') }}
                            </p>
                        </div>
                        <div class="records-copy" v-else>
                            <strong>{{ tt('personalFinance.organizer.tab.records') }}</strong>
                            <small>{{ tt('personalFinance.organizer.recordsHint') }}</small>
                        </div>
                        <v-spacer />
                        <import-upload-button :size="embedded ? 'default' : 'large'" @changed="onUploadChanged" />
                        <v-btn
                            variant="tonal"
                            :size="embedded ? 'default' : 'large'"
                            :icon="mdiRefresh"
                            :loading="personalFinanceStore.loadingBatches"
                            @click="reload"
                        >
                            <v-tooltip activator="parent">{{ tt('Refresh') }}</v-tooltip>
                        </v-btn>
                    </div>
                </div>

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
                                            <v-icon :icon="batch.sourceType === 'alipay' ? mdiWalletOutline : (batch.sourceType === 'wechat' ? mdiChatOutline : mdiBankOutline)" />
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
                                        color="primary"
                                        :prepend-icon="mdiTableCog"
                                        :disabled="!canConfigureSelectedFileAsGenericBank || personalFinanceStore.submitting"
                                        @click="configureSelectedAsGenericBank"
                                    >
                                        {{ tt('personalFinance.genericBank.configure') }}
                                    </v-btn>
                                    <v-btn
                                        variant="tonal"
                                        color="primary"
                                        :prepend-icon="mdiCreditCardOutline"
                                        :disabled="!canConfigureSelectedFileAsCebCredit || personalFinanceStore.submitting"
                                        @click="configureSelectedAsCebCredit"
                                    >
                                        {{ tt('personalFinance.cebCredit.configure') }}
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

                                <v-alert
                                    class="mt-4"
                                    :type="unresolvedPaymentAccountCount > 0 ? 'warning' : 'success'"
                                    variant="tonal"
                                    v-if="personalFinanceStore.paymentAccounts.length > 0"
                                >
                                    <div class="d-flex flex-wrap align-center ga-3">
                                        <div>
                                            <div class="font-weight-medium">
                                                {{ unresolvedPaymentAccountCount > 0
                                                    ? tt('personalFinance.paymentAccount.batchNeedsConfirmation', { total: personalFinanceStore.paymentAccounts.length, count: unresolvedPaymentAccountCount })
                                                    : tt('personalFinance.paymentAccount.batchMapped', { count: personalFinanceStore.paymentAccounts.length }) }}
                                            </div>
                                            <div class="text-body-small mt-1">
                                                {{ tt('personalFinance.paymentAccount.batchHint') }}
                                            </div>
                                        </div>
                                        <v-spacer />
                                        <v-btn
                                            size="small"
                                            :color="unresolvedPaymentAccountCount > 0 ? 'warning' : 'success'"
                                            variant="tonal"
                                            :prepend-icon="mdiCreditCardSearchOutline"
                                            @click="openPaymentAccountSetup"
                                        >
                                            {{ unresolvedPaymentAccountCount > 0
                                                ? tt('personalFinance.paymentAccount.review')
                                                : tt('personalFinance.paymentAccount.viewMapping') }}
                                        </v-btn>
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
                                <v-table class="rows-table" density="compact" hover>
                                    <thead>
                                    <tr>
                                        <th>{{ tt('personalFinance.rowNumber') }}</th>
                                        <th>{{ tt('personalFinance.transaction') }}</th>
                                        <th>{{ tt('personalFinance.paymentAccount.paymentMethod') }}</th>
                                        <th>{{ tt('Amount') }}</th>
                                        <th>{{ tt('Status') }}</th>
                                        <th class="text-end">{{ tt('Operation') }}</th>
                                    </tr>
                                    </thead>
                                    <tbody>
                                    <tr v-if="personalFinanceStore.loadingRows">
                                        <td colspan="6"><v-progress-linear indeterminate /></td>
                                    </tr>
                                    <tr v-else-if="personalFinanceStore.rows.length < 1">
                                        <td colspan="6" class="text-center text-medium-emphasis py-8">{{ tt('personalFinance.noRows') }}</td>
                                    </tr>
                                    <tr :key="row.id" v-for="row in personalFinanceStore.rows">
                                        <td class="text-medium-emphasis">#{{ row.rowNumber }}</td>
                                        <td>
                                            <div class="font-weight-medium text-truncate row-summary">{{ row.rawCounterparty || row.rawItem || tt('Unknown') }}</div>
                                            <div class="text-body-small text-medium-emphasis text-truncate row-summary">
                                                {{ row.rawTransactionTime || formatTime(row.normalizedUnixTime) }} · {{ row.rawTransactionType || row.normalizedTransactionType }}
                                            </div>
                                        </td>
                                        <td>
                                            <div class="font-weight-medium text-truncate payment-method" v-if="row.rawPaymentMethod">
                                                {{ getRowPaymentAccountGroup(row)?.displayName ?? getSafePaymentAccountDisplayName(row.rawPaymentMethod) }}
                                            </div>
                                            <span class="text-medium-emphasis" v-else>—</span>
                                            <v-chip
                                                class="mt-1"
                                                size="x-small"
                                                :color="getRowPaymentAccountGroup(row)?.mapped ? 'success' : 'warning'"
                                                variant="tonal"
                                                v-if="getRowPaymentAccountGroup(row)"
                                            >
                                                {{ getRowPaymentAccountGroup(row)?.mapped
                                                    ? tt('personalFinance.paymentAccount.mapped')
                                                    : tt('personalFinance.paymentAccount.needsConfirmation') }}
                                            </v-chip>
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
                                                color="warning"
                                                variant="tonal"
                                                :disabled="personalFinanceStore.submitting"
                                                @click="openPaymentAccountSetup"
                                                v-if="isRowPaymentAccountUnresolved(row)"
                                            >
                                                {{ tt('personalFinance.paymentAccount.review') }}
                                            </v-btn>
                                            <span class="text-body-small text-medium-emphasis" v-else>
                                                {{ getRowPaymentAccountGroup(row)?.mapped ? tt('personalFinance.paymentAccount.mapped') : '—' }}
                                            </span>
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
    <generic-bank-import-dialog ref="genericBankImportDialog" @parsed="onParsed" />
    <ceb-credit-import-dialog ref="cebCreditImportDialog" @parsed="onParsed" />
    <payment-account-setup-dialog ref="paymentAccountSetupDialog" @saved="onPaymentAccountsSaved" />
	<confirm-dialog ref="confirmDialog" />
    <snack-bar ref="snackbar" />
</template>

<script setup lang="ts">
import SnackBar from '@/components/desktop/SnackBar.vue';
import ConfirmDialog from '@/components/desktop/ConfirmDialog.vue';
import ImportUploadButton from '../components/ImportUploadButton.vue';
import SourceAccountDialog from '../components/SourceAccountDialog.vue';
import GenericBankImportDialog from '../components/GenericBankImportDialog.vue';
import CebCreditImportDialog from '../components/CebCreditImportDialog.vue';
import PaymentAccountSetupDialog from '../components/PaymentAccountSetupDialog.vue';

import { computed, onMounted, ref, useTemplateRef, watch } from 'vue';

import { useI18n } from '@/locales/helpers.ts';
import { useUserStore } from '@/stores/user.ts';

import { getCurrentUnixTime, getTimezoneOffsetMinutes, parseDateTimeFromUnixTimeWithBrowserTimezone } from '@/lib/datetime.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';

import type { PersonalFinanceImportRow, PersonalFinanceImportUploadResult, PersonalFinancePaymentAccountGroup, PersonalFinanceUndoImpact } from '../models.ts';
import {
    getBatchStatusColor,
    getBatchStatusKey,
    getIdentityStateKey,
    getRowExplanationKey,
    getSourceTypeKey
} from '../presentation.ts';
import {
    canConfigureCebCreditPdf,
    canConfigureGenericBankTable,
    canDeleteImportFileContent,
    canDiscardImportBatch,
    findPaymentAccountGroupForRow,
    getSafePaymentAccountDisplayName
} from '../state.ts';
import { usePersonalFinanceStore } from '../store.ts';

withDefaults(defineProps<{
    embedded?: boolean;
}>(), {
    embedded: false
});

import {
    mdiChatOutline,
	mdiBankOutline,
	mdiCancel,
    mdiCreditCardSearchOutline,
    mdiCreditCardOutline,
	mdiDeleteOutline,
    mdiFileDocumentOutline,
    mdiFileSearchOutline,
    mdiRefresh,
	mdiInformationOutline,
    mdiReload,
	mdiTableCog,
    mdiWalletOutline
} from '@mdi/js';

type SnackBarType = InstanceType<typeof SnackBar>;
type SourceAccountDialogType = InstanceType<typeof SourceAccountDialog>;
type GenericBankImportDialogType = InstanceType<typeof GenericBankImportDialog>;
type CebCreditImportDialogType = InstanceType<typeof CebCreditImportDialog>;
type PaymentAccountSetupDialogType = InstanceType<typeof PaymentAccountSetupDialog>;
type ConfirmDialogType = InstanceType<typeof ConfirmDialog>;

const HISTORY_PAGE_SIZE = 20;
const ROW_PAGE_SIZE = 25;

const { tt, formatDateTimeToShortDateTime, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
const userStore = useUserStore();
const personalFinanceStore = usePersonalFinanceStore();

const sourceAccountDialog = useTemplateRef<SourceAccountDialogType>('sourceAccountDialog');
const genericBankImportDialog = useTemplateRef<GenericBankImportDialogType>('genericBankImportDialog');
const cebCreditImportDialog = useTemplateRef<CebCreditImportDialogType>('cebCreditImportDialog');
const paymentAccountSetupDialog = useTemplateRef<PaymentAccountSetupDialogType>('paymentAccountSetupDialog');
const snackbar = useTemplateRef<SnackBarType>('snackbar');
const confirmDialog = useTemplateRef<ConfirmDialogType>('confirmDialog');

const batchPage = ref<number>(1);
const rowPage = ref<number>(1);
const showUndoImpactDialog = ref<boolean>(false);
const undoImpact = ref<PersonalFinanceUndoImpact | null>(null);

const unresolvedPaymentAccountCount = computed<number>(() => personalFinanceStore.paymentAccounts.filter(group => !group.mapped).length);

const canDiscardSelectedBatch = computed<boolean>(() => {
	return canDiscardImportBatch(personalFinanceStore.selectedBatch);
});
const canDeleteSelectedFile = computed<boolean>(() => {
	return canDeleteImportFileContent(personalFinanceStore.selectedBatch?.file);
});
const canConfigureSelectedFileAsGenericBank = computed<boolean>(() => {
    return canConfigureGenericBankTable(personalFinanceStore.selectedBatch?.file);
});
const canConfigureSelectedFileAsCebCredit = computed<boolean>(() => {
    return canConfigureCebCreditPdf(personalFinanceStore.selectedBatch?.file);
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

async function onUploadChanged(batchId: string): Promise<void> {
    batchPage.value = 1;
    await personalFinanceStore.loadBatches(0, HISTORY_PAGE_SIZE);
    await selectBatch(batchId);
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
    maybeOpenPaymentAccountSetup();
}

async function reparseSelectedBatch(): Promise<void> {
    const batch = personalFinanceStore.selectedBatch;
    const file = batch?.file;

    if (!file || file.contentState !== 'available') {
        return;
    }

	if (batch?.parserName?.startsWith('generic_bank_')) {
		openGenericBankImport(file.id, file.fileExtension, 'user_requested_generic_reparse');
        return;
    }

    if (batch?.parserName === 'ceb_credit_pdf') {
        openCebCreditImport(file.id, 'user_requested_ceb_reparse');
        return;
    }

    try {
        await reparseFile(file.id, 'user_requested');
    } catch {
        if (!openExplicitParserFallback(file, 'user_requested_generic_fallback', 'user_requested_ceb_fallback')) {
            snackbar.value?.showMessage('personalFinance.error.operationFailed');
        }
    }
}

function openGenericBankImport(fileId: string, fileExtension: string, reasonCode: string): void {
    genericBankImportDialog.value?.open({
        fileId,
		fileExtension,
        currency: userStore.currentUserDefaultCurrency,
        timezoneUtcOffset: getTimezoneOffsetMinutes(getCurrentUnixTime()),
        reasonCode
    });
}

function openCebCreditImport(fileId: string, reasonCode: string): void {
    cebCreditImportDialog.value?.open({
        fileId,
        currency: userStore.currentUserDefaultCurrency,
        timezoneUtcOffset: getTimezoneOffsetMinutes(getCurrentUnixTime()),
        reasonCode
    });
}

function openExplicitParserFallback(file: PersonalFinanceImportUploadResult['file'] | undefined, genericReason: string, cebReason: string): boolean {
    if (!file) {
        return false;
    }
    if (canConfigureCebCreditPdf(file)) {
        openCebCreditImport(file.id, cebReason);
        snackbar.value?.showMessage('personalFinance.cebCredit.autoDetectionFailed');
        return true;
    }
    if (canConfigureGenericBankTable(file)) {
		openGenericBankImport(file.id, file.fileExtension, genericReason);
        snackbar.value?.showMessage('personalFinance.genericBank.autoDetectionFailed');
        return true;
    }
    return false;
}

function configureSelectedAsGenericBank(): void {
    const file = personalFinanceStore.selectedBatch?.file;

    if (!file || !canConfigureGenericBankTable(file)) {
        return;
    }

	openGenericBankImport(file.id, file.fileExtension, 'user_selected_generic_bank');
}

function configureSelectedAsCebCredit(): void {
    const file = personalFinanceStore.selectedBatch?.file;

    if (!file || !canConfigureCebCreditPdf(file)) {
        return;
    }

    openCebCreditImport(file.id, 'user_selected_ceb_credit_pdf');
}

function onParsed(): void {
    snackbar.value?.showMessage('personalFinance.parseCompleted');
    maybeOpenPaymentAccountSetup();
}

function getRowPaymentAccountGroup(row: PersonalFinanceImportRow): PersonalFinancePaymentAccountGroup | undefined {
    if (!row.rawPaymentMethod) {
        return undefined;
    }
    return findPaymentAccountGroupForRow(row, personalFinanceStore.paymentAccounts);
}

function isRowPaymentAccountUnresolved(row: PersonalFinanceImportRow): boolean {
    const group = getRowPaymentAccountGroup(row);
    return !!group && !group.mapped;
}

function openPaymentAccountSetup(): void {
    const currentBatchId = personalFinanceStore.selectedBatch?.id;
    if (currentBatchId) {
        paymentAccountSetupDialog.value?.open(currentBatchId);
    }
}

function maybeOpenPaymentAccountSetup(): void {
    if (unresolvedPaymentAccountCount.value > 0) {
        openPaymentAccountSetup();
    }
}

async function onPaymentAccountsSaved(): Promise<void> {
    const currentBatchId = personalFinanceStore.selectedBatch?.id;
    if (currentBatchId) {
        try {
            await personalFinanceStore.openBatch(currentBatchId, rowPage.value - 1, ROW_PAGE_SIZE);
            snackbar.value?.showMessage('personalFinance.paymentAccount.saved');
        } catch {
            snackbar.value?.showMessage('personalFinance.error.operationFailed');
        }
    }
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
    min-height: 620px;
    border: 1px solid rgba(var(--v-theme-on-surface), 0.11);
    border-radius: 10px;
    box-shadow: none;
}

.workbench-hero {
    background:
        radial-gradient(circle at 90% 20%, rgba(var(--v-theme-primary), 0.12), transparent 32%),
        linear-gradient(135deg, rgba(var(--v-theme-surface-variant), 0.58), rgba(var(--v-theme-surface), 0));
}

.workbench-toolbar {
    background: rgba(var(--v-theme-primary), 0.035);
}

.records-copy {
    display: grid;
    gap: 2px;
}

.records-copy strong {
    font-size: 1rem;
}

.records-copy small {
    color: rgba(var(--v-theme-on-surface), 0.58);
    font-size: 0.74rem;
}

.history-column,
.detail-column {
    min-height: 520px;
}

.history-list {
    background: transparent;
}

.history-item {
    min-height: 72px;
}

.metric-tile {
    height: 100%;
    background: rgba(var(--v-theme-surface-variant), 0.55);
}

.rows-table-wrapper {
    overflow-x: auto;
}

.rows-table {
    min-width: 980px;
}

.row-summary {
    max-width: 260px;
}

.row-explanation {
    max-width: 280px;
    white-space: normal;
}

.payment-method {
    max-width: 220px;
}

.empty-state {
    display: grid;
    min-height: 300px;
    place-content: center;
}

@media (min-width: 1280px) {
    .history-column {
        border-inline-end: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
    }
}
</style>
