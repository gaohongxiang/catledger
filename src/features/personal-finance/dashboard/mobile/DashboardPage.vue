<template>
    <f7-page ptr @ptr:refresh="pullRefresh">
        <f7-navbar :title="tt('personalFinance.dashboard.mobile.title')" :back-link="tt('Back')" />

        <f7-block strong inset class="mobile-ledger-head margin-vertical-half">
            <div class="mobile-kicker">{{ tt('personalFinance.dashboard.eyebrow') }}</div>
            <h2>{{ tt('personalFinance.dashboard.mobile.heading') }}</h2>
            <p>{{ tt('personalFinance.dashboard.mobile.subtitle') }}</p>
            <div class="mobile-auto-scope">{{ tt('personalFinance.dashboard.mobile.automatic') }} · {{ asOfDate }}</div>
            <f7-button fill :disabled="loading" @click="refresh">{{ tt('personalFinance.dashboard.refresh') }}</f7-button>
        </f7-block>

        <f7-block class="text-align-center" v-if="loading && !overview"><f7-preloader /></f7-block>
        <f7-block strong inset class="mobile-error" v-else-if="error">{{ tt('personalFinance.dashboard.error.load') }}</f7-block>

        <template v-if="overview">
            <f7-block strong inset class="trust-block" :class="{ warning: trustCode !== 'ready' }">
                <div class="display-flex align-items-center">
                    <f7-icon :f7="trustCode !== 'ready' ? 'exclamationmark_shield' : 'checkmark_shield'" size="22" />
                    <strong class="margin-left-half">{{ tt(`personalFinance.dashboard.headline.${trustCode}`) }}</strong>
                </div>
                <p>{{ tt('personalFinance.dashboard.headline.trustHint') }}</p>
            </f7-block>

            <div class="mobile-metric-grid">
                <f7-link class="mobile-metric primary" :href="overview.drilldown.accounts">
                    <span>{{ tt('personalFinance.dashboard.snapshot.netWorth') }}</span><strong>{{ accountTotal('netWorth') }}</strong>
                </f7-link>
                <f7-link class="mobile-metric" :href="transactionRangeLink(monthPeriod?.startDate ?? overview.startDate, monthPeriod?.endDate ?? overview.asOfDate)">
                    <span>{{ tt('personalFinance.dashboard.quick.consumption') }}</span><strong>{{ cashFlowTotal(monthPeriod?.amounts, 'consumption') }}</strong>
                </f7-link>
                <f7-link class="mobile-metric" href="/personal-finance/loans">
                    <span>{{ tt('personalFinance.dashboard.headline.nextPayment') }}</span>
                    <strong>{{ nextPayment ? formatRawAmount(nextPayment.nextDueAmount, nextPayment.currency) : tt('personalFinance.dashboard.headline.noNextPayment') }}</strong>
                </f7-link>
                <f7-link class="mobile-metric" href="/transaction/add">
                    <span>{{ tt('personalFinance.dashboard.headline.addTransaction') }}</span>
                    <strong>{{ tt('personalFinance.dashboard.headline.addTransactionHint') }}</strong>
                </f7-link>
            </div>

            <f7-block-title>{{ tt('personalFinance.dashboard.debt.title') }}</f7-block-title>
            <f7-list strong inset dividers>
                <f7-list-item :title="tt('personalFinance.dashboard.debt.overdue')" :after="debtTotal('overduePayment')" />
                <f7-list-item :title="tt('personalFinance.dashboard.debt.sevenDays')" :after="debtTotal('dueWithin7Days')" />
                <f7-list-item :title="tt('personalFinance.dashboard.debt.thirtyDays')" :after="debtTotal('dueWithin30Days')" />
                <f7-list-item :title="tt('personalFinance.dashboard.debt.remainingPrincipal')" :after="debtTotal('plannedRemainingPrincipal')" />
                <f7-list-item :title="tt('personalFinance.dashboard.snapshot.creditCardLabel')" :after="accountTotal('creditCardLiability')" />
                <f7-list-item :title="tt('personalFinance.dashboard.snapshot.debtAccountsLabel')" :after="accountTotal('debtAccountLiability')" />
                <f7-list-item :title="tt('personalFinance.dashboard.drilldown.loans')" link="/personal-finance/loans" />
            </f7-list>

            <f7-block-title>{{ tt('personalFinance.dashboard.quick.eyebrow') }}</f7-block-title>
            <f7-block class="mobile-period-switch margin-vertical-half">
                <f7-segmented strong round>
                    <f7-button round :text="tt(`personalFinance.dashboard.quick.period.${option}`)" :active="selectedPeriodKind === option"
                               :key="option" v-for="option in periodOptions" @click="selectedPeriodKind = option" />
                </f7-segmented>
            </f7-block>
            <f7-list strong inset dividers v-if="selectedPeriod">
                <f7-list-item :title="tt('personalFinance.dashboard.quick.range', { start: selectedPeriod.startDate, end: selectedPeriod.endDate })" />
                <f7-list-item :title="tt('personalFinance.dashboard.quick.income')" :after="cashFlowTotal(selectedPeriod.amounts, 'income')" />
                <f7-list-item :title="tt('personalFinance.dashboard.quick.outflow')" :after="cashFlowOutflowTotal(selectedPeriod.amounts)"
                              :footer="tt('personalFinance.dashboard.quick.outflowHint')" />
                <f7-list-item :title="tt('personalFinance.dashboard.quick.consumption')" :after="cashFlowTotal(selectedPeriod.amounts, 'consumption')" />
                <f7-list-item :title="tt('personalFinance.dashboard.quick.debtService')" :after="cashFlowDebtServiceTotal(selectedPeriod.amounts)" />
                <f7-list-item :title="tt('personalFinance.dashboard.quick.liquidChange')" :after="cashFlowTotal(selectedPeriod.amounts, 'liquidFundsNetChange')" />
                <f7-list-item :title="debtBurdenRatio ? tt('personalFinance.dashboard.cashFlow.debtBurdenRatio', { value: debtBurdenRatio }) : tt('personalFinance.dashboard.cashFlow.debtBurdenUnavailable')" />
                <f7-list-item :title="tt('personalFinance.dashboard.drilldown.transactions')" :link="transactionRangeLink(selectedPeriod.startDate, selectedPeriod.endDate)" />
            </f7-list>

            <f7-block-title>{{ tt('personalFinance.dashboard.coverage.title') }}</f7-block-title>
            <f7-block strong inset class="coverage-block">
                <div class="coverage-score">
                    <strong>{{ overview.coverage.coveredAccountCount }}/{{ overview.coverage.sourceAccountCount }}</strong>
                    <span>{{ tt('personalFinance.dashboard.coverage.covered') }}</span>
                </div>
                <p v-if="overview.coverage.complete">{{ tt('personalFinance.dashboard.coverage.complete') }}</p>
                <p v-else>{{ tt('personalFinance.dashboard.coverage.incompleteSummary') }}</p>
                <div class="coverage-counters">
                    <span>{{ tt('personalFinance.dashboard.coverage.withGaps') }} <strong>{{ overview.coverage.accountsWithGaps }}</strong></span>
                    <span>{{ tt('personalFinance.dashboard.coverage.pending') }} <strong>{{ overview.coverage.pendingRowCount }}</strong></span>
                    <span>{{ tt('personalFinance.dashboard.coverage.invalid') }} <strong>{{ overview.coverage.invalidRowCount }}</strong></span>
                    <span>{{ tt('personalFinance.dashboard.coverage.duplicates') }} <strong>{{ overview.coverage.exactDuplicateRowCount + overview.coverage.identityConflictRowCount }}</strong></span>
                    <span>{{ tt('personalFinance.dashboard.coverage.failed') }} <strong>{{ overview.coverage.failedBatchCount }}</strong></span>
                </div>
                <f7-button outline href="/personal-finance/bills">{{ tt('personalFinance.dashboard.drilldown.imports') }}</f7-button>
            </f7-block>
        </template>
    </f7-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { f7 } from 'framework7-vue';

