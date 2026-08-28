<template>
    <v-card class="loan-calculator overflow-hidden" :class="{ 'loan-calculator--embedded': embedded }" :variant="embedded ? 'flat' : 'outlined'">
        <div class="calculator-heading pa-5 pa-lg-6" v-if="!embedded">
            <div>
                <div class="text-overline text-primary">{{ tt(headingKeys.eyebrow) }}</div>
                <h3 class="text-h5 font-weight-bold mt-1">{{ tt(headingKeys.title) }}</h3>
                <p class="text-body-medium text-medium-emphasis mt-2 mb-0">
                    {{ tt(headingKeys.subtitle) }}
                </p>
            </div>
            <v-chip color="primary" variant="tonal">{{ currency }}</v-chip>
        </div>

        <v-divider v-if="!embedded" />

        <v-card-text :class="embedded ? (compactInstallment ? 'px-5 pb-5 pt-2' : 'px-5 pb-5 pt-0') : 'pa-5 pa-lg-6'">
            <v-alert class="mb-5" type="info" variant="tonal" v-if="!embedded">
                {{ tt(headingKeys.boundary) }}
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
                v-if="!compactInstallment"
            >
                <v-btn value="rate">{{ tt('personalFinance.loans.inputMode.rate') }}</v-btn>
                <v-btn value="repayment">{{ tt('personalFinance.loans.inputMode.repayment') }}</v-btn>
            </v-btn-toggle>

            <v-row>
                <v-col cols="12" sm="6" md="4" order="1" v-if="compactInstallment">
                    <slot name="compact-liability-account" />
                </v-col>
                <v-col cols="12" md="6" v-if="!compactInstallment">
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
                <v-col cols="12" sm="6" :md="compactInstallment ? (showOpeningCompletedInstallmentCount ? 4 : 6) : 6" :order="compactInstallment ? 4 : undefined">
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
                <v-col cols="12" sm="6" v-if="!compactInstallment">
                    <v-text-field
                        type="date"
                        :label="tt('personalFinance.loans.field.effectiveDate')"
                        :disabled="disabled || loading"
                        :model-value="modelValue.effectiveDate"
                        @update:model-value="value => updateField('effectiveDate', value)"
                    />
                </v-col>
                <v-col cols="12" sm="6" v-if="!compactInstallment">
                    <v-text-field
                        type="date"
                        :label="tt('personalFinance.loans.field.contractDate')"
                        :disabled="disabled || loading"
                        :model-value="modelValue.contractDate"
                        @update:model-value="value => updateField('contractDate', value)"
                    />
                </v-col>
                <v-col cols="12" sm="6" :md="compactInstallment ? (showOpeningCompletedInstallmentCount ? 4 : 6) : undefined" :order="compactInstallment ? 5 : undefined">
                    <v-text-field
                        type="date"
                        :label="tt('personalFinance.loans.field.firstDueDate')"
                        :disabled="disabled || loading"
                        :model-value="modelValue.firstDueDate"
                        @update:model-value="value => updateField('firstDueDate', value)"
                    />
                </v-col>
                <v-col cols="12" sm="6" md="4" order="6" v-if="compactInstallment && showOpeningCompletedInstallmentCount">
                    <v-text-field
                        type="number"
                        min="0"
                        :max="Math.max(0, modelValue.termCount - 1)"
                        :label="tt('personalFinance.loans.installmentRecord.field.completedInstallments')"
                        :disabled="disabled || loading"
                        :model-value="openingCompletedInstallmentCount"
                        @update:model-value="updateOpeningCompletedInstallmentCount"
                    />
                </v-col>
                <v-col cols="12" sm="6" :md="compactInstallment ? 4 : 4" :order="compactInstallment ? 2 : undefined">
                    <amount-input
                        :label="tt(compactInstallment ? 'personalFinance.loans.installmentRecord.field.principal' : 'personalFinance.loans.field.principal')"
                        :currency="currency"
                        show-currency
                        :disabled="disabled || loading"
                        :model-value="modelValue.principalAmount"
                        @update:model-value="value => updateAmount('principalAmount', value)"
                    />
                </v-col>
                <v-col cols="12" sm="6" md="4" v-if="!compactInstallment">
                    <amount-input
                        :label="tt('personalFinance.loans.field.actualDisbursement')"
                        :currency="currency"
                        show-currency
                        readonly
                        :disabled="disabled || loading"
                        :model-value="modelValue.actualDisbursementAmount"
                    />
                </v-col>
                <v-col cols="12" sm="6" :md="compactInstallment ? 4 : 4" :order="compactInstallment ? 3 : undefined">
                    <v-text-field
                        type="number"
                        min="1"
                        :label="tt('personalFinance.loans.field.termCount')"
                        :disabled="disabled || loading"
                        :model-value="modelValue.termCount"
                        @update:model-value="updateTermCount"
                    />
                </v-col>
                <v-col cols="12" sm="6" md="4" v-if="!compactInstallment">
                    <amount-input
                        :label="tt('personalFinance.loans.field.upfrontFee')"
                        :currency="currency"
                        show-currency
                        :disabled="disabled || loading"
                        :model-value="modelValue.upfrontFeeAmount"
                        @update:model-value="value => updateAmount('upfrontFeeAmount', value)"
                    />
                </v-col>
                <v-col cols="12" sm="6" md="4" v-if="!compactInstallment">
                    <amount-input
                        :label="tt('personalFinance.loans.field.perPeriodFee')"
                        :currency="currency"
                        show-currency
                        :disabled="disabled || loading"
                        :model-value="modelValue.perPeriodFeeAmount"
                        @update:model-value="value => updateAmount('perPeriodFeeAmount', value)"
                    />
                </v-col>
                <v-col cols="12" order="7" v-if="compactInstallment">
                    <div class="measurement-heading mb-2">{{ tt('personalFinance.loans.installmentRecord.field.measurementBasis') }}</div>
                    <v-btn-toggle
                        class="mode-toggle"
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
                </v-col>
                <v-col cols="12" sm="6" :md="compactInstallment ? 12 : 4" :order="compactInstallment ? 8 : undefined" v-if="modelValue.inputMode === 'repayment'">
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
                    <v-col cols="12" sm="6" :md="compactInstallment ? 6 : 4" :order="compactInstallment ? 8 : undefined">
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
                    <v-col cols="12" sm="6" :md="compactInstallment ? 6 : 4" :order="compactInstallment ? 8 : undefined">
                        <v-text-field
                            inputmode="decimal"
                            suffix="%"
                            :label="tt('personalFinance.loans.field.quotedRatePercent')"
                            :hint="compactInstallment ? undefined : tt('personalFinance.loans.field.percentageHint')"
                            :error="quotedRateInvalid"
                            :persistent-hint="!compactInstallment"
                            :disabled="disabled || loading"
                            :model-value="quotedRatePercent"
                            @update:model-value="updateQuotedRatePercent"
                            @blur="normalizeQuotedRate"
                        />
                    </v-col>
                </template>
                <v-col cols="12" md="4" v-if="!compactInstallment">
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
                <v-col cols="12" md="4" v-if="!compactInstallment && modelValue.discountType === 'interest_rate'">
                    <v-text-field
                        inputmode="decimal"
                        suffix="%"
                        :label="tt('personalFinance.loans.field.discountRatePercent')"
                        :hint="tt('personalFinance.loans.field.percentageHint')"
                        :error="discountRateInvalid"
                        persistent-hint
                        :disabled="disabled || loading"
                        :model-value="discountRatePercent"
                        @update:model-value="updateDiscountRatePercent"
                        @blur="normalizeDiscountRate"
                    />
                </v-col>
                <v-col cols="12" md="4" v-else-if="!compactInstallment && modelValue.discountType !== 'none'">
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

            <v-expansion-panels class="supplementary-panel mt-2" variant="accordion" v-if="compactInstallment">
                <v-expansion-panel elevation="0">
                    <v-expansion-panel-title>
                        <div>
                            <strong>{{ tt('personalFinance.loans.installmentRecord.extra.title') }}</strong>
                            <small>{{ tt('personalFinance.loans.installmentRecord.extra.hint') }}</small>
                        </div>
                    </v-expansion-panel-title>
                    <v-expansion-panel-text>
                        <div class="compact-extra-grid">
                            <div class="compact-field-pair" :class="{ 'compact-field-pair--single': compactFeeType === 'none' }">
                                <v-select
                                    item-title="title"
                                    item-value="value"
                                    :items="compactFeeTypeOptions"
                                    :label="tt('personalFinance.loans.installmentRecord.extra.fee')"
                                    :disabled="disabled || loading"
                                    :model-value="compactFeeType"
                                    @update:model-value="changeCompactFeeType"
                                />
                                <div class="compact-amount-field" v-if="compactFeeType !== 'none'">
                                    <amount-input
                                        :label="tt(compactFeeType === 'upfront' ? 'personalFinance.loans.installmentRecord.extra.oneTimeFee' : 'personalFinance.loans.installmentRecord.extra.perPeriodFee')"
                                        :currency="currency"
                                        show-currency
                                        :disabled="disabled || loading"
                                        :model-value="compactFeeAmount"
                                        @update:model-value="updateCompactFeeAmount"
                                    />
                                </div>
                            </div>
                            <div class="compact-field-pair" :class="{ 'compact-field-pair--single': modelValue.discountType === 'none' }">
                                <v-select
                                    item-title="title"
                                    item-value="value"
                                    :items="discountTypeOptions"
                                    :label="tt('personalFinance.loans.field.discountType')"
                                    :disabled="disabled || loading"
                                    :model-value="modelValue.discountType"
                                    @update:model-value="changeDiscountType"
                                />
                                <v-text-field
                                    v-if="modelValue.discountType === 'interest_rate'"
                                    inputmode="decimal"
                                    suffix="%"
                                    :label="tt('personalFinance.loans.field.discountRatePercent')"
                                    :error="discountRateInvalid"
                                    :disabled="disabled || loading"
                                    :model-value="discountRatePercent"
                                    @update:model-value="updateDiscountRatePercent"
                                    @blur="normalizeDiscountRate"
                                />
                                <div class="compact-amount-field" v-else-if="modelValue.discountType !== 'none'">
                                    <amount-input
                                        :label="tt('personalFinance.loans.field.discountAmount')"
                                        :currency="currency"
                                        show-currency
                                        :disabled="disabled || loading"
                                        :model-value="modelValue.discountAmount"
                                        @update:model-value="value => updateAmount('discountAmount', value)"
                                    />
                                </div>
                            </div>
                        </div>
                    </v-expansion-panel-text>
                </v-expansion-panel>
            </v-expansion-panels>

            <div class="d-flex justify-end mt-2">
                <v-btn color="primary" size="large" :disabled="disabled" :loading="loading" @click="emit('calculate')">
                    {{ tt(headingKeys.action) }}
                </v-btn>
            </div>
        </v-card-text>

        <template v-if="result">
            <v-divider />
            <loan-calculation-result-panel class="pa-5 pa-lg-6" :input="modelValue" :result="result" :currency="currency" :show-actual-disbursement="!compactInstallment" />
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
    normalizeLoanPercentageTextInput,
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
    purpose?: 'calculation' | 'installment-record';
    embedded?: boolean;
    compactInstallment?: boolean;
    openingCompletedInstallmentCount?: number;
    showOpeningCompletedInstallmentCount?: boolean;
}>(), {
    result: undefined,
    loading: false,
    disabled: false,
    purpose: 'calculation',
    embedded: false,
    compactInstallment: false,
    openingCompletedInstallmentCount: 0,
    showOpeningCompletedInstallmentCount: true
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: LoanCalculationInput): void;
    (e: 'update:openingCompletedInstallmentCount', value: number): void;
    (e: 'calculate'): void;
}>();

