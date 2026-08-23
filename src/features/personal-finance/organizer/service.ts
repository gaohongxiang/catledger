import axios from 'axios';

import services from '@/lib/services.ts';

import type { PersonalFinanceSourceType } from '../models.ts';
import type {
    EconomicEvent,
    EconomicEventPage,
    EconomicEventStatus,
    FinanceAction,
    FinanceUpdate,
    FinanceUpdatePage,
    FinanceUpdateSource,
    FinanceUpdateStatus,
    OrganizerCorrectRequest,
    OrganizerEventEvidence,
    OrganizerEvidenceItem,
    OrganizerImpact,
    OrganizerMutation,
    OrganizerRawRow,
    OrganizerRelation,
    OrganizerTransactionLink,
    ResolveReviewIssueRequest,
    ReviewIssue,
    ReviewIssueDetail,
    ReviewIssueMember,
    ReviewIssueMemberRole,
    ReviewIssueMutation,
    ReviewIssuePage,
    ReviewIssueStatus,
    ReviewIssueType,
    ReviewObjectType
} from './models.ts';

type UnknownRecord = Record<string, unknown>;

export class OrganizerProtocolError extends Error {
    public constructor() {
        super('invalid_organizer_response');
    }
}

function fail(): never { throw new OrganizerProtocolError(); }
function record(value: unknown): UnknownRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    return value as UnknownRecord;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) fail(); return value; }
function string(value: unknown): string { if (typeof value !== 'string') fail(); return value; }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') fail(); return value; }
function integer(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail();
    return value;
}
function signedInteger(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail();
    return value;
}
function identifier(value: unknown): string {
    const result = string(value);
    if (!/^[1-9]\d*$/.test(result)) fail();
    return result;
}
function optional<T>(value: unknown, parser: (input: unknown) => T): T | undefined {
    return value === null || typeof value === 'undefined' ? undefined : parser(value);
}
function asEnum<T extends string>(value: unknown, values: readonly T[]): T {
    const result = string(value) as T;
    if (!values.includes(result)) fail();
    return result;
}

const updateStatuses: readonly FinanceUpdateStatus[] = [
    'draft', 'organizing', 'review', 'posting', 'partially_posted', 'posted', 'failed', 'undone', 'abandoned'
];
const eventStatuses: readonly EconomicEventStatus[] = ['ready', 'needs_action', 'excluded', 'posted', 'corrected'];
const sourceTypes: readonly PersonalFinanceSourceType[] = ['alipay', 'wechat', 'bank'];
const flowDirections = ['inflow', 'outflow', 'neutral'] as const;
const economicNatures = [
    'income', 'expense', 'internal_transfer', 'borrow', 'repayment',
    'refund', 'fee', 'balance_adjustment', 'unknown'
] as const;
const reviewIssueStatuses: readonly ReviewIssueStatus[] = ['open', 'resolved', 'superseded'];
const reviewIssueTypes: readonly ReviewIssueType[] = [
    'account_mapping', 'shared_fields', 'same_event', 'refund_relation',
    'transfer_accounts', 'identity_conflict', 'field_conflict'
];
const reviewIssueMemberRoles: readonly ReviewIssueMemberRole[] = ['subject', 'candidate', 'supporting'];
const reviewObjectTypes: readonly ReviewObjectType[] = ['event', 'evidence', 'relation', 'transaction', 'source_account'];

function unwrap(response: unknown): unknown {
    const data = record(record(response)['data']);
    if (data['success'] !== true || data['result'] === null || typeof data['result'] === 'undefined') fail();
    return data['result'];
}

function source(value: unknown): FinanceUpdateSource {
    const item = record(value);
    return {
        id: identifier(item['id']),
        fileId: identifier(item['fileId']),
        batchId: identifier(item['batchId']),
        sourceOrder: integer(item['sourceOrder']),
        sourceAccountId: optional(item['sourceAccountId'], identifier),
        sourceType: asEnum(item['sourceType'], sourceTypes),
        parserVersion: string(item['parserVersion']),
        normalizationVersion: string(item['normalizationVersion']),
        identityKeyVersion: string(item['identityKeyVersion'])
    };
}