import { useI18n } from '@/locales/helpers.ts';
import { useExchangeRatesStore } from '@/stores/exchangeRates.ts';

import type { DashboardCashFlowPeriodKind } from '../models.ts';
import { useDashboard } from '../useDashboard.ts';
import { composeDashboardHeadline, nearestNextPayment, primaryDashboardHeadline } from '../state.ts';

const { tt } = useI18n();
const exchangeRatesStore = useExchangeRatesStore();
const dashboard = useDashboard();
const { asOfDate, overview, loading, error, accountTotal, debtTotal, cashFlowTotal, cashFlowOutflowTotal, cashFlowDebtServiceTotal, cashFlowDebtRatio, formatRawAmount } = dashboard;
const periodOptions: DashboardCashFlowPeriodKind[] = ['today', 'week', 'month', 'year'];
const selectedPeriodKind = ref<DashboardCashFlowPeriodKind>('month');
const selectedPeriod = computed(() => overview.value?.cashFlowPeriods.find(period => period.kind === selectedPeriodKind.value));
const monthPeriod = computed(() => overview.value?.cashFlowPeriods.find(period => period.kind === 'month'));
const nextPayment = computed(() => nearestNextPayment(overview.value?.debt.contracts ?? []));
const trustCode = computed(() => {
    if (!overview.value) return 'ready';
    return primaryDashboardHeadline(composeDashboardHeadline({
        coverageComplete: overview.value.coverage.complete,
        accountsWithGaps: overview.value.coverage.accountsWithGaps,
        uncategorizedCount: 0,
        todoOpenCount: 0,
        balanceUnverifiedCount: 0
    }));
});
const debtBurdenRatio = computed(() => dashboard.showAmounts.value ? cashFlowDebtRatio(selectedPeriod.value?.amounts) : undefined);

