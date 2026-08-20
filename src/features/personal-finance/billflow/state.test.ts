import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import type { PersonalFinanceImportBatch } from '../models.ts';
import {
    BILLFLOW_ACCOUNT_BUCKETS,
    BILLFLOW_CATEGORY_BUCKETS,
    BILLFLOW_MERGE_BUCKETS,
    BILLFLOW_OPENING_BALANCE_UNIX_TIME,
    BILLFLOW_REVIEW_PANES,
    BILLFLOW_WORKBENCH_STEPS,
    accountBucketHintKey,
    accountGroupHasCardHeader,
    billflowDirectionKey,
    billflowWorkbenchStepIndex,
    canAutoRunAfterAccounts,
    canReapplyOrganize,
    canAssignBillflowCategory,
    canEditOrganizeFiles,
    canOpenBillflowWorkbenchStep,
    chunkBillflowItems,
    composeDashboardHeadline,
    createdAccountsNeedingBalance,
    categoryBucketHintKey,
    categoryTodos,
    installmentTodos,
    mergeBucketHintKey,
    mergeSelectedOrganizeFileIds,
    nextBillflowWorkbenchStep,
    otherTodos,
    previousBillflowWorkbenchStep,
    rememberCreatedLedgerIds,
    resolveAccountBucket,
    resolveBillflowWorkbenchStep,
    resolveCategoryBucket,
    resolveMergeBucket,
    resolveReviewPane,
    reviewPaneHintKey,
    sameOrganizeFileIds,
    suggestedAccountBucket,
    suggestedBillflowWorkbenchStep,
    suggestedCategoryBucket,
    suggestedMergeBucket,
    suggestedReviewPane,
    eligibleOrganizeFileIds,
    matchedLedgerAccount,
    nearestNextPayment,
    primaryDashboardHeadline,
    suggestedAccountCategory,
    summarizeTask,
    taskAwaitsConfirm,
    taskNeedsAccounts,
    taskShowsTodos
} from './state.ts';

function batch(overrides: Partial<PersonalFinanceImportBatch>): PersonalFinanceImportBatch {
    return {
        id: '1',
        fileId: '11',
        status: 'ready',
        sourceType: 'alipay',
        parserName: 'alipay',
        parserVersion: 'v1',
        normalizationVersion: 'v1',
        identityKeyVersion: 'v1',
        coreDigestVersion: 'v1',
        fingerprintVersion: 'v1',
        rawSnapshotVersion: 'v1',
        reparseReasonCode: '',
        totalRowCount: 1,
        validRowCount: 1,
        invalidRowCount: 0,
        exactDuplicateRowCount: 0,
        identityConflictRowCount: 0,
        pendingRowCount: 1,
        postedRowCount: 0,
        errorCode: '',
        errorSummary: '',
        createdUnixTime: 1,
        updatedUnixTime: 1,
        ...overrides
    };
}

