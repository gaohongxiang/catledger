import services from '@/lib/services.ts';

import { TransactionType } from '@/core/transaction.ts';

import type {
    BillflowAccountGroup,
    BillflowAccountRow,
    BillflowAccounts,
    BillflowSourceType,
    BillflowTask,
    BillflowTaskMember,
    BillflowTaskPage,
    BillflowTaskStatus,
    BillflowTodo,
    BillflowTodoKind,
    BillflowTodoPage,
    BillflowTodoStatus,
    BillflowUndoImpact,
    CardBalanceReviewStatus,
    CardCycleAccount,
    CardMonthStatus,
    InstallmentCandidate,
    InstallmentCandidateStatus,
    InstallmentPurchaseRelation
} from './models.ts';

export class BillflowProtocolError extends Error {
    public constructor() {
        super('invalid_billflow_response');
    }
}

type UnknownRecord = Record<string, unknown>;

function fail(): never {
    throw new BillflowProtocolError();
}

function record(value: unknown): UnknownRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    return value as UnknownRecord;
}

function array(value: unknown): unknown[] {
    if (!Array.isArray(value)) fail();
    return value;
}

function string(value: unknown): string {
    if (typeof value !== 'string') fail();
    return value;
}

function boolean(value: unknown): boolean {
    if (typeof value !== 'boolean') fail();
    return value;
}

function identifier(value: unknown): string {
    const result = string(value);
    if (!/^[1-9]\d*$/.test(result)) fail();
    return result;
}

function integer(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail();
    return value;
}

function optionalIdentifier(value: unknown): string | undefined {
    if (value === null || typeof value === 'undefined') return undefined;
    return identifier(value);
}

function optionalInteger(value: unknown): number | undefined {
    if (value === null || typeof value === 'undefined') return undefined;
    return integer(value);
}

function asEnum<T extends string>(value: unknown, values: readonly T[]): T {
    if (typeof value !== 'string' || !values.includes(value as T)) fail();
    return value as T;
}

const taskStatuses = ['receiving', 'accounts_pending', 'processing', 'awaiting_confirm', 'ready', 'failed'] as const;
const confirmPolicies = ['confirm_then_post', 'auto_post'] as const;
const sourceTypes = ['alipay', 'wechat', 'bank'] as const;
const suggestedTypes = ['credit_card', 'virtual'] as const;
const todoKinds = [
    'unresolved_payment_account', 'identity_conflict', 'core_field_conflict', 'ledger_mismatch',
    'cross_source_ambiguous', 'transfer_unclear', 'refund_unclear', 'repayment_unclear',
    'installment_candidate', 'uncategorized'
] as const;
const todoStatuses = ['open', 'resolved', 'dismissed'] as const;
const subjectKinds = [
    'raw_row', 'source_identity', 'reconciliation_case', 'installment_candidate', 'payment_alias', 'transaction'
] as const;
const candidateStatuses = ['pending', 'incomplete', 'confirmed', 'dismissed'] as const;
const purchaseRelations = ['unresolved', 'link_existing', 'missing_candidate'] as const;
const monthStatuses = ['provisional', 'confirmed'] as const;
const reviewStatuses = ['unverified', 'verified'] as const;

function unwrap(response: unknown): unknown {
    const outer = record(response);
    const data = record(outer['data']);
    if (data['success'] !== true || data['result'] === null || typeof data['result'] === 'undefined') fail();
    return data['result'];
}

function member(value: unknown): BillflowTaskMember {
    const item = record(value);
    return {
        id: identifier(item['id']),
        fileId: identifier(item['fileId']),
        batchId: identifier(item['batchId']),
        memberOrder: integer(item['memberOrder'])
    };
}

