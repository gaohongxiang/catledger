<template>
    <v-btn
        :color="color"
        :size="size"
        :variant="variant"
        :prepend-icon="mdiTrayArrowUp"
        :loading="personalFinanceStore.submitting"
        @click="fileInput?.click()"
    >
        {{ label || tt('personalFinance.upload') }}
    </v-btn>
    <input
        ref="fileInput"
        type="file"
        class="d-none"
		accept=".csv,.xls,.xlsx,.pdf,text/csv,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        @change="upload"
    />

    <source-account-dialog ref="sourceAccountDialog" @parsed="onParsed" />
    <generic-bank-import-dialog ref="genericBankImportDialog" @parsed="onParsed" />
    <ceb-credit-import-dialog ref="cebCreditImportDialog" @parsed="onParsed" />
    <snack-bar ref="snackbar" />
</template>

<script setup lang="ts">
import SnackBar from '@/components/desktop/SnackBar.vue';

import { useTemplateRef } from 'vue';
import { mdiTrayArrowUp } from '@mdi/js';

import { getCurrentUnixTime, getTimezoneOffsetMinutes } from '@/lib/datetime.ts';
import { useI18n } from '@/locales/helpers.ts';
import { useUserStore } from '@/stores/user.ts';

import type { PersonalFinanceImportUploadResult } from '../models.ts';
import { canConfigureCebCreditPdf, canConfigureGenericBankTable } from '../state.ts';
import { usePersonalFinanceStore } from '../store.ts';
import CebCreditImportDialog from './CebCreditImportDialog.vue';
import GenericBankImportDialog from './GenericBankImportDialog.vue';
import SourceAccountDialog from './SourceAccountDialog.vue';

type SnackBarType = InstanceType<typeof SnackBar>;
type SourceAccountDialogType = InstanceType<typeof SourceAccountDialog>;
type GenericBankImportDialogType = InstanceType<typeof GenericBankImportDialog>;
type CebCreditImportDialogType = InstanceType<typeof CebCreditImportDialog>;

withDefaults(defineProps<{
    size?: 'x-small' | 'small' | 'default' | 'large' | 'x-large';
    color?: string;
    variant?: 'flat' | 'text' | 'elevated' | 'tonal' | 'outlined' | 'plain';
    label?: string;
}>(), {
    size: 'default',
    color: 'primary',
    variant: 'flat',
    label: ''
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
const snackbar = useTemplateRef<SnackBarType>('snackbar');
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

    try {
        await reparseFile(result.file.id, result.duplicate ? 'duplicate_upload_reparse' : 'initial_upload');
    } catch {
        const reasonPrefix = result.duplicate ? 'duplicate_upload' : 'initial_upload';
        if (!openExplicitParserFallback(result.file, `${reasonPrefix}_generic_fallback`, `${reasonPrefix}_ceb_fallback`)) {
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
	if (result.alreadyPosted) {
		snackbar.value?.showMessage('personalFinance.alreadyPosted');
		return;
	}
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
    if (canConfigureGenericBankTable(file)) {
		genericBankImportDialog.value?.open({ ...common, fileExtension: file.fileExtension, reasonCode: genericReason });
        snackbar.value?.showMessage('personalFinance.genericBank.autoDetectionFailed');
        return true;
    }
    return false;
}

</script>
