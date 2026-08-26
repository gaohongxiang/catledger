import { describe, expect, it } from 'vitest';

import type { PersonalFinanceImportBatch, PersonalFinanceImportFile, PersonalFinanceImportRow, PersonalFinanceImportUploadResult, PersonalFinancePaymentAccountGroup, PersonalFinancePostingDraft, PersonalFinanceSourceAccount } from './models.ts';
import {
    buildCebCreditReparseRequest,
    buildGenericBankReparseRequest,
    buildPersonalFinanceReparseRequest,
    buildSingleRowPostingRequest,
    canConfigureCebCreditPdf,
    canConfigureGenericBankTable,
    canDeleteImportFileContent,
    canDiscardImportBatch,
    createDefaultGenericBankMappingForm,
    findPaymentAccountGroupForRow,
    getSafePaymentAccountDisplayName,
    getCompatibleSourceAccounts,
    getRowAction,
    getUploadAction,
    inferPaymentAccountCategory,
    normalizePaymentAccountName,
    suggestPaymentAccount,
    toGenericCsvApiColumnIndex,
    validateGenericBankMappingForm
} from './state.ts';
import { AccountCategory } from '@/core/account.ts';
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

	it('only enables lifecycle actions for server-eligible states', () => {
		const batch = { status: 'ready', postedRowCount: 0 } as PersonalFinanceImportBatch;
		expect(canDiscardImportBatch(batch)).toBe(true);
		expect(canDiscardImportBatch({ ...batch, status: 'partially_posted' })).toBe(false);
		expect(canDiscardImportBatch({ ...batch, postedRowCount: 1 })).toBe(false);

		const file = { contentState: 'available' } as PersonalFinanceImportFile;
		expect(canDeleteImportFileContent(file)).toBe(true);
		expect(canDeleteImportFileContent({ ...file, contentState: 'pending' })).toBe(false);
		expect(canDeleteImportFileContent({ ...file, contentState: 'deleted' })).toBe(false);

        const csvFile = { contentState: 'available', fileExtension: 'csv' } as PersonalFinanceImportFile;
        expect(canConfigureGenericBankTable(csvFile)).toBe(true);
        expect(canConfigureGenericBankTable({ ...csvFile, contentState: 'missing' })).toBe(false);
		expect(canConfigureGenericBankTable({ ...csvFile, fileExtension: 'xls' })).toBe(true);
		expect(canConfigureGenericBankTable({ ...csvFile, fileExtension: 'xlsx' })).toBe(true);
		expect(canConfigureGenericBankTable({ ...csvFile, fileExtension: 'pdf' })).toBe(false);

        const pdfFile = { contentState: 'available', fileExtension: 'pdf' } as PersonalFinanceImportFile;
        expect(canConfigureCebCreditPdf(pdfFile)).toBe(true);
        expect(canConfigureCebCreditPdf({ ...pdfFile, contentState: 'missing' })).toBe(false);
        expect(canConfigureCebCreditPdf(csvFile)).toBe(false);
	});
});

