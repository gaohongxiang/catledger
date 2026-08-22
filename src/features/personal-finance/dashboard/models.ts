export interface DashboardAccountAmount {
    currency: string;
    assets: string;
    liabilities: string;
    netWorth: string;
    liquidFunds: string;
    creditCardLiability: string;
    debtAccountLiability: string;
}

export interface DashboardCashFlowAmount {
    currency: string;
    income: string;
    consumption: string;
    balanceAdjustment: string;
    loanPrincipal: string;
    loanInterest: string;
    loanFee: string;
    loanDisbursement: string;
    internalTransfer: string;
    liquidFundsNetChange: string;
}

export interface DashboardCashFlowMonth {
    month: string;
    amounts: DashboardCashFlowAmount[];
}

export type DashboardCashFlowPeriodKind = 'today' | 'week' | 'month' | 'year';

export interface DashboardCashFlowPeriod {
    kind: DashboardCashFlowPeriodKind;
    startDate: string;
    endDate: string;
    amounts: DashboardCashFlowAmount[];
}

export interface DashboardDebtAmount {
    currency: string;
    plannedRemainingPrincipal: string;
    overduePayment: string;
    dueWithin7Days: string;
    dueWithin30Days: string;
    dueThisMonth: string;
}

export interface DashboardDebtContract {
    contractId: string;
    name: string;
    currency: string;
    remainingPrincipal: string;
    remainingInstallments: number;
    effectiveAprPptr?: string;
    nextDueDate?: string;
    nextDueAmount: string;
    ledgerOutstanding?: string;
    ledgerPlanDifference?: string;
    actionRequired: boolean;
}

export interface DashboardDebtCurveAmount {
    currency: string;
    payment: string;
}

export interface DashboardDebtCurveMonth {
    month: string;
    amounts: DashboardDebtCurveAmount[];
}

export interface DashboardDebtSummary {
    amounts: DashboardDebtAmount[];
    contracts: DashboardDebtContract[];
    futureCurve: DashboardDebtCurveMonth[];
}

export interface DashboardDateRange {
    startDate: string;
    endDate: string;
}

export interface DashboardSourceCoverage {
    sourceAccountId: string;
    maskedDisplayName: string;
    ledgerAccountId?: string;
    intervals: DashboardDateRange[];
    gaps: DashboardDateRange[];
    overlaps: DashboardDateRange[];
    latestCoveredDate?: string;
    unknownPeriod: boolean;
}

export interface DashboardCoverageSummary {
    sourceAccountCount: number;
    mappedAccountCount: number;
    coveredAccountCount: number;
    accountsWithGaps: number;
    latestCoveredDate?: string;
    pendingRowCount: number;
    invalidRowCount: number;
    exactDuplicateRowCount: number;
    identityConflictRowCount: number;
    failedBatchCount: number;
    unconfirmedExcluded: boolean;
    complete: boolean;
    accounts: DashboardSourceCoverage[];
}

export interface DashboardTrustSummary {
    ledgerTransactionCount: number;
    activeLoanContractCount: number;
    loanClassificationIssueCount: number;
    amountsGroupedByCurrency: boolean;
    historicalBalanceDerived: boolean;
    hasWarnings: boolean;
}

export interface DashboardDrilldown {
    accounts: string;
    transactions: string;
    loans: string;
    imports: string;
}

export interface PersonalFinanceDashboardOverview {
    startDate: string;
    asOfDate: string;
    generatedUnixTime: number;
    accountSnapshot: DashboardAccountAmount[];
    monthlyCashFlow: DashboardCashFlowMonth[];
    cashFlowPeriods: DashboardCashFlowPeriod[];
    debt: DashboardDebtSummary;
    coverage: DashboardCoverageSummary;
    trust: DashboardTrustSummary;
    drilldown: DashboardDrilldown;
}

export interface DashboardQuery {
    startDate: string;
    asOfDate: string;
    months: number;
    firstDayOfWeek: number;
}

export type DashboardHeadlineCode =
    'provisional_month' | 'uncategorized_count' | 'todo_open_count' | 'balance_unverified_count';

export interface DashboardHeadlineItem {
    readonly code: DashboardHeadlineCode;
    readonly count: number;
}

export interface CardCycleAccount {
    readonly ledgerAccountId: string;
    readonly displayName: string;
    readonly currency: string;
    readonly monthStatus: 'provisional' | 'confirmed';
    readonly balanceReview?: {
        readonly id: string;
        readonly status: 'unverified' | 'verified';
        readonly asOfDate: string;
        readonly version: number;
    };
}
