<template>
    <v-card class="contract-list overflow-hidden" variant="outlined">
        <div class="d-flex align-center ga-3 px-5 py-4">
            <div>
                <div class="text-subtitle-1 font-weight-bold">{{ tt('personalFinance.loans.contracts.title') }}</div>
                <div class="text-body-small text-medium-emphasis">{{ tt('personalFinance.loans.contracts.subtitle') }}</div>
            </div>
            <v-spacer />
            <v-btn color="primary" size="small" variant="tonal" :disabled="loading" @click="emit('create')">
                {{ tt('personalFinance.loans.contracts.create') }}
            </v-btn>
        </div>

        <v-divider />

        <v-skeleton-loader type="list-item-three-line@4" v-if="loading && !items.length" />

        <v-list class="pa-0" lines="three" v-else-if="items.length">
            <template :key="item.contract.id" v-for="(item, index) in items">
                <v-list-item
                    class="contract-item px-5 py-4"
                    color="primary"
                    :active="selectedContractId === item.contract.id"
                    @click="emit('select', item.contract.id)"
                >
                    <template #prepend>
                        <div class="contract-mark" :class="{ 'needs-action': item.actionRequired }">
                            {{ item.paidInstallmentCount }}/{{ item.totalInstallmentCount }}
                        </div>
                    </template>
                    <v-list-item-title class="font-weight-bold">{{ item.contract.name }}</v-list-item-title>
                    <v-list-item-subtitle class="mt-1">
                        {{ tt(getLoanContractTypeKey(item.contract.contractType)) }} · {{ item.contract.lenderName }}
                    </v-list-item-subtitle>
                    <v-list-item-subtitle class="mt-2 d-flex flex-wrap align-center ga-2">
                        <v-chip size="x-small" :color="getLoanStatusColor(item.contract.status)" variant="tonal">
                            {{ tt(getLoanContractStatusKey(item.contract.status)) }}
                        </v-chip>
                        <span>{{ tt('personalFinance.loans.contracts.outstanding', { amount: formatAmount(item.outstandingPrincipalAmount, item.contract.currency) }) }}</span>
                    </v-list-item-subtitle>
                    <template #append>
                        <v-icon :color="item.actionRequired ? 'error' : 'medium-emphasis'" :icon="item.actionRequired ? mdiAlertCircleOutline : mdiChevronRight" />
                    </template>
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
    </v-card>
</template>

<script setup lang="ts">
import { mdiAlertCircleOutline, mdiChevronRight, mdiFileDocumentOutline } from '@mdi/js';

import { useI18n } from '@/locales/helpers.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';

import type { LoanContractSummary } from '../../models.ts';
import {
    getLoanContractStatusKey,
    getLoanContractTypeKey,
    getLoanStatusColor
} from '../../presentation.ts';

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
    (e: 'create'): void;
    (e: 'loadMore'): void;
}>();

const { tt, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();

function formatAmount(amount: number, currency: string): string {
    return formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(amount), currency);
}
</script>

<style scoped>
.contract-list {
    min-height: 420px;
}

.contract-item {
    min-height: 108px;
}

.contract-mark {
    width: 50px;
    height: 50px;
    border: 2px solid rgba(var(--v-theme-primary), 0.5);
    border-radius: 15px 15px 15px 5px;
    display: grid;
    place-items: center;
    color: rgb(var(--v-theme-primary));
    font-size: 0.78rem;
    font-weight: 800;
}

.contract-mark.needs-action {
    border-color: rgb(var(--v-theme-error));
    color: rgb(var(--v-theme-error));
}

.empty-state {
    color: rgba(var(--v-theme-on-surface), 0.7);
}
</style>
