import type { DashboardAccountAmount, DashboardCashFlowMonth, DashboardDebtAmount, DashboardQuery } from './models.ts';

export const DASHBOARD_REPORT_START_STORAGE_KEY = 'personalFinance.dashboard.reportStartDate';
export const DASHBOARD_DEFAULT_MONTHS = 6;

function isCivilDate(value: string): boolean {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!parts) return false;
    const parsed = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])));
    return parsed.getUTCFullYear() === Number(parts[1]) && parsed.getUTCMonth() + 1 === Number(parts[2]) && parsed.getUTCDate() === Number(parts[3]);
}

export function todayCivilDate(now: Date = new Date()): string {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function defaultReportStartDate(asOfDate: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOfDate);
    if (!match) return asOfDate;
    return `${match[1]}-01-01`;
}

export function createDashboardQuery(startDate: string, asOfDate: string, months: number = DASHBOARD_DEFAULT_MONTHS): DashboardQuery {
    if (!isCivilDate(startDate) || !isCivilDate(asOfDate) ||
        startDate > asOfDate || !Number.isSafeInteger(months) || months < 1 || months > 24) {
        throw new Error('invalid_dashboard_query');
    }
    return { startDate, asOfDate, months };
}

export function findAccountAmount(values: DashboardAccountAmount[], currency: string): DashboardAccountAmount | undefined {
    return values.find(value => value.currency === currency);
}

export function findDebtAmount(values: DashboardDebtAmount[], currency: string): DashboardDebtAmount | undefined {
    return values.find(value => value.currency === currency);
}

export function findCashFlowAmount(month: DashboardCashFlowMonth | undefined, currency: string) {
    return month?.amounts.find(value => value.currency === currency);
}
