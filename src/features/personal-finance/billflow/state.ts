import type { PersonalFinanceBatchStatus, PersonalFinanceImportBatch } from '../models.ts';
import { suggestPaymentAccount, type PersonalFinanceLedgerAccountCandidate } from '../state.ts';
import type {
    BillflowAccountGroup,
    BillflowTask,
    BillflowTaskStatus,
    BillflowTaskSummary,
    BillflowTodoKind,
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

export function billflowDirectionKey(direction: string): string {
    if (direction === 'income' || direction === 'expense' || direction === 'neutral') {
        return `personalFinance.billflow.accounts.direction.${direction}`;
    }
    return 'personalFinance.billflow.accounts.direction.unknown';
}

export function mergeSelectedOrganizeFileIds(
    selected: readonly string[],
    previousEligible: readonly string[],
    nextEligible: readonly string[]
): string[] {
    const eligible = new Set(nextEligible);
    const previous = new Set(previousEligible);
    const nextSelected = selected.filter(id => eligible.has(id));
    for (const id of nextEligible) {
        if (!previous.has(id) && !nextSelected.includes(id)) {
            nextSelected.push(id);
        }
    }
    if (nextSelected.length === 0 && previousEligible.length === 0) {
        return [...nextEligible];
    }
    return nextSelected;
}

export function sameOrganizeFileIds(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    const counts = new Map<string, number>();
    for (const id of left) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const id of right) {
        const next = (counts.get(id) ?? 0) - 1;
        if (next < 0) {
            return false;
        }
        counts.set(id, next);
    }
    return true;
}

export function canEditOrganizeFiles(status?: BillflowTaskStatus): boolean {
    return status !== 'ready' && status !== 'processing';
}

export function canAutoRunAfterAccounts(status: BillflowTaskStatus, needsCreateCount: number): boolean {
    return needsCreateCount < 1 && (status === 'accounts_pending' || status === 'receiving');
}

export function canReapplyOrganize(status: BillflowTaskStatus, needsCreateCount: number): boolean {
    return needsCreateCount < 1 && (status === 'receiving' || status === 'awaiting_confirm' || status === 'ready');
}

export function rememberCreatedLedgerIds(
    previousReusedIds: readonly string[],
    nextReused: readonly Pick<BillflowAccountGroup, 'ledgerAccountId'>[],
    already: readonly string[]
): string[] {
    const previous = new Set(previousReusedIds);
    const next = new Set(already);
    for (const group of nextReused) {
        if (group.ledgerAccountId && !previous.has(group.ledgerAccountId)) {
            next.add(group.ledgerAccountId);
        }
    }
    return [...next];
}

export function createdAccountsNeedingBalance(input: {
    createdLedgerIds: readonly string[];
    reused: readonly Pick<BillflowAccountGroup, 'ledgerAccountId' | 'displayName' | 'currency'>[];
    answeredLedgerIds: readonly string[];
    reviewedLedgerIds: readonly string[];
}): { ledgerAccountId: string; displayName: string; currency: string }[] {
    const answered = new Set(input.answeredLedgerIds);
    const reviewed = new Set(input.reviewedLedgerIds);
    const names = new Map<string, { displayName: string; currency: string }>();
    for (const group of input.reused) {
        if (group.ledgerAccountId) {
            names.set(group.ledgerAccountId, { displayName: group.displayName, currency: group.currency });
        }
    }
    const items: { ledgerAccountId: string; displayName: string; currency: string }[] = [];
    for (const id of input.createdLedgerIds) {
        const item = names.get(id);
        if (!item || answered.has(id) || reviewed.has(id)) {
            continue;
        }
        items.push({ ledgerAccountId: id, displayName: item.displayName, currency: item.currency });
    }
    return items;
}

export const BILLFLOW_OPENING_BALANCE_UNIX_TIME = 946684800;

export type BillflowAccountBucket = 'pending' | 'reused' | 'excluded';

export const BILLFLOW_ACCOUNT_BUCKETS: readonly BillflowAccountBucket[] = ['pending', 'reused', 'excluded'];

export function suggestedAccountBucket(counts: { pending: number; reused: number; excluded: number }): BillflowAccountBucket {
    if (counts.pending > 0) {
        return 'pending';
    }
    if (counts.excluded > 0) {
        return 'excluded';
    }
    return 'reused';
}

