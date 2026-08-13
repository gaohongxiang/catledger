import { describe, expect, it } from 'vitest';

import { createDashboardQuery, defaultReportStartDate, todayCivilDate } from './state.ts';

describe('dashboard query state', () => {
    it('uses local civil dates and the beginning of the selected year', () => {
        expect(todayCivilDate(new Date(2026, 7, 14, 23, 59))).toBe('2026-08-14');
        expect(defaultReportStartDate('2026-08-14')).toBe('2026-01-01');
    });

    it('creates only bounded, ordered, real civil-date queries', () => {
        expect(createDashboardQuery('2026-01-01', '2026-08-14', 6)).toEqual({ startDate: '2026-01-01', asOfDate: '2026-08-14', months: 6 });
        expect(() => createDashboardQuery('2026-02-30', '2026-08-14', 6)).toThrow('invalid_dashboard_query');
        expect(() => createDashboardQuery('2026-08-15', '2026-08-14', 6)).toThrow('invalid_dashboard_query');
        expect(() => createDashboardQuery('2026-01-01', '2026-08-14', 25)).toThrow('invalid_dashboard_query');
    });
});
