<template>
    <section class="schedule-panel overflow-hidden">
        <template v-if="detail">
            <div class="schedule-heading px-5 py-3">
                <div>
                    <div class="text-subtitle-1 font-weight-bold">{{ tt('personalFinance.loans.result.scheduleTitle') }}</div>
                    <div class="text-body-small text-medium-emphasis">
                        {{ tt('personalFinance.loans.schedule.revision', { revision: detail.currentRevision.revisionNumber }) }} ·
                        {{ tt('personalFinance.loans.schedule.asOf', { date: detail.asOfDate }) }}
                    </div>
                </div>
            </div>

            <v-divider />

            <div class="comparison-grid px-5 py-3">
                <section>
                    <span>{{ tt('personalFinance.loans.schedule.plannedOutstanding') }}</span>
                    <strong>{{ formatAmount(detail.liabilityComparison.plannedOutstandingPrincipalAmount) }}</strong>
                </section>
                <section>
                    <span>{{ tt('personalFinance.loans.schedule.ledgerLiability') }}</span>
                    <strong>{{ formatAmount(detail.liabilityComparison.ledgerOutstandingLiabilityAmount) }}</strong>
                </section>
                <section :class="{ 'comparison-warning': detail.liabilityComparison.actionRequired }">
                    <span>{{ tt('personalFinance.loans.schedule.difference') }}</span>
                    <strong>{{ formatAmount(detail.liabilityComparison.differenceAmount) }}</strong>
                </section>
            </div>

            <div class="boundary-note px-5 py-2">
                <v-icon size="16" :icon="mdiInformationOutline" />
                <span>{{ tt('personalFinance.loans.boundary.planIsNotPayment') }}</span>
            </div>

            <v-divider />

            <div class="schedule-table">
                <v-table density="compact" hover>
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
    </section>
</template>

<script setup lang="ts">
import { mdiCalendarMonthOutline, mdiInformationOutline } from '@mdi/js';

import { useI18n } from '@/locales/helpers.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';

import type { LoanContractDetail, LoanInstallment, LoanInstallmentDisplayStatus } from '../../models.ts';
import { getLoanInstallmentStatusKey, getLoanStatusColor } from '../../presentation.ts';
import { getLoanInstallmentDisplayStatus } from '../../state.ts';

const props = withDefaults(defineProps<{
    detail?: LoanContractDetail | null;
    selectedInstallmentId?: string;
}>(), {
    detail: null,
    selectedInstallmentId: undefined
});

const emit = defineEmits<{
    (e: 'selectInstallment', installmentId: string): void;
    (e: 'settle', installmentId: string): void;
}>();

const { tt, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
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
    display: block;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.schedule-heading {
    display: flex;
    align-items: center;
    gap: 20px;
}

.comparison-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0;
    background: rgba(var(--v-theme-on-surface), .018);
}

.comparison-grid section {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 7px 14px;
    border-inline-end: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.comparison-grid section:last-child { border-inline-end: 0; }

.comparison-grid span,
.comparison-grid small {
    color: rgba(var(--v-theme-on-surface), 0.62);
}

.comparison-grid strong {
    font-size: 1rem;
}

.comparison-grid .comparison-warning {
    color: rgb(var(--v-theme-error));
    background: rgba(var(--v-theme-error), 0.045);
}

.boundary-note { display: flex; align-items: center; gap: 7px; color: rgba(var(--v-theme-on-surface), .62); font-size: .78rem; }

.schedule-table {
    overflow-x: auto;
}

.installment-row {
    cursor: pointer;
}

.installment-row.selected {
    background: rgba(var(--v-theme-primary), 0.06);
}

.schedule-table :deep(th), .schedule-table :deep(td) { white-space: nowrap; }

@media (max-width: 959px) {
    .comparison-grid {
        grid-template-columns: 1fr;
    }
    .comparison-grid section { border-inline-end: 0; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
    .comparison-grid section:last-child { border-bottom: 0; }
}
</style>
