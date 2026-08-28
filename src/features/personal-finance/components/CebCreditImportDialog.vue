<template>
    <v-dialog width="720" :persistent="submitting" v-model="showState">
        <v-card class="ceb-credit-dialog">
            <v-card-title class="d-flex align-center py-4 px-5">
                <v-icon class="me-3" color="primary" :icon="mdiCreditCardOutline" />
                <span>{{ tt('personalFinance.cebCredit.title') }}</span>
                <v-spacer />
                <v-btn density="compact" variant="text" :icon="mdiClose" :disabled="submitting" @click="close" />
            </v-card-title>

            <v-divider />

            <v-card-text class="pa-0">
                <div class="pa-5">
                    <v-alert type="info" variant="tonal">
                        <div class="font-weight-medium">{{ tt('personalFinance.cebCredit.templateNotice') }}</div>
                        <div class="text-body-small mt-1">{{ tt('personalFinance.cebCredit.privacyNotice') }}</div>
                        <div class="text-body-small mt-1">{{ tt('personalFinance.cebCredit.twoCardHint') }}</div>
                    </v-alert>
                </div>
            </v-card-text>

            <v-divider />

            <v-card-actions class="px-5 py-4">
                <v-spacer />
                <v-btn variant="text" :disabled="submitting" @click="close">{{ tt('Cancel') }}</v-btn>
                <v-btn color="primary" :loading="submitting" :disabled="submitting" @click="submit">
                    {{ tt('personalFinance.cebCredit.parse') }}
                </v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>

    <snack-bar ref="snackbar" />
</template>

<script setup lang="ts">
import SnackBar from '@/components/desktop/SnackBar.vue';

import { ref, useTemplateRef } from 'vue';

import { useI18n } from '@/locales/helpers.ts';

import { buildCebCreditReparseRequest } from '../state.ts';
import { usePersonalFinanceStore } from '../store.ts';

import { mdiClose, mdiCreditCardOutline } from '@mdi/js';

type SnackBarType = InstanceType<typeof SnackBar>;

const emit = defineEmits<{
    (e: 'parsed', batchId: string): void;
}>();

const { tt } = useI18n();
const personalFinanceStore = usePersonalFinanceStore();
const snackbar = useTemplateRef<SnackBarType>('snackbar');

const showState = ref<boolean>(false);
const submitting = ref<boolean>(false);
const fileId = ref<string>('');
const currency = ref<string>('');
const timezoneUtcOffset = ref<number>(0);
const reasonCode = ref<string>('user_selected_ceb_credit_pdf');

function close(): void {
    if (!submitting.value) {
        showState.value = false;
    }
}

function open(options: {
    fileId: string;
    currency: string;
    timezoneUtcOffset: number;
    reasonCode?: string;
}): void {
    showState.value = true;
    fileId.value = options.fileId;
    currency.value = options.currency;
    timezoneUtcOffset.value = options.timezoneUtcOffset;
    reasonCode.value = options.reasonCode ?? 'user_selected_ceb_credit_pdf';
}

async function submit(): Promise<void> {
    if (submitting.value) {
        return;
    }

    submitting.value = true;

    try {
        const result = await personalFinanceStore.reparseFile(buildCebCreditReparseRequest({
            fileId: fileId.value,
            currency: currency.value,
            timezoneUtcOffset: timezoneUtcOffset.value,
            reasonCode: reasonCode.value
        }));

        if (result.alreadyPosted) {
            showState.value = false;
            snackbar.value?.showMessage('personalFinance.alreadyPosted');
            return;
        }

        if (!result.batch) {
            throw new Error('ceb credit parser did not create a batch');
        }

        showState.value = false;
        emit('parsed', result.batch.id);
    } catch {
        snackbar.value?.showMessage('personalFinance.error.operationFailed');
    } finally {
        submitting.value = false;
    }
}

defineExpose({ open });
</script>

<style scoped>
.ceb-credit-dialog {
    display: flex;
    flex-direction: column;
    max-height: min(720px, calc(100vh - 48px));
}

.ceb-credit-dialog > .v-card-text {
    overflow-y: auto;
}
</style>
