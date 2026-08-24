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
        expect(results).toContain('v-for="batch in selectedBatches"');
        expect(results).toContain('@click="removeBatch(batch.id)"');
        expect(results).not.toContain('v-checkbox-btn');
        expect(results).toContain('organizerApi.getUpdate(selected.id)');
        expect(results).not.toContain("emit('open-records')");
        expect(router).toContain("path: '/personal-finance/bills'");
        expect(router).toContain("path: '/personal-finance/imports'");
        expect(router).toContain("path: '/personal-finance/reconciliation'");
        expect(router).not.toContain("view: 'imports'");
        expect(router).not.toContain("view: 'reconciliation'");
    });

    it('keeps one primary round action while allowing more statements to be added', () => {
        const results = source('../organizer/desktop/ResultsFlowPage.vue');
        const organizer = source('./BillOrganizerPage.vue');
        const upload = source('../components/ImportUploadButton.vue');
        const paymentAccounts = source('../components/PaymentAccountSetupDialog.vue');

        expect(results).toContain('<import-upload-button size="large" v-if="selectedBatchIds.length < 1" @changed="onImportChanged" />');
        expect(results).toContain('class="source-add"');
        expect(results).toContain('personalFinance.organizerV2.start.add');
        expect(results).toContain('v-else @click="startOrganizing"');
        expect(results).toContain('selectedBatchIds.value = readyBatches.value.map(batch => batch.id)');
        expect(results).toContain("paymentAccountSetupDialog.value?.open(selectedBatchIds.value, { unresolvedOnly: true })");
        expect(results).toContain('<payment-account-setup-dialog ref="paymentAccountSetupDialog" @saved="createAndOrganize" />');
        expect(upload).not.toContain('PaymentAccountSetupDialog');
        expect(upload).not.toContain('paymentAccountSetupDialog.value?.open');
        expect(paymentAccounts).toContain('Promise.all(batchIds.map');
        expect(paymentAccounts).toContain('const merged = new Map<string, PaymentAccountMember[]>()');
        expect(paymentAccounts).toContain('paymentAccountKey(group)');
        expect(paymentAccounts).toContain('personalFinanceStore.excludePaymentAccount');
        expect(paymentAccounts).toContain('personalFinanceStore.skipPaymentAccount');
        expect(paymentAccounts).toContain('personalFinanceStore.restorePaymentAccount');
        expect(paymentAccounts).toContain('personalFinance.paymentAccount.ignoreCurrent');
        expect(paymentAccounts).toContain('personalFinance.paymentAccount.ignoreFuture');
        expect(paymentAccounts).toContain('personalFinance.paymentAccount.ignoredAccounts');
        expect(paymentAccounts).toContain('.filter(draft => !options.unresolvedOnly || draft.group.excluded || !draft.group.mapped)');
        expect(results).toContain('personalFinance.organizerV2.action.continueReview');
        expect(results).toContain('personalFinance.organizerV2.action.confirmAndPost');
        expect(results).toContain('canAbandonUpdate(update)');
        expect(results).toContain('organizerApi.abandon(current');
        expect(results).toContain('abandonAndReselect');
        expect(results.match(/personalFinance\.organizerV2\.action\.abandonAndReselect/g)).toHaveLength(1);
        expect(results).toContain('<import-upload-button v-else-if="update.status === \'posted\' || update.status === \'undone\'" @changed="onImportChanged" />');
        expect(results).toContain("update.value?.status === 'posted' || update.value?.status === 'undone'");
        expect(results).toContain('resetToSourceSelection([batchId])');
        expect(results).not.toContain('personalFinance.organizerV2.action.new');
        expect(results).not.toContain('source-chips');
        expect(results).not.toContain('updateSourceNames');
        expect(results).not.toContain('<header><div><h3>{{ tt(\'personalFinance.organizerV2.sources.title\') }}</h3><p>{{ tt(\'personalFinance.organizerV2.sources.lockedHint\') }}</p></div><import-upload-button');
        expect(results).not.toContain('<v-menu>');
        expect(results).not.toContain('personalFinance.organizerV2.sources.continue');
        expect(results).not.toContain('mdiDotsHorizontal');
        expect(results).toContain('visibilitychange');
        expect(results).not.toContain('organizeCurrent');
        expect(results).not.toContain('mdiRefresh');
        expect(results).not.toContain('@click="load"');
        expect(results).toContain('<footer v-if="activeWorkflowStep !== 1">');
        expect(results).toContain('eventFilterCount(filter)');
        expect(results).toContain('class="conservation-inline"');
        expect(results).not.toContain('class="round-meta"');
        expect(results).not.toContain('#{{ update.id }}');
        expect(organizer).toContain('class="organizer-sync"');
        expect(organizer).toContain('@sync-label="organizerSyncLabel = $event"');
        expect(results).not.toContain('personalFinance.organizerV2.workflow.title');
        expect(results).not.toContain('personalFinance.organizerV2.workflow.hint');
        expect(results).not.toContain('class="verification"');
        expect(results.match(/class="round-primary-action"/g)).toHaveLength(2);
        expect(results).toContain('<footer v-if="update.needsActionEventCount > 0">');
        expect(results).toContain('class="post-all-action"');
        expect(results).toContain(':disabled="!canPostUpdate(update)"');
        expect(results).toContain('personalFinance.organizerV2.action.resolveBeforePost');
        expect(results).not.toContain('activeWorkflowStep !== 2');
        expect(results).not.toContain('personalFinance.organizerV2.events.eyebrow');
        expect(results).not.toContain('personalFinance.organizerV2.events.hint');
        expect(results).toContain('class="issue-actions"');
        expect(results).not.toContain('reviewIssueTitle');
        expect(results).not.toContain('.issue-card > footer');
        expect(results).toContain('personalFinance.organizerV2.audit.compactConservation');
        expect(results).toContain('update.postedEventCount');
        expect(results).toContain('item.row.rawFields');
        expect(results).toContain('personalFinance.organizerV2.evidence.originalFields');
        expect(results).toContain('personalFinance.organizerV2.audit.title');
        expect(results).toContain("['needs_action', 'anomaly', 'excluded', 'audit']");
        expect(results).not.toContain("['needs_action', 'ready', 'excluded', 'audit']");
        expect(results).not.toContain("['needs_action', 'ready', 'posted', 'excluded', 'audit']");
        expect(results).not.toContain("'all'");
        expect(results).not.toContain("'relation'");
        expect(results).toContain('showPostingStep');
        expect(results).toContain('postingStepShowsPosted');
        expect(results).toContain('class="posting-complete"');
        expect(results).toContain("eventFilter === 'audit'");
        expect(results).toContain("eventFilter !== 'audit'");
        expect(results).toContain('auditEvents.value = pages.flat().filter(event => event.evidenceCount > 1)');
        expect(results).toContain("reasons.includes('auto_same_event')");
        expect(results).toContain('personalFinance.organizerV2.audit.amountWarning');
        expect(results).toContain('v-for="event in auditEvents"');
        expect(results).not.toContain('showAllAuditEvents');
        expect(results).not.toContain('auditPreviewLimit');
        expect(results).not.toContain('原始证据与来源');
    });

    it('keeps raw records non-posting and reviews ledger fields in the organizer', () => {
        const records = source('./ImportWorkbenchPage.vue');
        const results = source('../organizer/desktop/ResultsFlowPage.vue');

        expect(records).not.toContain('PostingDialog.vue');
        expect(records).not.toContain('openPosting(row)');
        expect(results).toContain('selectedLedgerAccountId');
        expect(results).toContain('selectedCounterpartyLedgerAccountId');
        expect(results).toContain('selectedCounterpartyLedgerAccountId.value !== selectedLedgerAccountId.value');
        expect(results).toContain('selectedCategoryId');
        expect(results).toContain('let fieldMask = 1 | 4 | 8');
        expect(results).toContain('fieldMask |= 128');
        expect(results).not.toContain('fieldMask |= 256');
        const locale = source('../../../locales/zh_Hans.json');
        expect(locale).toContain('"title": "核对资金账户"');
        expect(locale).toContain('"anomaly": "交易异常"');
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