describe('billflow task page state', () => {
    it('selects unique files that already have a successful batch', () => {
        expect(eligibleOrganizeFileIds([
            batch({ id: '1', fileId: '11', status: 'ready' }),
            batch({ id: '2', fileId: '11', status: 'completed' }),
            batch({ id: '3', fileId: '12', status: 'failed' }),
            batch({ id: '4', fileId: '13', status: 'partially_posted' })
        ])).toEqual(['11', '13']);
    });

    it('summarizes the three headline counts used by the task page', () => {
        expect(summarizeTask({
            createdAccountCount: 2,
            reusedMappingCount: 3,
            autoPostedCount: 180,
            todoOpenCount: 6
        })).toEqual({
            createdAccountCount: 2,
            reusedMappingCount: 3,
            autoPostedCount: 180,
            todoOpenCount: 6
        });
        expect(taskNeedsAccounts('accounts_pending', 0)).toBe(true);
        expect(taskNeedsAccounts('ready', 1)).toBe(true);
        expect(taskNeedsAccounts('ready', 0)).toBe(false);
        expect(taskAwaitsConfirm('awaiting_confirm')).toBe(true);
        expect(taskShowsTodos('ready')).toBe(true);
        expect(suggestedAccountCategory('credit_card')).toBe(3);
        expect(suggestedAccountCategory('virtual')).toBe(4);
    });

    it('reuses a uniquely named existing ledger account instead of creating another', () => {
        const existing = [
            { id: 'guangda', name: '光大银行信用卡(2690)', currency: 'CNY' },
            { id: 'xingye', name: '兴业银行信用卡(6106)', currency: 'CNY' },
            { id: 'huabei', name: '花呗', currency: 'CNY' }
        ];
        expect(matchedLedgerAccount({
            sourceType: 'alipay',
            currency: 'CNY',
            displayName: '光大银行信用卡(2690)'
        }, existing)?.id).toBe('guangda');
        expect(matchedLedgerAccount({
            sourceType: 'wechat',
            currency: 'CNY',
            displayName: '光大银行信用卡（2690）'
        }, existing)?.id).toBe('guangda');
        expect(matchedLedgerAccount({
            sourceType: 'wechat',
            currency: 'CNY',
            displayName: '兴业银行信用卡 尾号6106'
        }, existing)?.id).toBe('xingye');
        expect(matchedLedgerAccount({
            sourceType: 'alipay',
            currency: 'CNY',
            displayName: '支付宝小荷包(树与草的小荷包)'
        }, existing)?.id).toBeUndefined();
        expect(matchedLedgerAccount({
            sourceType: 'bank',
            currency: 'CNY',
            displayName: '末四位2690'
        }, existing)?.id).toBe('guangda');
    });

    it('does not auto-select when two existing cards share the same unique score', () => {
        expect(matchedLedgerAccount({
            sourceType: 'alipay',
            currency: 'CNY',
            displayName: '光大银行信用卡(2690)'
        }, [
            { id: 'guangda', name: '光大银行信用卡(2690)', currency: 'CNY' },
            { id: 'other', name: '光大银行信用卡 2690', currency: 'CNY' }
        ])?.id).toBeUndefined();
    });

    it('composes a first-screen trust headline from stable codes only', () => {
        const items = composeDashboardHeadline({
            coverageComplete: false,
            accountsWithGaps: 2,
            uncategorizedCount: 4,
            todoOpenCount: 6,
            balanceUnverifiedCount: 1
        });
        expect(items.map(item => item.code)).toEqual([
            'provisional_month',
            'uncategorized_count',
            'todo_open_count',
            'balance_unverified_count'
        ]);
        expect(primaryDashboardHeadline(items)).toBe('provisional_month');
        expect(primaryDashboardHeadline([])).toBe('ready');
        expect(composeDashboardHeadline({
            coverageComplete: true,
            accountsWithGaps: 0,
            uncategorizedCount: 0,
            todoOpenCount: 0,
            balanceUnverifiedCount: 0
        })).toEqual([]);
    });

    it('picks the nearest dated next payment and ignores undated contracts', () => {
        expect(nearestNextPayment([
            { name: 'later', nextDueDate: '2026-09-01', nextDueAmount: '200', currency: 'CNY' },
            { name: 'cash', nextDueAmount: '0', currency: 'CNY' },
            { name: 'sooner', nextDueDate: '2026-08-20', nextDueAmount: '100', currency: 'CNY' }
        ])?.name).toBe('sooner');
    });
});

