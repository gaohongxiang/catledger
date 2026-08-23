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

    it('keeps review and raw statement records in one route-local workspace', () => {
        const organizer = source('./BillOrganizerPage.vue');
        const router = source('../../../router/desktop.ts');

        expect(organizer).toContain('ResultsFlowPage.vue');
        expect(organizer).not.toContain('TaskWorkbenchPage.vue');
        expect(organizer).toContain('ImportWorkbenchPage.vue');
        expect(organizer).not.toContain('ReconciliationWorkbenchPage.vue');
        expect(organizer).not.toContain('useRoute');
        expect(organizer).not.toContain('useRouter');
        expect(organizer).toContain("ref<BillOrganizerView>('review')");
        expect(organizer).toContain('value="review"');
        expect(organizer).toContain('value="records"');
        expect(organizer).not.toContain('@open-records');
        const results = source('../organizer/desktop/ResultsFlowPage.vue');
        expect(results).toContain('activeWorkflowStep === 1');
        expect(results).toContain('<import-upload-button');
        expect(results).toContain('selectedBatchIds.includes(batch.id)');
        expect(results).toContain('organizerApi.getUpdate(selected.id)');
        expect(results).not.toContain("emit('open-records')");
        expect(router).toContain("path: '/personal-finance/bills'");
        expect(router).toContain("path: '/personal-finance/imports'");
        expect(router).toContain("path: '/personal-finance/reconciliation'");
        expect(router).not.toContain("view: 'imports'");
        expect(router).not.toContain("view: 'reconciliation'");
    });

    it('keeps one primary round action and abandons immutable sources before reselection', () => {
        const results = source('../organizer/desktop/ResultsFlowPage.vue');

        expect(results).toContain('personalFinance.organizerV2.action.continueReview');
        expect(results).toContain('personalFinance.organizerV2.action.confirmAndPost');
        expect(results).toContain('canAbandonUpdate(update)');
        expect(results).toContain('organizerApi.abandon(current');
        expect(results).toContain('abandonAndReselect');
        expect(results).toContain('visibilitychange');
        expect(results).not.toContain('organizeCurrent');
        expect(results).not.toContain('mdiRefresh');
        expect(results).not.toContain('@click="load"');
    });

    it('keeps raw records non-posting and reviews ledger fields in the organizer', () => {
        const records = source('./ImportWorkbenchPage.vue');
        const results = source('../organizer/desktop/ResultsFlowPage.vue');

        expect(records).not.toContain('PostingDialog.vue');
        expect(records).not.toContain('openPosting(row)');
        expect(results).toContain('selectedLedgerAccountId');
        expect(results).toContain('selectedCounterpartyLedgerAccountId');
        expect(results).toContain('selectedCategoryId');
        expect(results).toContain('let fieldMask = 1 | 4 | 8');
        expect(results).toContain('fieldMask |= 128');
        expect(results).not.toContain('fieldMask |= 256');
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
