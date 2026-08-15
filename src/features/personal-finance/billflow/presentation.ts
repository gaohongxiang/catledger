import type { BillflowTodoKind } from './models.ts';

const TODO_REASON_KEYS = new Set<string>([
    'unresolved_payment_account',
    'identity_conflict',
    'core_field_conflict',
    'ledger_mismatch',
    'cross_source_ambiguous',
    'transfer_unclear',
    'refund_unclear',
    'repayment_unclear',
    'installment_candidate',
    'uncategorized'
]);

export function todoKindKey(kind: BillflowTodoKind): string {
    return `personalFinance.billflow.todo.${kind}`;
}

export function todoReasonKey(code: string): string | undefined {
    if (!TODO_REASON_KEYS.has(code)) {
        return undefined;
    }
    return `personalFinance.billflow.todo.${code}`;
}
