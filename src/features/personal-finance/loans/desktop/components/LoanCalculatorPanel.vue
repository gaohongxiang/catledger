<template>
    <v-card class="loan-calculator overflow-hidden" variant="outlined">
        <div class="calculator-heading pa-5 pa-lg-6">
            <div>
                <div class="text-overline text-primary">{{ tt('personalFinance.loans.calculator.eyebrow') }}</div>
                <h3 class="text-h5 font-weight-bold mt-1">{{ tt('personalFinance.loans.calculator.title') }}</h3>
                <p class="text-body-medium text-medium-emphasis mt-2 mb-0">
                    {{ tt('personalFinance.loans.calculator.subtitle') }}
                </p>
            </div>
            <v-chip color="primary" variant="tonal">{{ currency }}</v-chip>
        </div>

        <v-divider />

        <v-card-text class="pa-5 pa-lg-6">
            <v-alert class="mb-5" type="info" variant="tonal">
                {{ tt('personalFinance.loans.boundary.calculationIsNotLedger') }}
            </v-alert>

            <v-btn-toggle
                class="mode-toggle mb-5"
                color="primary"
                divided
                mandatory
                variant="outlined"
                :disabled="disabled || loading"
                :model-value="modelValue.inputMode"
                @update:model-value="changeInputMode"
            >
                <v-btn value="rate">{{ tt('personalFinance.loans.inputMode.rate') }}</v-btn>
                <v-btn value="repayment">{{ tt('personalFinance.loans.inputMode.repayment') }}</v-btn>
            </v-btn-toggle>

            <v-row>
                <v-col cols="12" md="6">
                    <v-select
                        item-title="title"
                        item-value="value"
                        :items="fundingTypeOptions"
                        :label="tt('personalFinance.loans.field.fundingType')"
                        :disabled="disabled || loading"
                        :model-value="modelValue.fundingType"
                        @update:model-value="value => updateField('fundingType', value)"
                    />
                </v-col>
                <v-col cols="12" md="6">
                    <v-select
                        item-title="title"
                        item-value="value"
                        :items="repaymentMethodOptions"
                        :label="tt('personalFinance.loans.field.repaymentMethod')"
                        :disabled="disabled || loading"
                        :model-value="modelValue.repaymentMethod"
                        @update:model-value="changeRepaymentMethod"
                    />
                </v-col>
                <v-col cols="12" sm="6">
                    <v-text-field
                        type="date"
                        :label="tt('personalFinance.loans.field.effectiveDate')"
                        :disabled="disabled || loading"
                        :model-value="modelValue.effectiveDate"
                        @update:model-value="value => updateField('effectiveDate', value)"
                    />
                </v-col>
                <v-col cols="12" sm="6">
                    <v-text-field
                        type="date"
                        :label="tt('personalFinance.loans.field.contractDate')"
                        :disabled="disabled || loading"
                        :model-value="modelValue.contractDate"
                        @update:model-value="value => updateField('contractDate', value)"
                    />
                </v-col>
                <v-col cols="12" sm="6">
                    <v-text-field
                        type="date"
                        :label="tt('personalFinance.loans.field.firstDueDate')"
                        :disabled="disabled || loading"
                        :model-value="modelValue.firstDueDate"
                        @update:model-value="value => updateField('firstDueDate', value)"
                    />
                </v-col>
                <v-col cols="12" sm="6" md="4">
                    <amount-input
                        :label="tt('personalFinance.loans.field.principal')"
                        :currency="currency"
                        show-currency
                        :disabled="disabled || loading"
                        :model-value="modelValue.principalAmount"
                        @update:model-value="value => updateAmount('principalAmount', value)"
                    />
                </v-col>
                <v-col cols="12" sm="6" md="4">
                    <amount-input
                        :label="tt('personalFinance.loans.field.actualDisbursement')"
                        :currency="currency"
                        show-currency
                        readonly
                        :disabled="disabled || loading"
                        :model-value="modelValue.actualDisbursementAmount"
                    />
                </v-col>
                <v-col cols="12" sm="6" md="4">
                    <v-text-field
                        type="number"
                        min="1"
                        :label="tt('personalFinance.loans.field.termCount')"
                        :disabled="disabled || loading"
                        :model-value="modelValue.termCount"
                        @update:model-value="updateTermCount"
                    />
                </v-col>
                <v-col cols="12" sm="6" md="4">
                    <amount-input
                        :label="tt('personalFinance.loans.field.upfrontFee')"
                        :currency="currency"
                        show-currency
                        :disabled="disabled || loading"
                        :model-value="modelValue.upfrontFeeAmount"
                        @update:model-value="value => updateAmount('upfrontFeeAmount', value)"
                    />
                </v-col>
                <v-col cols="12" sm="6" md="4">
                    <amount-input
                        :label="tt('personalFinance.loans.field.perPeriodFee')"
                        :currency="currency"
                        show-currency
                        :disabled="disabled || loading"
                        :model-value="modelValue.perPeriodFeeAmount"
                        @update:model-value="value => updateAmount('perPeriodFeeAmount', value)"
                    />
                </v-col>
                <v-col cols="12" sm="6" md="4" v-if="modelValue.inputMode === 'repayment'">
                    <amount-input
                        :label="tt('personalFinance.loans.field.paymentBasis')"
                        :currency="currency"
                        show-currency
                        :disabled="disabled || loading"
                        :model-value="modelValue.paymentBasisAmount ?? 0"
                        @update:model-value="value => updateAmount('paymentBasisAmount', value)"
                    />
                </v-col>
                <template v-else>
                    <v-col cols="12" sm="6" md="4">
                        <v-select
                            item-title="title"
                            item-value="value"
                            :items="rateQuoteTypeOptions"
                            :label="tt('personalFinance.loans.field.rateQuoteType')"
                            :disabled="disabled || loading"
                            :model-value="modelValue.rateQuoteType"
                            @update:model-value="value => updateField('rateQuoteType', value)"
                        />
                    </v-col>
                    <v-col cols="12" sm="6" md="4">
                        <v-text-field
                            inputmode="decimal"
                            suffix="%"
                            :label="tt('personalFinance.loans.field.quotedRatePercent')"
                            :hint="tt('personalFinance.loans.field.percentageHint')"
                            :error="quotedRateInvalid"
                            persistent-hint
                            :disabled="disabled || loading"
                            v-model="quotedRatePercent"
                            @blur="normalizeQuotedRate"
                        />
                    </v-col>
                </template>
                <v-col cols="12" md="4">
                    <v-select
                        item-title="title"
                        item-value="value"
                        :items="discountTypeOptions"
                        :label="tt('personalFinance.loans.field.discountType')"
                        :disabled="disabled || loading"
                        :model-value="modelValue.discountType"
                        @update:model-value="changeDiscountType"
                    />
                </v-col>
                <v-col cols="12" md="4" v-if="modelValue.discountType === 'interest_rate'">
                    <v-text-field
                        inputmode="decimal"
                        suffix="%"
                        :label="tt('personalFinance.loans.field.discountRatePercent')"
                        :hint="tt('personalFinance.loans.field.percentageHint')"
                        :error="discountRateInvalid"
                        persistent-hint
                        :disabled="disabled || loading"
                        v-model="discountRatePercent"
                        @blur="normalizeDiscountRate"
                    />
                </v-col>
                <v-col cols="12" md="4" v-else-if="modelValue.discountType !== 'none'">
                    <amount-input
                        :label="tt('personalFinance.loans.field.discountAmount')"
                        :currency="currency"
                        show-currency
                        :disabled="disabled || loading"
                        :model-value="modelValue.discountAmount"
                        @update:model-value="value => updateAmount('discountAmount', value)"
                    />
                </v-col>
            </v-row>

            <div class="d-flex justify-end mt-2">
                <v-btn color="primary" size="large" :disabled="disabled" :loading="loading" @click="emit('calculate')">
                    {{ tt('personalFinance.loans.calculator.calculate') }}
                </v-btn>
            </div>
        </v-card-text>

        <template v-if="result">
            <v-divider />
            <loan-calculation-result-panel class="pa-5 pa-lg-6" :input="modelValue" :result="result" :currency="currency" />
        </template>
    </v-card>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import AmountInput from '@/components/desktop/AmountInput.vue';