export function normalizeBillflowTask(value: unknown): BillflowTask {
    const item = record(value);
    return {
        id: identifier(item['id']),
        status: asEnum<BillflowTaskStatus>(item['status'], taskStatuses),
        confirmPolicy: asEnum(item['confirmPolicy'], confirmPolicies),
        version: integer(item['version']),
        createdAccountCount: integer(item['createdAccountCount']),
        reusedMappingCount: integer(item['reusedMappingCount']),
        autoPostedCount: integer(item['autoPostedCount']),
        todoOpenCount: integer(item['todoOpenCount']),
        errorCode: string(item['errorCode']),
        createdUnixTime: integer(item['createdUnixTime']),
        updatedUnixTime: integer(item['updatedUnixTime']),
        members: array(item['members']).map(member)
    };
}

function normalizeTaskPage(value: unknown): BillflowTaskPage {
    const item = record(value);
    const cursor = item['nextCursor'];
    return {
        items: array(item['items']).map(normalizeBillflowTask),
        ...(cursor === null || typeof cursor === 'undefined' ? {} : {
            nextCursor: {
                updatedUnixTime: integer(record(cursor)['updatedUnixTime']),
                taskId: identifier(record(cursor)['taskId'])
            }
        })
    };
}

function accountGroup(value: unknown): BillflowAccountGroup {
    const item = record(value);
    return {
        sourceType: asEnum<BillflowSourceType>(item['sourceType'], sourceTypes),
        currency: string(item['currency']),
        displayName: string(item['displayName']),
        rowCount: integer(item['rowCount']),
        pendingRowCount: integer(item['pendingRowCount']),
        sampleRowId: identifier(item['sampleRowId']),
        ledgerAccountId: optionalIdentifier(item['ledgerAccountId']),
        suggestedType: asEnum(item['suggestedType'], suggestedTypes),
        mapped: boolean(item['mapped']),
        excluded: boolean(item['excluded'])
    };
}

function accountRow(value: unknown): BillflowAccountRow {
    const item = record(value);
    return {
        id: identifier(item['id']),
        batchId: identifier(item['batchId']),
        unixTime: optionalInteger(item['unixTime']),
        amount: string(item['amount']),
        currency: string(item['currency']),
        direction: string(item['direction']),
        label: string(item['label']),
        skipped: boolean(item['skipped'])
    };
}

function normalizeAccounts(value: unknown): BillflowAccounts {
    const item = record(value);
    return {
        needsCreate: array(item['needsCreate']).map(accountGroup),
        reused: array(item['reused']).map(accountGroup),
        excluded: array(item['excluded']).map(accountGroup)
    };
}

function normalizeAccountRows(value: unknown): readonly BillflowAccountRow[] {
    return array(value).map(accountRow);
}

function normalizeTodo(value: unknown): BillflowTodo {
    const item = record(value);
    return {
        id: identifier(item['id']),
        todoKind: asEnum<BillflowTodoKind>(item['todoKind'], todoKinds),
        status: asEnum<BillflowTodoStatus>(item['status'], todoStatuses),
        subjectKind: asEnum(item['subjectKind'], subjectKinds),
        subjectId: identifier(item['subjectId']),
        reasonCodes: array(item['reasonCodes']).map(string),
        version: integer(item['version']),
        createdUnixTime: integer(item['createdUnixTime']),
        updatedUnixTime: integer(item['updatedUnixTime'])
    };
}

function normalizeTodoPage(value: unknown): BillflowTodoPage {
    const item = record(value);
    const cursor = item['nextCursor'];
    return {
        items: array(item['items']).map(normalizeTodo),
        ...(cursor === null || typeof cursor === 'undefined' ? {} : {
            nextCursor: {
                updatedUnixTime: integer(record(cursor)['updatedUnixTime']),
                todoId: identifier(record(cursor)['todoId'])
            }
        })
    };
}

function normalizeUndoImpact(value: unknown): BillflowUndoImpact {
    const item = record(value);
    return {
        canReverse: boolean(item['canReverse']),
        autoPostedCount: integer(item['autoPostedCount']),
        reusedLinkCount: integer(item['reusedLinkCount']),
        reasonCodes: array(item['reasonCodes']).map(string)
    };
}

