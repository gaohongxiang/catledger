import { computed, ref } from 'vue';

import type { BigDecimalWithSuffix } from '@/core/numeral.ts';
import { DISPLAY_HIDDEN_AMOUNT, INCOMPLETE_AMOUNT_SUFFIX } from '@/consts/numeral.ts';
import { useI18n } from '@/locales/helpers.ts';
import { useExchangeRatesStore } from '@/stores/exchangeRates.ts';
import { useSettingsStore } from '@/stores/setting.ts';
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
    todayCivilDate
} from './state.ts';

type CurrencyBucket = { currency: string };
type CashFlowAmountField = Exclude<keyof DashboardCashFlowAmount, 'currency'>;

export function useDashboard() {
    const { formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
    const userStore = useUserStore();
    const settingsStore = useSettingsStore();
    const exchangeRatesStore = useExchangeRatesStore();
    const asOfDate = ref(todayCivilDate());
    const months = ref(DASHBOARD_DEFAULT_MONTHS);
    const overview = ref<PersonalFinanceDashboardOverview>();
    const loading = ref(false);
    const error = ref(false);
    const defaultCurrency = computed(() => userStore.currentUserDefaultCurrency || 'CNY');
    const showAmounts = computed<boolean>({
        get: () => settingsStore.appSettings.showAmountInHomePage,
        set: (value) => settingsStore.setShowAmountInHomePage(value)
    });

    async function load(): Promise<void> {
        loading.value = true;
        error.value = false;
        try {
            asOfDate.value = todayCivilDate();
            const query = createDashboardQuery(asOfDate.value, months.value, userStore.currentUserFirstDayOfWeek);
            overview.value = await getDashboardOverview(query);
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
        if (!showAmounts.value) {
            return formatAmountToLocalizedNumeralsWithCurrency(DISPLAY_HIDDEN_AMOUNT, defaultCurrency.value);
        }
        return formatAmountToLocalizedNumeralsWithCurrency(value, defaultCurrency.value);
    }

    function accountTotal(field: keyof DashboardAccountAmount): string {
        return format(total(overview.value?.accountSnapshot ?? [], field));
    }

    function debtTotal(field: keyof DashboardDebtAmount): string {
        return format(total(overview.value?.debt.amounts ?? [], field));
    }

    function cashFlowTotal(value: DashboardCashFlowAmount[] | undefined, field: CashFlowAmountField): string {
        return format(cashFlowValue(value, [field]));
    }

    function cashFlowValue(value: DashboardCashFlowAmount[] | undefined, fields: CashFlowAmountField[]): BigDecimalWithSuffix {
        let result = BIG_DECIMAL_ZERO;
        let incomplete = false;
        for (const field of fields) {
            const fieldTotal = total(value ?? [], field);
            result = result.add(fieldTotal.value);
            incomplete = incomplete || !!fieldTotal.suffix;
        }
        return { value: result, suffix: incomplete ? INCOMPLETE_AMOUNT_SUFFIX : '' };
    }

    function cashFlowDebtServiceTotal(value: DashboardCashFlowAmount[] | undefined): string {
        return format(cashFlowValue(value, ['loanPrincipal', 'loanInterest', 'loanFee']));
    }

    function cashFlowOutflowTotal(value: DashboardCashFlowAmount[] | undefined): string {
        return format(cashFlowValue(value, ['consumption', 'loanPrincipal', 'loanInterest', 'loanFee']));
    }

    function cashFlowDebtRatio(value: DashboardCashFlowAmount[] | undefined): string | undefined {
        const income = cashFlowValue(value, ['income']);
        const debtService = cashFlowValue(value, ['loanPrincipal', 'loanInterest', 'loanFee']);
        if (income.suffix || debtService.suffix || !income.value.isPositive()) {
            return undefined;
        }
        const ratio = debtService.value.divide(income.value).multiply(100).toDoubleNumber();
        return Number.isFinite(ratio) ? ratio.toFixed(1) : undefined;
    }

    function formatRawAmount(value: string, currency: string): string {
        if (!showAmounts.value) {
            return formatAmountToLocalizedNumeralsWithCurrency(DISPLAY_HIDDEN_AMOUNT, currency);
        }
        return formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(value), currency);
    }

    return {
        asOfDate,
        months,
        overview,
        loading,
        error,
        defaultCurrency,
        showAmounts,
        load,
        accountTotal,
        debtTotal,
        cashFlowTotal,
        cashFlowValue,
        cashFlowDebtServiceTotal,
        cashFlowOutflowTotal,
        cashFlowDebtRatio,
        formatRawAmount
    };
}