const { tt } = useI18n();
const headingKeys = computed(() => props.purpose === 'installment-record' ? {
    eyebrow: 'personalFinance.loans.installmentRecord.eyebrow',
    title: 'personalFinance.loans.installmentRecord.title',
    subtitle: 'personalFinance.loans.installmentRecord.subtitle',
    boundary: 'personalFinance.loans.installmentRecord.boundary',
    action: 'personalFinance.loans.installmentRecord.calculate'
} : {
    eyebrow: 'personalFinance.loans.calculator.eyebrow',
    title: 'personalFinance.loans.calculator.title',
    subtitle: 'personalFinance.loans.calculator.subtitle',
    boundary: 'personalFinance.loans.boundary.calculationIsNotLedger',
    action: 'personalFinance.loans.calculator.calculate'
});

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
const compactFeeTypeOptions = computed(() => [
    { title: tt('personalFinance.loans.installmentRecord.extra.none'), value: 'none' },
    { title: tt('personalFinance.loans.installmentRecord.extra.oneTimeFee'), value: 'upfront' },
    { title: tt('personalFinance.loans.installmentRecord.extra.perPeriodFee'), value: 'per_period' }
]);
const compactFeeType = ref<'none' | 'upfront' | 'per_period'>(
    props.modelValue.upfrontFeeAmount > 0
        ? 'upfront'
        : props.modelValue.perPeriodFeeAmount > 0 ? 'per_period' : 'none'
);
const compactFeeAmount = computed(() => {
    if (compactFeeType.value === 'upfront') return props.modelValue.upfrontFeeAmount;
    if (compactFeeType.value === 'per_period') return props.modelValue.perPeriodFeeAmount;
    return 0;
});
const quotedRatePercent = ref(formatLoanPptrAsPercentage(props.modelValue.quotedRatePptr));
const discountRatePercent = ref(formatLoanPptrAsPercentage(props.modelValue.discountRatePptr));
const quotedRatePptr = computed(() => normalizeLoanPercentageInput(quotedRatePercent.value, undefined, true, 4));
const discountRatePptr = computed(() => normalizeLoanPercentageInput(discountRatePercent.value, '1000000000000', false, 4));
const quotedRateInvalid = computed(() => !quotedRatePptr.value);
const discountRateInvalid = computed(() => !discountRatePptr.value);