describe('billflow task page wiring', () => {
    it('keeps the desktop organizer on one task page and only unfolds todos', () => {
        const organizer = readFileSync(new URL('../desktop/BillOrganizerPage.vue', import.meta.url), 'utf8');
        const workbench = readFileSync(new URL('./desktop/TaskWorkbenchPage.vue', import.meta.url), 'utf8');
        expect(organizer).toContain('TaskWorkbenchPage.vue');
        expect(organizer).toContain("view === 'task'");
        expect(workbench).toContain('personalFinance.billflow.summary.created');
        expect(workbench).toContain('personalFinance.billflow.summary.posted');
        expect(workbench).toContain('personalFinance.billflow.summary.todos');
        expect(workbench).toContain('personalFinance.billflow.accounts.exclude');
        expect(workbench).toContain('personalFinance.billflow.accounts.useExisting');
        expect(workbench).toContain('personalFinance.billflow.accounts.bucket.');
        expect(workbench).toContain('BILLFLOW_ACCOUNT_BUCKETS');
        expect(workbench).toContain('accountBucket === \'reused\'');
        expect(workbench).toContain('accountBucket === \'excluded\'');
        expect(workbench).toContain('personalFinance.billflow.step.back');
        expect(workbench).toContain('personalFinance.billflow.step.next');
        expect(workbench).toContain('BILLFLOW_WORKBENCH_STEPS');
        expect(workbench).toContain('currentStep === \'accounts\'');
        expect(workbench).not.toContain('currentStep === \'balance\'');
        expect(workbench).not.toContain('currentStep === \'merge\'');
        expect(workbench).toContain('account-row-card__name');
        expect(workbench).toContain('formatAmountToLocalizedNumeralsWithCurrency');
        expect(workbench).toContain('billflowDirectionKey');
        expect(workbench).toContain("listTasks('receiving')");
        expect(workbench).not.toContain('refreshTaskAndMaybeRun');
        expect(workbench).toContain('mergeSelectedOrganizeFileIds');
        expect(workbench).toContain('replaceTaskFiles');
        expect(workbench).toContain('parseUploadedFile');
        expect(workbench).toContain("reasonCode: 'initial_upload'");
        expect(workbench).toContain('canConfigureCebCreditPdf');
        expect(workbench).toContain('SourceAccountDialog');
        expect(workbench).toContain('applyUniqueMatchedAccounts');
        expect(workbench).toContain('canEditOrganizeFiles');
        expect(workbench).toContain("userStep.value = 'accounts'");
        expect(workbench).not.toContain("userStep.value = 'balance'");
        expect(workbench).not.toContain("userStep.value = 'merge'");
        expect(workbench).toContain('personalFinance.billflow.confirmHint');
        expect(workbench).toContain('personalFinance.billflow.summary.willPost');
        expect(workbench).toContain('v-for="todo in reviewTodos"');
        expect(workbench).toContain('v-for="todo in otherReviewTodos"');
        expect(workbench).toContain('v-for="(group, groupIndex) in activeMergeGroups"');
        expect(workbench).toContain('listMergeGroups');
        expect(workbench).toContain('transactionPlan.evidenceRowCount');
        expect(workbench).toContain('transactionPlan.consolidatedRowCount');
        expect(workbench).toContain('transactionPlan.plannedTransactionCount');
        expect(workbench).toContain("todo.todoKind !== 'uncategorized'");
        expect(workbench).toContain('blockingTodos.value.length > 0');
        expect(workbench).not.toContain('matchingReappliedFor');
        expect(workbench).toContain('formatMergeSource');
        expect(workbench).toContain('formatMergeTime');
        expect(workbench).toContain('mergeGroupRows');
        expect(workbench).toContain('mergeHasItemColumn');
        expect(workbench).toContain('mergeColumnCount');
        expect(workbench).toContain('merge-group');
        expect(workbench).toContain('merge-table');
        expect(workbench).not.toContain('todo-compare__line');
        expect(workbench).not.toContain('todo-compare__badge');
        expect(workbench).not.toContain('personalFinance.billflow.merge.matchesHint');
        expect(workbench).toContain('group.rows');
        expect(workbench).toContain('openReconciliation(caseId)');
        expect(workbench).toContain("...(caseId ? { caseId } : {})");
        expect(workbench).toContain('toggleSkipTodo');
        expect(workbench).toContain('personalFinance.billflow.accounts.skipped');
        expect(workbench).not.toContain('skippableAccountGroups');
        expect(workbench).not.toContain('BILLFLOW_MERGE_BUCKETS');
        expect(workbench).not.toContain('BILLFLOW_REVIEW_PANES');
        expect(workbench).toContain("@click=\"setReviewPane('merge')\"");
        expect(workbench).toContain("@click=\"setReviewPane('category')\"");
        expect(workbench).toContain("@click=\"setReviewPane('evidence')\"");
        expect(workbench).toContain("@click=\"setReviewPane('transactions')\"");
        expect(workbench).toContain("@click=\"setReviewPane('relations')\"");
        expect(workbench).toContain('transactionPlan?.transactions');
        expect(workbench).toContain('transactionPlan?.evidenceRows');
        expect(workbench).toContain("reviewPane === 'merge'");
        expect(workbench).toContain('personalFinance.billflow.pane.');
        expect(workbench).toContain('isInstallmentTodo');
        expect(workbench).toContain('assignTodoCategories');
        expect(workbench).toContain('canAssignBillflowCategory');
        expect(workbench).toContain('personalFinance.billflow.todos.pickCategory');
        expect(workbench).toContain('personalFinance.billflow.todos.selectAll');
        expect(workbench).not.toContain('BILLFLOW_CATEGORY_BUCKETS');
        expect(workbench).toContain('classifiedReviewRows');
        expect(workbench).toContain('todo-row');
        expect(workbench).not.toContain('todo-card');
        expect(workbench).toContain('listAllTodos(taskId, \'open\')');
        expect(workbench).toContain('listClassifiedRows(taskId)');
        expect(workbench).toContain('chunkBillflowItems');
        expect(workbench).toContain('todoTitle(todo)');
        expect(workbench).toContain('todoSubtitle(todo)');
        expect(workbench).toContain('todoMeta(todo)');
        expect(workbench).toContain('formatTodoAmount(todo)');
        expect(workbench).toContain('newBalanceAccounts');
        expect(workbench).toContain('accountGroupHasCardHeader');
        expect(workbench).toContain('personalFinance.billflow.balance.amount');
        expect(workbench).toContain('personalFinance.billflow.accounts.statementDate');
        expect(workbench).toContain('personalFinance.billflow.accounts.cardHeaderCreateHint');
        expect(workbench).toContain('personalFinance.billflow.balance.save');
        expect(workbench).toContain('currentStep === \'review\'');
        expect(workbench).toContain('currentStep === \'others\'');
        expect(workbench).toContain('nextBillflowWorkbenchStep');
        expect(workbench).toContain('userStep.value = stayOn');
        expect(workbench).not.toContain('unverifiedCards');
        expect(workbench).not.toContain('currentStep === \'todos\'');
        expect(workbench).not.toContain('currentStep === \'loans\'');
        expect(workbench).not.toContain('来源账户');
        expect(workbench).not.toContain('todo.reasonCodes.join');
    });

    it('keeps newly uploaded files selected without restoring a cleared choice', () => {
        expect(mergeSelectedOrganizeFileIds([], [], ['a', 'b'])).toEqual(['a', 'b']);
        expect(mergeSelectedOrganizeFileIds(['a'], ['a'], ['a', 'b'])).toEqual(['a', 'b']);
        expect(mergeSelectedOrganizeFileIds([], ['a', 'b'], ['a', 'b'])).toEqual([]);
        expect(mergeSelectedOrganizeFileIds(['b'], ['a', 'b'], ['a', 'b'])).toEqual(['b']);
        expect(sameOrganizeFileIds(['a', 'b'], ['b', 'a'])).toBe(true);
        expect(sameOrganizeFileIds(['a', 'b'], ['a'])).toBe(false);
        expect(canEditOrganizeFiles('awaiting_confirm')).toBe(true);
        expect(canEditOrganizeFiles('ready')).toBe(false);
        expect(canAutoRunAfterAccounts('accounts_pending', 0)).toBe(true);
        expect(canAutoRunAfterAccounts('accounts_pending', 1)).toBe(false);
        expect(canAutoRunAfterAccounts('receiving', 0)).toBe(true);
        expect(canAutoRunAfterAccounts('receiving', 1)).toBe(false);
        expect(canAutoRunAfterAccounts('awaiting_confirm', 0)).toBe(false);
        expect(canReapplyOrganize('receiving', 0)).toBe(true);
        expect(canReapplyOrganize('awaiting_confirm', 0)).toBe(true);
        expect(canReapplyOrganize('ready', 0)).toBe(true);
        expect(canReapplyOrganize('awaiting_confirm', 1)).toBe(false);
        expect(canReapplyOrganize('accounts_pending', 0)).toBe(false);
    });

    it('maps income, expense and neither-income-nor-expense to display keys', () => {
        expect(billflowDirectionKey('income')).toBe('personalFinance.billflow.accounts.direction.income');
        expect(billflowDirectionKey('expense')).toBe('personalFinance.billflow.accounts.direction.expense');
        expect(billflowDirectionKey('neutral')).toBe('personalFinance.billflow.accounts.direction.neutral');
        expect(billflowDirectionKey('unknown')).toBe('personalFinance.billflow.accounts.direction.unknown');
        expect(billflowDirectionKey('')).toBe('personalFinance.billflow.accounts.direction.unknown');
    });

    it('walks files, accounts, review, other items and confirm as a progress path', () => {
        const noTask = { hasTask: false, needsCreateCount: 0, needsBalanceCount: 0 };
        const pendingAccounts = { hasTask: true, status: 'accounts_pending' as const, needsCreateCount: 2, needsBalanceCount: 0 };
        const accountsReady = { hasTask: true, status: 'receiving' as const, needsCreateCount: 0, needsBalanceCount: 0 };
        const needsBalance = { hasTask: true, status: 'receiving' as const, needsCreateCount: 0, needsBalanceCount: 1 };
        const awaiting = { hasTask: true, status: 'awaiting_confirm' as const, needsCreateCount: 0, needsBalanceCount: 0 };
        const ready = { hasTask: true, status: 'ready' as const, needsCreateCount: 0, needsBalanceCount: 0 };
        expect(BILLFLOW_WORKBENCH_STEPS).toEqual(['files', 'accounts', 'review', 'others', 'confirm']);
        expect(suggestedBillflowWorkbenchStep(noTask)).toBe('files');
        expect(suggestedBillflowWorkbenchStep(pendingAccounts)).toBe('accounts');
        expect(suggestedBillflowWorkbenchStep({ hasTask: true, status: 'processing', needsCreateCount: 0, needsBalanceCount: 0 })).toBe('accounts');
        expect(suggestedBillflowWorkbenchStep(accountsReady)).toBe('accounts');
        expect(suggestedBillflowWorkbenchStep(needsBalance)).toBe('accounts');
        expect(suggestedBillflowWorkbenchStep(awaiting)).toBe('review');
        expect(suggestedBillflowWorkbenchStep({ hasTask: true, status: 'awaiting_confirm', needsCreateCount: 1, needsBalanceCount: 0 })).toBe('accounts');
        expect(suggestedBillflowWorkbenchStep(ready)).toBe('confirm');
        expect(suggestedBillflowWorkbenchStep({ hasTask: true, status: 'failed', needsCreateCount: 0, needsBalanceCount: 0 })).toBe('confirm');
        expect(canOpenBillflowWorkbenchStep('accounts', noTask)).toBe(false);
        expect(canOpenBillflowWorkbenchStep('files', ready)).toBe(true);
        expect(canOpenBillflowWorkbenchStep('confirm', pendingAccounts)).toBe(false);
        expect(canOpenBillflowWorkbenchStep('confirm', awaiting)).toBe(true);
        expect(canOpenBillflowWorkbenchStep('confirm', { hasTask: true, status: 'awaiting_confirm', needsCreateCount: 1, needsBalanceCount: 0 })).toBe(false);
        expect(canOpenBillflowWorkbenchStep('review', awaiting)).toBe(true);
        expect(canOpenBillflowWorkbenchStep('review', accountsReady)).toBe(true);
        expect(canOpenBillflowWorkbenchStep('review', pendingAccounts)).toBe(false);
        expect(canOpenBillflowWorkbenchStep('others', awaiting)).toBe(true);
        expect(canOpenBillflowWorkbenchStep('others', accountsReady)).toBe(false);
        expect(previousBillflowWorkbenchStep('accounts')).toBe('files');
        expect(previousBillflowWorkbenchStep('confirm')).toBe('others');
        expect(previousBillflowWorkbenchStep('files')).toBeUndefined();
        expect(nextBillflowWorkbenchStep('files')).toBe('accounts');
        expect(nextBillflowWorkbenchStep('accounts')).toBe('review');
        expect(nextBillflowWorkbenchStep('review')).toBe('others');
        expect(nextBillflowWorkbenchStep('others')).toBe('confirm');
        expect(nextBillflowWorkbenchStep('confirm')).toBeUndefined();
        expect(billflowWorkbenchStepIndex('confirm')).toBe(4);
        expect(resolveBillflowWorkbenchStep('files', awaiting)).toBe('files');
        expect(resolveBillflowWorkbenchStep('confirm', pendingAccounts)).toBe('accounts');
        expect(categoryTodos([
            { todoKind: 'uncategorized' },
            { todoKind: 'installment_candidate' },
            { todoKind: 'transfer_unclear' },
            { todoKind: 'refund_unclear' },
            { todoKind: 'cross_source_ambiguous' }
        ]).map(todo => todo.todoKind)).toEqual(['uncategorized', 'transfer_unclear']);
        expect(otherTodos([
            { todoKind: 'uncategorized' },
            { todoKind: 'installment_candidate' },
            { todoKind: 'refund_unclear' },
            { todoKind: 'cross_source_ambiguous' }
        ]).map(todo => todo.todoKind)).toEqual(['installment_candidate', 'refund_unclear']);
        expect(installmentTodos([
            { todoKind: 'uncategorized' },
            { todoKind: 'installment_candidate' }
        ]).map(todo => todo.todoKind)).toEqual(['installment_candidate']);
        expect(canAssignBillflowCategory('uncategorized')).toBe(true);
        expect(canAssignBillflowCategory('transfer_unclear')).toBe(true);
        expect(canAssignBillflowCategory('refund_unclear')).toBe(false);
        expect(canAssignBillflowCategory('identity_conflict')).toBe(false);
        expect(canAssignBillflowCategory('cross_source_ambiguous')).toBe(false);
        expect(accountGroupHasCardHeader({ statementDate: '2026-08-01' })).toBe(true);
        expect(accountGroupHasCardHeader({})).toBe(false);
        expect(BILLFLOW_MERGE_BUCKETS).toEqual(['pending', 'merged']);
        expect(suggestedMergeBucket({ pending: 4, merged: 2 })).toBe('pending');
        expect(suggestedMergeBucket({ pending: 0, merged: 2 })).toBe('merged');
        expect(resolveMergeBucket('merged', { pending: 3, merged: 2 }, true)).toBe('merged');
        expect(resolveMergeBucket('merged', { pending: 3, merged: 2 }, false)).toBe('pending');
        expect(mergeBucketHintKey('pending')).toBe('personalFinance.billflow.merge.pendingHint');
        expect(mergeBucketHintKey('merged')).toBe('personalFinance.billflow.merge.mergedHint');
        expect(BILLFLOW_REVIEW_PANES).toEqual(['transactions', 'relations', 'category', 'merge', 'evidence']);
        expect(suggestedReviewPane({ awaitingRun: true, mergePending: 0, categoryPending: 4 })).toBe('merge');
        expect(suggestedReviewPane({ awaitingRun: false, mergePending: 2, categoryPending: 4 })).toBe('merge');
        expect(suggestedReviewPane({ awaitingRun: false, mergePending: 0, categoryPending: 4 })).toBe('transactions');
        expect(suggestedReviewPane({ awaitingRun: false, mergePending: 0, categoryPending: 0 })).toBe('transactions');
        expect(resolveReviewPane('category', { awaitingRun: false, mergePending: 3, categoryPending: 1 }, true)).toBe('category');
        expect(resolveReviewPane('category', { awaitingRun: false, mergePending: 3, categoryPending: 1 }, false)).toBe('merge');
        expect(reviewPaneHintKey('merge')).toBe('personalFinance.billflow.mergeHint');
        expect(reviewPaneHintKey('category')).toBe('personalFinance.billflow.reviewHint');
        expect(reviewPaneHintKey('evidence')).toBe('personalFinance.billflow.plan.evidenceHint');
        expect(reviewPaneHintKey('transactions')).toBe('personalFinance.billflow.plan.transactionsHint');
        expect(reviewPaneHintKey('relations')).toBe('personalFinance.billflow.plan.relationsHint');
    });

    it('keeps account checks in pending, reused and excluded buckets', () => {
        expect(BILLFLOW_ACCOUNT_BUCKETS).toEqual(['pending', 'reused', 'excluded']);
        expect(suggestedAccountBucket({ pending: 3, reused: 8, excluded: 1 })).toBe('pending');
        expect(suggestedAccountBucket({ pending: 0, reused: 8, excluded: 1 })).toBe('excluded');
        expect(suggestedAccountBucket({ pending: 0, reused: 8, excluded: 0 })).toBe('reused');
        expect(resolveAccountBucket('reused', { pending: 2, reused: 8, excluded: 0 }, true)).toBe('reused');
        expect(resolveAccountBucket('reused', { pending: 2, reused: 8, excluded: 0 }, false)).toBe('pending');
        expect(accountBucketHintKey('pending')).toBe('personalFinance.billflow.accounts.pendingHint');
        expect(accountBucketHintKey('reused')).toBe('personalFinance.billflow.accounts.reusedHint');
        expect(accountBucketHintKey('excluded')).toBe('personalFinance.billflow.accounts.excludedHint');
    });

    it('keeps category work in uncategorized and categorized buckets', () => {
        expect(BILLFLOW_CATEGORY_BUCKETS).toEqual(['pending', 'classified']);
        expect(suggestedCategoryBucket({ pending: 4, classified: 2 })).toBe('pending');
        expect(suggestedCategoryBucket({ pending: 0, classified: 2 })).toBe('classified');
        expect(resolveCategoryBucket('classified', { pending: 3, classified: 2 }, true)).toBe('classified');
        expect(resolveCategoryBucket('classified', { pending: 3, classified: 2 }, false)).toBe('pending');
        expect(categoryBucketHintKey('pending')).toBe('personalFinance.billflow.todos.pendingHint');
        expect(categoryBucketHintKey('classified')).toBe('personalFinance.billflow.todos.classifiedHint');
        expect(chunkBillflowItems([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
        expect(chunkBillflowItems([], 100)).toEqual([]);
    });

    it('asks for balances only on newly created accounts that are still unanswered', () => {
        const created = rememberCreatedLedgerIds(['1'], [{ ledgerAccountId: '1' }, { ledgerAccountId: '9' }], []);
        expect(created).toEqual(['9']);
        expect(createdAccountsNeedingBalance({
            createdLedgerIds: ['9', '8'],
            reused: [
                { ledgerAccountId: '1', displayName: 'old', currency: 'CNY' },
                { ledgerAccountId: '9', displayName: 'new card', currency: 'CNY' }
            ],
            answeredLedgerIds: [],
            reviewedLedgerIds: []
        })).toEqual([{ ledgerAccountId: '9', displayName: 'new card', currency: 'CNY' }]);
        expect(createdAccountsNeedingBalance({
            createdLedgerIds: ['9'],
            reused: [{ ledgerAccountId: '9', displayName: 'new card', currency: 'CNY' }],
            answeredLedgerIds: ['9'],
            reviewedLedgerIds: []
        })).toEqual([]);
        expect(createdAccountsNeedingBalance({
            createdLedgerIds: ['9'],
            reused: [{ ledgerAccountId: '9', displayName: 'new card', currency: 'CNY' }],
            answeredLedgerIds: [],
            reviewedLedgerIds: ['9']
        })).toEqual([]);
        expect(BILLFLOW_OPENING_BALANCE_UNIX_TIME).toBe(946684800);
        expect(BILLFLOW_OPENING_BALANCE_UNIX_TIME).toBeLessThan(1_700_000_000);
    });
});
