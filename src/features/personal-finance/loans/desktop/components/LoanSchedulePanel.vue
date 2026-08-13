<template>
    <v-card class="schedule-panel overflow-hidden" variant="outlined">
        <template v-if="detail">
            <div class="schedule-heading pa-5 pa-lg-6">
                <div>
                    <div class="d-flex flex-wrap align-center ga-2">
                        <h3 class="text-h5 font-weight-bold">{{ detail.contract.name }}</h3>
                        <v-chip size="small" :color="getLoanStatusColor(detail.contract.status)" variant="tonal">
                            {{ tt(getLoanContractStatusKey(detail.contract.status)) }}
                        </v-chip>
                    </div>
                    <div class="text-body-small text-medium-emphasis mt-2">
                        {{ tt(getLoanRepaymentMethodKey(detail.currentRevision.input.repaymentMethod)) }} ·
                        {{ tt('personalFinance.loans.schedule.revision', { revision: detail.currentRevision.revisionNumber }) }} ·
                        {{ tt('personalFinance.loans.schedule.asOf', { date: detail.asOfDate }) }}
                    </div>
                </div>
                <v-spacer />
                <v-btn variant="tonal" :disabled="!canRevise" @click="emit('revise')">
                    {{ tt('personalFinance.loans.schedule.revise') }}
                </v-btn>
            </div>

            <v-divider />

            <div class="comparison-grid pa-5 pa-lg-6">
                <section>
                    <span>{{ tt('personalFinance.loans.schedule.plannedOutstanding') }}</span>
                    <strong>{{ formatAmount(detail.liabilityComparison.plannedOutstandingPrincipalAmount) }}</strong>
                    <small>{{ tt('personalFinance.loans.schedule.planSource') }}</small>
                </section>
                <section>
                    <span>{{ tt('personalFinance.loans.schedule.ledgerLiability') }}</span>
                    <strong>{{ formatAmount(detail.liabilityComparison.ledgerOutstandingLiabilityAmount) }}</strong>
                    <small>{{ tt('personalFinance.loans.schedule.ledgerSource') }}</small>
                </section>
                <section :class="{ 'comparison-warning': detail.liabilityComparison.actionRequired }">
                    <span>{{ tt('personalFinance.loans.schedule.difference') }}</span>
                    <strong>{{ formatAmount(detail.liabilityComparison.differenceAmount) }}</strong>
                    <small>{{ tt('personalFinance.loans.schedule.differenceHint') }}</small>
                </section>
            </div>

            <div class="px-5 px-lg-6 pb-5">
                <v-alert type="info" variant="tonal">
                    {{ tt('personalFinance.loans.boundary.planIsNotPayment') }}
                </v-alert>
            </div>

            <v-divider />

            <div class="schedule-table">
                <v-table hover>
                    <thead>
                        <tr>
                            <th>{{ tt('personalFinance.loans.schedule.period') }}</th>
                            <th>{{ tt('personalFinance.loans.schedule.dueDate') }}</th>
                            <th class="text-end">{{ tt('personalFinance.loans.component.principal') }}</th>
                            <th class="text-end">{{ tt('personalFinance.loans.component.interest') }}</th>
                            <th class="text-end">{{ tt('personalFinance.loans.component.fee') }}</th>
                            <th class="text-end">{{ tt('personalFinance.loans.schedule.payment') }}</th>
                            <th>{{ tt('personalFinance.loans.schedule.state') }}</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        <tr
                            class="installment-row"
                            :class="{ selected: selectedInstallmentId === item.id }"
                            :key="item.id"
                            v-for="item in detail.installments"
                            @click="emit('selectInstallment', item.id)"
                        >
                            <td class="font-weight-bold">{{ item.installmentNumber }}</td>
                            <td>{{ item.dueDate }}</td>
                            <td class="text-end">{{ formatAmount(item.principalAmount) }}</td>
                            <td class="text-end">{{ formatAmount(item.interestAmount) }}</td>
                            <td class="text-end">{{ formatAmount(item.feeAmount) }}</td>
                            <td class="text-end font-weight-medium">{{ formatAmount(item.paymentAmount) }}</td>
                            <td>
                                <v-chip size="x-small" :color="getLoanStatusColor(displayStatus(item))" variant="tonal">
                                    {{ tt(getLoanInstallmentStatusKey(displayStatus(item))) }}
                                </v-chip>
                            </td>
                            <td class="text-end">
                                <v-btn
                                    size="small"
                                    variant="text"
                                    :disabled="detail.contract.status !== 'active'"
                                    @click.stop="emit('settle', item.id)"
                                >
                                    {{ tt('personalFinance.loans.schedule.allocate') }}
                                </v-btn>
                            </td>
                        </tr>
                    </tbody>
                </v-table>
            </div>
        </template>

        <div class="empty-detail pa-12 text-center" v-else>
            <v-icon color="medium-emphasis" size="56" :icon="mdiCalendarMonthOutline" />
            <div class="text-h6 mt-4">{{ tt('personalFinance.loans.schedule.empty') }}</div>
            <div class="text-body-medium text-medium-emphasis mt-1">{{ tt('personalFinance.loans.schedule.emptyHint') }}</div>
        </div>
    </v-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { mdiCalendarMonthOutline } from '@mdi/js';

import { useI18n } from '@/locales/helpers.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';

import type { LoanContractDetail, LoanInstallment, LoanInstallmentDisplayStatus } from '../../models.ts';
import {
    getLoanContractStatusKey,
    getLoanInstallmentStatusKey,
    getLoanRepaymentMethodKey,
    getLoanStatusColor
} from '../../presentation.ts';
import { canReviseLoanContract, getLoanInstallmentDisplayStatus } from '../../state.ts';

const props = withDefaults(defineProps<{
    detail?: LoanContractDetail | null;
    selectedInstallmentId?: string;
}>(), {
    detail: null,
    selectedInstallmentId: undefined
});

const emit = defineEmits<{
    (e: 'revise'): void;
    (e: 'selectInstallment', installmentId: string): void;
    (e: 'settle', installmentId: string): void;
}>();

const { tt, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
const canRevise = computed(() => canReviseLoanContract(props.detail ?? null));

function displayStatus(item: LoanInstallment): LoanInstallmentDisplayStatus {
    return getLoanInstallmentDisplayStatus(item);
}

function formatAmount(amount: number): string {
    return props.detail
        ? formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(amount), props.detail.contract.currency)
        : String(amount);
}
</script>

<style scoped>
.schedule-panel {
    min-height: 520px;
}

.schedule-heading {
    display: flex;
    align-items: center;
    gap: 20px;
}

.comparison-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
}

.comparison-grid section {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 16px;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    border-radius: 12px;
}

.comparison-grid span,
.comparison-grid small {
    color: rgba(var(--v-theme-on-surface), 0.62);
}

.comparison-grid strong {
    font-size: 1.15rem;
}

.comparison-grid .comparison-warning {
    border-color: rgba(var(--v-theme-error), 0.55);
    background: rgba(var(--v-theme-error), 0.04);
}

.schedule-table {
    overflow-x: auto;
}

.installment-row {
    cursor: pointer;
}

.installment-row.selected {
    background: rgba(var(--v-theme-primary), 0.06);
}

@media (max-width: 959px) {
    .comparison-grid {
        grid-template-columns: 1fr;
    }
}
</style>