function transactionRangeLink(startDate: string, endDate: string): string {
    const base = overview.value?.drilldown.transactions ?? '/transaction/list';
    const start = new Date(`${startDate}T00:00:00`);
    const endExclusive = new Date(`${endDate}T00:00:00`);
    endExclusive.setDate(endExclusive.getDate() + 1);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(endExclusive.getTime())) return base;
    return `${base}?pageType=0&dateType=255&minTime=${Math.floor(start.getTime() / 1000)}&maxTime=${Math.floor(endExclusive.getTime() / 1000) - 1}`;
}

async function refresh(): Promise<void> {
    try {
        await dashboard.load();
    } catch {
        f7.toast.create({ text: tt('personalFinance.dashboard.error.load'), closeTimeout: 3000 }).open();
    }
}

async function pullRefresh(done?: () => void): Promise<void> {
    try {
        await refresh();
    } finally {
        done?.();
    }
}

onMounted(async () => {
    await exchangeRatesStore.getLatestExchangeRates({ silent: true, force: false }).catch(() => undefined);
    await refresh();
});
</script>

<style scoped>
.mobile-ledger-head { border-radius: 18px 6px 18px 6px; border-inline-start: 4px solid var(--f7-theme-color); }
.mobile-ledger-head h2 { margin: 4px 0 8px; font-size: 1.55rem; letter-spacing: -.035em; }
.mobile-ledger-head p { color: var(--f7-text-color-secondary); line-height: 1.45; }
.mobile-kicker { color: var(--f7-theme-color); font-size: .68rem; font-weight: 800; text-transform: uppercase; letter-spacing: .12em; }
.mobile-auto-scope { margin: 14px 0; padding: 10px 12px; border-inline-start: 3px solid var(--f7-theme-color); background: var(--f7-page-bg-color); color: var(--f7-text-color-secondary); font-size: .72rem; }
.mobile-period-switch { margin-inline: 16px; padding: 0; }
.trust-block { border-inline-start: 3px solid var(--f7-color-green); }
.trust-block.warning { border-inline-start-color: var(--f7-color-orange); }
.trust-block p { color: var(--f7-text-color-secondary); margin-bottom: 0; }
.mobile-error { color: var(--f7-color-red); border-inline-start: 3px solid var(--f7-color-red); }
.mobile-metric-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin: 0 16px; }
.mobile-metric { color: var(--f7-text-color); text-decoration: none; background: var(--f7-block-strong-bg-color); padding: 15px; border-radius: 5px 16px 5px 16px; min-height: 76px; display: flex; flex-direction: column; justify-content: space-between; box-shadow: 0 1px 1px rgba(0,0,0,.05); }
.mobile-metric.primary { background: #17352f; color: #f5f1df; }
.mobile-metric span { opacity: .68; font-size: .72rem; }
.mobile-metric strong { font-size: 1.1rem; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.coverage-score { display: flex; align-items: baseline; gap: 10px; }
.coverage-score strong { font-size: 1.8rem; color: var(--f7-theme-color); }
.coverage-score span, .coverage-block p { color: var(--f7-text-color-secondary); }
.coverage-counters { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 14px 0; font-size: .72rem; color: var(--f7-text-color-secondary); }
.coverage-counters span { display: flex; justify-content: space-between; gap: 8px; padding: 8px; background: var(--f7-page-bg-color); border-radius: 7px; }
</style>
