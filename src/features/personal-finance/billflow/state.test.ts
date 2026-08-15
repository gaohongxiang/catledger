import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import type { PersonalFinanceImportBatch } from '../models.ts';
import {
    composeDashboardHeadline,
    eligibleOrganizeFileIds,
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
        expect(workbench).toContain('v-for="todo in openTodos"');
        expect(workbench).not.toContain('来源账户');
    });
});