export function normalizeFinanceUpdate(value: unknown): FinanceUpdate {
    const item = record(value);
    return {
        id: identifier(item['id']),
        status: asEnum(item['status'], updateStatuses),
        version: integer(item['version']),
        planVersion: string(item['planVersion']),
        currentActionId: optional(item['currentActionId'], identifier),
        sourceCount: integer(item['sourceCount']),
        validEvidenceCount: integer(item['validEvidenceCount']),
        duplicateEvidenceCount: integer(item['duplicateEvidenceCount']),
        finalEventCount: integer(item['finalEventCount']),
        postedEventCount: integer(item['postedEventCount']),
        readyEventCount: integer(item['readyEventCount']),
        needsActionEventCount: integer(item['needsActionEventCount']),
        excludedEventCount: integer(item['excludedEventCount']),
        errorCode: string(item['errorCode']),
        createdUnixTime: integer(item['createdUnixTime']),
        updatedUnixTime: integer(item['updatedUnixTime']),
        ...(item['sources'] === null || typeof item['sources'] === 'undefined'
            ? {} : { sources: array(item['sources']).map(source) })
    };
}

function normalizeUpdatePage(value: unknown): FinanceUpdatePage {
    const item = record(value);
    const cursor = optional(item['nextCursor'], record);
    return {
        items: array(item['items']).map(normalizeFinanceUpdate),
        ...(cursor ? { nextCursor: { updatedUnixTime: integer(cursor['updatedUnixTime']), updateId: identifier(cursor['updateId']) } } : {})
    };
}

export function normalizeEconomicEvent(value: unknown): EconomicEvent {
    const item = record(value);
    return {
        id: identifier(item['id']),
        updateId: identifier(item['updateId']),
        status: asEnum(item['status'], eventStatuses),
        version: integer(item['version']),
        flowDirection: asEnum(item['flowDirection'], flowDirections),
        economicNature: asEnum(item['economicNature'], economicNatures),
        ledgerAccountId: optional(item['ledgerAccountId'], identifier),
        counterpartyLedgerAccountId: optional(item['counterpartyLedgerAccountId'], identifier),
        eventUnixTime: optional(item['eventUnixTime'], integer),
        timezoneUtcOffset: optional(item['timezoneUtcOffset'], signedInteger),
        amount: optional(item['amount'], string),
        currency: string(item['currency']),
        categoryId: optional(item['categoryId'], identifier),
        manualFieldMask: integer(item['manualFieldMask']),
        fieldSourcesJson: string(item['fieldSourcesJson']),
        reasonCodesJson: string(item['reasonCodesJson']),
        createdUnixTime: integer(item['createdUnixTime']),
        updatedUnixTime: integer(item['updatedUnixTime']),
        counterparty: string(item['counterparty']),
        item: string(item['item']),
        paymentMethod: string(item['paymentMethod']),
        note: string(item['note']),
        evidenceCount: integer(item['evidenceCount'])
    };
}

function normalizeEventPage(value: unknown): EconomicEventPage {
    const item = record(value);
    const cursor = optional(item['nextCursor'], record);
    return {
        items: array(item['items']).map(normalizeEconomicEvent),
        ...(cursor ? { nextCursor: { updatedUnixTime: integer(cursor['updatedUnixTime']), eventId: identifier(cursor['eventId']) } } : {})
    };
}

function action(value: unknown): FinanceAction {
    const item = record(value);
    return {
        id: identifier(item['id']), updateId: identifier(item['updateId']),
        actionType: string(item['actionType']), status: string(item['status']),
        appliedUpdateVersion: integer(item['appliedUpdateVersion']),
        reasonCodesJson: string(item['reasonCodesJson']), errorCode: string(item['errorCode']),
        createdUnixTime: integer(item['createdUnixTime']), updatedUnixTime: integer(item['updatedUnixTime'])
    };
}

function impact(value: unknown): OrganizerImpact {
    const item = record(value);
    return {
        safeToApply: boolean(item['safeToApply']), postedEventCount: integer(item['postedEventCount']),
        transactionCount: integer(item['transactionCount']), missingTransactionCount: integer(item['missingTransactionCount']),
        modifiedTransactionCount: integer(item['modifiedTransactionCount']), sharedTransactionCount: integer(item['sharedTransactionCount']),
        batchRelationCount: integer(item['batchRelationCount']), debtRelationCount: integer(item['debtRelationCount']),
        incompleteTransferPairCount: integer(item['incompleteTransferPairCount']),
        reasonCodes: array(item['reasonCodes']).map(string)
    };
}

function mutation(value: unknown): OrganizerMutation {
    const item = record(value);
    return {
        update: normalizeFinanceUpdate(item['update']), action: action(item['action']), replayed: boolean(item['replayed']),
        event: optional(item['event'], normalizeEconomicEvent),
        events: optional(item['events'], value => array(value).map(normalizeEconomicEvent)),
        impact: optional(item['impact'], impact)
    };
}

