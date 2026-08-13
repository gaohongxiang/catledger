import { TransactionType } from '@/core/transaction.ts';

import type {
	PersonalFinanceGenericBankMappingForm,
	PersonalFinanceGenericCsvMapping,
	PersonalFinanceImportBatch,
	PersonalFinanceImportFile,
    PersonalFinanceImportRow,
    PersonalFinanceImportUploadResult,
    PersonalFinancePostingDraft,
    PersonalFinancePostingRequest,
    PersonalFinanceReparseRequest,
    PersonalFinanceSourceAccount,
    PersonalFinanceSourceType
} from './models.ts';

export type PersonalFinanceUploadAction = 'reparse' | 'choose_duplicate_action';
export type PersonalFinanceRowAction = 'create' | 'create_or_reuse' | 'blocked';
export type PersonalFinanceGenericBankMappingError =
    'header_row_required' |
    'column_required' |
    'column_out_of_range' |
    'column_duplicate' |
    'direction_values_required' |
    'direction_values_invalid' |
    'direction_values_overlap' |
    'source_account_required' |
    'ledger_account_required';

const MAXIMUM_GENERIC_CSV_COLUMN = 1024;
const MAXIMUM_GENERIC_CSV_HEADER_ROW = 10000;
const MAXIMUM_GENERIC_CSV_DIRECTION_VALUES = 32;

const OPTIONAL_GENERIC_CSV_COLUMNS = [
    'currencyColumn',
    'transactionIdColumn',
    'orderIdColumn',
    'merchantOrderIdColumn',
    'counterpartyColumn',
    'itemColumn',
    'paymentMethodColumn',
    'statusColumn',
    'transactionTypeColumn',
    'noteColumn'
] as const;

export function canDiscardImportBatch(batch: PersonalFinanceImportBatch | null): boolean {
	return !!batch && (batch.status === 'awaiting_source_account' || batch.status === 'ready') && batch.postedRowCount === 0;
}

export function canDeleteImportFileContent(file: PersonalFinanceImportFile | undefined): boolean {
	return !!file && file.contentState !== 'pending' && file.contentState !== 'deleted';
}

export function canConfigureGenericBankCsv(file: PersonalFinanceImportFile | undefined): boolean {
    return !!file && file.contentState === 'available' && file.fileExtension.replace(/^\./, '').toLowerCase() === 'csv';
}

export function getUploadAction(result: PersonalFinanceImportUploadResult): PersonalFinanceUploadAction {
    if (result.duplicate && result.latestBatch) {
        return 'choose_duplicate_action';
    }

    return 'reparse';
}

export function getCompatibleSourceAccounts(
    accounts: PersonalFinanceSourceAccount[],
    sourceType: PersonalFinanceSourceType
): PersonalFinanceSourceAccount[] {
    return accounts.filter(account => account.sourceType === sourceType && account.status === 'active');
}

export function getUsableBankSourceAccounts(accounts: PersonalFinanceSourceAccount[]): PersonalFinanceSourceAccount[] {
    return getCompatibleSourceAccounts(accounts, 'bank').filter(account => !!account.ledgerAccountId);
}

export function createDefaultGenericBankMappingForm(): PersonalFinanceGenericBankMappingForm {
    return {
        encoding: 'utf8',
        delimiter: 'comma',
        headerRow: 1,
        timeFormat: '2006-01-02 15:04:05',
        amountMode: 'signed',
        signedPositiveDirection: 'income',
        timeColumn: 1,
        amountColumn: 2,
        directionColumn: null,
        incomeColumn: null,
        expenseColumn: null,
        currencyColumn: null,
        transactionIdColumn: null,
        orderIdColumn: null,
        merchantOrderIdColumn: null,
        counterpartyColumn: null,
        itemColumn: null,
        paymentMethodColumn: null,
        statusColumn: null,
        transactionTypeColumn: null,
        noteColumn: null,
        incomeValues: [],
        expenseValues: []
    };
}

export function toGenericCsvApiColumnIndex(column: number | null): number {
    return column === null ? -1 : column - 1;
}

