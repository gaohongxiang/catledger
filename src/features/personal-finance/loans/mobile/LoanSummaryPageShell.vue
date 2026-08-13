<template>
    <f7-page ptr @ptr:refresh="refresh">
        <f7-navbar :title="tt('personalFinance.loans.mobile.title')" :back-link="tt('Back')" />

        <f7-block class="read-only-note margin-vertical-half">
            <div class="display-flex align-items-center">
                <f7-icon f7="lock_shield" size="22" />
                <span class="margin-left-half">{{ tt('personalFinance.loans.mobile.readOnly') }}</span>
            </div>
        </f7-block>

        <f7-block strong inset class="accounting-note margin-vertical-half">
            <strong>{{ tt('personalFinance.loans.boundary.planIsNotPayment') }}</strong>
            <p class="text-color-gray margin-top-half margin-bottom-none">
                {{ tt('personalFinance.loans.boundary.principalIsNotExpense') }}
            </p>
        </f7-block>

        <f7-block class="text-align-center" v-if="loading && !items.length">
            <f7-preloader />
        </f7-block>

        <f7-list strong inset media-list dividers class="margin-vertical-half" v-else-if="items.length">
            <f7-list-item
                link="#"
                :key="item.contract.id"
                v-for="item in items"
                @click="emit('select', item.contract.id)"
            >
                <template #media>
                    <div class="progress-mark" :class="{ alert: item.actionRequired }">
                        <span>{{ item.paidInstallmentCount }}</span>
                        <small>/{{ item.totalInstallmentCount }}</small>
                    </div>
                </template>
                <template #title>
                    <span>{{ item.contract.name }}</span>
                </template>
                <template #subtitle>
                    <span>{{ tt(getLoanContractTypeKey(item.contract.contractType)) }} · {{ tt(getLoanContractStatusKey(item.contract.status)) }}</span>
                </template>
                <template #text>
                    <span v-if="nextInstallment(item)">
                        {{ tt('personalFinance.loans.mobile.nextPayment', {
                            date: nextInstallment(item)?.dueDate,
                            amount: formatAmount(nextInstallment(item)?.progress.outstandingPaymentAmount ?? 0, item.contract.currency)
                        }) }}
                    </span>
                    <span v-else>{{ tt('personalFinance.loans.mobile.noNextPayment') }}</span>
                </template>
                <template #after>
                    <f7-badge :color="item.actionRequired ? 'red' : item.contract.status === 'active' ? 'blue' : 'gray'">
                        {{ formatAmount(item.outstandingPrincipalAmount, item.contract.currency) }}
                    </f7-badge>
                </template>
            </f7-list-item>
        </f7-list>

        <f7-block class="empty-summary text-align-center" v-else>
            <f7-icon f7="doc_text_search" size="48" />
            <p class="font-weight-medium">{{ tt('personalFinance.loans.mobile.empty') }}</p>
            <p class="text-color-gray">{{ tt('personalFinance.loans.mobile.desktopHint') }}</p>
        </f7-block>

        <f7-popup push :opened="!!detail" @popup:closed="emit('closeDetail')">
            <f7-page>
                <f7-navbar :title="tt('personalFinance.loans.mobile.detailTitle')">
                    <template #right>
                        <f7-link popup-close>{{ tt('Close') }}</f7-link>
                    </template>
                </f7-navbar>

                <template v-if="detail">
                    <f7-block strong inset>
                        <div class="display-flex justify-content-space-between align-items-center">
                            <strong>{{ detail.contract.name }}</strong>
                            <f7-badge :color="detail.contract.status === 'active' ? 'blue' : 'gray'">
                                {{ tt(getLoanContractStatusKey(detail.contract.status)) }}
                            </f7-badge>
                        </div>
                        <p class="text-color-gray margin-bottom-none">
                            {{ tt(getLoanRepaymentMethodKey(detail.currentRevision.input.repaymentMethod)) }} ·
                            {{ tt('personalFinance.loans.mobile.asOf', { date: detail.asOfDate }) }}
                        </p>
                    </f7-block>

                    <f7-block-title>{{ tt('personalFinance.loans.mobile.progress') }}</f7-block-title>
                    <f7-list strong inset dividers>
                        <f7-list-item
                            :title="tt('personalFinance.loans.schedule.plannedOutstanding')"
                            :after="formatAmount(detail.liabilityComparison.plannedOutstandingPrincipalAmount, detail.contract.currency)"
                        />
                        <f7-list-item
                            :title="tt('personalFinance.loans.schedule.ledgerLiability')"
                            :after="formatAmount(detail.liabilityComparison.ledgerOutstandingLiabilityAmount, detail.contract.currency)"
                        />
                    </f7-list>

                    <f7-block-title>{{ tt('personalFinance.loans.mobile.nextInstallments') }}</f7-block-title>
                    <f7-list strong inset dividers>
                        <f7-list-item :key="installment.id" v-for="installment in remainingInstallments">
                            <template #title>
                                <span>{{ tt('personalFinance.loans.settlement.installment', { number: installment.installmentNumber, date: installment.dueDate }) }}</span>
                            </template>
                            <template #subtitle>
                                <span>{{ tt(getLoanInstallmentStatusKey(displayStatus(installment))) }}</span>
                            </template>
                            <template #after>
                                <span>{{ formatAmount(installment.progress.outstandingPaymentAmount, detail.contract.currency) }}</span>
                            </template>
                        </f7-list-item>
                    </f7-list>
                </template>
            </f7-page>
        </f7-popup>
    </f7-page>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { useI18n } from '@/locales/helpers.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';

import type { LoanContractDetail, LoanContractSummary, LoanInstallment } from '../models.ts';
import {
    getLoanContractStatusKey,
    getLoanContractTypeKey,
    getLoanInstallmentStatusKey,
    getLoanRepaymentMethodKey
} from '../presentation.ts';
import { getLoanInstallmentDisplayStatus, getNextLoanInstallment } from '../state.ts';

const props = withDefaults(defineProps<{
    items: LoanContractSummary[];
    detail?: LoanContractDetail | null;
    loading?: boolean;
}>(), {
    detail: null,
    loading: false
});

const emit = defineEmits<{
    (e: 'refresh', done?: () => void): void;
    (e: 'select', contractId: string): void;
    (e: 'closeDetail'): void;
}>();

const { tt, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();

const remainingInstallments = computed(() => (props.detail?.installments ?? [])
    .filter(installment => installment.progress.outstandingPaymentAmount > 0)
    .slice(0, 3));

function nextInstallment(summary: LoanContractSummary): LoanInstallment | undefined {
    return getNextLoanInstallment(summary);
}

function displayStatus(installment: LoanInstallment) {
    return getLoanInstallmentDisplayStatus(installment);
}

function refresh(done?: () => void): void {
    emit('refresh', done);
}

function formatAmount(amount: number, currency: string): string {
    return formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(amount), currency);
}
</script>

<style scoped>
.read-only-note {
    color: var(--f7-theme-color);
}

.accounting-note {
    border-inline-start: 3px solid var(--f7-theme-color);
}

.progress-mark {
    width: 46px;
    height: 46px;
    border: 2px solid var(--f7-theme-color);
    border-radius: 14px 14px 14px 5px;
    display: flex;
    align-items: baseline;
    justify-content: center;
    color: var(--f7-theme-color);
    font-weight: 750;
}

.progress-mark.alert {
    border-color: var(--f7-color-red);
    color: var(--f7-color-red);
}

.progress-mark small {
    font-size: 0.67rem;
}

.empty-summary {
    margin-top: 18vh;
}
</style>