export function resolveAccountBucket(
    current: BillflowAccountBucket | undefined,
    counts: { pending: number; reused: number; excluded: number },
    userPicked = false
): BillflowAccountBucket {
    if (userPicked && current && BILLFLOW_ACCOUNT_BUCKETS.includes(current)) {
        return current;
    }
    return suggestedAccountBucket(counts);
}

export function accountBucketHintKey(bucket: BillflowAccountBucket): string {
    if (bucket === 'reused') {
        return 'personalFinance.billflow.accounts.reusedHint';
    }
    if (bucket === 'excluded') {
        return 'personalFinance.billflow.accounts.excludedHint';
    }
    return 'personalFinance.billflow.accounts.pendingHint';
}

export type BillflowCategoryBucket = 'pending' | 'classified';

export const BILLFLOW_CATEGORY_BUCKETS: readonly BillflowCategoryBucket[] = ['pending', 'classified'];
export const BILLFLOW_TODO_PAGE_LIMIT = 100;
export const BILLFLOW_TODO_MAX_PAGES = 50;

export function chunkBillflowItems<T>(items: readonly T[], size = BILLFLOW_TODO_PAGE_LIMIT): T[][] {
    if (size < 1) {
        return items.length ? [ [...items] ] : [];
    }
    const pages: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
        pages.push([...items.slice(index, index + size)]);
    }
    return pages;
}

export function suggestedCategoryBucket(counts: { pending: number; classified: number }): BillflowCategoryBucket {
    return counts.pending > 0 ? 'pending' : 'classified';
}

export function resolveCategoryBucket(
    current: BillflowCategoryBucket | undefined,
    counts: { pending: number; classified: number },
    userPicked = false
): BillflowCategoryBucket {
    if (userPicked && current && BILLFLOW_CATEGORY_BUCKETS.includes(current)) {
        return current;
    }
    return suggestedCategoryBucket(counts);
}

export function categoryBucketHintKey(bucket: BillflowCategoryBucket): string {
    return bucket === 'classified'
        ? 'personalFinance.billflow.todos.classifiedHint'
        : 'personalFinance.billflow.todos.pendingHint';
}

export type BillflowMergeBucket = 'pending' | 'merged';

export const BILLFLOW_MERGE_BUCKETS: readonly BillflowMergeBucket[] = ['pending', 'merged'];

export function suggestedMergeBucket(counts: { pending: number; merged: number }): BillflowMergeBucket {
    return counts.pending > 0 ? 'pending' : 'merged';
}

export function resolveMergeBucket(
    current: BillflowMergeBucket | undefined,
    counts: { pending: number; merged: number },
    userPicked = false
): BillflowMergeBucket {
    if (userPicked && current && BILLFLOW_MERGE_BUCKETS.includes(current)) {
        return current;
    }
    return suggestedMergeBucket(counts);
}

export function mergeBucketHintKey(bucket: BillflowMergeBucket): string {
    return bucket === 'merged'
        ? 'personalFinance.billflow.merge.mergedHint'
        : 'personalFinance.billflow.merge.pendingHint';
}

export type BillflowReviewPane = 'merge' | 'category';

export const BILLFLOW_REVIEW_PANES: readonly BillflowReviewPane[] = ['merge', 'category'];

export function suggestedReviewPane(input: { awaitingRun: boolean; mergePending: number; categoryPending: number }): BillflowReviewPane {
    if (input.awaitingRun || input.mergePending > 0) {
        return 'merge';
    }
    return 'category';
}

export function resolveReviewPane(
    current: BillflowReviewPane | undefined,
    input: { awaitingRun: boolean; mergePending: number; categoryPending: number },
    userPicked = false
): BillflowReviewPane {
    if (userPicked && current && BILLFLOW_REVIEW_PANES.includes(current)) {
        return current;
    }
    return suggestedReviewPane(input);
}

export function reviewPaneHintKey(pane: BillflowReviewPane): string {
    return pane === 'category'
        ? 'personalFinance.billflow.reviewHint'
        : 'personalFinance.billflow.mergeHint';
}

export type BillflowWorkbenchStep = 'files' | 'accounts' | 'review' | 'others' | 'confirm';

export const BILLFLOW_WORKBENCH_STEPS: readonly BillflowWorkbenchStep[] = ['files', 'accounts', 'review', 'others', 'confirm'];

export type BillflowWorkbenchInput = {
    hasTask: boolean;
    status?: BillflowTaskStatus;
    needsCreateCount: number;
    needsBalanceCount: number;
};

export function accountGroupHasCardHeader(group: Pick<BillflowAccountGroup, 'statementDate' | 'dueDate' | 'creditLimitAmount'>): boolean {
    return !!group.statementDate || !!group.dueDate || !!group.creditLimitAmount;
}

