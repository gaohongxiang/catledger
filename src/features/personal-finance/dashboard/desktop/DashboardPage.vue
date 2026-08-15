<template>
    <div class="finance-dashboard">
        <section class="dashboard-masthead pa-6 pa-lg-8">
            <div class="masthead-copy">
                <div class="text-overline dashboard-kicker">{{ tt('personalFinance.dashboard.eyebrow') }}</div>
                <h2 class="dashboard-title">{{ tt('personalFinance.dashboard.title') }}</h2>
                <p class="dashboard-subtitle">{{ tt('personalFinance.dashboard.subtitle') }}</p>
                <div class="d-flex flex-wrap ga-2 mt-4">
                    <v-chip size="small" variant="tonal" color="primary" :prepend-icon="mdiShieldCheckOutline">
                        {{ tt('personalFinance.dashboard.trust.formalOnly') }}
                    </v-chip>
                    <v-chip size="small" variant="tonal" :color="overview?.coverage.complete ? 'success' : 'warning'" :prepend-icon="mdiTimelineClockOutline">
                        {{ coverageHeadline }}
                    </v-chip>
                    <v-btn class="amount-visibility" size="small" variant="text"
                           :prepend-icon="showAmounts ? mdiEyeOffOutline : mdiEyeOutline" @click="showAmounts = !showAmounts">
                        {{ tt(showAmounts ? 'Hide Amount' : 'Show Amount') }}
                    </v-btn>
                    <v-btn size="small" variant="text" :prepend-icon="mdiBookOpenPageVariantOutline" @click="showGettingStarted = !showGettingStarted">
                        {{ tt('personalFinance.dashboard.gettingStarted.open') }}
                    </v-btn>
                </div>
            </div>
            <div class="automatic-scope">
                <span>{{ tt('personalFinance.dashboard.snapshot.title') }}</span>
                <strong>{{ tt('personalFinance.dashboard.automaticScope', { date: asOfDate }) }}</strong>
                <p>{{ tt('personalFinance.dashboard.automaticScopeHint') }}</p>
                <v-btn color="primary" variant="flat" :prepend-icon="mdiRefresh" :loading="loading" @click="refresh">
                    {{ tt('personalFinance.dashboard.refresh') }}
                </v-btn>
            </div>
        </section>

        <section class="getting-started mt-5" v-if="showGettingStarted">
            <div class="getting-started__head">
                <div>
                    <span>{{ tt('personalFinance.dashboard.gettingStarted.eyebrow') }}</span>
                    <h3>{{ tt('personalFinance.dashboard.gettingStarted.title') }}</h3>
                    <p>{{ tt('personalFinance.dashboard.gettingStarted.subtitle') }}</p>
                </div>
                <v-btn size="small" variant="text" :prepend-icon="mdiClose" @click="dismissGettingStarted">
                    {{ tt('personalFinance.dashboard.gettingStarted.dismiss') }}
                </v-btn>
            </div>
            <div class="getting-started__steps">
                <router-link to="/personal-finance/bills">
                    <v-icon :icon="mdiTrayArrowDown" />
                    <span>01</span>
                    <strong>{{ tt('personalFinance.dashboard.gettingStarted.imports') }}</strong>
                    <small>{{ tt('personalFinance.dashboard.gettingStarted.importsHint') }}</small>
                </router-link>
                <router-link to="/personal-finance/bills">
                    <v-icon :icon="mdiCreditCardOutline" />
                    <span>02</span>
                    <strong>{{ tt('personalFinance.dashboard.gettingStarted.account') }}</strong>
                    <small>{{ tt('personalFinance.dashboard.gettingStarted.accountHint') }}</small>
                </router-link>
                <router-link to="/personal-finance/bills">
                    <v-icon :icon="mdiCheckCircleOutline" />
                    <span>03</span>
                    <strong>{{ tt('personalFinance.dashboard.gettingStarted.review') }}</strong>
                    <small>{{ tt('personalFinance.dashboard.gettingStarted.reviewHint') }}</small>
                </router-link>
            </div>
            <p class="getting-started__boundary">{{ tt('personalFinance.dashboard.gettingStarted.boundary') }}</p>
        </section>

        <v-alert class="mt-5" type="error" variant="tonal" v-if="error">
            {{ tt('personalFinance.dashboard.error.load') }}
        </v-alert>

        <template v-if="loading && !overview">
            <v-skeleton-loader class="mt-5" type="heading, image, table, image" />
        </template>

        <template v-else-if="overview">
            <section class="snapshot-grid mt-5">
                <router-link class="metric-card metric-card--ink" :to="overview.drilldown.accounts">
                    <span class="metric-label">{{ tt('personalFinance.dashboard.snapshot.netWorth') }}</span>
                    <strong>{{ accountTotal('netWorth') }}</strong>
                    <small>{{ tt('personalFinance.dashboard.snapshot.authority') }}</small>
                </router-link>
                <router-link class="metric-card" :to="transactionRangeLink(monthPeriod?.startDate ?? overview.startDate, monthPeriod?.endDate ?? overview.asOfDate)">
                    <span class="metric-label">{{ tt('personalFinance.dashboard.quick.consumption') }}</span>
                    <strong>{{ cashFlowTotal(monthPeriod?.amounts, 'consumption') }}</strong>
                    <small>{{ tt('personalFinance.dashboard.headline.monthConsumption') }}</small>
                </router-link>
                <router-link class="metric-card" :to="overview.drilldown.loans">
                    <span class="metric-label">{{ tt('personalFinance.dashboard.headline.nextPayment') }}</span>
                    <strong>{{ nextPaymentLabel }}</strong>
                    <small>{{ nextPaymentHint }}</small>
                </router-link>
                <router-link class="metric-card metric-card--liquid" to="/personal-finance/bills">
                    <span class="metric-label">{{ tt('personalFinance.dashboard.headline.trust') }}</span>
                    <strong>{{ trustHeadline }}</strong>
                    <small>{{ tt('personalFinance.dashboard.headline.trustHint') }}</small>
                </router-link>
            </section>

            <section class="period-overview mt-5" v-if="selectedPeriod">
                <div class="period-overview__head">
                    <div>
                        <span class="period-overview__eyebrow">{{ tt('personalFinance.dashboard.quick.eyebrow') }}</span>
                        <h3>{{ tt('personalFinance.dashboard.quick.title', { period: selectedPeriodLabel }) }}</h3>
                        <p>{{ tt('personalFinance.dashboard.quick.range', { start: selectedPeriod.startDate, end: selectedPeriod.endDate }) }}</p>
                    </div>
                    <div class="period-overview__actions">
                        <v-btn-toggle color="primary" density="compact" divided mandatory variant="outlined" v-model="selectedPeriodKind">
                            <v-btn :value="option" :key="option" v-for="option in periodOptions">
                                {{ tt(`personalFinance.dashboard.quick.period.${option}`) }}
                            </v-btn>
                        </v-btn-toggle>
                        <router-link :to="transactionRangeLink(selectedPeriod.startDate, selectedPeriod.endDate)">
                            {{ tt('personalFinance.dashboard.quick.viewTransactions') }} →
                        </router-link>
                    </div>
                </div>
                <div class="period-metrics">
                    <router-link :to="transactionRangeLink(selectedPeriod.startDate, selectedPeriod.endDate)">
                        <span>{{ tt('personalFinance.dashboard.quick.income') }}</span>
                        <strong>{{ cashFlowTotal(selectedPeriod.amounts, 'income') }}</strong>
                    </router-link>
                    <router-link class="period-metric--outflow" :to="transactionRangeLink(selectedPeriod.startDate, selectedPeriod.endDate)">
                        <span>{{ tt('personalFinance.dashboard.quick.outflow') }}</span>
                        <strong>{{ cashFlowOutflowTotal(selectedPeriod.amounts) }}</strong>
                        <small>{{ tt('personalFinance.dashboard.quick.outflowHint') }}</small>
                    </router-link>
                    <router-link :to="transactionRangeLink(selectedPeriod.startDate, selectedPeriod.endDate)">
                        <span>{{ tt('personalFinance.dashboard.quick.consumption') }}</span>
                        <strong>{{ cashFlowTotal(selectedPeriod.amounts, 'consumption') }}</strong>
                    </router-link>
                    <router-link :to="transactionRangeLink(selectedPeriod.startDate, selectedPeriod.endDate)">
                        <span>{{ tt('personalFinance.dashboard.quick.debtService') }}</span>
                        <strong>{{ cashFlowDebtServiceTotal(selectedPeriod.amounts) }}</strong>
                    </router-link>
                    <router-link class="period-metric--change" :to="transactionRangeLink(selectedPeriod.startDate, selectedPeriod.endDate)">
                        <span>{{ tt('personalFinance.dashboard.quick.liquidChange') }}</span>
                        <strong :class="cashFlowSign(selectedPeriod.amounts)">{{ cashFlowTotal(selectedPeriod.amounts, 'liquidFundsNetChange') }}</strong>
                    </router-link>
                </div>
            </section>

            <v-alert class="mt-5 trust-ribbon" :type="overview.trust.hasWarnings ? 'warning' : 'success'" variant="tonal">
                <div class="d-flex flex-wrap align-center ga-3">
                    <strong>{{ overview.trust.hasWarnings ? tt('personalFinance.dashboard.trust.review') : tt('personalFinance.dashboard.trust.ready') }}</strong>
                    <span>{{ tt('personalFinance.dashboard.trust.range', { start: overview.startDate, end: overview.asOfDate }) }}</span>
                    <span>{{ tt('personalFinance.dashboard.trust.transactions', { count: overview.trust.ledgerTransactionCount }) }}</span>
                    <span>{{ tt('personalFinance.dashboard.trust.unconfirmedExcluded') }}</span>
                </div>
            </v-alert>

            <section class="dashboard-section mt-5">
                <div class="section-heading">
                    <div>
                        <span class="section-index">01</span>
                        <h3>{{ tt('personalFinance.dashboard.debt.title') }}</h3>
                        <p>{{ tt('personalFinance.dashboard.debt.subtitle') }}</p>
                    </div>
                    <router-link class="section-link" :to="overview.drilldown.loans">{{ tt('personalFinance.dashboard.drilldown.loans') }} →</router-link>
                </div>

                <div class="due-grid">
                    <div class="due-cell due-cell--urgent">
                        <span>{{ tt('personalFinance.dashboard.debt.overdue') }}</span>
                        <strong>{{ debtTotal('overduePayment') }}</strong>
                    </div>
                    <div class="due-cell">
                        <span>{{ tt('personalFinance.dashboard.debt.sevenDays') }}</span>
                        <strong>{{ debtTotal('dueWithin7Days') }}</strong>
                    </div>
                    <div class="due-cell">
                        <span>{{ tt('personalFinance.dashboard.debt.thirtyDays') }}</span>
                        <strong>{{ debtTotal('dueWithin30Days') }}</strong>
                    </div>
                    <div class="due-cell">
                        <span>{{ tt('personalFinance.dashboard.debt.thisMonth') }}</span>
                        <strong>{{ debtTotal('dueThisMonth') }}</strong>
                    </div>
                    <div class="due-cell due-cell--principal">
                        <span>{{ tt('personalFinance.dashboard.debt.remainingPrincipal') }}</span>
                        <strong>{{ debtTotal('plannedRemainingPrincipal') }}</strong>
                    </div>
                </div>

                <div class="contract-strip mt-5" v-if="overview.debt.contracts.length">
                    <router-link class="contract-ticket" :class="{ 'contract-ticket--warning': contract.actionRequired }"
                                 :key="contract.contractId" :to="overview.drilldown.loans" v-for="contract in overview.debt.contracts">
                        <div class="d-flex justify-space-between ga-3">
                            <strong>{{ contract.name }}</strong>
                            <v-icon size="18" :icon="contract.actionRequired ? mdiAlertCircleOutline : mdiArrowTopRight" />
                        </div>
                        <div class="contract-amount mt-3">{{ formatRawAmount(contract.remainingPrincipal, contract.currency) }}</div>
                        <div class="contract-meta mt-2">
                            <span>{{ tt('personalFinance.dashboard.debt.termsLeft', { count: contract.remainingInstallments }) }}</span>
                            <span v-if="contract.nextDueDate">{{ tt('personalFinance.dashboard.debt.nextDue', { date: contract.nextDueDate, amount: formatRawAmount(contract.nextDueAmount, contract.currency) }) }}</span>
                            <span v-if="contract.effectiveAprPptr">{{ tt('personalFinance.dashboard.debt.apr', { value: formatApr(contract.effectiveAprPptr) }) }}</span>
                        </div>
                    </router-link>
                </div>
                <div class="empty-inline mt-5" v-else>{{ tt('personalFinance.dashboard.debt.empty') }}</div>

                <div class="curve-grid mt-5">
                    <div class="curve-cell" :key="row.month" v-for="row in overview.debt.futureCurve.slice(0, 6)">
                        <span>{{ row.month }}</span>
                        <strong>{{ curveTotal(row.amounts) }}</strong>
                    </div>
                </div>
            </section>

            <section class="dashboard-section mt-5">
                <div class="section-heading">
                    <div>
                        <span class="section-index">02</span>
                        <h3>{{ tt('personalFinance.dashboard.cashFlow.title') }}</h3>
                        <p>{{ tt('personalFinance.dashboard.cashFlow.subtitle') }}</p>
                    </div>
                    <div class="cashflow-actions">
                        <v-chip size="small" variant="tonal" color="primary">
                            {{ debtBurdenRatio ? tt('personalFinance.dashboard.cashFlow.debtBurdenRatio', { value: debtBurdenRatio }) : tt('personalFinance.dashboard.cashFlow.debtBurdenUnavailable') }}
                        </v-chip>
                        <router-link class="section-link" :to="transactionLink(latestMonth?.month)">{{ tt('personalFinance.dashboard.drilldown.transactions') }} →</router-link>
                    </div>
                </div>

                <div class="trend-heading">
                    <div>
                        <strong>{{ tt('personalFinance.dashboard.cashFlow.trendTitle') }}</strong>
                        <p>{{ tt('personalFinance.dashboard.cashFlow.trendSubtitle') }}</p>
                    </div>
                    <v-btn-toggle color="primary" density="compact" divided mandatory variant="outlined"
                                  :model-value="months" @update:model-value="changeTrendMonths">
                        <v-btn :value="option" :key="option" v-for="option in trendMonthOptions">
                            {{ tt('personalFinance.dashboard.cashFlow.trendMonths', { count: option }) }}
                        </v-btn>
                    </v-btn-toggle>
                </div>
                <cash-flow-trend-chart :points="trendPoints" :hidden="!showAmounts" />

                <div class="cashflow-table-wrap">
                    <table class="cashflow-table">
                        <thead>
                            <tr>
                                <th>{{ tt('personalFinance.dashboard.cashFlow.month') }}</th>
                                <th>{{ tt('personalFinance.dashboard.cashFlow.income') }}</th>
                                <th>{{ tt('personalFinance.dashboard.cashFlow.consumption') }}</th>
                                <th>{{ tt('personalFinance.dashboard.cashFlow.principal') }}</th>
                                <th>{{ tt('personalFinance.dashboard.cashFlow.interest') }}</th>
                                <th>{{ tt('personalFinance.dashboard.cashFlow.fee') }}</th>
                                <th>{{ tt('personalFinance.dashboard.cashFlow.internalTransfer') }}</th>
                                <th>{{ tt('personalFinance.dashboard.cashFlow.disbursement') }}</th>
                                <th>{{ tt('personalFinance.dashboard.cashFlow.debtBurden') }}</th>
                                <th>{{ tt('personalFinance.dashboard.cashFlow.liquidChange') }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr :key="row.month" v-for="row in overview.monthlyCashFlow">
                                <td><router-link :to="transactionLink(row.month)">{{ row.month }}</router-link></td>
                                <td>{{ cashFlowTotal(row.amounts, 'income') }}</td>
                                <td>{{ cashFlowTotal(row.amounts, 'consumption') }}</td>
                                <td>{{ cashFlowTotal(row.amounts, 'loanPrincipal') }}</td>
                                <td>{{ cashFlowTotal(row.amounts, 'loanInterest') }}</td>
                                <td>{{ cashFlowTotal(row.amounts, 'loanFee') }}</td>
                                <td>{{ cashFlowTotal(row.amounts, 'internalTransfer') }}</td>
                                <td>{{ cashFlowTotal(row.amounts, 'loanDisbursement') }}</td>
                                <td>{{ formatDebtBurden(row.amounts) }}</td>
                                <td :class="cashFlowSign(row.amounts)">{{ cashFlowTotal(row.amounts, 'liquidFundsNetChange') }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <p class="accounting-boundary mt-4 mb-0">{{ tt('personalFinance.dashboard.cashFlow.boundary') }}</p>
            </section>

            <section class="dashboard-section mt-5">
                <div class="section-heading">
                    <div>
                        <span class="section-index">03</span>
                        <h3>{{ tt('personalFinance.dashboard.coverage.title') }}</h3>
                        <p>{{ tt('personalFinance.dashboard.coverage.subtitle') }}</p>
                    </div>
                    <router-link class="section-link" to="/personal-finance/bills">{{ tt('personalFinance.dashboard.drilldown.imports') }} →</router-link>
                </div>

                <div class="coverage-summary">
                    <div><strong>{{ overview.coverage.coveredAccountCount }}/{{ overview.coverage.sourceAccountCount }}</strong><span>{{ tt('personalFinance.dashboard.coverage.covered') }}</span></div>
                    <div><strong>{{ overview.coverage.mappedAccountCount }}/{{ overview.coverage.sourceAccountCount }}</strong><span>{{ tt('personalFinance.dashboard.coverage.mapped') }}</span></div>
                    <div><strong>{{ overview.coverage.accountsWithGaps }}</strong><span>{{ tt('personalFinance.dashboard.coverage.withGaps') }}</span></div>
                    <div><strong>{{ overview.coverage.latestCoveredDate || '—' }}</strong><span>{{ tt('personalFinance.dashboard.coverage.latest') }}</span></div>
                    <div><strong>{{ overview.coverage.pendingRowCount }}</strong><span>{{ tt('personalFinance.dashboard.coverage.pending') }}</span></div>
                    <div><strong>{{ overview.coverage.invalidRowCount }}</strong><span>{{ tt('personalFinance.dashboard.coverage.invalid') }}</span></div>
                    <div><strong>{{ overview.coverage.exactDuplicateRowCount + overview.coverage.identityConflictRowCount }}</strong><span>{{ tt('personalFinance.dashboard.coverage.duplicates') }}</span></div>
                    <div><strong>{{ overview.coverage.failedBatchCount }}</strong><span>{{ tt('personalFinance.dashboard.coverage.failed') }}</span></div>
                </div>

                <div class="coverage-list mt-5" v-if="overview.coverage.accounts.length">
                    <div class="coverage-account" :key="source.sourceAccountId" v-for="source in overview.coverage.accounts">
                        <div class="coverage-account__head">
                            <div>
                                <strong>{{ source.maskedDisplayName }}</strong>
                                <span>{{ source.ledgerAccountId ? tt('personalFinance.dashboard.coverage.mappedYes') : tt('personalFinance.dashboard.coverage.mappedNo') }}</span>
                            </div>
                            <v-chip size="x-small" variant="tonal" :color="sourceCoverageTone(source)">
                                {{ source.gaps.length || source.unknownPeriod ? tt('personalFinance.dashboard.coverage.incomplete') : tt('personalFinance.dashboard.coverage.continuous') }}
                            </v-chip>
                        </div>
                        <div class="coverage-account__body">
                            <p v-if="source.latestCoveredDate">{{ tt('personalFinance.dashboard.coverage.through', { date: source.latestCoveredDate }) }}</p>
                            <p v-if="source.unknownPeriod">{{ tt('personalFinance.dashboard.coverage.unknownPeriod') }}</p>
                            <p v-for="gap in source.gaps" :key="`${gap.startDate}-${gap.endDate}`">
                                {{ tt('personalFinance.dashboard.coverage.gap', { range: formatCoverageRange(gap.startDate, gap.endDate) }) }}
                            </p>
                            <p v-for="overlap in source.overlaps" :key="`overlap-${overlap.startDate}-${overlap.endDate}`">
                                {{ tt('personalFinance.dashboard.coverage.overlap', { range: formatCoverageRange(overlap.startDate, overlap.endDate) }) }}
                            </p>
                        </div>
                    </div>
                </div>
                <div class="empty-inline mt-5" v-else>{{ tt('personalFinance.dashboard.coverage.empty') }}</div>
            </section>
        </template>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
    mdiAlertCircleOutline,
    mdiArrowTopRight,
    mdiBookOpenPageVariantOutline,
    mdiCheckCircleOutline,
    mdiClose,
    mdiCreditCardOutline,
    mdiEyeOffOutline,
    mdiEyeOutline,
    mdiRefresh,
    mdiShieldCheckOutline,
    mdiTrayArrowDown,
    mdiTimelineClockOutline
} from '@mdi/js';

import { useI18n } from '@/locales/helpers.ts';
import { useExchangeRatesStore } from '@/stores/exchangeRates.ts';
import { DISPLAY_HIDDEN_AMOUNT } from '@/consts/numeral.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';

import type { DashboardCashFlowAmount, DashboardCashFlowPeriodKind, DashboardDebtCurveAmount } from '../models.ts';
import { formatLoanPptrAsPercentage } from '../../loans/state.ts';
import { composeDashboardHeadline, nearestNextPayment, primaryDashboardHeadline } from '../../billflow/state.ts';
import { billflowApi } from '../../billflow/service.ts';
import { coverageTone, formatCoverageRange, sourceCoverageTone } from '../presentation.ts';
import { useDashboard } from '../useDashboard.ts';
import CashFlowTrendChart from './CashFlowTrendChart.vue';

const { tt, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
const exchangeRatesStore = useExchangeRatesStore();
const dashboard = useDashboard();
const {
    asOfDate,
    months,
    overview,
    loading,
    error,
    showAmounts,
    accountTotal,
    debtTotal,
    cashFlowTotal,
    cashFlowValue,
    cashFlowDebtServiceTotal,
    cashFlowOutflowTotal,
    cashFlowDebtRatio,
    formatRawAmount
} = dashboard;

const periodOptions: DashboardCashFlowPeriodKind[] = ['today', 'week', 'month', 'year'];
const trendMonthOptions = [6, 12, 24];
const gettingStartedStorageKey = 'personal-finance-getting-started-dismissed-v1';
const selectedPeriodKind = ref<DashboardCashFlowPeriodKind>('month');
const showGettingStarted = ref<boolean>(localStorage.getItem(gettingStartedStorageKey) !== '1');
const selectedPeriod = computed(() => overview.value?.cashFlowPeriods.find(period => period.kind === selectedPeriodKind.value));
const selectedPeriodLabel = computed(() => tt(`personalFinance.dashboard.quick.period.${selectedPeriodKind.value}`));
const latestMonth = computed(() => overview.value?.monthlyCashFlow.at(-1));
const debtBurdenRatio = computed(() => showAmounts.value ? cashFlowDebtRatio(latestMonth.value?.amounts) : undefined);
const trendPoints = computed(() => {
    if (!showAmounts.value) return [];
    return (overview.value?.monthlyCashFlow ?? []).map(row => ({
        month: row.month,
        income: cashFlowValue(row.amounts, ['income']).value.toDoubleNumber(),
        consumption: cashFlowValue(row.amounts, ['consumption']).value.toDoubleNumber(),
        debtService: cashFlowValue(row.amounts, ['loanPrincipal', 'loanInterest', 'loanFee']).value.toDoubleNumber(),
        incomeLabel: cashFlowTotal(row.amounts, 'income'),
        consumptionLabel: cashFlowTotal(row.amounts, 'consumption'),
        debtServiceLabel: cashFlowDebtServiceTotal(row.amounts)
    }));
});
const coverageHeadline = computed(() => {
    if (!overview.value) return tt('personalFinance.dashboard.trust.loading');
    const tone = coverageTone(overview.value.coverage);
    return tone === 'success' ? tt('personalFinance.dashboard.trust.coverageComplete') : tt('personalFinance.dashboard.trust.coverageGaps');
});
const monthPeriod = computed(() => overview.value?.cashFlowPeriods.find(period => period.kind === 'month'));
const nextPayment = computed(() => nearestNextPayment(overview.value?.debt.contracts ?? []));
const nextPaymentLabel = computed(() => {
    if (!nextPayment.value) return tt('personalFinance.dashboard.headline.noNextPayment');
    return formatRawAmount(nextPayment.value.nextDueAmount, nextPayment.value.currency);
});
const nextPaymentHint = computed(() => nextPayment.value?.nextDueDate
    ? tt('personalFinance.dashboard.headline.nextPaymentDate', { date: nextPayment.value.nextDueDate })
    : tt('personalFinance.dashboard.headline.nextPaymentHint'));
const headlineExtras = ref({ uncategorizedCount: 0, todoOpenCount: 0, balanceUnverifiedCount: 0 });
const trustHeadline = computed(() => {
    if (!overview.value) return tt('personalFinance.dashboard.trust.loading');
    const code = primaryDashboardHeadline(composeDashboardHeadline({
        coverageComplete: overview.value.coverage.complete,
        accountsWithGaps: overview.value.coverage.accountsWithGaps,
        uncategorizedCount: headlineExtras.value.uncategorizedCount,
        todoOpenCount: headlineExtras.value.todoOpenCount,
        balanceUnverifiedCount: headlineExtras.value.balanceUnverifiedCount
    }));
    return tt(`personalFinance.dashboard.headline.${code}`);
});

function refresh(): void {
    dashboard.load().then(loadHeadlineExtras).catch(() => undefined);
}

async function loadHeadlineExtras(): Promise<void> {
    try {
        const [ready, cards] = await Promise.all([
            billflowApi.listTasks('ready'),
            billflowApi.listCardAccounts(asOfDate.value)
        ]);
        const task = ready.items[0];
        const todos = task ? await billflowApi.listTodos(task.id, 'open') : { items: [] };
        headlineExtras.value = {
            uncategorizedCount: todos.items.filter(item => item.todoKind === 'uncategorized').length,
            todoOpenCount: task?.todoOpenCount ?? todos.items.length,
            balanceUnverifiedCount: cards.filter(card => !card.balanceReview || card.balanceReview.status === 'unverified').length
        };
    } catch {
        headlineExtras.value = { uncategorizedCount: 0, todoOpenCount: 0, balanceUnverifiedCount: 0 };
    }
}

function dismissGettingStarted(): void {
    showGettingStarted.value = false;
    localStorage.setItem(gettingStartedStorageKey, '1');
}

function changeTrendMonths(value: unknown): void {
    if (typeof value !== 'number' || !trendMonthOptions.includes(value) || value === months.value) return;
    months.value = value;
    refresh();
}

function formatApr(value: string): string {
    const formatted = formatLoanPptrAsPercentage(value);
    return formatted ? `${formatted}%` : '—';
}

function curveTotal(values: DashboardDebtCurveAmount[]): string {
    if (!showAmounts.value) {
        return formatAmountToLocalizedNumeralsWithCurrency(DISPLAY_HIDDEN_AMOUNT, dashboard.defaultCurrency.value);
    }
    let total = 0n;
    let incomplete = false;
    for (const value of values) {
        if (value.currency === dashboard.defaultCurrency.value) {
            total += BigInt(value.payment);
            continue;
        }
        const exchanged = exchangeRatesStore.getExchangedAmount(parseBigDecimal(value.payment), value.currency, dashboard.defaultCurrency.value);
        if (!exchanged) {
            incomplete = true;
        } else {
            total += BigInt(exchanged.truncate().toString());
        }
    }
    return formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(total.toString()), dashboard.defaultCurrency.value) + (incomplete ? '*' : '');
}

function cashFlowSign(values: DashboardCashFlowAmount[]): string {
    if (!showAmounts.value) return '';
    const total = cashFlowValue(values, ['liquidFundsNetChange']).value;
    return total.isNegative() ? 'amount-negative' : total.isPositive() ? 'amount-positive' : '';
}

function formatDebtBurden(values: DashboardCashFlowAmount[]): string {
    if (!showAmounts.value) return '—';
    const ratio = cashFlowDebtRatio(values);
    return ratio ? `${ratio}%` : '—';
}

function transactionLink(month?: string): string {
    if (!month || !overview.value) return overview.value?.drilldown.transactions ?? '/transaction/list';
    const parts = /^(\d{4})-(\d{2})$/.exec(month);
    if (!parts) return overview.value.drilldown.transactions;
    const end = new Date(Number(parts[1]), Number(parts[2]), 0);
    const monthEnd = month === overview.value.asOfDate.slice(0, 7) ? overview.value.asOfDate : formatLocalCivilDate(end);
    return transactionRangeLink(`${month}-01`, monthEnd);
}

function transactionRangeLink(startDate: string, endDate: string): string {
    const base = overview.value?.drilldown.transactions ?? '/transaction/list';
    const start = new Date(`${startDate}T00:00:00`);
    const endExclusive = new Date(`${endDate}T00:00:00`);
    endExclusive.setDate(endExclusive.getDate() + 1);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(endExclusive.getTime())) return base;
    return `${base}?pageType=0&dateType=255&minTime=${Math.floor(start.getTime() / 1000)}&maxTime=${Math.floor(endExclusive.getTime() / 1000) - 1}`;
}

