<template>
    <v-dialog width="960" :persistent="submitting" v-model="showState">
        <v-card class="generic-bank-dialog">
            <v-card-title class="d-flex align-center py-4 px-5">
                <v-icon class="me-3" color="primary" :icon="mdiBankOutline" />
                <span>{{ tt('personalFinance.genericBank.title') }}</span>
                <v-spacer />
                <v-btn density="compact" variant="text" :icon="mdiClose" :disabled="submitting" @click="close" />
            </v-card-title>

            <v-divider />

            <v-card-text class="pa-0">
                <div class="pa-5">
                    <v-alert type="info" variant="tonal">
                        <div class="font-weight-medium">{{ tt('personalFinance.genericBank.templateNotice') }}</div>
                        <div class="text-body-small mt-1">{{ tt('personalFinance.genericBank.privacyNotice') }}</div>
                    </v-alert>
                </div>

                <v-divider />

                <section class="pa-5">
                    <div class="text-subtitle-1 font-weight-bold">{{ tt('personalFinance.genericBank.fileSection') }}</div>
                    <div class="text-body-small text-medium-emphasis mt-1 mb-4">
                        {{ tt('personalFinance.genericBank.columnNumberHint') }}
                    </div>

                    <v-row>
                        <v-col cols="12" sm="6" md="3">
                            <v-select :items="encodingOptions" :label="tt('personalFinance.genericBank.encoding')" v-model="form.encoding" />
                        </v-col>
                        <v-col cols="12" sm="6" md="3">
                            <v-select :items="delimiterOptions" :label="tt('personalFinance.genericBank.delimiter')" v-model="form.delimiter" />
                        </v-col>
                        <v-col cols="12" sm="6" md="3">
                            <v-text-field
                                type="number"
                                min="1"
                                max="10000"
                                :label="tt('personalFinance.genericBank.headerRow')"
                                v-model.number="form.headerRow"
                            />
                        </v-col>
                        <v-col cols="12" sm="6" md="3">
                            <v-select :items="timeFormatOptions" :label="tt('personalFinance.genericBank.timeFormat')" v-model="form.timeFormat" />
                        </v-col>
                        <v-col cols="12" sm="6">
                            <column-field
                                :label="tt('personalFinance.genericBank.column.time')"
                                :model-value="form.timeColumn"
                                required
                                @update:model-value="form.timeColumn = $event"
                            />
                        </v-col>
                    </v-row>
                </section>

                <v-divider />

                <section class="pa-5">
                    <div class="text-subtitle-1 font-weight-bold">{{ tt('personalFinance.genericBank.amountSection') }}</div>
                    <div class="text-body-small text-medium-emphasis mt-1 mb-4">
                        {{ tt('personalFinance.genericBank.amountHint') }}
                    </div>

                    <v-btn-toggle mandatory divided color="primary" class="amount-mode-toggle mb-4" v-model="form.amountMode">
                        <v-btn value="signed">{{ tt('personalFinance.genericBank.amountMode.signed') }}</v-btn>
                        <v-btn value="amount_direction">{{ tt('personalFinance.genericBank.amountMode.amountDirection') }}</v-btn>
                        <v-btn value="income_expense">{{ tt('personalFinance.genericBank.amountMode.incomeExpense') }}</v-btn>
                    </v-btn-toggle>

                    <v-row v-if="form.amountMode === 'signed'">
                        <v-col cols="12" sm="6">
                            <column-field
                                :label="tt('personalFinance.genericBank.column.amount')"
                                :model-value="form.amountColumn"
                                required
                                @update:model-value="form.amountColumn = $event"
                            />
                        </v-col>
                        <v-col cols="12" sm="6">
                            <v-select
                                :items="signedDirectionOptions"
                                :label="tt('personalFinance.genericBank.signedPositiveDirection')"
                                v-model="form.signedPositiveDirection"
                            />
                        </v-col>
                    </v-row>

                    <v-row v-else-if="form.amountMode === 'amount_direction'">
                        <v-col cols="12" sm="6">
                            <column-field
                                :label="tt('personalFinance.genericBank.column.amount')"
                                :model-value="form.amountColumn"
                                required
                                @update:model-value="form.amountColumn = $event"
                            />
                        </v-col>
                        <v-col cols="12" sm="6">
                            <column-field
                                :label="tt('personalFinance.genericBank.column.direction')"
                                :model-value="form.directionColumn"
                                required
                                @update:model-value="form.directionColumn = $event"
                            />
                        </v-col>
                        <v-col cols="12" sm="6">
                            <v-combobox
                                multiple
                                chips
                                closable-chips
                                :label="tt('personalFinance.genericBank.incomeValues')"
                                :hint="tt('personalFinance.genericBank.directionValuesHint')"
                                persistent-hint
                                v-model="form.incomeValues"
                            />
                        </v-col>
                        <v-col cols="12" sm="6">
                            <v-combobox
                                multiple
                                chips
                                closable-chips
                                :label="tt('personalFinance.genericBank.expenseValues')"
                                :hint="tt('personalFinance.genericBank.directionValuesHint')"
                                persistent-hint
                                v-model="form.expenseValues"
                            />
                        </v-col>
                    </v-row>

                    <v-row v-else>
                        <v-col cols="12" sm="6">
                            <column-field
                                :label="tt('personalFinance.genericBank.column.income')"
                                :model-value="form.incomeColumn"
                                required
                                @update:model-value="form.incomeColumn = $event"
                            />
                        </v-col>
                        <v-col cols="12" sm="6">
                            <column-field
                                :label="tt('personalFinance.genericBank.column.expense')"
                                :model-value="form.expenseColumn"
                                required
                                @update:model-value="form.expenseColumn = $event"
                            />
                        </v-col>
                    </v-row>
                </section>

                <v-divider />

                <section class="pa-5">
                    <v-expansion-panels variant="accordion">
                        <v-expansion-panel>
                            <v-expansion-panel-title>
                                <div>
                                    <div class="font-weight-medium">{{ tt('personalFinance.genericBank.optionalColumns') }}</div>
                                    <div class="text-body-small text-medium-emphasis">{{ tt('personalFinance.genericBank.optionalColumnsHint') }}</div>
                                </div>
                            </v-expansion-panel-title>
                            <v-expansion-panel-text>
                                <v-row class="pt-2">
                                    <v-col cols="12" sm="6" md="4" :key="field.key" v-for="field in optionalColumnFields">
                                        <column-field
                                            :label="tt(field.label)"
                                            :model-value="form[field.key]"
                                            @update:model-value="setColumn(field.key, $event)"
                                        />
                                    </v-col>
                                </v-row>
                            </v-expansion-panel-text>
                        </v-expansion-panel>
                    </v-expansion-panels>
                </section>

                <div class="px-5 pb-5" v-if="validation.errors.length">
                    <v-alert type="error" variant="tonal" density="compact">
                        <div :key="error" v-for="error in validation.errors">
                            {{ tt(`personalFinance.genericBank.error.${error}`) }}
                        </div>
                    </v-alert>
                </div>
            </v-card-text>

            <v-divider />

            <v-card-actions class="px-5 py-4">
                <v-spacer />
                <v-btn variant="text" :disabled="submitting" @click="close">{{ tt('Cancel') }}</v-btn>
                <v-btn color="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">
                    {{ tt('personalFinance.genericBank.parse') }}
                </v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>

    <snack-bar ref="snackbar" />
