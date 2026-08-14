import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services.ts', () => ({
    default: { getPersonalFinanceDashboardOverview: vi.fn() }
}));

import { DashboardProtocolError, normalizeDashboardOverview } from './service.ts';

function overview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        startDate: '2026-01-01',
        asOfDate: '2026-08-14',
        generatedUnixTime: 1786656000,
        accountSnapshot: [{
            currency: 'CNY',
            assets: '9223372036854775807',
            liabilities: '1',
            netWorth: '9223372036854775806',
            liquidFunds: '9007199254740993',
            creditCardLiability: '0',
            debtAccountLiability: '1'
        }],
        monthlyCashFlow: [],
        cashFlowPeriods: [
            { kind: 'today', startDate: '2026-08-14', endDate: '2026-08-14', amounts: [] },
            { kind: 'week', startDate: '2026-08-10', endDate: '2026-08-14', amounts: [] },
            { kind: 'month', startDate: '2026-08-01', endDate: '2026-08-14', amounts: [] },
            { kind: 'year', startDate: '2026-01-01', endDate: '2026-08-14', amounts: [] }
        ],
        debt: { amounts: [], contracts: [], futureCurve: [] },
        coverage: {
            sourceAccountCount: 0,
            mappedAccountCount: 0,
            coveredAccountCount: 0,
            accountsWithGaps: 0,
            latestCoveredDate: null,
            pendingRowCount: 0,
            invalidRowCount: 0,
            exactDuplicateRowCount: 0,
            identityConflictRowCount: 0,
            failedBatchCount: 0,
            unconfirmedExcluded: true,
            complete: true,
            accounts: []
        },
        trust: {
            ledgerTransactionCount: 0,
            activeLoanContractCount: 0,
            loanClassificationIssueCount: 0,
            amountsGroupedByCurrency: true,
            historicalBalanceDerived: true,
            hasWarnings: false
        },
        drilldown: {
            accounts: '/account/list',
            transactions: '/transaction/list',
            loans: '/personal-finance/loans',
            imports: '/personal-finance/imports'
        },
        ...overrides
    };
}

describe('dashboard response protocol', () => {
    it('preserves int64 money and identifiers as strings without number coercion', () => {
        const result = normalizeDashboardOverview(overview());
        expect(result.accountSnapshot[0]?.assets).toBe('9223372036854775807');
        expect(result.accountSnapshot[0]?.liquidFunds).toBe('9007199254740993');
    });

    it.each([
        { accountSnapshot: [{ currency: 'CNY', assets: 1 }] },
        { startDate: '2026-02-30' },
        { generatedUnixTime: Number.MAX_SAFE_INTEGER + 1 },
        { cashFlowPeriods: [{ kind: 'month', startDate: '2026-08-01', endDate: '2026-08-14', amounts: [] }] },
        { drilldown: { accounts: 'https://example.com', transactions: '/transaction/list', loans: '/personal-finance/loans', imports: '/personal-finance/imports' } }
    ])('rejects malformed or unsafe payloads', value => {
        expect(() => normalizeDashboardOverview(overview(value))).toThrow(DashboardProtocolError);
    });
});
