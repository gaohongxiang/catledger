import { computed, ref } from 'vue';

import type { BigDecimalWithSuffix } from '@/core/numeral.ts';
import { INCOMPLETE_AMOUNT_SUFFIX } from '@/consts/numeral.ts';
import { useI18n } from '@/locales/helpers.ts';
import { useExchangeRatesStore } from '@/stores/exchangeRates.ts';
import { useUserStore } from '@/stores/user.ts';
import { BIG_DECIMAL_ZERO, parseBigDecimal } from '@/lib/numeral.ts';

import type {
    DashboardAccountAmount,
    DashboardCashFlowAmount,
    DashboardDebtAmount,
    PersonalFinanceDashboardOverview
} from './models.ts';
import { getDashboardOverview } from './service.ts';
import {
    createDashboardQuery,
    DASHBOARD_DEFAULT_MONTHS,
    DASHBOARD_REPORT_START_STORAGE_KEY,
    defaultReportStartDate,
    todayCivilDate
} from './state.ts';

type CurrencyBucket = { currency: string };

export function useDashboard() {
    const { formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
    const userStore = useUserStore();
    const exchangeRatesStore = useExchangeRatesStore();
    const asOfDate = ref(todayCivilDate());
    const storedStart = localStorage.getItem(DASHBOARD_REPORT_START_STORAGE_KEY);
    const startDate = ref(storedStart && storedStart <= asOfDate.value ? storedStart : defaultReportStartDate(asOfDate.value));
    const months = ref(DASHBOARD_DEFAULT_MONTHS);
    const overview = ref<PersonalFinanceDashboardOverview>();
    const loading = ref(false);
    const error = ref(false);
    const defaultCurrency = computed(() => userStore.currentUserDefaultCurrency || 'CNY');

    async function load(): Promise<void> {
        loading.value = true;
        error.value = false;
        try {
            const query = createDashboardQuery(startDate.value, asOfDate.value, months.value);
            overview.value = await getDashboardOverview(query);
            localStorage.setItem(DASHBOARD_REPORT_START_STORAGE_KEY, query.startDate);
        } catch (reason) {
            error.value = true;
            throw reason;
        } finally {
            loading.value = false;
        }
    }

    function total(values: readonly CurrencyBucket[], field: string): BigDecimalWithSuffix {
        let result = BIG_DECIMAL_ZERO;
        let incomplete = false;
        for (const item of values) {
            const rawValue = (item as unknown as Record<string, unknown>)[field];
            if (typeof rawValue !== 'string') {
                throw new Error(`Dashboard amount field ${field} is invalid`);
            }
            const value = parseBigDecimal(rawValue);
            if (item.currency === defaultCurrency.value) {
                result = result.add(value);
                continue;
            }
            const exchanged = exchangeRatesStore.getExchangedAmount(value, item.currency, defaultCurrency.value);
            if (!exchanged) {
                incomplete = true;
                continue;
            }
            result = result.add(exchanged.truncate());
        }
        return { value: result, suffix: incomplete ? INCOMPLETE_AMOUNT_SUFFIX : '' };
    }

    function format(value: BigDecimalWithSuffix): string {
        return formatAmountToLocalizedNumeralsWithCurrency(value, defaultCurrency.value);
    }

    function accountTotal(field: keyof DashboardAccountAmount): string {
        return format(total(overview.value?.accountSnapshot ?? [], field));
    }

    function debtTotal(field: keyof DashboardDebtAmount): string {
        return format(total(overview.value?.debt.amounts ?? [], field));
    }

    function cashFlowTotal(value: DashboardCashFlowAmount[] | undefined, field: keyof DashboardCashFlowAmount): string {
        return format(total(value ?? [], field));
    }

    function cashFlowDebtRatio(value: DashboardCashFlowAmount[] | undefined): string | undefined {
        const values = value ?? [];
        const income = total(values, 'income');
        const principal = total(values, 'loanPrincipal');
        const interest = total(values, 'loanInterest');
        const fee = total(values, 'loanFee');
        if (income.suffix || principal.suffix || interest.suffix || fee.suffix || !income.value.isPositive()) {
            return undefined;
        }
        const debtService = principal.value.add(interest.value).add(fee.value);
        const ratio = debtService.divide(income.value).multiply(100).toDoubleNumber();
        return Number.isFinite(ratio) ? ratio.toFixed(1) : undefined;
    }

    function formatRawAmount(value: string, currency: string): string {
        return formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(value), currency);
    }

    return {
        asOfDate,
        startDate,
        months,
        overview,
        loading,
        error,
        defaultCurrency,
        load,
        accountTotal,
        debtTotal,
        cashFlowTotal,
        cashFlowDebtRatio,
        formatRawAmount
    };
}
