import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import type { PersonalFinanceImportBatch } from '../models.ts';
import {
    BILLFLOW_ACCOUNT_BUCKETS,
    BILLFLOW_OPENING_BALANCE_UNIX_TIME,
    BILLFLOW_WORKBENCH_STEPS,
    accountBucketHintKey,
    billflowDirectionKey,
    billflowWorkbenchStepIndex,
    canAutoRunAfterAccounts,
    canAssignBillflowCategory,
    canOpenBillflowWorkbenchStep,
    composeDashboardHeadline,
    createdAccountsNeedingBalance,
    categoryTodos,
    installmentTodos,
    mergeSelectedOrganizeFileIds,
    nextBillflowWorkbenchStep,
    previousBillflowWorkbenchStep,
    rememberCreatedLedgerIds,
    resolveAccountBucket,
    resolveBillflowWorkbenchStep,
    suggestedAccountBucket,
    suggestedBillflowWorkbenchStep,
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
        expect(workbench).toContain('account-row-card__name');
        expect(workbench).toContain('formatAmountToLocalizedNumeralsWithCurrency');
        expect(workbench).toContain('billflowDirectionKey');
        expect(workbench).toContain("listTasks('receiving')");
        expect(workbench).not.toContain('refreshTaskAndMaybeRun');
        expect(workbench).toContain('mergeSelectedOrganizeFileIds');
        expect(workbench).toContain('personalFinance.billflow.confirmHint');
        expect(workbench).toContain('personalFinance.billflow.summary.willPost');
        expect(workbench).toContain('v-for="todo in reviewTodos"');
        expect(workbench).toContain('v-for="todo in otherTodos"');
        expect(workbench).toContain('assignTodoCategories');
        expect(workbench).toContain('canAssignBillflowCategory');
        expect(workbench).toContain('personalFinance.billflow.todos.pickCategory');
        expect(workbench).toContain('personalFinance.billflow.todos.selectAll');
        expect(workbench).toContain('todoTitle(todo)');
        expect(workbench).toContain('todoSubtitle(todo)');
        expect(workbench).toContain('formatTodoAmount(todo)');
        expect(workbench).toContain('newBalanceAccounts');
        expect(workbench).toContain('personalFinance.billflow.balance.amount');
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
        expect(canAutoRunAfterAccounts('accounts_pending', 0)).toBe(true);
        expect(canAutoRunAfterAccounts('accounts_pending', 1)).toBe(false);
        expect(canAutoRunAfterAccounts('receiving', 0)).toBe(true);
        expect(canAutoRunAfterAccounts('receiving', 1)).toBe(false);
        expect(canAutoRunAfterAccounts('awaiting_confirm', 0)).toBe(false);
    });

    it('maps income, expense and neither-income-nor-expense to display keys', () => {
        expect(billflowDirectionKey('income')).toBe('personalFinance.billflow.accounts.direction.income');
        expect(billflowDirectionKey('expense')).toBe('personalFinance.billflow.accounts.direction.expense');
        expect(billflowDirectionKey('neutral')).toBe('personalFinance.billflow.accounts.direction.neutral');
        expect(billflowDirectionKey('unknown')).toBe('personalFinance.billflow.accounts.direction.unknown');
        expect(billflowDirectionKey('')).toBe('personalFinance.billflow.accounts.direction.unknown');
    });

    it('walks files, accounts, review, other items and confirm as a progress path', () => {
        expect(BILLFLOW_WORKBENCH_STEPS).toEqual(['files', 'accounts', 'review', 'others', 'confirm']);
        expect(suggestedBillflowWorkbenchStep({ hasTask: false, needsCreateCount: 0 })).toBe('files');
        expect(suggestedBillflowWorkbenchStep({ hasTask: true, status: 'accounts_pending', needsCreateCount: 2 })).toBe('accounts');
        expect(suggestedBillflowWorkbenchStep({ hasTask: true, status: 'processing', needsCreateCount: 0 })).toBe('accounts');
        expect(suggestedBillflowWorkbenchStep({ hasTask: true, status: 'receiving', needsCreateCount: 0 })).toBe('accounts');
        expect(suggestedBillflowWorkbenchStep({ hasTask: true, status: 'awaiting_confirm', needsCreateCount: 0 })).toBe('review');
        expect(suggestedBillflowWorkbenchStep({ hasTask: true, status: 'ready', needsCreateCount: 0 })).toBe('confirm');
        expect(suggestedBillflowWorkbenchStep({ hasTask: true, status: 'failed', needsCreateCount: 0 })).toBe('confirm');
        expect(canOpenBillflowWorkbenchStep('accounts', { hasTask: false, needsCreateCount: 0 })).toBe(false);
        expect(canOpenBillflowWorkbenchStep('files', { hasTask: true, status: 'ready', needsCreateCount: 0 })).toBe(true);
        expect(canOpenBillflowWorkbenchStep('confirm', { hasTask: true, status: 'accounts_pending', needsCreateCount: 1 })).toBe(false);
        expect(canOpenBillflowWorkbenchStep('confirm', { hasTask: true, status: 'awaiting_confirm', needsCreateCount: 0 })).toBe(true);
        expect(canOpenBillflowWorkbenchStep('review', { hasTask: true, status: 'awaiting_confirm', needsCreateCount: 0 })).toBe(true);
        expect(canOpenBillflowWorkbenchStep('others', { hasTask: true, status: 'awaiting_confirm', needsCreateCount: 0 })).toBe(true);
        expect(previousBillflowWorkbenchStep('accounts')).toBe('files');
        expect(previousBillflowWorkbenchStep('confirm')).toBe('others');
        expect(previousBillflowWorkbenchStep('files')).toBeUndefined();
        expect(nextBillflowWorkbenchStep('files')).toBe('accounts');
        expect(nextBillflowWorkbenchStep('accounts')).toBe('review');
        expect(nextBillflowWorkbenchStep('review')).toBe('others');
        expect(nextBillflowWorkbenchStep('others')).toBe('confirm');
        expect(nextBillflowWorkbenchStep('confirm')).toBeUndefined();
        expect(billflowWorkbenchStepIndex('confirm')).toBe(4);
        expect(resolveBillflowWorkbenchStep('files', { hasTask: true, status: 'awaiting_confirm', needsCreateCount: 0 })).toBe('files');
        expect(resolveBillflowWorkbenchStep('confirm', { hasTask: true, status: 'accounts_pending', needsCreateCount: 1 })).toBe('accounts');
        expect(categoryTodos([
            { todoKind: 'uncategorized' },
            { todoKind: 'installment_candidate' },
            { todoKind: 'transfer_unclear' }
        ]).map(todo => todo.todoKind)).toEqual(['uncategorized', 'transfer_unclear']);
        expect(installmentTodos([
            { todoKind: 'uncategorized' },
            { todoKind: 'installment_candidate' }
        ]).map(todo => todo.todoKind)).toEqual(['installment_candidate']);
        expect(canAssignBillflowCategory('uncategorized')).toBe(true);
        expect(canAssignBillflowCategory('transfer_unclear')).toBe(true);
        expect(canAssignBillflowCategory('refund_unclear')).toBe(false);
        expect(canAssignBillflowCategory('identity_conflict')).toBe(false);
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