function normalizeDirectionValues(values: string[]): string[] | null {
    if (values.length < 1 || values.length > MAXIMUM_GENERIC_CSV_DIRECTION_VALUES) {
        return null;
    }

    const normalized = values.map(value => value.normalize('NFKC').trim().toLowerCase());
    const uniqueValues = new Set(normalized);

    if (uniqueValues.size !== normalized.length || normalized.some(value => !value || [...value].length > 64 || /[\p{Cc}\p{Cf}]/u.test(value))) {
        return null;
    }

    return [...uniqueValues].sort();
}

export function validateGenericBankMappingForm(form: PersonalFinanceGenericBankMappingForm): {
    mapping?: PersonalFinanceGenericCsvMapping;
    errors: PersonalFinanceGenericBankMappingError[];
} {
    const errors = new Set<PersonalFinanceGenericBankMappingError>();

    if (!Number.isInteger(form.headerRow) || !form.headerRow || form.headerRow < 1 || form.headerRow > MAXIMUM_GENERIC_CSV_HEADER_ROW) {
        errors.add('header_row_required');
    }

    const requiredColumns: Array<keyof PersonalFinanceGenericBankMappingForm> = ['timeColumn'];

    if (form.amountMode === 'signed') {
        requiredColumns.push('amountColumn');
    } else if (form.amountMode === 'amount_direction') {
        requiredColumns.push('amountColumn', 'directionColumn');
    } else {
        requiredColumns.push('incomeColumn', 'expenseColumn');
    }

    const activeColumns = [...requiredColumns, ...OPTIONAL_GENERIC_CSV_COLUMNS];
    const usedColumns: number[] = [];

    for (const field of activeColumns) {
        const column = form[field] as number | null;

        if (requiredColumns.includes(field) && column === null) {
            errors.add('column_required');
            continue;
        }
        if (column !== null && (!Number.isInteger(column) || column < 1 || column > MAXIMUM_GENERIC_CSV_COLUMN)) {
            errors.add('column_out_of_range');
            continue;
        }
        if (column !== null) {
            usedColumns.push(column);
        }
    }

    if (new Set(usedColumns).size !== usedColumns.length) {
        errors.add('column_duplicate');
    }

    let incomeValues: string[] = [];
    let expenseValues: string[] = [];

    if (form.amountMode === 'amount_direction') {
        incomeValues = normalizeDirectionValues(form.incomeValues) ?? [];
        expenseValues = normalizeDirectionValues(form.expenseValues) ?? [];

        if (form.incomeValues.length < 1 || form.expenseValues.length < 1) {
            errors.add('direction_values_required');
        } else if (incomeValues.length < 1 || expenseValues.length < 1) {
            errors.add('direction_values_invalid');
        } else if (incomeValues.some(value => expenseValues.includes(value))) {
            errors.add('direction_values_overlap');
        }
    }

    if (errors.size > 0) {
        return { errors: [...errors] };
    }

    const isSigned = form.amountMode === 'signed';
    const isAmountDirection = form.amountMode === 'amount_direction';
    const isIncomeExpense = form.amountMode === 'income_expense';

    return {
        errors: [],
        mapping: {
            encoding: form.encoding,
            delimiter: form.delimiter,
            headerRow: form.headerRow!,
            timeFormat: form.timeFormat,
            amountMode: form.amountMode,
            signedPositiveDirection: isSigned ? form.signedPositiveDirection : '',
            timeColumn: toGenericCsvApiColumnIndex(form.timeColumn),
            amountColumn: isSigned || isAmountDirection ? toGenericCsvApiColumnIndex(form.amountColumn) : -1,
            directionColumn: isAmountDirection ? toGenericCsvApiColumnIndex(form.directionColumn) : -1,
            incomeColumn: isIncomeExpense ? toGenericCsvApiColumnIndex(form.incomeColumn) : -1,
            expenseColumn: isIncomeExpense ? toGenericCsvApiColumnIndex(form.expenseColumn) : -1,
            currencyColumn: toGenericCsvApiColumnIndex(form.currencyColumn),
            transactionIdColumn: toGenericCsvApiColumnIndex(form.transactionIdColumn),
            orderIdColumn: toGenericCsvApiColumnIndex(form.orderIdColumn),
            merchantOrderIdColumn: toGenericCsvApiColumnIndex(form.merchantOrderIdColumn),
            counterpartyColumn: toGenericCsvApiColumnIndex(form.counterpartyColumn),
            itemColumn: toGenericCsvApiColumnIndex(form.itemColumn),
            paymentMethodColumn: toGenericCsvApiColumnIndex(form.paymentMethodColumn),
            statusColumn: toGenericCsvApiColumnIndex(form.statusColumn),
            transactionTypeColumn: toGenericCsvApiColumnIndex(form.transactionTypeColumn),
            noteColumn: toGenericCsvApiColumnIndex(form.noteColumn),
            incomeValues: isAmountDirection ? incomeValues : [],
            expenseValues: isAmountDirection ? expenseValues : []
        }
    };
}

