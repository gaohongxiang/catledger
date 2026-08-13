import type { DashboardCoverageSummary, DashboardSourceCoverage } from './models.ts';

export function coverageTone(coverage: DashboardCoverageSummary): 'success' | 'warning' | 'error' {
    if (coverage.complete) return 'success';
    if (coverage.failedBatchCount > 0 || coverage.identityConflictRowCount > 0) return 'error';
    return 'warning';
}

export function sourceCoverageTone(source: DashboardSourceCoverage): 'success' | 'warning' {
    return !source.unknownPeriod && source.gaps.length === 0 ? 'success' : 'warning';
}

export function formatCoverageRange(startDate: string, endDate: string): string {
    return startDate === endDate ? startDate : `${startDate} — ${endDate}`;
}
