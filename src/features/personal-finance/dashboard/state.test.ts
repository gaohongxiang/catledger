import { describe, expect, it } from 'vitest';

import {
    automaticReportStartDate,
    composeDashboardHeadline,
    createDashboardQuery,
    nearestNextPayment,
    primaryDashboardHeadline,
    todayCivilDate
} from './state.ts';

describe('dashboard query state', () => {
    it('uses local civil today and automatically covers both year-to-date and trend months', () => {
        expect(todayCivilDate(new Date(2026, 7, 14, 23, 59))).toBe('2026-08-14');
        expect(automaticReportStartDate('2026-08-14', 6)).toBe('2026-01-01');
        expect(automaticReportStartDate('2026-08-14', 12)).toBe('2025-09-01');
        expect(automaticReportStartDate('2026-08-14', 24)).toBe('2024-09-01');
    });

    it('creates only bounded real-date and user-week queries', () => {
        expect(createDashboardQuery('2026-08-14', 12, 1)).toEqual({
            startDate: '2025-09-01', asOfDate: '2026-08-14', months: 12, firstDayOfWeek: 1
        });
        expect(() => createDashboardQuery('2026-02-30', 6, 1)).toThrow('invalid_dashboard_query');
        expect(() => createDashboardQuery('2026-08-14', 25, 1)).toThrow('invalid_dashboard_query');
        expect(() => createDashboardQuery('2026-08-14', 12, 7)).toThrow('invalid_dashboard_query');
    });
});

describe('dashboard headline state', () => {
    it('orders trust warnings by decision priority', () => {
        const items = composeDashboardHeadline({ coverageComplete: false, accountsWithGaps: 2, uncategorizedCount: 3, todoOpenCount: 4, balanceUnverifiedCount: 5 });
        expect(items.map(item => item.code)).toEqual(['provisional_month', 'uncategorized_count', 'todo_open_count', 'balance_unverified_count']);
        expect(primaryDashboardHeadline(items)).toBe('provisional_month');
        expect(primaryDashboardHeadline([])).toBe('ready');
    });

    it('selects the nearest dated payment without mutating input', () => {
        const contracts = [
            { name: 'later', currency: 'CNY', nextDueAmount: '2', nextDueDate: '2026-09-02' },
            { name: 'sooner', currency: 'CNY', nextDueAmount: '1', nextDueDate: '2026-08-29' }
        ];
        expect(nearestNextPayment(contracts)?.name).toBe('sooner');
        expect(contracts[0]?.name).toBe('later');
    });
});