export function buildPersonalFinanceReparseRequest(params: {
    fileId: string;
    sourceAccountId?: string;
    parserName?: string;
    currency: string;
    timezoneUtcOffset: number;
    reasonCode: string;
    genericCsvMapping?: PersonalFinanceGenericCsvMapping;
}): PersonalFinanceReparseRequest {
    return {
        fileId: params.fileId,
        ...(params.sourceAccountId ? { sourceAccountId: params.sourceAccountId } : {}),
        ...(params.parserName ? { parserName: params.parserName } : {}),
        currency: params.currency,
        timezoneUtcOffset: params.timezoneUtcOffset,
        reasonCode: params.reasonCode,
        ...(params.genericCsvMapping ? { genericCsvMapping: params.genericCsvMapping } : {})
    };
}

export function buildGenericBankReparseRequest(params: {
    fileId: string;
    sourceAccount?: PersonalFinanceSourceAccount;
    currency: string;
    timezoneUtcOffset: number;
    reasonCode: string;
    form: PersonalFinanceGenericBankMappingForm;
}): PersonalFinanceReparseRequest {
    if (!params.sourceAccount || params.sourceAccount.sourceType !== 'bank' || params.sourceAccount.status !== 'active') {
        throw new Error('source_account_required');
    }
    if (!params.sourceAccount.ledgerAccountId) {
        throw new Error('ledger_account_required');
    }

    const validation = validateGenericBankMappingForm(params.form);

    if (!validation.mapping) {
        throw new Error(validation.errors[0] ?? 'invalid_generic_bank_mapping');
    }

    return buildPersonalFinanceReparseRequest({
        fileId: params.fileId,
        sourceAccountId: params.sourceAccount.id,
        parserName: 'generic_bank_csv',
        currency: params.currency,
        timezoneUtcOffset: params.timezoneUtcOffset,
        reasonCode: params.reasonCode,
        genericCsvMapping: validation.mapping
    });
}

export function getRowAction(row: PersonalFinanceImportRow): PersonalFinanceRowAction {
    if (row.parseState !== 'valid' || row.processingState !== 'pending' || !row.identityId ||
        (row.disposition !== 'postable' && row.disposition !== 'review_required') ||
        row.identityState === 'identity_conflict' || row.identityState === 'not_evaluated') {
        return 'blocked';
    }

    if (row.identityState === 'exact_duplicate') {
        return 'create_or_reuse';
    }

    if (row.identityState === 'new' || row.identityState === 'batch_local') {
        return 'create';
    }

    return 'blocked';
}

export function getSuggestedTransactionType(row: PersonalFinanceImportRow): TransactionType {
    if (row.normalizedDirection === 'income') {
        return TransactionType.Income;
    }

    return TransactionType.Expense;
}

export function buildSingleRowPostingRequest(
    row: PersonalFinanceImportRow,
    idempotencyKey: string,
    draft?: PersonalFinancePostingDraft
): PersonalFinancePostingRequest {
    const action = getRowAction(row);

    if (action === 'blocked' || !idempotencyKey || !draft) {
        throw new Error('invalid personal finance row posting request');
    }

    return {
        batchId: row.batchId,
        idempotencyKey,
        commands: [{
            rowIds: [row.id],
            draft
        }]
    };
}