describe('generic bank CSV mapping state', () => {

    it('converts visible one-based columns and unused columns to the API contract', () => {
        const form = createDefaultGenericBankMappingForm();
        form.timeColumn = 3;
        form.amountColumn = 5;

        const result = validateGenericBankMappingForm(form);

        expect(toGenericCsvApiColumnIndex(1)).toBe(0);
        expect(toGenericCsvApiColumnIndex(null)).toBe(-1);
        expect(result.errors).toEqual([]);
        expect(result.mapping).toMatchObject({
            timeColumn: 2,
            amountColumn: 4,
            directionColumn: -1,
            incomeColumn: -1,
            expenseColumn: -1,
            currencyColumn: -1,
            signedPositiveDirection: 'income',
            incomeValues: [],
            expenseValues: []
        });
    });

    it('builds only the fields used by amount-plus-direction mode and normalizes values', () => {
        const form = createDefaultGenericBankMappingForm();
        form.amountMode = 'amount_direction';
        form.amountColumn = 2;
        form.directionColumn = 3;
        form.incomeValues = [' Credit ', 'IN'];
        form.expenseValues = ['debit', 'OUT'];

        const result = validateGenericBankMappingForm(form);

        expect(result.errors).toEqual([]);
        expect(result.mapping).toMatchObject({
            amountMode: 'amount_direction',
            amountColumn: 1,
            directionColumn: 2,
            incomeColumn: -1,
            expenseColumn: -1,
            signedPositiveDirection: '',
            incomeValues: ['credit', 'in'],
            expenseValues: ['debit', 'out']
        });
    });

    it('builds only the two amount columns used by income-expense mode', () => {
        const form = createDefaultGenericBankMappingForm();
        form.amountMode = 'income_expense';
        form.incomeColumn = 4;
        form.expenseColumn = 6;

        const result = validateGenericBankMappingForm(form);

        expect(result.errors).toEqual([]);
        expect(result.mapping).toMatchObject({
            amountMode: 'income_expense',
            amountColumn: -1,
            directionColumn: -1,
            incomeColumn: 3,
            expenseColumn: 5,
            signedPositiveDirection: '',
            incomeValues: [],
            expenseValues: []
        });
    });

    it('rejects duplicate active columns and overlapping normalized direction values', () => {
        const duplicateColumns = createDefaultGenericBankMappingForm();
        duplicateColumns.currencyColumn = duplicateColumns.timeColumn;
        expect(validateGenericBankMappingForm(duplicateColumns).errors).toContain('column_duplicate');

        const overlappingValues = createDefaultGenericBankMappingForm();
        overlappingValues.amountMode = 'amount_direction';
        overlappingValues.directionColumn = 3;
        overlappingValues.incomeValues = [' Credit '];
        overlappingValues.expenseValues = ['credit'];
        expect(validateGenericBankMappingForm(overlappingValues).errors).toContain('direction_values_overlap');
    });

    it('builds a generic bank request from column mapping without a source profile', () => {
        const form = createDefaultGenericBankMappingForm();
        const base = {
            fileId: 'file-1',
			fileExtension: 'csv',
            currency: 'CNY',
            timezoneUtcOffset: 480,
            reasonCode: 'user_selected_generic_bank',
            form
        };

        expect(buildGenericBankReparseRequest(base)).toMatchObject({
            fileId: 'file-1',
            parserName: 'generic_bank_csv',
			genericBankMapping: { amountMode: 'signed', sheetIndex: -1 }
        });
		expect(buildGenericBankReparseRequest(base).sourceAccountId).toBeUndefined();
		expect(buildGenericBankReparseRequest({ ...base, fileExtension: 'xls' })).toMatchObject({
			parserName: 'generic_bank_xls',
			genericBankMapping: { sheetIndex: 0 }
		});
		expect(buildGenericBankReparseRequest({ ...base, fileExtension: 'xlsx' })).toMatchObject({
			parserName: 'generic_bank_xlsx',
			genericBankMapping: { sheetIndex: 0 }
		});
    });

    it('builds a CEB request without asking for a ledger account first', () => {
        expect(buildCebCreditReparseRequest({
            fileId: 'file-2',
            currency: 'CNY',
            timezoneUtcOffset: 480,
            reasonCode: 'user_selected_ceb_credit_pdf'
        })).toEqual({
            fileId: 'file-2',
            parserName: 'ceb_credit_pdf',
            currency: 'CNY',
            timezoneUtcOffset: 480,
            reasonCode: 'user_selected_ceb_credit_pdf'
        });
    });

    it('keeps legacy Alipay and WeChat reparse requests free of generic parser fields', () => {
        const request = buildPersonalFinanceReparseRequest({
            fileId: 'file-1',
            sourceAccountId: 'source-1',
            currency: 'CNY',
            timezoneUtcOffset: 480,
            reasonCode: 'user_requested'
        });

        expect(request).toEqual({
            fileId: 'file-1',
            sourceAccountId: 'source-1',
            currency: 'CNY',
            timezoneUtcOffset: 480,
            reasonCode: 'user_requested'
        });
        expect('parserName' in request).toBe(false);
        expect('genericBankMapping' in request).toBe(false);
    });
});

