import { describe, expect, it } from 'vitest';

import type { PersonalFinanceImportRow, PersonalFinanceImportUploadResult, PersonalFinancePostingDraft, PersonalFinanceSourceAccount } from './models.ts';
import { buildSingleRowPostingRequest, getCompatibleSourceAccounts, getRowAction, getUploadAction } from './state.ts';
import { TransactionType } from '@/core/transaction.ts';

function row(overrides: Partial<PersonalFinanceImportRow> = {}): PersonalFinanceImportRow {
    return {
        id: '101',
        batchId: '201',
        rowNumber: 1,
        sourceLocator: 'row:1',
        identityId: '301',
        rawTransactionTime: '',
        rawAmount: '',
        rawDirection: '',
        rawStatus: '',
        rawTransactionType: '',
        rawCounterparty: '',
        rawItem: '',
        rawPaymentMethod: '',
        normalizedUnixTime: 1700000000,
        normalizedTimezoneUtcOffset: 480,
        normalizedAmount: '1234',
        currency: 'CNY',
        normalizedDirection: 'expense',
        normalizedTransactionType: 'payment',
        economicEffect: 'normal',
        primaryIssueCode: '',
        semanticEligibility: 'postable',
        parseState: 'valid',
        identityState: 'new',
        disposition: 'postable',
        processingState: 'pending',
        createdUnixTime: 1700000000,
        ...overrides
    };
}

const draft: PersonalFinancePostingDraft = {
    type: TransactionType.Expense,
    categoryId: '401',
    time: 1700000000,
    utcOffset: 480,
    sourceAccountId: '501',
    destinationAccountId: '0',
    sourceAmount: 1234,
    destinationAmount: 0,
    hideAmount: false,
    tagIds: [],
    comment: ''
};

describe('personal finance import workflow state', () => {
    it('asks before reparsing a duplicate file with existing history', () => {
        const result = {
            duplicate: true,
            recovered: false,
            latestBatch: { id: '201' },
            file: { id: '1' }
        } as PersonalFinanceImportUploadResult;

        expect(getUploadAction(result)).toBe('choose_duplicate_action');
        expect(getUploadAction({ ...result, duplicate: false })).toBe('reparse');
    });

    it('only offers active profiles from the detected source', () => {
        const accounts = [
            { id: '1', sourceType: 'alipay', status: 'active' },
            { id: '2', sourceType: 'alipay', status: 'disabled' },
            { id: '3', sourceType: 'wechat', status: 'active' }
        ] as PersonalFinanceSourceAccount[];

        expect(getCompatibleSourceAccounts(accounts, 'alipay').map(account => account.id)).toEqual(['1']);
    });

    it('allows a new row only with an explicit draft', () => {
        expect(getRowAction(row())).toBe('create');
        expect(() => buildSingleRowPostingRequest(row(), 'pf-ui-v1:key')).toThrow();
        expect(buildSingleRowPostingRequest(row(), 'pf-ui-v1:key', draft).commands[0]?.draft).toEqual(draft);
    });

    it('requires an explicit draft for an exact duplicate confirmation', () => {
        const duplicate = row({ identityState: 'exact_duplicate' });
        const request = buildSingleRowPostingRequest(duplicate, 'pf-ui-v1:key', draft);

        expect(getRowAction(duplicate)).toBe('create_or_reuse');
        expect(() => buildSingleRowPostingRequest(duplicate, 'pf-ui-v1:key')).toThrow();
        expect(request.commands[0]).toEqual({ rowIds: ['101'], draft });
    });

    it('blocks conflicts, invalid and already-linked rows', () => {
        expect(getRowAction(row({ identityState: 'identity_conflict' }))).toBe('blocked');
        expect(getRowAction(row({ parseState: 'invalid' }))).toBe('blocked');
        expect(getRowAction(row({ processingState: 'linked' }))).toBe('blocked');
    });
});