function formatLocalCivilDate(value: Date): string {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

onMounted(async () => {
    await exchangeRatesStore.getLatestExchangeRates({ silent: true, force: false }).catch(() => undefined);
    refresh();
});
</script>

<style scoped>
.finance-dashboard {
    --dash-ink: #17352f;
    --dash-mint: #dff3e9;
    --dash-paper: rgb(var(--v-theme-surface));
    --dash-rule: rgba(var(--v-theme-on-surface), 0.11);
    max-width: 1500px;
    margin-inline: auto;
}

.dashboard-masthead {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(280px, 460px);
    gap: 44px;
    align-items: end;
    position: relative;
    overflow: hidden;
    border: 1px solid var(--dash-rule);
    border-radius: 26px 8px 26px 8px;
    background:
        linear-gradient(115deg, rgba(var(--v-theme-primary), 0.11), transparent 52%),
        repeating-linear-gradient(90deg, transparent 0, transparent 39px, rgba(var(--v-theme-on-surface), 0.025) 40px),
        var(--dash-paper);
}

.dashboard-masthead::after {
    content: '';
    position: absolute;
    width: 180px;
    height: 180px;
    border: 28px solid rgba(var(--v-theme-primary), 0.08);
    border-radius: 50%;
    inset: -80px -55px auto auto;
}

.dashboard-kicker { color: rgb(var(--v-theme-primary)); letter-spacing: 0.16em; }
.dashboard-title { font-size: clamp(2rem, 4vw, 3.6rem); line-height: 1; letter-spacing: -0.045em; color: rgb(var(--v-theme-on-surface)); }
.dashboard-subtitle { max-width: 720px; margin: 16px 0 0; color: rgba(var(--v-theme-on-surface), 0.68); font-size: 1rem; line-height: 1.7; }
.automatic-scope { z-index: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 22px; border-inline-start: 3px solid rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-surface), .78); backdrop-filter: blur(8px); }
.automatic-scope span { color: rgb(var(--v-theme-primary)); font-size: .7rem; font-weight: 800; letter-spacing: .11em; text-transform: uppercase; }
.automatic-scope strong { font-size: 1.15rem; }
.automatic-scope p { margin: 0 0 5px; color: rgba(var(--v-theme-on-surface), .63); font-size: .8rem; line-height: 1.5; }
.amount-visibility { align-self: center; }

