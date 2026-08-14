import services from '@/lib/services.ts';

import type {
    DashboardAccountAmount,
    DashboardCashFlowAmount,
    DashboardCashFlowMonth,
    DashboardCashFlowPeriod,
    DashboardCashFlowPeriodKind,
    DashboardCoverageSummary,
    DashboardDateRange,
    DashboardDebtAmount,
    DashboardDebtContract,
    DashboardDebtCurveAmount,
    DashboardDebtCurveMonth,
    DashboardDebtSummary,
    DashboardDrilldown,
    DashboardQuery,
    DashboardSourceCoverage,
    DashboardTrustSummary,
    PersonalFinanceDashboardOverview
} from './models.ts';

type UnknownRecord = Record<string, unknown>;

export class DashboardProtocolError extends Error {
    public constructor() {
        super('invalid_dashboard_response');
    }
}

function fail(): never {
    throw new DashboardProtocolError();
}

function record(value: unknown): UnknownRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    return value as UnknownRecord;
}

function array(value: unknown): unknown[] {
    if (!Array.isArray(value)) fail();
    return value;
}

function string(value: unknown): string {
    if (typeof value !== 'string') fail();
    return value;
}

function identifier(value: unknown): string {
    const result = string(value);
    if (!/^[1-9]\d*$/.test(result)) fail();
    return result;
}

function amount(value: unknown): string {
    const result = string(value);
    if (!/^-?(0|[1-9]\d*)$/.test(result) || result === '-0') fail();
    const parsed = BigInt(result);
    if (parsed < -9223372036854775808n || parsed > 9223372036854775807n) fail();
    return result;
}

function currency(value: unknown): string {
    const result = string(value);
    if (!/^[A-Z]{3}$/.test(result)) fail();
    return result;
}

function date(value: unknown): string {
    const result = string(value);
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(result);
    if (!parts) fail();
    const parsed = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])));
    if (parsed.getUTCFullYear() !== Number(parts[1]) || parsed.getUTCMonth() + 1 !== Number(parts[2]) || parsed.getUTCDate() !== Number(parts[3])) fail();
    return result;
}

function month(value: unknown): string {
    const result = string(value);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(result)) fail();
    return result;
}

function integer(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) fail();
    return value as number;
}

function boolean(value: unknown): boolean {
    if (typeof value !== 'boolean') fail();
    return value;
}

function optionalString(value: unknown, parser: (input: unknown) => string): string | undefined {
    return value === null || typeof value === 'undefined' ? undefined : parser(value);
}

function dateRange(value: unknown): DashboardDateRange {
    const item = record(value);
    const startDate = date(item['startDate']);
    const endDate = date(item['endDate']);
    if (startDate > endDate) fail();
    return { startDate, endDate };
}

function accountAmount(value: unknown): DashboardAccountAmount {
    const item = record(value);
    return {
        currency: currency(item['currency']),
        assets: amount(item['assets']),
        liabilities: amount(item['liabilities']),
        netWorth: amount(item['netWorth']),
        liquidFunds: amount(item['liquidFunds']),
        creditCardLiability: amount(item['creditCardLiability']),
        debtAccountLiability: amount(item['debtAccountLiability'])
    };
}

function cashFlowAmount(value: unknown): DashboardCashFlowAmount {
    const item = record(value);
    return {
        currency: currency(item['currency']),
        income: amount(item['income']),
        consumption: amount(item['consumption']),
        balanceAdjustment: amount(item['balanceAdjustment']),
        loanPrincipal: amount(item['loanPrincipal']),
        loanInterest: amount(item['loanInterest']),
        loanFee: amount(item['loanFee']),
        loanDisbursement: amount(item['loanDisbursement']),
        internalTransfer: amount(item['internalTransfer']),
        liquidFundsNetChange: amount(item['liquidFundsNetChange'])
    };
}

function cashFlowMonth(value: unknown): DashboardCashFlowMonth {
    const item = record(value);
    return { month: month(item['month']), amounts: array(item['amounts']).map(cashFlowAmount) };
}

const cashFlowPeriodKinds: DashboardCashFlowPeriodKind[] = ['today', 'week', 'month', 'year'];

function cashFlowPeriod(value: unknown, expectedKind: DashboardCashFlowPeriodKind, asOfDate: string): DashboardCashFlowPeriod {
    const item = record(value);
    const kind = string(item['kind']);
    const startDate = date(item['startDate']);
    const endDate = date(item['endDate']);
    if (kind !== expectedKind || startDate > endDate || endDate !== asOfDate) fail();
    return { kind: expectedKind, startDate, endDate, amounts: array(item['amounts']).map(cashFlowAmount) };
}

function debtAmount(value: unknown): DashboardDebtAmount {
    const item = record(value);
    return {
        currency: currency(item['currency']),
        plannedRemainingPrincipal: amount(item['plannedRemainingPrincipal']),
        overduePayment: amount(item['overduePayment']),
        dueWithin7Days: amount(item['dueWithin7Days']),
        dueWithin30Days: amount(item['dueWithin30Days']),
        dueThisMonth: amount(item['dueThisMonth'])
    };
}

