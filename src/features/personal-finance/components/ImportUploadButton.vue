<template>
    <v-btn
        color="primary"
        :size="size"
        :prepend-icon="mdiTrayArrowUp"
        :loading="personalFinanceStore.submitting"
        @click="fileInput?.click()"
    >
        {{ tt('personalFinance.upload') }}
    </v-btn>
    <input
        ref="fileInput"
        type="file"
        class="d-none"
        accept=".csv,.xlsx,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        @change="upload"
    />

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

    <source-account-dialog ref="sourceAccountDialog" @parsed="onParsed" />
    <generic-bank-import-dialog ref="genericBankImportDialog" @parsed="onParsed" />
    <ceb-credit-import-dialog ref="cebCreditImportDialog" @parsed="onParsed" />
    <payment-account-setup-dialog ref="paymentAccountSetupDialog" @saved="onPaymentAccountsSaved" />
    <snack-bar ref="snackbar" />
</template>

<script setup lang="ts">
import SnackBar from '@/components/desktop/SnackBar.vue';

import { ref, useTemplateRef } from 'vue';
import { mdiTrayArrowUp } from '@mdi/js';

import { getCurrentUnixTime, getTimezoneOffsetMinutes } from '@/lib/datetime.ts';
import { useI18n } from '@/locales/helpers.ts';
import { useUserStore } from '@/stores/user.ts';

import type { PersonalFinanceImportUploadResult } from '../models.ts';
import { canConfigureCebCreditPdf, canConfigureGenericBankCsv, getUploadAction } from '../state.ts';
import { usePersonalFinanceStore } from '../store.ts';
import CebCreditImportDialog from './CebCreditImportDialog.vue';
import GenericBankImportDialog from './GenericBankImportDialog.vue';
import PaymentAccountSetupDialog from './PaymentAccountSetupDialog.vue';
import SourceAccountDialog from './SourceAccountDialog.vue';

type SnackBarType = InstanceType<typeof SnackBar>;
type SourceAccountDialogType = InstanceType<typeof SourceAccountDialog>;
type GenericBankImportDialogType = InstanceType<typeof GenericBankImportDialog>;
type CebCreditImportDialogType = InstanceType<typeof CebCreditImportDialog>;
type PaymentAccountSetupDialogType = InstanceType<typeof PaymentAccountSetupDialog>;

withDefaults(defineProps<{
    size?: 'x-small' | 'small' | 'default' | 'large' | 'x-large';
}>(), {
    size: 'default'
});

const emit = defineEmits<{
    (e: 'changed', batchId: string): void;
}>();

const { tt } = useI18n();
const userStore = useUserStore();
const personalFinanceStore = usePersonalFinanceStore();
const fileInput = useTemplateRef<HTMLInputElement>('fileInput');
const sourceAccountDialog = useTemplateRef<SourceAccountDialogType>('sourceAccountDialog');
const genericBankImportDialog = useTemplateRef<GenericBankImportDialogType>('genericBankImportDialog');
const cebCreditImportDialog = useTemplateRef<CebCreditImportDialogType>('cebCreditImportDialog');
const paymentAccountSetupDialog = useTemplateRef<PaymentAccountSetupDialogType>('paymentAccountSetupDialog');
const snackbar = useTemplateRef<SnackBarType>('snackbar');
const showDuplicateDialog = ref(false);
const duplicateUpload = ref<PersonalFinanceImportUploadResult>();

async function upload(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    let result: PersonalFinanceImportUploadResult;
    try {
        result = await personalFinanceStore.uploadFile(file);
    } catch {
        snackbar.value?.showMessage('personalFinance.error.operationFailed');
        return;
    }

    if (getUploadAction(result) === 'choose_duplicate_action') {
        duplicateUpload.value = result;
        showDuplicateDialog.value = true;
        return;
    }

    try {
        await reparseFile(result.file.id, 'initial_upload');
    } catch {
        if (!openExplicitParserFallback(result.file, 'initial_upload_generic_fallback', 'initial_upload_ceb_fallback')) {
            snackbar.value?.showMessage('personalFinance.error.operationFailed');
        }
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
    if (result.batch) await onParsed(result.batch.id);
}

async function onParsed(batchId: string): Promise<void> {
    await Promise.allSettled([
        personalFinanceStore.loadBatches(0, 100),
        personalFinanceStore.openBatch(batchId)
    ]);
    snackbar.value?.showMessage('personalFinance.parseCompleted');
    emit('changed', batchId);
    if (personalFinanceStore.paymentAccounts.some(group => !group.mapped)) {
        paymentAccountSetupDialog.value?.open(batchId);
    }
}

async function openLatestDuplicate(): Promise<void> {
    const latestBatch = duplicateUpload.value?.latestBatch;
    showDuplicateDialog.value = false;
    if (!latestBatch) return;
    await onParsed(latestBatch.id);
}

async function reparseDuplicate(): Promise<void> {
    const file = duplicateUpload.value?.file;
    showDuplicateDialog.value = false;
    if (!file) return;
    try {
        await reparseFile(file.id, 'duplicate_upload_reparse');
    } catch {
        if (!openExplicitParserFallback(file, 'duplicate_upload_generic_fallback', 'duplicate_upload_ceb_fallback')) {
            snackbar.value?.showMessage('personalFinance.error.operationFailed');
        }
    }
}

function openExplicitParserFallback(file: PersonalFinanceImportUploadResult['file'], genericReason: string, cebReason: string): boolean {
    const common = {
        fileId: file.id,
        currency: userStore.currentUserDefaultCurrency,
        timezoneUtcOffset: getTimezoneOffsetMinutes(getCurrentUnixTime())
    };
    if (canConfigureCebCreditPdf(file)) {
        cebCreditImportDialog.value?.open({ ...common, reasonCode: cebReason });
        snackbar.value?.showMessage('personalFinance.cebCredit.autoDetectionFailed');
        return true;
    }
    if (canConfigureGenericBankCsv(file)) {
        genericBankImportDialog.value?.open({ ...common, reasonCode: genericReason });
        snackbar.value?.showMessage('personalFinance.genericBank.autoDetectionFailed');
        return true;
    }
    return false;
}

function onPaymentAccountsSaved(): void {
    const batchId = personalFinanceStore.selectedBatch?.id;
    if (batchId) emit('changed', batchId);
}
</script>