import { useI18n } from '@/locales/helpers.ts';

import type {
    LoanCalculationInput,
    LoanCalculationResult,
    LoanDiscountType,
    LoanInputMode,
    LoanRepaymentMethod
} from '../../models.ts';
import {
    formatLoanPptrAsPercentage,
    normalizeLoanPercentageInput,
    type LoanEditableAmountField,
    updateLoanCalculationAmount
} from '../../state.ts';
import LoanCalculationResultPanel from './LoanCalculationResultPanel.vue';

const props = withDefaults(defineProps<{
    modelValue: LoanCalculationInput;
    result?: LoanCalculationResult;
    currency: string;
    loading?: boolean;
    disabled?: boolean;
}>(), {
    result: undefined,
    loading: false,
    disabled: false
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: LoanCalculationInput): void;
    (e: 'calculate'): void;
}>();

const { tt } = useI18n();

const fundingTypeOptions = computed(() => [
    { title: tt('personalFinance.loans.fundingType.cashDisbursement'), value: 'cash_disbursement' },
    { title: tt('personalFinance.loans.fundingType.purchaseInstallment'), value: 'purchase_installment' }
]);
const repaymentMethodOptions = computed(() => [
    { title: tt('personalFinance.loans.repaymentMethod.flat'), value: 'flat' },
    { title: tt('personalFinance.loans.repaymentMethod.equalPayment'), value: 'equal_payment' },
    { title: tt('personalFinance.loans.repaymentMethod.equalPrincipal'), value: 'equal_principal' },
    { title: tt('personalFinance.loans.repaymentMethod.interestOnly'), value: 'interest_only' }
]);
const rateQuoteTypeOptions = computed(() => [
    { title: tt('personalFinance.loans.rateQuote.annual'), value: 'annual' },
    { title: tt('personalFinance.loans.rateQuote.monthly'), value: 'monthly' },
    { title: tt('personalFinance.loans.rateQuote.daily'), value: 'daily' },
    ...(props.modelValue.repaymentMethod === 'flat'
        ? [{ title: tt('personalFinance.loans.rateQuote.installment'), value: 'installment' }]
        : [])
]);
const discountTypeOptions = computed(() => [
    { title: tt('personalFinance.loans.discount.none'), value: 'none' },
    { title: tt('personalFinance.loans.discount.interestRate'), value: 'interest_rate' },
    { title: tt('personalFinance.loans.discount.perPeriodAmount'), value: 'per_period' },
    { title: tt('personalFinance.loans.discount.totalAmount'), value: 'total' }
]);
const quotedRatePercent = ref(formatLoanPptrAsPercentage(props.modelValue.quotedRatePptr));
const discountRatePercent = ref(formatLoanPptrAsPercentage(props.modelValue.discountRatePptr));
const quotedRatePptr = computed(() => normalizeLoanPercentageInput(quotedRatePercent.value));
const discountRatePptr = computed(() => normalizeLoanPercentageInput(discountRatePercent.value, '1000000000000', false));
const quotedRateInvalid = computed(() => !quotedRatePptr.value);
const discountRateInvalid = computed(() => !discountRatePptr.value);

