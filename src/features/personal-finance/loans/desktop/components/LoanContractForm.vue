<template>
    <v-card class="contract-form" :class="{ 'contract-form--embedded': embedded }" :variant="embedded ? 'flat' : 'outlined'">
        <v-card-title class="d-flex align-center ga-3 px-5 pt-5" v-if="!embedded">
            <span>{{ tt(embedded ? 'personalFinance.loans.contractForm.embeddedTitle' : 'personalFinance.loans.contractForm.title') }}</span>
            <v-spacer />
            <v-chip color="primary" size="small" variant="tonal" v-if="!embedded">
                {{ tt('personalFinance.loans.contractForm.identityOnly') }}
            </v-chip>
        </v-card-title>
        <v-card-subtitle class="px-5 pt-1" v-if="!embedded">
            {{ tt('personalFinance.loans.contractForm.subtitle') }}
        </v-card-subtitle>
        <v-card-text class="pa-5">
            <v-row v-if="compactInstallment">
                <v-col cols="12">
                    <v-text-field
                        maxlength="128"
                        :label="tt('personalFinance.loans.installmentRecord.field.name')"
                        :disabled="disabled"
                        :model-value="modelValue.name"
                        @update:model-value="value => updateField('name', value)"
                    />
                </v-col>
            </v-row>
            <v-row v-else>
                <v-col cols="12" md="6">
                    <v-text-field
                        maxlength="128"
                        :label="tt('personalFinance.loans.field.name')"
                        :disabled="disabled"
                        :model-value="modelValue.name"
                        @update:model-value="value => updateField('name', value)"
                    />
                </v-col>
                <v-col cols="12" md="6">
                    <v-text-field
                        maxlength="128"
                        :label="tt('personalFinance.loans.field.lenderName')"
                        :disabled="disabled"
                        :model-value="modelValue.lenderName"
                        @update:model-value="value => updateField('lenderName', value)"
                    />
                </v-col>
                <v-col cols="12" md="6">
                    <v-select
                        item-title="title"
                        item-value="value"
                        :items="contractTypeOptions"
                        :label="tt('personalFinance.loans.field.contractType')"
                        :disabled="disabled"
                        :model-value="modelValue.contractType"
                        @update:model-value="value => updateField('contractType', value)"
                    />
                </v-col>
                <v-col cols="12" md="6">
                    <v-text-field
                        maxlength="3"
                        :label="tt('Currency')"
                        :disabled="disabled"
                        :model-value="modelValue.currency"
                        @update:model-value="updateCurrency"
                    />
                </v-col>
                <v-col cols="12" md="6">
                    <v-select
                        clearable
                        item-title="name"
                        item-value="id"
                        :items="liabilityAccounts"
                        :label="tt('personalFinance.loans.field.liabilityAccount')"
                        :disabled="disabled"
                        :model-value="modelValue.liabilityAccountId"
                        @update:model-value="value => updateField('liabilityAccountId', value)"
                    />
                </v-col>
                <v-col cols="12" md="6">
                    <v-select
                        clearable
                        item-title="name"
                        item-value="id"
                        :items="paymentAccounts"
                        :label="tt('personalFinance.loans.field.defaultPaymentAccount')"
                        :disabled="disabled"
                        :model-value="modelValue.defaultPaymentAccountId"
                        @update:model-value="value => updateField('defaultPaymentAccountId', value || undefined)"
                    />
                </v-col>
                <v-col cols="12">
                    <v-textarea
                        maxlength="255"
                        rows="2"
                        :label="tt('Notes')"
                        :disabled="disabled"
                        :model-value="modelValue.note"
                        @update:model-value="value => updateField('note', value)"
                    />
                </v-col>
            </v-row>

            <v-alert type="info" variant="tonal" v-if="!embedded">
                {{ tt('personalFinance.loans.contractForm.accountBoundary') }}
            </v-alert>
        </v-card-text>
    </v-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { useI18n } from '@/locales/helpers.ts';

import type { LoanContractIdentityInput } from '../../models.ts';

export interface LoanContractAccountOption {
    readonly id: string;
    readonly name: string;
    readonly currency: string;
}

const props = withDefaults(defineProps<{
    modelValue: LoanContractIdentityInput;
    liabilityAccounts?: LoanContractAccountOption[];
    paymentAccounts?: LoanContractAccountOption[];
    disabled?: boolean;
    embedded?: boolean;
    compactInstallment?: boolean;
}>(), {
    liabilityAccounts: () => [],
    paymentAccounts: () => [],
    disabled: false,
    embedded: false,
    compactInstallment: false
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: LoanContractIdentityInput): void;
}>();

const { tt } = useI18n();
const contractTypeOptions = computed(() => [
    { title: tt('personalFinance.loans.contractType.creditCardInstallment'), value: 'credit_card_installment' },
    { title: tt('personalFinance.loans.contractType.bankLoan'), value: 'bank_loan' },
    { title: tt('personalFinance.loans.contractType.consumerLoan'), value: 'consumer_loan' },
    { title: tt('personalFinance.loans.contractType.personalLoan'), value: 'personal_loan' }
]);

function updateField(field: keyof LoanContractIdentityInput, value: unknown): void {
    emit('update:modelValue', { ...props.modelValue, [field]: value });
}

function updateCurrency(value: unknown): void {
    updateField('currency', String(value ?? '').trim().toUpperCase());
}
</script>

<style scoped>
.contract-form {
    background:
        linear-gradient(145deg, rgba(var(--v-theme-primary), 0.035), transparent 44%),
        rgb(var(--v-theme-surface));
}

.contract-form--embedded {
    border-radius: 0;
    background: transparent;
}
</style>