</template>

<script setup lang="ts">
import SnackBar from '@/components/desktop/SnackBar.vue';
import ColumnField from './GenericBankColumnField.vue';

import { computed, reactive, ref, useTemplateRef } from 'vue';

import { useI18n } from '@/locales/helpers.ts';

import type { PersonalFinanceGenericBankMappingForm } from '../models.ts';
import {
    buildGenericBankReparseRequest,
    createDefaultGenericBankMappingForm,
    validateGenericBankMappingForm
} from '../state.ts';
import { usePersonalFinanceStore } from '../store.ts';

import { mdiBankOutline, mdiClose } from '@mdi/js';

type SnackBarType = InstanceType<typeof SnackBar>;
type OptionalColumnKey =
    'currencyColumn' |
    'transactionIdColumn' |
    'orderIdColumn' |
    'merchantOrderIdColumn' |
    'counterpartyColumn' |
    'itemColumn' |
    'paymentMethodColumn' |
    'statusColumn' |
    'transactionTypeColumn' |
    'noteColumn';

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
const reasonCode = ref<string>('generic_bank_mapping');
const form = reactive<PersonalFinanceGenericBankMappingForm>(createDefaultGenericBankMappingForm());

const encodingOptions = computed(() => [
    { title: tt('personalFinance.genericBank.encodingOption.utf8'), value: 'utf8' },
    { title: tt('personalFinance.genericBank.encodingOption.gb18030'), value: 'gb18030' },
    { title: tt('personalFinance.genericBank.encodingOption.gbk'), value: 'gbk' }
]);
const delimiterOptions = computed(() => [
    { title: tt('personalFinance.genericBank.delimiterOption.comma'), value: 'comma' },
    { title: tt('personalFinance.genericBank.delimiterOption.tab'), value: 'tab' }
]);
const timeFormatOptions = computed(() => [
    '2006-01-02 15:04:05',
    '2006-01-02 15:04',
    '2006/01/02 15:04:05',
    '2006/01/02 15:04',
    '2006-01-02',
    '2006/01/02'
]);
const signedDirectionOptions = computed(() => [
    { title: tt('Income'), value: 'income' },
    { title: tt('Expense'), value: 'expense' }
]);
const optionalColumnFields: Array<{ key: OptionalColumnKey; label: string }> = [
    { key: 'currencyColumn', label: 'personalFinance.genericBank.column.currency' },
    { key: 'transactionIdColumn', label: 'personalFinance.genericBank.column.transactionId' },
    { key: 'orderIdColumn', label: 'personalFinance.genericBank.column.orderId' },
    { key: 'merchantOrderIdColumn', label: 'personalFinance.genericBank.column.merchantOrderId' },
    { key: 'counterpartyColumn', label: 'personalFinance.genericBank.column.counterparty' },
    { key: 'itemColumn', label: 'personalFinance.genericBank.column.item' },
    { key: 'paymentMethodColumn', label: 'personalFinance.genericBank.column.paymentMethod' },
    { key: 'statusColumn', label: 'personalFinance.genericBank.column.status' },
    { key: 'transactionTypeColumn', label: 'personalFinance.genericBank.column.transactionType' },
    { key: 'noteColumn', label: 'personalFinance.genericBank.column.note' }
];

