<template>
    <div class="loan-result-panel">
        <div class="result-grid">
            <div v-if="showActualDisbursement">
                <span>{{ tt('personalFinance.loans.result.actualDisbursement') }}</span>
                <strong>{{ formatAmount(input.actualDisbursementAmount) }}</strong>
            </div>
            <div>
                <span>{{ tt('personalFinance.loans.result.principal') }}</span>
                <strong>{{ formatAmount(input.principalAmount) }}</strong>
            </div>
            <div class="result-primary">
                <span>{{ tt('personalFinance.loans.result.totalPayment') }}</span>
                <strong>{{ formatAmount(result.summary.totalPaymentAmount) }}</strong>
            </div>
            <div>
                <span>{{ tt('personalFinance.loans.result.totalInterest') }}</span>
                <strong>{{ formatAmount(result.summary.totalInterestAmount) }}</strong>
            </div>
            <div>
                <span>{{ tt('personalFinance.loans.result.totalFees') }}</span>
                <strong>{{ formatAmount(result.summary.totalFeeAmount) }}</strong>
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
                <span>{{ tt('personalFinance.loans.result.costRatio') }}</span>
                <strong>{{ formatPptr(result.summary.costRatioPptr) }}</strong>
            </div>
        </div>

        <template v-if="showInstallments">
            <div class="text-subtitle-1 font-weight-bold mt-6 mb-3">
                {{ tt('personalFinance.loans.result.scheduleTitle') }}
            </div>
            <v-table class="result-table" density="comfortable">
                <thead>
                    <tr>
                        <th>{{ tt('personalFinance.loans.result.period') }}</th>
                        <th>{{ tt('personalFinance.loans.result.dueDate') }}</th>
                        <th class="text-end">{{ tt('personalFinance.loans.result.principalPayment') }}</th>
                        <th class="text-end">{{ tt('personalFinance.loans.result.interest') }}</th>
                        <th class="text-end">{{ tt('personalFinance.loans.result.fee') }}</th>
                        <th class="text-end">{{ tt('personalFinance.loans.result.payment') }}</th>
                        <th class="text-end">{{ tt('personalFinance.loans.result.remainingPrincipal') }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr :key="installment.installmentNumber" v-for="installment in result.installments">
                        <td>{{ installment.installmentNumber }}</td>
                        <td>{{ installment.dueDate }}</td>
                        <td class="text-end">{{ formatAmount(installment.principalAmount) }}</td>
                        <td class="text-end">{{ formatAmount(installment.interestAmount) }}</td>
                        <td class="text-end">{{ formatAmount(installment.feeAmount) }}</td>
                        <td class="text-end font-weight-medium">{{ formatAmount(installment.paymentAmount) }}</td>
                        <td class="text-end">{{ formatAmount(installment.endingPrincipalAmount) }}</td>
                    </tr>
                </tbody>
            </v-table>
        </template>
    </div>
</template>

<script setup lang="ts">
import { useI18n } from '@/locales/helpers.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';

import type { LoanCalculationInput, LoanCalculationResult } from '../../models.ts';
import { formatLoanPptrAsPercentage } from '../../state.ts';

const props = withDefaults(defineProps<{
    input: LoanCalculationInput;
    result: LoanCalculationResult;
    currency: string;
    showInstallments?: boolean;
    showActualDisbursement?: boolean;
}>(), {
    showInstallments: true,
    showActualDisbursement: true
});

const { tt, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();

function formatAmount(amount: number): string {
    return formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(amount), props.currency);
}

function formatPptr(value?: string): string {
    const percentage = formatLoanPptrAsPercentage(value, 2);
    return percentage ? `${percentage}%` : tt('Unknown');
}
</script>

<style scoped>
.result-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
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

.result-table {
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    border-radius: 12px;
}

@media (max-width: 959px) {
    .result-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 599px) {
    .result-grid { grid-template-columns: 1fr; }
}
</style>