function updateQuotedRatePercent(value: unknown): void {
    quotedRatePercent.value = normalizeLoanPercentageTextInput(String(value ?? ''));
}

function updateDiscountRatePercent(value: unknown): void {
    discountRatePercent.value = normalizeLoanPercentageTextInput(String(value ?? ''));
}

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

function updateCompactFeeAmount(value: number): void {
    if (compactFeeType.value === 'none') return;
    updateAmount(compactFeeType.value === 'upfront' ? 'upfrontFeeAmount' : 'perPeriodFeeAmount', value);
}

function changeCompactFeeType(value: 'none' | 'upfront' | 'per_period'): void {
    const amount = compactFeeAmount.value;
    compactFeeType.value = value;

    const cleared: LoanCalculationInput = {
        ...props.modelValue,
        upfrontFeeAmount: 0,
        perPeriodFeeAmount: 0,
        actualDisbursementAmount: props.modelValue.principalAmount
    };
    if (value === 'none') {
        emit('update:modelValue', cleared);
        return;
    }
    emit('update:modelValue', updateLoanCalculationAmount(cleared, value === 'upfront' ? 'upfrontFeeAmount' : 'perPeriodFeeAmount', amount));
}

function updateTermCount(value: unknown): void {
    const termCount = typeof value === 'number' ? value : Number(value ?? 0);
    updateField('termCount', Number.isFinite(termCount) ? termCount : 0);
}

