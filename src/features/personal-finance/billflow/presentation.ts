import type { BillflowTodoKind } from './models.ts';

export function todoKindKey(kind: BillflowTodoKind): string {
    return `personalFinance.billflow.todo.${kind}`;
}
