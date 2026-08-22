import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

function source(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('personal-finance simple web workflow', () => {
    it('keeps one top-level overview and one statement-organizing entry', () => {
        const layout = source('../../../views/desktop/MainLayout.vue');

        expect(layout.match(/<router-link to="\/">/g)).toHaveLength(1);
        expect(layout.match(/to="\/personal-finance\/bills"/g)).toHaveLength(1);
        expect(layout).not.toContain('to="/personal-finance/imports"');
        expect(layout).not.toContain('to="/personal-finance/reconciliation"');
        expect(layout).toContain('personalFinance.simpleNav.more');
    });

    it('combines result-first organization, statement upload, and evidence review', () => {
        const organizer = source('./BillOrganizerPage.vue');
        const router = source('../../../router/desktop.ts');

        expect(organizer).toContain('ResultsFlowPage.vue');
        expect(organizer).not.toContain('TaskWorkbenchPage.vue');
        expect(organizer).toContain('ImportWorkbenchPage.vue');
        expect(organizer).toContain('ReconciliationWorkbenchPage.vue');
        expect(organizer).toContain("view === 'task'");
        expect(organizer).toContain("value=\"task\"");
        expect(organizer).toContain('value="imports"');
        expect(organizer).toContain('value="reconciliation"');
        expect(router).toContain("path: '/personal-finance/bills'");
        expect(router).toContain("path: '/personal-finance/imports'");
        expect(router).toContain("path: '/personal-finance/reconciliation'");
        expect(router).toContain("view: 'imports'");
        expect(router).toContain("view: 'reconciliation'");
    });

    it('teaches the batch-first workflow and progressively discloses loan details', () => {
        const dashboard = source('../dashboard/desktop/DashboardPage.vue');
        const loans = source('../loans/desktop/LoanWorkbenchPage.vue');

        expect(dashboard).toContain('personalFinance.dashboard.gettingStarted.boundary');
        expect(dashboard).toContain('to="/personal-finance/bills"');
        expect(dashboard).not.toContain('/personal-finance/bills?view=imports');
        expect(dashboard).not.toContain('/personal-finance/bills?view=reconciliation');
        expect(loans).toContain('<v-expansion-panels class="calculation-disclosure');
        expect(loans).toContain('personalFinance.loans.advanced.hint');
    });
});
