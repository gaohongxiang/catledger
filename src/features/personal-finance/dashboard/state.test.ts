import { describe, expect, it } from 'vitest';

import { automaticReportStartDate, createDashboardQuery, todayCivilDate } from './state.ts';

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