function rawRow(value: unknown): OrganizerRawRow {
    const item = record(value);
    return {
        id: identifier(item['id']), batchId: identifier(item['batchId']), rowNumber: integer(item['rowNumber']),
        unixTime: optional(item['unixTime'], integer), amount: optional(item['amount'], string), currency: string(item['currency']),
        direction: string(item['direction']), transactionType: string(item['transactionType']),
        counterparty: string(item['counterparty']), item: string(item['item']),
        paymentMethod: string(item['paymentMethod']), note: string(item['note'])
    };
}

function evidence(value: unknown): OrganizerEvidenceItem {
    const item = record(value);
    return { id: identifier(item['id']), rowId: identifier(item['rowId']), evidenceRole: string(item['evidenceRole']), fieldMask: integer(item['fieldMask']), row: rawRow(item['row']) };
}

function relation(value: unknown): OrganizerRelation {
    const item = record(value);
    return {
        id: identifier(item['id']), type: string(item['type']), status: string(item['status']), version: integer(item['version']),
        sourceEventId: identifier(item['sourceEventId']), targetEventId: identifier(item['targetEventId']),
        amount: optional(item['amount'], string), currency: string(item['currency']), manual: boolean(item['manual']),
        reasonCodesJson: string(item['reasonCodesJson'])
    };
}

function transactionLink(value: unknown): OrganizerTransactionLink {
    const item = record(value);
    return {
        id: identifier(item['id']), transactionId: identifier(item['transactionId']), role: string(item['role']),
        transactionUpdatedUnixTime: integer(item['transactionUpdatedUnixTime'])
    };
}

function eventEvidence(value: unknown): OrganizerEventEvidence {
    const item = record(value);
    return {
        event: normalizeEconomicEvent(item['event']), evidence: array(item['evidence']).map(evidence),
        relations: array(item['relations']).map(relation), transactions: array(item['transactions']).map(transactionLink)
    };
}

function reviewIssue(value: unknown): ReviewIssue {
    const item = record(value);
    return {
        id: identifier(item['id']), updateId: identifier(item['updateId']),
        status: asEnum(item['status'], reviewIssueStatuses), type: asEnum(item['type'], reviewIssueTypes),
        version: integer(item['version']), blocking: boolean(item['blocking']),
        primaryReasonCode: string(item['primaryReasonCode']), memberCount: integer(item['memberCount']),
        candidateCount: integer(item['candidateCount']), resolvedActionId: optional(item['resolvedActionId'], identifier),
        reasonCodesJson: string(item['reasonCodesJson']), createdUnixTime: integer(item['createdUnixTime']),
        updatedUnixTime: integer(item['updatedUnixTime'])
    };
}

function reviewIssueMember(value: unknown): ReviewIssueMember {
    const item = record(value);
    return {
        id: identifier(item['id']), issueId: identifier(item['issueId']),
        role: asEnum(item['role'], reviewIssueMemberRoles), objectType: asEnum(item['objectType'], reviewObjectTypes),
        objectId: identifier(item['objectId']), objectVersion: integer(item['objectVersion']),
        sortOrder: integer(item['sortOrder']), score: integer(item['score']), reasonCodesJson: string(item['reasonCodesJson'])
    };
}

function reviewIssuePage(value: unknown): ReviewIssuePage {
    const item = record(value);
    const cursor = optional(item['nextCursor'], record);
    return {
        items: array(item['items']).map(reviewIssue), members: array(item['members']).map(reviewIssueMember),
        ...(cursor ? { nextCursor: { updatedUnixTime: integer(cursor['updatedUnixTime']), issueId: identifier(cursor['issueId']) } } : {})
    };
}

function reviewIssueDetail(value: unknown): ReviewIssueDetail {
    const item = record(value);
    return {
        issue: reviewIssue(item['issue']), members: array(item['members']).map(reviewIssueMember),
        events: array(item['events']).map(normalizeEconomicEvent), relations: array(item['relations']).map(relation),
        transactions: array(item['transactions']).map(transactionLink)
    };
}

function reviewIssueMutation(value: unknown): ReviewIssueMutation {
    const item = record(value);
    return {
        update: normalizeFinanceUpdate(item['update']), issue: reviewIssue(item['issue']),
        members: [], events: array(item['events']).map(normalizeEconomicEvent),
        relations: array(item['relations']).map(relation), transactions: array(item['transactions']).map(transactionLink),
        action: action(item['action']), replayed: boolean(item['replayed'])
    };
}