describe('payment account suggestions', () => {
    const group = {
        sourceType: 'wechat',
        currency: 'CNY',
        displayName: '兴业银行信用卡（6106）',
        rowCount: 12,
        pendingRowCount: 12,
        sampleRowId: '901',
        mapped: false
    } as PersonalFinancePaymentAccountGroup;

    it('normalizes punctuation and tail-label variants without dropping the card tail', () => {
        expect(normalizePaymentAccountName('兴业银行信用卡（6106）')).toBe('兴业银行信用卡6106');
        expect(normalizePaymentAccountName(' 兴业银行信用卡 尾号 6106 ')).toBe('兴业银行信用卡6106');
        expect(normalizePaymentAccountName('兴业银行信用卡 6222600000006106')).toBe('兴业银行信用卡6106');
        expect(getSafePaymentAccountDisplayName('兴业银行信用卡 6222600000006106')).toBe('兴业银行信用卡 ****6106');
    });

    it('suggests one uniquely matching existing account and never guesses between ties', () => {
        const accounts = [
            { id: 'xingye', name: '兴业信用卡 6106', currency: 'CNY' },
            { id: 'guangda', name: '光大银行信用卡(2690)', currency: 'CNY' },
            { id: 'usd', name: '兴业银行信用卡6106', currency: 'USD' }
        ];

        expect(suggestPaymentAccount(group, accounts).ledgerAccountId).toBe('xingye');
        expect(suggestPaymentAccount(group, [
            ...accounts,
            { id: 'xingye-duplicate', name: '兴业信用卡(6106)', currency: 'CNY' }
        ]).ledgerAccountId).toBeUndefined();
        expect(suggestPaymentAccount({
            ...group,
            sourceType: 'bank',
            displayName: '末四位2690'
        }, accounts).ledgerAccountId).toBe('guangda');
        expect(suggestPaymentAccount({
            ...group,
            sourceType: 'bank',
            displayName: '末四位2690'
        }, [
            { id: 'xingye', name: '兴业银行信用卡(6106)', currency: 'CNY' }
        ]).ledgerAccountId).toBeUndefined();
        expect(suggestPaymentAccount({
            ...group,
            sourceType: 'bank',
            displayName: '末四位2690'
        }, [
            ...accounts,
            { id: 'other-2690', name: '别的卡2690', currency: 'CNY' }
        ]).ledgerAccountId).toBe('guangda');
    });

    it('infers a sensible editable category for cards and wallets', () => {
        expect(inferPaymentAccountCategory('江苏银行信用购', 'alipay')).toBe(AccountCategory.CreditCard.type);
        expect(inferPaymentAccountCategory('微信零钱', 'wechat')).toBe(AccountCategory.VirtualAccount.type);
        expect(inferPaymentAccountCategory('浙江农商联合银行储蓄卡(5564)', 'wechat')).toBe(AccountCategory.CheckingAccount.type);
    });

    it('associates a row with its batch group across equivalent formatting', () => {
        const matched = findPaymentAccountGroupForRow(row({
            rawPaymentMethod: '兴业银行信用卡 尾号6106'
        }), [group]);

        expect(matched?.sampleRowId).toBe('901');
        expect(findPaymentAccountGroupForRow(row({ rawPaymentMethod: '光大银行信用卡(2690)' }), [group])).toBeUndefined();
    });

    it('prefers a unique exact group over an earlier approximate group and closes on ties', () => {
        const approximate = { ...group, displayName: '兴业信用卡(6106)', sampleRowId: '902' };
        const exact = { ...group, displayName: '兴业银行信用卡(6106)', sampleRowId: '903' };
        const currentRow = row({ rawPaymentMethod: '兴业银行信用卡（6106）' });

        expect(findPaymentAccountGroupForRow(currentRow, [approximate, exact])?.sampleRowId).toBe('903');
        expect(findPaymentAccountGroupForRow(currentRow, [exact, { ...exact, sampleRowId: '904' }])).toBeUndefined();
    });
});