watch(() => props.modelValue.quotedRatePptr, value => {
    const formatted = formatLoanPptrAsPercentage(value);
    if (formatted !== formatLoanPptrAsPercentage(quotedRatePptr.value)) quotedRatePercent.value = formatted;
});
watch(() => props.modelValue.discountRatePptr, value => {
    const formatted = formatLoanPptrAsPercentage(value);
    if (formatted !== formatLoanPptrAsPercentage(discountRatePptr.value)) discountRatePercent.value = formatted;
});
watch(quotedRatePptr, value => {
    if (props.modelValue.inputMode === 'rate' && value !== props.modelValue.quotedRatePptr) updateField('quotedRatePptr', value);
});
watch(discountRatePptr, value => {
    if (props.modelValue.discountType === 'interest_rate' && value !== props.modelValue.discountRatePptr) updateField('discountRatePptr', value);
});

function updateField(field: keyof LoanCalculationInput, value: unknown): void {
    emit('update:modelValue', { ...props.modelValue, [field]: value });
}

function updateAmount(field: LoanEditableAmountField, value: number): void {
    emit('update:modelValue', updateLoanCalculationAmount(props.modelValue, field, value));
}

function updateTermCount(value: unknown): void {
    const termCount = typeof value === 'number' ? value : Number(value ?? 0);
    updateField('termCount', Number.isFinite(termCount) ? termCount : 0);
}

function normalizeQuotedRate(): void {
    quotedRatePercent.value = formatLoanPptrAsPercentage(props.modelValue.quotedRatePptr);
}

function normalizeDiscountRate(): void {
    discountRatePercent.value = formatLoanPptrAsPercentage(props.modelValue.discountRatePptr);
}

function changeInputMode(value: LoanInputMode): void {
    emit('update:modelValue', {
        ...props.modelValue,
        inputMode: value,
        quotedRatePptr: value === 'rate' ? '0' : undefined,
        paymentBasisAmount: value === 'repayment' ? 0 : undefined
    });
}

function changeRepaymentMethod(value: LoanRepaymentMethod): void {
    emit('update:modelValue', {
        ...props.modelValue,
        repaymentMethod: value,
        rateQuoteType: props.modelValue.rateQuoteType === 'installment' && value !== 'flat'
            ? 'annual'
            : props.modelValue.rateQuoteType
    });
}

function changeDiscountType(value: LoanDiscountType): void {
    emit('update:modelValue', {
        ...props.modelValue,
        discountType: value,
        discountRatePptr: value === 'interest_rate' ? '0' : undefined,
        discountAmount: 0
    });
}

</script>

<style scoped>
.calculator-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    background:
        radial-gradient(circle at 92% 15%, rgba(var(--v-theme-primary), 0.12), transparent 32%),
        rgb(var(--v-theme-surface));
}

.mode-toggle {
    width: 100%;
}

.mode-toggle :deep(.v-btn) {
    flex: 1;
}

@media (max-width: 599px) {
    .calculator-heading {
        flex-direction: column;
    }

}
</style>
