<template>
    <v-dialog width="820" v-model="showState">
        <v-card>
            <v-card-title class="d-flex align-center py-4 px-5">
                <span>{{ tt('personalFinance.evidence.title') }}</span>
                <v-spacer />
                <v-btn density="compact" variant="text" :icon="mdiClose" @click="showState = false" />
            </v-card-title>

            <v-divider />

            <v-card-text class="pa-5">
                <v-skeleton-loader type="list-item-three-line@2" v-if="loading" />

                <v-alert type="info" variant="tonal" v-else-if="items.length < 1">
                    {{ tt('personalFinance.evidence.none') }}
                </v-alert>

                <v-list lines="three" class="evidence-list pa-0" v-else>
                    <template :key="`${item.rowId}-${item.relationRole}`" v-for="(item, index) in items">
                        <v-list-item class="px-0 py-3">
                            <template #prepend>
                                <v-avatar color="primary" variant="tonal">
                                    <v-icon :icon="mdiFileDocumentCheckOutline" />
                                </v-avatar>
                            </template>

                            <v-list-item-title>
                                {{ tt(getSourceTypeKey(item.sourceType)) }} · {{ formatAmount(item.normalizedAmount, item.currency) }}
                            </v-list-item-title>
                            <v-list-item-subtitle class="mt-1">
                                {{ tt('personalFinance.evidence.batchRow', { batch: item.batchId, row: item.rowNumber }) }} · .{{ item.fileExtension }}
                            </v-list-item-subtitle>
                            <v-list-item-subtitle>
                                {{ formatTime(item.normalizedUnixTime, item.normalizedTimezoneUtcOffset) }} ·
                                {{ tt(`personalFinance.evidence.creation.${item.creationMethod}`) }} ·
                                {{ tt(`personalFinance.evidence.role.${item.relationRole}`) }}
                            </v-list-item-subtitle>
                        </v-list-item>
                        <v-divider v-if="index < items.length - 1" />
                    </template>
                </v-list>
            </v-card-text>

            <v-divider />

            <v-card-actions class="px-5 py-4">
                <div class="text-body-small text-medium-emphasis">
                    {{ tt('personalFinance.evidence.privacyNote') }}
                </div>
                <v-spacer />
                <v-btn variant="tonal" @click="showState = false">{{ tt('Close') }}</v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>

    <snack-bar ref="snackbar" />
</template>

<script setup lang="ts">
import SnackBar from '@/components/desktop/SnackBar.vue';

import { ref, useTemplateRef } from 'vue';

import { useI18n } from '@/locales/helpers.ts';
import services from '@/lib/services.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';
import { parseDateTimeFromUnixTimeWithTimezoneOffset } from '@/lib/datetime.ts';

import type { PersonalFinanceEvidenceItem } from '../models.ts';
import { getSourceTypeKey } from '../presentation.ts';

import { mdiClose, mdiFileDocumentCheckOutline } from '@mdi/js';

type SnackBarType = InstanceType<typeof SnackBar>;

const { tt, formatDateTimeToLongDateTime, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
const snackbar = useTemplateRef<SnackBarType>('snackbar');

const showState = ref<boolean>(false);
const loading = ref<boolean>(false);
const items = ref<PersonalFinanceEvidenceItem[]>([]);

function formatAmount(amount: string | undefined, currency: string): string {
    return amount ? formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(amount), currency) : tt('Unknown');
}

function formatTime(unixTime?: number, utcOffset = 0): string {
    return unixTime
        ? formatDateTimeToLongDateTime(parseDateTimeFromUnixTimeWithTimezoneOffset(unixTime, utcOffset))
        : tt('Unknown');
}

async function open(transactionId: string): Promise<void> {
    if (!transactionId) {
        return;
    }

    showState.value = true;
    loading.value = true;
    items.value = [];

    try {
        const response = await services.getPersonalFinanceTransactionEvidence({ transactionId });
        const data = response.data;

        if (!data || !data.success || !data.result) {
            throw new Error('Unable to retrieve transaction evidence');
        }

        items.value = data.result.items;
    } catch {
        snackbar.value?.showMessage('personalFinance.error.operationFailed');
    } finally {
        loading.value = false;
    }
}

defineExpose({ open });
</script>

<style scoped>
.evidence-list {
    background: transparent;
}
</style>