.getting-started { overflow: hidden; border: 1px solid var(--dash-rule); border-radius: 18px 5px 18px 5px; background: var(--dash-paper); }
.getting-started__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 20px 22px; background: rgba(var(--v-theme-primary), .065); }
.getting-started__head span { color: rgb(var(--v-theme-primary)); font-size: .68rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.getting-started__head h3 { margin: 4px 0 0; font-size: 1.2rem; }
.getting-started__head p { margin: 5px 0 0; color: rgba(var(--v-theme-on-surface), .63); font-size: .82rem; }
.getting-started__steps { display: grid; grid-template-columns: repeat(3, 1fr); }
.getting-started__steps > a { position: relative; display: grid; grid-template-columns: auto 1fr; column-gap: 12px; min-height: 132px; padding: 20px 22px; border-inline-start: 1px solid var(--dash-rule); color: inherit; text-decoration: none; transition: background-color .18s ease; }
.getting-started__steps > a:first-child { border-inline-start: 0; }
.getting-started__steps > a:hover { background: rgba(var(--v-theme-primary), .045); }
.getting-started__steps .v-icon { grid-row: 1 / 4; color: rgb(var(--v-theme-primary)); }
.getting-started__steps span { color: rgba(var(--v-theme-on-surface), .42); font-size: .65rem; font-weight: 800; letter-spacing: .1em; }
.getting-started__steps strong { margin-top: 2px; font-size: .96rem; }
.getting-started__steps small { margin-top: 5px; color: rgba(var(--v-theme-on-surface), .6); font-size: .75rem; line-height: 1.45; }
.getting-started__boundary { margin: 0; padding: 12px 22px; border-top: 1px solid var(--dash-rule); color: rgba(var(--v-theme-on-surface), .62); font-size: .76rem; }

.snapshot-grid { display: grid; grid-template-columns: 1.25fr repeat(3, 1fr); gap: 14px; }
.metric-card { color: inherit; text-decoration: none; padding: 24px; min-height: 154px; display: flex; flex-direction: column; justify-content: space-between; border: 1px solid var(--dash-rule); border-radius: 5px 18px 5px 18px; background: var(--dash-paper); transition: transform .18s ease, border-color .18s ease; }
.metric-card:hover { transform: translateY(-3px); border-color: rgba(var(--v-theme-primary), .5); }
.metric-card--ink { background: var(--dash-ink); color: #f5f1df; border-color: transparent; }
.metric-card--liquid { background: var(--dash-mint); color: var(--dash-ink); }
.metric-label { font-size: .78rem; text-transform: uppercase; letter-spacing: .1em; opacity: .72; }
.metric-card strong { font-size: clamp(1.55rem, 2.4vw, 2.35rem); letter-spacing: -.035em; font-variant-numeric: tabular-nums; }
.metric-card small { opacity: .64; line-height: 1.35; }
.metric-foot { display: grid; gap: 2px; }
.period-overview { overflow: hidden; border: 1px solid var(--dash-rule); border-radius: 18px 5px 18px 5px; background: var(--dash-paper); }
.period-overview__head { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 20px 22px; background: rgba(var(--v-theme-primary), .07); }
.period-overview__eyebrow { color: rgb(var(--v-theme-primary)); font-size: .68rem; font-weight: 800; text-transform: uppercase; letter-spacing: .12em; }
.period-overview__head h3 { margin: 4px 0 0; font-size: 1.2rem; }
.period-overview__head p { margin: 4px 0 0; color: rgba(var(--v-theme-on-surface), .6); font-size: .78rem; }
.period-overview__actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 14px; }
.period-overview__actions a { color: rgb(var(--v-theme-primary)); font-size: .78rem; font-weight: 700; text-decoration: none; white-space: nowrap; }
.period-metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); }
.period-metrics > a { min-width: 0; min-height: 122px; padding: 18px; color: inherit; text-decoration: none; border-inline-start: 1px solid var(--dash-rule); display: flex; flex-direction: column; justify-content: center; gap: 9px; transition: background-color .18s ease; }
.period-metrics > a:first-child { border-inline-start: 0; }
.period-metrics > a:hover { background: rgba(var(--v-theme-primary), .04); }
.period-metrics span { color: rgba(var(--v-theme-on-surface), .6); font-size: .74rem; }
.period-metrics strong { font-size: clamp(1rem, 1.5vw, 1.3rem); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.period-metrics small { color: rgba(var(--v-theme-on-surface), .5); font-size: .65rem; line-height: 1.35; }
.period-metric--outflow { box-shadow: inset 0 3px #d17a42; }
.period-metric--change { background: rgba(var(--v-theme-primary), .035); }
.trust-ribbon { border-radius: 6px 18px 6px 18px; }

.dashboard-section { border: 1px solid var(--dash-rule); border-radius: 6px 24px 6px 24px; background: var(--dash-paper); padding: clamp(22px, 3vw, 38px); }
.section-heading { display: flex; justify-content: space-between; gap: 24px; align-items: end; padding-bottom: 22px; border-bottom: 1px solid var(--dash-rule); }
.section-heading > div { display: grid; grid-template-columns: 42px 1fr; column-gap: 12px; }
.section-index { grid-row: 1 / 3; color: rgb(var(--v-theme-primary)); font-weight: 800; font-variant-numeric: tabular-nums; }
.section-heading h3 { margin: 0; font-size: 1.55rem; letter-spacing: -.025em; }
.section-heading p { margin: 4px 0 0; color: rgba(var(--v-theme-on-surface), .6); }
.section-link { color: rgb(var(--v-theme-primary)); text-decoration: none; font-weight: 650; white-space: nowrap; }

.due-grid { display: grid; grid-template-columns: repeat(5, 1fr); margin-top: 24px; border: 1px solid var(--dash-rule); }
.due-cell { padding: 18px; border-inline-end: 1px solid var(--dash-rule); min-height: 108px; display: flex; flex-direction: column; justify-content: space-between; }
.due-cell:last-child { border-inline-end: 0; }
.due-cell span { color: rgba(var(--v-theme-on-surface), .62); font-size: .8rem; }
.due-cell strong { font-size: 1.3rem; font-variant-numeric: tabular-nums; }
.due-cell--urgent { box-shadow: inset 0 3px rgb(var(--v-theme-error)); }
.due-cell--principal { background: rgba(var(--v-theme-primary), .06); }
.contract-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.contract-ticket { color: inherit; text-decoration: none; border: 1px solid var(--dash-rule); padding: 18px; border-radius: 14px 3px 14px 3px; }
.contract-ticket--warning { border-color: rgba(var(--v-theme-warning), .7); }
.contract-amount { font-size: 1.35rem; font-weight: 750; font-variant-numeric: tabular-nums; }
.contract-meta { display: grid; gap: 3px; font-size: .75rem; color: rgba(var(--v-theme-on-surface), .62); }
.curve-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
.curve-cell { padding: 12px; background: rgba(var(--v-theme-primary), .055); min-width: 0; }
.curve-cell span, .curve-cell strong { display: block; }
.curve-cell span { font-size: .72rem; color: rgba(var(--v-theme-on-surface), .6); }
.curve-cell strong { margin-top: 6px; font-size: .83rem; overflow-wrap: anywhere; }

.cashflow-table-wrap { overflow-x: auto; margin-top: 22px; }
.cashflow-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 12px; }
.trend-heading { display: flex; justify-content: space-between; align-items: center; gap: 20px; margin-top: 24px; }
.trend-heading strong { font-size: 1rem; }
.trend-heading p { margin: 4px 0 0; color: rgba(var(--v-theme-on-surface), .58); font-size: .78rem; }
.cashflow-table { width: 100%; border-collapse: collapse; min-width: 1180px; }
.cashflow-table th { text-align: start; font-size: .72rem; letter-spacing: .06em; text-transform: uppercase; color: rgba(var(--v-theme-on-surface), .55); }
.cashflow-table th, .cashflow-table td { padding: 14px 12px; border-bottom: 1px solid var(--dash-rule); font-variant-numeric: tabular-nums; }
.cashflow-table td:not(:first-child) { font-weight: 600; }
.cashflow-table a { color: rgb(var(--v-theme-primary)); text-decoration: none; font-weight: 700; }
.amount-positive { color: rgb(var(--v-theme-success)); }
.amount-negative { color: rgb(var(--v-theme-error)); }
.accounting-boundary { color: rgba(var(--v-theme-on-surface), .64); font-size: .82rem; border-inline-start: 3px solid rgb(var(--v-theme-primary)); padding-inline-start: 12px; }

.coverage-summary { display: grid; grid-template-columns: repeat(8, 1fr); gap: 1px; background: var(--dash-rule); border: 1px solid var(--dash-rule); margin-top: 24px; }
.coverage-summary > div { background: var(--dash-paper); padding: 16px; display: flex; flex-direction: column; gap: 5px; }
.coverage-summary strong { font-size: 1.25rem; font-variant-numeric: tabular-nums; }
.coverage-summary span { color: rgba(var(--v-theme-on-surface), .58); font-size: .75rem; }
.coverage-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
.coverage-account { border: 1px solid var(--dash-rule); border-radius: 3px 14px 3px 14px; overflow: hidden; }
.coverage-account__head { display: flex; justify-content: space-between; align-items: start; gap: 12px; padding: 15px; background: rgba(var(--v-theme-primary), .045); }
.coverage-account__head > div { display: flex; flex-direction: column; gap: 3px; }
.coverage-account__head span { font-size: .72rem; color: rgba(var(--v-theme-on-surface), .55); }
.coverage-account__body { padding: 14px 15px; font-size: .78rem; color: rgba(var(--v-theme-on-surface), .68); }
.coverage-account__body p { margin: 4px 0; }
.empty-inline { padding: 24px; border: 1px dashed var(--dash-rule); text-align: center; color: rgba(var(--v-theme-on-surface), .58); }

@media (max-width: 1100px) {
    .dashboard-masthead { grid-template-columns: 1fr; }
    .getting-started__steps { grid-template-columns: 1fr; }
    .getting-started__steps > a { border-top: 1px solid var(--dash-rule); border-inline-start: 0; }
    .getting-started__steps > a:first-child { border-top: 0; }
    .snapshot-grid { grid-template-columns: repeat(2, 1fr); }
    .period-metrics { grid-template-columns: repeat(3, 1fr); }
    .period-metrics > a { border-top: 1px solid var(--dash-rule); }
    .period-metrics > a:nth-child(3n + 1) { border-inline-start: 0; }
    .due-grid { grid-template-columns: repeat(3, 1fr); }
    .due-cell { border-bottom: 1px solid var(--dash-rule); }
    .curve-grid { grid-template-columns: repeat(3, 1fr); }
    .coverage-summary { grid-template-columns: repeat(3, 1fr); }
}

@media (max-width: 640px) {
    .getting-started__head { flex-direction: column; }
    .snapshot-grid { grid-template-columns: 1fr; }
    .period-overview__head, .trend-heading { align-items: flex-start; flex-direction: column; }
    .period-overview__actions { justify-content: flex-start; }
    .period-metrics { grid-template-columns: 1fr; }
    .period-metrics > a { border-inline-start: 0; }
    .due-grid, .coverage-summary { grid-template-columns: repeat(2, 1fr); }
    .curve-grid { grid-template-columns: repeat(2, 1fr); }
    .section-heading { align-items: start; flex-direction: column; }
}
</style>