export function shouldOpenBalanceStep(input: Pick<BillflowWorkbenchInput, 'needsBalanceCount'>): boolean {
    return input.needsBalanceCount > 0;
}

export function isMergeTodo(kind: BillflowTodoKind): boolean {
    return kind === 'cross_source_ambiguous';
}

export function isInstallmentTodo(kind: BillflowTodoKind): boolean {
    return kind === 'installment_candidate';
}

export function isCategoryTodo(kind: BillflowTodoKind): boolean {
    return kind === 'uncategorized' || kind === 'transfer_unclear';
}

export function canAssignBillflowCategory(kind: BillflowTodoKind): boolean {
    return isCategoryTodo(kind);
}

export function mergeTodos<T extends { todoKind: BillflowTodoKind }>(todos: readonly T[]): T[] {
    return todos.filter(todo => isMergeTodo(todo.todoKind));
}

export function categoryTodos<T extends { todoKind: BillflowTodoKind }>(todos: readonly T[]): T[] {
    return todos.filter(todo => isCategoryTodo(todo.todoKind));
}

export function installmentTodos<T extends { todoKind: BillflowTodoKind }>(todos: readonly T[]): T[] {
    return todos.filter(todo => isInstallmentTodo(todo.todoKind));
}

export function otherTodos<T extends { todoKind: BillflowTodoKind }>(todos: readonly T[]): T[] {
    return todos.filter(todo => !isMergeTodo(todo.todoKind) && !isCategoryTodo(todo.todoKind));
}

export function billflowWorkbenchStepIndex(step: BillflowWorkbenchStep): number {
    return BILLFLOW_WORKBENCH_STEPS.indexOf(step);
}

export function accountsReadyForNextStep(input: Pick<BillflowWorkbenchInput, 'hasTask' | 'status' | 'needsCreateCount'>): boolean {
    return input.hasTask && !taskNeedsAccounts(input.status ?? 'receiving', input.needsCreateCount);
}

export function suggestedBillflowWorkbenchStep(input: BillflowWorkbenchInput): BillflowWorkbenchStep {
    if (!input.hasTask) {
        return 'files';
    }
    const status = input.status ?? 'receiving';
    if (status === 'processing' || taskNeedsAccounts(status, input.needsCreateCount)) {
        return 'accounts';
    }
    if (canAutoRunAfterAccounts(status, input.needsCreateCount)) {
        return 'accounts';
    }
    if (taskAwaitsConfirm(status)) {
        return 'review';
    }
    return 'confirm';
}

export function canOpenBillflowWorkbenchStep(step: BillflowWorkbenchStep, input: BillflowWorkbenchInput): boolean {
    if (!input.hasTask) {
        return step === 'files';
    }
    if (step === 'review') {
        return accountsReadyForNextStep(input);
    }
    if (step === 'others' || step === 'confirm') {
        if (input.status === 'ready' || input.status === 'failed') {
            return true;
        }
        return input.status === 'awaiting_confirm' && accountsReadyForNextStep(input);
    }
    return billflowWorkbenchStepIndex(step) <= billflowWorkbenchStepIndex(suggestedBillflowWorkbenchStep(input));
}

export function previousBillflowWorkbenchStep(step: BillflowWorkbenchStep): BillflowWorkbenchStep | undefined {
    const index = billflowWorkbenchStepIndex(step);
    return index > 0 ? BILLFLOW_WORKBENCH_STEPS[index - 1] : undefined;
}

export function nextBillflowWorkbenchStep(step: BillflowWorkbenchStep): BillflowWorkbenchStep | undefined {
    const index = billflowWorkbenchStepIndex(step);
    return index >= 0 && index < BILLFLOW_WORKBENCH_STEPS.length - 1 ? BILLFLOW_WORKBENCH_STEPS[index + 1] : undefined;
}

export function resolveBillflowWorkbenchStep(
    userStep: BillflowWorkbenchStep | undefined,
    input: BillflowWorkbenchInput
): BillflowWorkbenchStep {
    const suggested = suggestedBillflowWorkbenchStep(input);
    if (!userStep || !canOpenBillflowWorkbenchStep(userStep, input)) {
        return suggested;
    }
    return userStep;
}

function pushHeadline(items: DashboardHeadlineItem[], code: DashboardHeadlineCode, count: number): void {
    if (!Number.isSafeInteger(count) || count < 1) {
        return;
    }
    items.push({ code, count });
}