const validation = computed(() => validateGenericBankMappingForm(form));
const canSubmit = computed<boolean>(() => !submitting.value && !!validation.value.mapping);

function setColumn(key: OptionalColumnKey, value: number | null): void {
    form[key] = value;
}

function resetForm(): void {
    Object.assign(form, createDefaultGenericBankMappingForm());
}

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
    reasonCode.value = options.reasonCode ?? 'generic_bank_mapping';
    resetForm();
}

async function submit(): Promise<void> {
    if (!canSubmit.value) {
        return;
    }

    submitting.value = true;

    try {
        const request = buildGenericBankReparseRequest({
            fileId: fileId.value,
            currency: currency.value,
            timezoneUtcOffset: timezoneUtcOffset.value,
            reasonCode: reasonCode.value,
            form
        });
        const result = await personalFinanceStore.reparseFile(request);

        if (!result.batch) {
            throw new Error('generic bank parser did not create a batch');
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
.generic-bank-dialog {
    display: flex;
    flex-direction: column;
    max-height: min(900px, calc(100vh - 48px));
}

.generic-bank-dialog > .v-card-text {
    overflow-y: auto;
}

.amount-mode-toggle {
    max-width: 100%;
}

@media (max-width: 700px) {
    .amount-mode-toggle {
        display: grid;
        width: 100%;
    }
}
</style>