export function normalizeInstallmentCandidate(value: unknown): InstallmentCandidate {
    const item = record(value);
    return {
        id: identifier(item['id']),
        status: asEnum<InstallmentCandidateStatus>(item['status'], candidateStatuses),
        version: integer(item['version']),
        liabilityAccountId: optionalIdentifier(item['liabilityAccountId']),
        termCount: optionalInteger(item['termCount']),
        purchaseRelation: asEnum<InstallmentPurchaseRelation>(item['purchaseRelation'], purchaseRelations),
        linkedPurchaseTransactionId: optionalIdentifier(item['linkedPurchaseTransactionId'])
    };
}

export function normalizeCardCycleAccounts(value: unknown): CardCycleAccount[] {
    const item = record(value);
    return array(item['items']).map(entry => {
        const account = record(entry);
        const review = account['balanceReview'];
        return {
            ledgerAccountId: identifier(account['ledgerAccountId']),
            displayName: string(account['displayName']),
            currency: string(account['currency']),
            monthStatus: asEnum<CardMonthStatus>(account['monthStatus'], monthStatuses),
            ...(review === null || typeof review === 'undefined' ? {} : {
                balanceReview: {
                    id: identifier(record(review)['id']),
                    status: asEnum<CardBalanceReviewStatus>(record(review)['status'], reviewStatuses),
                    asOfDate: string(record(review)['asOfDate']),
                    version: integer(record(review)['version'])
                }
            })
        };
    });
}

