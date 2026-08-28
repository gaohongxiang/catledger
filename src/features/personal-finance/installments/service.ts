import services from '@/lib/services.ts';

import type {
    ConfirmInstallmentCandidateRequest,
    InstallmentCandidate,
    InstallmentCandidateMember,
    InstallmentCandidateMemberKind,
    InstallmentCandidatePage,
    InstallmentCandidateStatus
} from './models.ts';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_installment_response');
    return value as UnknownRecord;
}

function array(value: unknown): unknown[] {
    if (!Array.isArray(value)) throw new Error('invalid_installment_response');
    return value;
}

function identifier(value: unknown): string {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new Error('invalid_installment_identifier');
    return value;
}

function integer(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('invalid_installment_integer');
    return value;
}

function positiveInteger(value: unknown): number {
    const parsed = integer(value);
    if (parsed < 1) throw new Error('invalid_installment_integer');
    return parsed;
}

function nonNegativeInteger(value: unknown): number {
    const parsed = integer(value);
    if (parsed < 0) throw new Error('invalid_installment_integer');
    return parsed;
}

function string(value: unknown): string {
    if (typeof value !== 'string') throw new Error('invalid_installment_string');
    return value;
}

function optional<T>(value: unknown, convert: (item: unknown) => T): T | undefined {
    return value === null || typeof value === 'undefined' ? undefined : convert(value);
}

const statuses: readonly InstallmentCandidateStatus[] = ['pending', 'needs_details', 'action_required', 'linked', 'converted', 'dismissed'];
const memberKinds: readonly InstallmentCandidateMemberKind[] = ['raw_row', 'source_identity'];

function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
    const parsed = string(value) as T;
    if (!values.includes(parsed)) throw new Error('invalid_installment_enum');
    return parsed;
}

function unwrap(value: unknown): unknown {
    const data = record(record(value)['data']);
    if (data['success'] !== true || data['result'] === null || typeof data['result'] === 'undefined') throw new Error('invalid_installment_response');
    return data['result'];
}

function member(value: unknown): InstallmentCandidateMember {
    const item = record(value);
    return {
        id: identifier(item['id']), kind: enumValue(item['kind'], memberKinds), refId: identifier(item['refId']),
        role: string(item['role']), periodNumber: optional(item['periodNumber'], positiveInteger),
        createdUnixTime: positiveInteger(item['createdUnixTime'])
    };
}

export function normalizeInstallmentCandidate(value: unknown): InstallmentCandidate {
    const item = record(value);
    return {
        id: identifier(item['id']), status: enumValue(item['status'], statuses), version: positiveInteger(item['version']),
        liabilityAccountId: optional(item['liabilityAccountId'], identifier), termCount: optional(item['termCount'], positiveInteger),
        linkedContractId: optional(item['linkedContractId'], identifier), purchaseRelation: string(item['purchaseRelation']),
        linkedPurchaseTransactionId: optional(item['linkedPurchaseTransactionId'], identifier),
        principalAmount: optional(item['principalAmount'], nonNegativeInteger), paymentAmount: optional(item['paymentAmount'], nonNegativeInteger),
        interestAmount: optional(item['interestAmount'], nonNegativeInteger), feeAmount: optional(item['feeAmount'], nonNegativeInteger),
        repaymentMethod: string(item['repaymentMethod']), firstDueDate: string(item['firstDueDate']),
        currentPeriod: optional(item['currentPeriod'], positiveInteger), createdUnixTime: positiveInteger(item['createdUnixTime']),
        updatedUnixTime: positiveInteger(item['updatedUnixTime']), members: array(item['members']).map(member)
    };
}

function normalizePage(value: unknown): InstallmentCandidatePage {
    const item = record(value);
    const cursor = optional(item['nextCursor'], record);
    return {
        items: array(item['items']).map(normalizeInstallmentCandidate),
        ...(cursor ? { nextCursor: { updatedUnixTime: positiveInteger(cursor['updatedUnixTime']), candidateId: identifier(cursor['candidateId']) } } : {})
    };
}

export const installmentApi = {
    async listCandidates(status: InstallmentCandidateStatus, cursor?: InstallmentCandidatePage['nextCursor'], limit = 100): Promise<InstallmentCandidatePage> {
        return normalizePage(unwrap(await services.listPersonalFinanceInstallmentCandidates({
            status, limit,
            ...(cursor ? { cursorUpdatedUnixTime: cursor.updatedUnixTime, cursorCandidateId: cursor.candidateId } : {})
        })));
    },

    async confirmCandidate(request: ConfirmInstallmentCandidateRequest): Promise<InstallmentCandidate> {
        return normalizeInstallmentCandidate(unwrap(await services.confirmPersonalFinanceInstallmentCandidate({ ...request })));
    }
};
