import type { PersonalFinanceBatchStatus, PersonalFinanceImportBatch } from '../models.ts';
import { suggestPaymentAccount, type PersonalFinanceLedgerAccountCandidate } from '../state.ts';
import type {
    BillflowAccountGroup,
    BillflowTask,
    BillflowTaskStatus,
    BillflowTaskSummary,
    DashboardHeadlineCode,
    DashboardHeadlineItem
} from './models.ts';

export const BILLFLOW_SUCCESSFUL_BATCH_STATUSES: readonly PersonalFinanceBatchStatus[] = [
    'ready',
    'partially_posted',
    'completed'
];

const CREDIT_CARD_CATEGORY = 3;
const VIRTUAL_ACCOUNT_CATEGORY = 4;

export function isSuccessfulOrganizeBatch(status: PersonalFinanceBatchStatus): boolean {
    return BILLFLOW_SUCCESSFUL_BATCH_STATUSES.includes(status);
}

export function eligibleOrganizeFileIds(batches: readonly PersonalFinanceImportBatch[]): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const batch of batches) {
        if (!isSuccessfulOrganizeBatch(batch.status) || seen.has(batch.fileId)) {
            continue;
        }
        seen.add(batch.fileId);
        ids.push(batch.fileId);
    }
    return ids;
}

export function summarizeTask(task: Pick<BillflowTask, 'createdAccountCount' | 'reusedMappingCount' | 'autoPostedCount' | 'todoOpenCount'>): BillflowTaskSummary {
    return {
        createdAccountCount: task.createdAccountCount,
        reusedMappingCount: task.reusedMappingCount,
        autoPostedCount: task.autoPostedCount,
        todoOpenCount: task.todoOpenCount
    };
}

export function taskNeedsAccounts(status: BillflowTaskStatus, needsCreateCount: number): boolean {
    return status === 'accounts_pending' || needsCreateCount > 0;
}

export function taskAwaitsConfirm(status: BillflowTaskStatus): boolean {
    return status === 'awaiting_confirm';
}

export function taskShowsTodos(status: BillflowTaskStatus): boolean {
    return status === 'ready' || status === 'awaiting_confirm';
}

export function suggestedAccountCategory(suggestedType: BillflowAccountGroup['suggestedType']): number {
    return suggestedType === 'credit_card' ? CREDIT_CARD_CATEGORY : VIRTUAL_ACCOUNT_CATEGORY;
}

export function matchedLedgerAccount(
    group: Pick<BillflowAccountGroup, 'sourceType' | 'currency' | 'displayName'>,
    accounts: readonly PersonalFinanceLedgerAccountCandidate[]
): PersonalFinanceLedgerAccountCandidate | undefined {
    const suggestion = suggestPaymentAccount({
        sourceType: group.sourceType,
        currency: group.currency,
        displayName: group.displayName,
        rowCount: 0,
        pendingRowCount: 0,
        sampleRowId: '1',
        mapped: false
    }, [...accounts]);
    if (!suggestion.ledgerAccountId) {
        return undefined;
    }
    return accounts.find(account => account.id === suggestion.ledgerAccountId && account.currency === group.currency && !account.hidden);
}

export function composeDashboardHeadline(input: {
    coverageComplete: boolean;
    accountsWithGaps: number;
    uncategorizedCount: number;
    todoOpenCount: number;
    balanceUnverifiedCount: number;
}): DashboardHeadlineItem[] {
    const items: DashboardHeadlineItem[] = [];
    pushHeadline(items, 'provisional_month', input.coverageComplete ? 0 : Math.max(input.accountsWithGaps, 1));
    pushHeadline(items, 'uncategorized_count', input.uncategorizedCount);
    pushHeadline(items, 'todo_open_count', input.todoOpenCount);
    pushHeadline(items, 'balance_unverified_count', input.balanceUnverifiedCount);
    return items;
}

export function primaryDashboardHeadline(items: readonly DashboardHeadlineItem[]): DashboardHeadlineCode | 'ready' {
    return items[0]?.code ?? 'ready';
}

export function nearestNextPayment<T extends { nextDueDate?: string; nextDueAmount: string; name: string; currency: string }>(
    contracts: readonly T[]
): T | undefined {
    const dated = contracts.filter(contract => typeof contract.nextDueDate === 'string' && contract.nextDueDate.length === 10);
    dated.sort((left, right) => (left.nextDueDate ?? '').localeCompare(right.nextDueDate ?? ''));
    return dated[0];
}

function pushHeadline(items: DashboardHeadlineItem[], code: DashboardHeadlineCode, count: number): void {
    if (!Number.isSafeInteger(count) || count < 1) {
        return;
    }
    items.push({ code, count });
}
