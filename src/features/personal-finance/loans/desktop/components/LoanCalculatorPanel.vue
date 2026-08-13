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
                    <v-text-field
                        type="number"
                        min="1"
                        :label="tt('personalFinance.loans.field.principal')"
                        :disabled="disabled || loading"
                        :model-value="modelValue.principalAmount"
                        @update:model-value="value => updateAmount('principalAmount', value)"
                    />
                </v-col>
                <v-col cols="12" sm="6" md="4">
                    <v-text-field
                        type="number"
                        min="1"
                        :label="tt('personalFinance.loans.field.actualDisbursement')"
                        :disabled="disabled || loading"
                        :model-value="modelValue.actualDisbursementAmount"
                        @update:model-value="value => updateAmount('actualDisbursementAmount', value)"
                    />
                </v-col>
                <v-col cols="12" sm="6" md="4">
                    <v-text-field
                        type="number"
                        min="1"
                        :label="tt('personalFinance.loans.field.termCount')"
                        :disabled="disabled || loading"
                        :model-value="modelValue.termCount"
                        @update:model-value="value => updateAmount('termCount', value)"
                    />
                </v-col>
                <v-col cols="12" sm="6" md="4">
                    <v-text-field
                        type="number"
                        min="0"
                        :label="tt('personalFinance.loans.field.upfrontFee')"
                        :disabled="disabled || loading"
                        :model-value="modelValue.upfrontFeeAmount"
                        @update:model-value="value => updateAmount('upfrontFeeAmount', value)"
                    />
                </v-col>
                <v-col cols="12" sm="6" md="4">
                    <v-text-field
                        type="number"
                        min="0"
                        :label="tt('personalFinance.loans.field.perPeriodFee')"
                        :disabled="disabled || loading"
                        :model-value="modelValue.perPeriodFeeAmount"
                        @update:model-value="value => updateAmount('perPeriodFeeAmount', value)"
                    />
                </v-col>
                <v-col cols="12" sm="6" md="4" v-if="modelValue.inputMode === 'repayment'">
                    <v-text-field
                        type="number"
                        min="1"
                        :label="tt('personalFinance.loans.field.paymentBasis')"
                        :disabled="disabled || loading"
                        :model-value="modelValue.paymentBasisAmount"
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
                            inputmode="numeric"
                            :label="tt('personalFinance.loans.field.quotedRatePptr')"
                            :hint="tt('personalFinance.loans.field.pptrHint')"
                            persistent-hint
                            :disabled="disabled || loading"
                            :model-value="modelValue.quotedRatePptr"
                            @update:model-value="value => updateField('quotedRatePptr', value)"
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
                        inputmode="numeric"
                        :label="tt('personalFinance.loans.field.discountRatePptr')"
                        :disabled="disabled || loading"
                        :model-value="modelValue.discountRatePptr"
                        @update:model-value="value => updateField('discountRatePptr', value)"
                    />
                </v-col>
                <v-col cols="12" md="4" v-else-if="modelValue.discountType !== 'none'">
                    <v-text-field
                        type="number"
                        min="1"
                        :label="tt('personalFinance.loans.field.discountAmount')"
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
            <div class="result-grid pa-5 pa-lg-6">
                <div class="result-primary">
                    <span>{{ tt('personalFinance.loans.result.totalPayment') }}</span>
                    <strong>{{ formatAmount(result.summary.totalPaymentAmount) }}</strong>
                </div>
                <div>
                    <span>{{ tt('personalFinance.loans.result.totalCost') }}</span>
                    <strong>{{ formatAmount(result.summary.totalCostAmount) }}</strong>
                </div>
                <div>
                    <span>{{ tt('personalFinance.loans.result.effectiveApr') }}</span>
                    <strong>{{ formatPptr(result.summary.effectiveAprPptr) }}</strong>
                </div>
                <div>
                    <span>{{ tt('personalFinance.loans.result.installments') }}</span>
                    <strong>{{ result.installments.length }}</strong>
                </div>
            </div>
        </template>
    </v-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { useI18n } from '@/locales/helpers.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';

import type {
    LoanCalculationInput,
    LoanCalculationResult,
    LoanDiscountType,
    LoanInputMode,
    LoanRepaymentMethod
} from '../../models.ts';

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

const { tt, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();

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

function updateField(field: keyof LoanCalculationInput, value: unknown): void {
    emit('update:modelValue', { ...props.modelValue, [field]: value });
}

function updateAmount(field: keyof LoanCalculationInput, value: unknown): void {
    const amount = typeof value === 'number' ? value : Number(value ?? 0);
    updateField(field, Number.isFinite(amount) ? amount : 0);
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

function formatAmount(amount: number): string {
    return formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(amount), props.currency);
}

function formatPptr(value?: string): string {
    return value ? `${parseBigDecimal(value).divide(10000000000).toString()}%` : tt('Unknown');
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

.result-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    background: rgba(var(--v-theme-primary), 0.035);
}

.result-grid > div {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 16px;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    border-radius: 12px;
    background: rgb(var(--v-theme-surface));
}

.result-grid span {
    color: rgba(var(--v-theme-on-surface), 0.62);
    font-size: 0.78rem;
}

.result-grid strong {
    font-size: 1.08rem;
}

.result-grid .result-primary {
    border-color: rgba(var(--v-theme-primary), 0.4);
}

@media (max-width: 959px) {
    .result-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}

@media (max-width: 599px) {
    .calculator-heading {
        flex-direction: column;
    }

    .result-grid {
        grid-template-columns: 1fr;
    }
}
</style>