export const billflowApi = {
    async createTask(fileIds: string[], idempotencyKey: string): Promise<BillflowTask> {
        return normalizeBillflowTask(unwrap(await services.createPersonalFinanceBillflowTask({ fileIds, idempotencyKey })));
    },
    async listTasks(status: BillflowTaskStatus, limit = 20): Promise<BillflowTaskPage> {
        return normalizeTaskPage(unwrap(await services.listPersonalFinanceBillflowTasks({ status, limit })));
    },
    async getTask(taskId: string): Promise<BillflowTask> {
        return normalizeBillflowTask(unwrap(await services.getPersonalFinanceBillflowTask({ taskId })));
    },
    async getAccounts(taskId: string): Promise<BillflowAccounts> {
        return normalizeAccounts(unwrap(await services.getPersonalFinanceBillflowAccounts({ taskId })));
    },
    async createAccount(request: {
        taskId: string;
        expectedVersion: number;
        sampleRowId: string;
        name: string;
        category: number;
        currency: string;
        idempotencyKey: string;
    }): Promise<BillflowAccounts> {
        return normalizeAccounts(unwrap(await services.createPersonalFinanceBillflowAccount(request)));
    },
    async overrideAccount(request: {
        taskId: string;
        expectedVersion: number;
        sampleRowId: string;
        ledgerAccountId: string;
        idempotencyKey: string;
    }): Promise<BillflowAccounts> {
        return normalizeAccounts(unwrap(await services.overridePersonalFinanceBillflowAccount(request)));
    },
    async excludeAccount(request: {
        taskId: string;
        expectedVersion: number;
        sampleRowId: string;
        idempotencyKey: string;
    }): Promise<BillflowAccounts> {
        return normalizeAccounts(unwrap(await services.excludePersonalFinanceBillflowAccount(request)));
    },
    async restoreAccount(request: {
        taskId: string;
        expectedVersion: number;
        sampleRowId: string;
        idempotencyKey: string;
    }): Promise<BillflowAccounts> {
        return normalizeAccounts(unwrap(await services.restorePersonalFinanceBillflowAccount(request)));
    },
    async listAccountRows(taskId: string, sampleRowId: string): Promise<readonly BillflowAccountRow[]> {
        return normalizeAccountRows(unwrap(await services.listPersonalFinanceBillflowAccountRows({ taskId, sampleRowId })));
    },
    async skipAccountRows(request: {
        taskId: string;
        expectedVersion: number;
        sampleRowId: string;
        rowIds: readonly string[];
        idempotencyKey: string;
    }): Promise<BillflowAccounts> {
        return normalizeAccounts(unwrap(await services.skipPersonalFinanceBillflowAccountRows(request)));
    },
    async restoreAccountRows(request: {
        taskId: string;
        expectedVersion: number;
        sampleRowId: string;
        rowIds: readonly string[];
        idempotencyKey: string;
    }): Promise<BillflowAccounts> {
        return normalizeAccounts(unwrap(await services.restorePersonalFinanceBillflowAccountRows(request)));
    },
    async runTask(taskId: string, expectedVersion: number, idempotencyKey: string): Promise<BillflowTask> {
        return normalizeBillflowTask(unwrap(await services.runPersonalFinanceBillflowTask({ taskId, expectedVersion, idempotencyKey })));
    },
    async confirmPost(taskId: string, expectedVersion: number, idempotencyKey: string): Promise<BillflowTask> {
        return normalizeBillflowTask(unwrap(await services.confirmPersonalFinanceBillflowPost({ taskId, expectedVersion, idempotencyKey })));
    },
    async listTodos(taskId: string, status: BillflowTodoStatus, limit = 50): Promise<BillflowTodoPage> {
        return normalizeTodoPage(unwrap(await services.listPersonalFinanceBillflowTodos({ taskId, status, limit })));
    },
    async resolveTodo(todoId: string, expectedVersion: number, status: Exclude<BillflowTodoStatus, 'open'>, idempotencyKey: string): Promise<BillflowTodo> {
        return normalizeTodo(unwrap(await services.resolvePersonalFinanceBillflowTodo({ todoId, expectedVersion, status, idempotencyKey })));
    },
    async getUndoImpact(taskId: string): Promise<BillflowUndoImpact> {
        return normalizeUndoImpact(unwrap(await services.getPersonalFinanceBillflowUndoImpact({ taskId })));
    },
    async undoTask(taskId: string, expectedVersion: number, idempotencyKey: string): Promise<BillflowTask> {
        return normalizeBillflowTask(unwrap(await services.undoPersonalFinanceBillflowTask({ taskId, expectedVersion, idempotencyKey })));
    },
    async getInstallmentCandidate(candidateId: string): Promise<InstallmentCandidate> {
        return normalizeInstallmentCandidate(unwrap(await services.getPersonalFinanceInstallmentCandidate({ candidateId })));
    },
    async confirmInstallment(request: {
        candidateId: string;
        expectedVersion: number;
        treatAsInstallment: boolean;
        liabilityAccountId?: string;
        termCount?: number;
        purchaseRelation: InstallmentPurchaseRelation;
        linkedPurchaseTransactionId?: string;
    }): Promise<InstallmentCandidate> {
        return normalizeInstallmentCandidate(unwrap(await services.confirmPersonalFinanceInstallmentCandidate(request)));
    },
    async listCardAccounts(asOfDate: string): Promise<CardCycleAccount[]> {
        return normalizeCardCycleAccounts(unwrap(await services.listPersonalFinanceCardCycleAccounts({ asOfDate })));
    },
    async saveBalanceReview(request: {
        ledgerAccountId: string;
        status: CardBalanceReviewStatus;
        asOfDate: string;
        expectedVersion: number;
        idempotencyKey: string;
    }): Promise<void> {
        unwrap(await services.savePersonalFinanceBalanceReview(request));
    },
    async addOpeningBalance(request: {
        accountId: string;
        amount: number;
        time: number;
        utcOffset: number;
        clientSessionId: string;
    }): Promise<void> {
        unwrap(await services.addTransaction({
            type: TransactionType.ModifyBalance,
            categoryId: '0',
            time: request.time,
            utcOffset: request.utcOffset,
            sourceAccountId: request.accountId,
            destinationAccountId: '0',
            sourceAmount: request.amount,
            destinationAmount: 0,
            hideAmount: false,
            tagIds: [],
            pictureIds: [],
            comment: '',
            clientSessionId: request.clientSessionId
        }));
    }
};