function debtContract(value: unknown): DashboardDebtContract {
    const item = record(value);
    return {
        contractId: identifier(item['contractId']),
        name: string(item['name']),
        currency: currency(item['currency']),
        remainingPrincipal: amount(item['remainingPrincipal']),
        remainingInstallments: integer(item['remainingInstallments']),
        effectiveAprPptr: optionalString(item['effectiveAprPptr'], amount),
        nextDueDate: optionalString(item['nextDueDate'], date),
        nextDueAmount: amount(item['nextDueAmount']),
        ledgerOutstanding: optionalString(item['ledgerOutstanding'], amount),
        ledgerPlanDifference: optionalString(item['ledgerPlanDifference'], amount),
        actionRequired: boolean(item['actionRequired'])
    };
}

function debtCurveAmount(value: unknown): DashboardDebtCurveAmount {
    const item = record(value);
    return { currency: currency(item['currency']), payment: amount(item['payment']) };
}

function debtCurveMonth(value: unknown): DashboardDebtCurveMonth {
    const item = record(value);
    return { month: month(item['month']), amounts: array(item['amounts']).map(debtCurveAmount) };
}

function debtSummary(value: unknown): DashboardDebtSummary {
    const item = record(value);
    return {
        amounts: array(item['amounts']).map(debtAmount),
        contracts: array(item['contracts']).map(debtContract),
        futureCurve: array(item['futureCurve']).map(debtCurveMonth)
    };
}

function sourceCoverage(value: unknown): DashboardSourceCoverage {
    const item = record(value);
    return {
        sourceAccountId: identifier(item['sourceAccountId']),
        maskedDisplayName: string(item['maskedDisplayName']),
        ledgerAccountId: optionalString(item['ledgerAccountId'], identifier),
        intervals: array(item['intervals']).map(dateRange),
        gaps: array(item['gaps']).map(dateRange),
        overlaps: array(item['overlaps']).map(dateRange),
        latestCoveredDate: optionalString(item['latestCoveredDate'], date),
        unknownPeriod: boolean(item['unknownPeriod'])
    };
}

function coverageSummary(value: unknown): DashboardCoverageSummary {
    const item = record(value);
    return {
        sourceAccountCount: integer(item['sourceAccountCount']),
        mappedAccountCount: integer(item['mappedAccountCount']),
        coveredAccountCount: integer(item['coveredAccountCount']),
        accountsWithGaps: integer(item['accountsWithGaps']),
        latestCoveredDate: optionalString(item['latestCoveredDate'], date),
        pendingRowCount: integer(item['pendingRowCount']),
        invalidRowCount: integer(item['invalidRowCount']),
        exactDuplicateRowCount: integer(item['exactDuplicateRowCount']),
        identityConflictRowCount: integer(item['identityConflictRowCount']),
        failedBatchCount: integer(item['failedBatchCount']),
        unconfirmedExcluded: boolean(item['unconfirmedExcluded']),
        complete: boolean(item['complete']),
        accounts: array(item['accounts']).map(sourceCoverage)
    };
}

function trustSummary(value: unknown): DashboardTrustSummary {
    const item = record(value);
    return {
        ledgerTransactionCount: integer(item['ledgerTransactionCount']),
        activeLoanContractCount: integer(item['activeLoanContractCount']),
        loanClassificationIssueCount: integer(item['loanClassificationIssueCount']),
        amountsGroupedByCurrency: boolean(item['amountsGroupedByCurrency']),
        historicalBalanceDerived: boolean(item['historicalBalanceDerived']),
        hasWarnings: boolean(item['hasWarnings'])
    };
}

function drilldown(value: unknown): DashboardDrilldown {
    const item = record(value);
    const result = {
        accounts: string(item['accounts']),
        transactions: string(item['transactions']),
        loans: string(item['loans']),
        imports: string(item['imports'])
    };
    if (Object.values(result).some(path => !path.startsWith('/'))) fail();
    return result;
}

export function normalizeDashboardOverview(value: unknown): PersonalFinanceDashboardOverview {
    const item = record(value);
    const startDate = date(item['startDate']);
    const asOfDate = date(item['asOfDate']);
    if (startDate > asOfDate) fail();
    const periodValues = array(item['cashFlowPeriods']);
    if (periodValues.length !== cashFlowPeriodKinds.length) fail();
    return {
        startDate,
        asOfDate,
        generatedUnixTime: integer(item['generatedUnixTime']),
        accountSnapshot: array(item['accountSnapshot']).map(accountAmount),
        monthlyCashFlow: array(item['monthlyCashFlow']).map(cashFlowMonth),
        cashFlowPeriods: periodValues.map((period, index) => cashFlowPeriod(period, cashFlowPeriodKinds[index] as DashboardCashFlowPeriodKind, asOfDate)),
        debt: debtSummary(item['debt']),
        coverage: coverageSummary(item['coverage']),
        trust: trustSummary(item['trust']),
        drilldown: drilldown(item['drilldown'])
    };
}

function unwrap(response: unknown): unknown {
    const outer = record(response);
    const data = record(outer['data']);
    if (data['success'] !== true || data['result'] === null || typeof data['result'] === 'undefined') fail();
    return data['result'];
}

export async function getDashboardOverview(query: DashboardQuery): Promise<PersonalFinanceDashboardOverview> {
    if (query.months < 1 || query.months > 24 || !Number.isSafeInteger(query.months) ||
        query.firstDayOfWeek < 0 || query.firstDayOfWeek > 6 || !Number.isSafeInteger(query.firstDayOfWeek)) fail();
    return normalizeDashboardOverview(unwrap(await services.getPersonalFinanceDashboardOverview(query)));
}