function idempotencyRequest(update: FinanceUpdate, idempotencyKey: string) {
    return { updateId: update.id, expectedUpdateVersion: update.version, idempotencyKey };
}

export const organizerApi = {
    async createUpdate(batchIds: readonly string[], idempotencyKey: string): Promise<FinanceUpdate> {
        return normalizeFinanceUpdate(unwrap(await services.createPersonalFinanceOrganizerUpdate({ batchIds: [...batchIds], idempotencyKey })));
    },
    async listUpdates(status: FinanceUpdateStatus, limit = 20): Promise<FinanceUpdatePage> {
        return normalizeUpdatePage(unwrap(await services.listPersonalFinanceOrganizerUpdates({ status, limit })));
    },
    async getUpdate(updateId: string): Promise<FinanceUpdate> {
        return normalizeFinanceUpdate(unwrap(await services.getPersonalFinanceOrganizerUpdate({ updateId })));
    },
    async organize(update: FinanceUpdate, idempotencyKey: string): Promise<OrganizerMutation> {
        return mutation(unwrap(await services.organizePersonalFinanceUpdate(idempotencyRequest(update, idempotencyKey))));
    },
    async abandon(update: FinanceUpdate, idempotencyKey: string): Promise<OrganizerMutation> {
        return mutation(unwrap(await services.abandonPersonalFinanceOrganizerUpdate(idempotencyRequest(update, idempotencyKey))));
    },
    async listEvents(updateId: string, status?: EconomicEventStatus, limit = 100): Promise<EconomicEventPage> {
        return normalizeEventPage(unwrap(await services.listPersonalFinanceOrganizerEvents({ updateId, status, limit })));
    },
    async getEvidence(eventId: string): Promise<OrganizerEventEvidence> {
        return eventEvidence(unwrap(await services.getPersonalFinanceOrganizerEventEvidence({ eventId })));
    },
    async correctEvent(request: OrganizerCorrectRequest): Promise<OrganizerMutation> {
        return mutation(unwrap(await services.correctPersonalFinanceOrganizerEvent(request)));
    },
    async excludeEvent(update: FinanceUpdate, event: EconomicEvent, idempotencyKey: string): Promise<OrganizerMutation> {
        return mutation(unwrap(await services.excludePersonalFinanceOrganizerEvent({
            updateId: update.id, eventId: event.id, expectedUpdateVersion: update.version,
            expectedEventVersion: event.version, idempotencyKey
        })));
    },
    async listReviewIssues(updateId: string, status: ReviewIssueStatus = 'open', type?: ReviewIssueType, limit = 100): Promise<ReviewIssuePage> {
        const typeQuery = type ? `&type=${encodeURIComponent(type)}` : '';
        const response = await axios.get(`v1/personal_finance/review_issues/list.json?update_id=${encodeURIComponent(updateId)}&status=${encodeURIComponent(status)}&limit=${limit}${typeQuery}`);
        return reviewIssuePage(unwrap(response));
    },
    async getReviewIssue(issueId: string): Promise<ReviewIssueDetail> {
        return reviewIssueDetail(unwrap(await axios.get(`v1/personal_finance/review_issues/get.json?id=${encodeURIComponent(issueId)}`)));
    },
    async resolveReviewIssue(request: ResolveReviewIssueRequest): Promise<ReviewIssueMutation> {
        return reviewIssueMutation(unwrap(await axios.post('v1/personal_finance/review_issues/resolve.json', request)));
    },
    async postAllReady(update: FinanceUpdate, idempotencyKey: string): Promise<OrganizerMutation> {
        return mutation(unwrap(await services.postAllReadyPersonalFinanceOrganizerEvents(idempotencyRequest(update, idempotencyKey))));
    },
    async postReady(update: FinanceUpdate, idempotencyKey: string): Promise<OrganizerMutation> {
        return mutation(unwrap(await services.postReadyPersonalFinanceOrganizerEvents(idempotencyRequest(update, idempotencyKey))));
    },
    async getUndoImpact(updateId: string): Promise<OrganizerImpact> {
        return impact(unwrap(await services.getPersonalFinanceOrganizerUndoImpact({ updateId })));
    },
    async undo(update: FinanceUpdate, idempotencyKey: string): Promise<OrganizerMutation> {
        return mutation(unwrap(await services.undoPersonalFinanceOrganizerUpdate(idempotencyRequest(update, idempotencyKey))));
    }
};