function updateOpeningCompletedInstallmentCount(value: unknown): void {
    const parsed = typeof value === 'number' ? value : Number(value ?? 0);
    const maximum = Math.max(0, props.modelValue.termCount - 1);
    const completed = Number.isFinite(parsed) ? Math.max(0, Math.min(maximum, Math.trunc(parsed))) : 0;
    emit('update:openingCompletedInstallmentCount', completed);
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

.loan-calculator--embedded {
    border-radius: 0;
    background: transparent;
}

.loan-calculator--embedded .calculator-heading {
    background: transparent;
}

.supplementary-panel {
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    border-radius: 12px;
    overflow: hidden;
}

.supplementary-panel :deep(.v-expansion-panel-title > div) {
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.supplementary-panel small {
    color: rgba(var(--v-theme-on-surface), .58);
    font-size: .76rem;
    font-weight: 400;
}

.compact-extra-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    align-items: start;
}

.compact-field-pair {
    display: grid;
    grid-template-columns: minmax(132px, .42fr) minmax(0, .58fr);
    gap: 8px;
    min-width: 0;
}

.compact-field-pair--single {
    grid-template-columns: 1fr;
}

.compact-amount-field {
    min-width: 0;
}

@media (max-width: 599px) {
    .calculator-heading {
        flex-direction: column;
    }

    .compact-extra-grid {
        grid-template-columns: 1fr;
    }

}
</style>
