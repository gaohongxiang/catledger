<template>
    <div class="contract-list overflow-hidden">
        <v-skeleton-loader type="list-item-three-line@4" v-if="loading && !items.length" />

        <v-list class="contract-records pa-0" v-else-if="items.length">
            <template :key="item.contract.id" v-for="(item, index) in items">
                <v-list-item
                    class="contract-item px-4 py-3"
                    color="primary"
                    :active="selectedContractId === item.contract.id"
                    @click="emit('select', item.contract.id)"
                >
                    <div class="contract-row">
                        <div class="contract-identity">
                            <div class="contract-progress-mark" :class="{ 'needs-action': item.actionRequired }">
                                <strong>{{ item.paidInstallmentCount }}/{{ item.totalInstallmentCount }}</strong>
                                <span>{{ tt('personalFinance.loans.contracts.paidProgress') }}</span>
                            </div>
                            <div class="contract-copy">
                                <div class="contract-name-row">
                                    <strong class="contract-name">{{ item.contract.name }}</strong>
                                    <v-chip v-if="item.actionRequired" size="x-small" color="error" variant="tonal">
                                        {{ tt('personalFinance.loans.actionRequired') }}
                                    </v-chip>
                                </div>
                                <span class="contract-type">{{ tt(getLoanContractTypeKey(item.contract.contractType)) }}</span>
                            </div>
                        </div>

                        <div class="contract-stat">
                            <span>{{ tt('personalFinance.loans.portfolio.remainingPayment') }}</span>
                            <strong>{{ formatAmount(item.outstandingPaymentAmount, item.contract.currency) }}</strong>
                        </div>
                        <div class="contract-stat">
                            <span>{{ tt('personalFinance.loans.result.remainingPrincipal') }}</span>
                            <strong>{{ formatAmount(item.outstandingPrincipalAmount, item.contract.currency) }}</strong>
                        </div>
                        <div class="contract-stat contract-stat-next">
                            <span>{{ tt('personalFinance.loans.portfolio.nextPayment') }}</span>
                            <strong v-if="item.nextInstallment">
                                {{ formatAmount(item.nextInstallment.progress.outstandingPaymentAmount, item.contract.currency) }}
                            </strong>
                            <strong v-else>—</strong>
                            <small>{{ item.nextInstallment?.dueDate ?? tt('personalFinance.loans.portfolio.completed') }}</small>
                        </div>
                        <v-icon class="contract-arrow" :color="item.actionRequired ? 'error' : 'medium-emphasis'" :icon="item.actionRequired ? mdiAlertCircleOutline : mdiChevronRight" />
                    </div>
                </v-list-item>
                <v-divider v-if="index < items.length - 1" />
            </template>
        </v-list>

        <div class="empty-state pa-10 text-center" v-else>
            <v-icon color="medium-emphasis" size="50" :icon="mdiFileDocumentOutline" />
            <div class="text-h6 mt-4">{{ tt('personalFinance.loans.contracts.empty') }}</div>
            <div class="text-body-medium text-medium-emphasis mt-1">{{ tt('personalFinance.loans.contracts.emptyHint') }}</div>
        </div>

        <template v-if="hasMore">
            <v-divider />
            <div class="pa-4 text-center">
                <v-btn variant="tonal" :loading="loading" @click="emit('loadMore')">
                    {{ tt('personalFinance.loans.contracts.loadMore') }}
                </v-btn>
            </div>
        </template>
    </div>
</template>

<script setup lang="ts">
import { mdiAlertCircleOutline, mdiChevronRight, mdiFileDocumentOutline } from '@mdi/js';

import { useI18n } from '@/locales/helpers.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';

import type { LoanContractSummary } from '../../models.ts';
import { getLoanContractTypeKey } from '../../presentation.ts';

withDefaults(defineProps<{
    items: LoanContractSummary[];
    selectedContractId?: string;
    loading?: boolean;
    hasMore?: boolean;
}>(), {
    selectedContractId: undefined,
    loading: false,
    hasMore: false
});

const emit = defineEmits<{
    (e: 'select', contractId: string): void;
    (e: 'loadMore'): void;
}>();

const { tt, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();

function formatAmount(amount: number, currency: string): string {
    return formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(amount), currency);
}
</script>

<style scoped>
.contract-list {
    min-height: 320px;
    background: transparent;
}

.contract-item {
    min-height: 88px;
}

.contract-row {
    display: grid;
    grid-template-columns: minmax(260px, 1.45fr) repeat(3, minmax(132px, .7fr)) 28px;
    align-items: center;
    gap: 22px;
    width: 100%;
}

.contract-identity {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 14px;
}

.contract-progress-mark {
    display: grid;
    width: 56px;
    height: 48px;
    flex: 0 0 56px;
    place-items: center;
    border: 1px solid rgba(var(--v-theme-primary), 0.4);
    border-radius: 10px;
    color: rgb(var(--v-theme-primary));
    line-height: 1.05;
}

.contract-progress-mark strong { font-size: .82rem; }
.contract-progress-mark span { font-size: .62rem; font-weight: 700; opacity: .82; }
.contract-copy { display: grid; min-width: 0; gap: 4px; }
.contract-name-row { display: flex; min-width: 0; align-items: center; gap: 8px; }
.contract-name { overflow: hidden; font-size: .96rem; text-overflow: ellipsis; white-space: nowrap; }
.contract-type { color: rgba(var(--v-theme-on-surface), .62); font-size: .75rem; }

.contract-stat {
    display: grid;
    min-width: 0;
    gap: 3px;
}

.contract-stat span,
.contract-stat small {
    overflow: hidden;
    color: rgba(var(--v-theme-on-surface), .58);
    font-size: .72rem;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.contract-stat strong {
    overflow: hidden;
    font-size: .88rem;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.contract-stat-next strong { color: rgb(var(--v-theme-primary)); }
.contract-arrow { justify-self: end; }

.contract-progress-mark.needs-action {
    border-color: rgb(var(--v-theme-error));
    color: rgb(var(--v-theme-error));
}

@media (max-width: 959px) {
    .contract-row { grid-template-columns: minmax(220px, 1.3fr) repeat(2, minmax(120px, .7fr)) 24px; gap: 14px; }
    .contract-stat-next { display: none; }
}

@media (max-width: 699px) {
    .contract-row { grid-template-columns: minmax(0, 1fr) 24px; }
    .contract-stat { display: none; }
}

.empty-state {
    color: rgba(var(--v-theme-on-surface), 0.7);
}
</style>
