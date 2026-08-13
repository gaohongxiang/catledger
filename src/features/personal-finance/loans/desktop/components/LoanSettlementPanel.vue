<template>
    <v-card class="settlement-panel overflow-hidden" variant="outlined">
        <div class="d-flex flex-wrap align-center ga-3 px-5 py-4">
            <div>
                <div class="text-subtitle-1 font-weight-bold">{{ tt('personalFinance.loans.settlement.title') }}</div>
                <div class="text-body-small text-medium-emphasis" v-if="installment">
                    {{ tt('personalFinance.loans.settlement.installment', { number: installment.installmentNumber, date: installment.dueDate }) }}
                </div>
                <div class="text-body-small text-medium-emphasis" v-else>
                    {{ tt('personalFinance.loans.settlement.selectInstallment') }}
                </div>
            </div>
            <v-spacer />
            <v-chip color="success" size="small" variant="tonal" v-if="installment">
                {{ tt('personalFinance.loans.settlement.ready') }}
            </v-chip>
        </div>

        <v-divider />

        <div class="pa-5" v-if="installment">
            <v-alert class="mb-3" type="warning" variant="tonal">
                {{ tt('personalFinance.loans.boundary.combinedPaymentMustBeSplit') }}
            </v-alert>
            <v-alert class="mb-5" type="info" variant="tonal">
                {{ tt('personalFinance.loans.boundary.principalIsNotExpense') }}
            </v-alert>

            <section class="component-card mb-4" :key="component.type" v-for="component in outstandingComponents">
                <div class="component-heading px-4 py-3">
                    <div>
                        <div class="font-weight-bold">{{ tt(getLoanComponentTypeKey(component.type)) }}</div>
                        <div class="text-body-small text-medium-emphasis">
                            {{ tt('personalFinance.loans.settlement.outstanding', { amount: formatAmount(component.amount) }) }}
                        </div>
                    </div>
                    <v-spacer />
                    <v-btn
                        size="small"
                        variant="tonal"
                        :loading="loadingComponent === component.type"
                        :disabled="submitting"
                        @click="emit('loadCandidates', component.type)"
                    >
                        {{ tt('personalFinance.loans.settlement.findCandidates') }}
                    </v-btn>
                    <v-btn size="small" variant="text" :disabled="submitting" @click="emit('createDraft', component.type)">
                        {{ tt('personalFinance.loans.settlement.createLedgerDraft') }}
                    </v-btn>
                </div>

                <v-divider />

                <div class="candidate-list" v-if="candidateGroup(component.type)?.candidates.length">
                    <button
                        class="candidate-row"
                        type="button"
                        :class="{ selected: isSelectedCandidate(component.type, candidate.transactionId) }"
                        :disabled="!candidate.eligible || submitting"
                        :key="candidate.transactionId"
                        v-for="candidate in candidateGroup(component.type)?.candidates"
                        @click="emit('selectCandidate', component.type, candidate)"
                    >
                        <span class="candidate-icon">
                            <v-icon :icon="candidate.transactionType === 'transfer' ? mdiSwapHorizontal : mdiReceiptTextOutline" />
                        </span>
                        <span class="candidate-copy">
                            <strong>{{ formatAmount(candidate.amount) }}</strong>
                            <small>{{ candidate.transactionDate }} · {{ candidate.maskedSourceAccount }}</small>
                        </span>
                        <v-chip size="x-small" :color="candidate.eligible ? 'success' : 'warning'" variant="tonal">
                            {{ tt(candidate.eligible ? 'personalFinance.loans.settlement.candidateEligible' : 'personalFinance.loans.settlement.candidateReview') }}
                        </v-chip>
                    </button>
                </div>

                <div class="pa-4 text-body-small text-medium-emphasis" v-else>
                    {{ tt('personalFinance.loans.settlement.noCandidatesLoaded') }}
                </div>
            </section>

            <div class="selection-summary pa-4" v-if="components.length">
                <div class="font-weight-bold">{{ tt('personalFinance.loans.settlement.commandSummary') }}</div>
                <div class="d-flex flex-wrap ga-2 mt-3">
                    <v-chip :key="component.componentType" v-for="component in components" color="primary" variant="tonal">
                        {{ tt(getLoanComponentTypeKey(component.componentType)) }} · {{ formatAmount(component.allocatedAmount) }}
                    </v-chip>
                </div>
                <div class="text-body-small text-medium-emphasis mt-3">
                    {{ tt('personalFinance.loans.settlement.atomicHint') }}
                </div>
            </div>

            <div class="d-flex flex-wrap justify-end ga-2 mt-5">
                <v-btn variant="text" :disabled="submitting || !canInspectUndo" @click="emit('inspectUndo')">
                    {{ tt('personalFinance.loans.settlement.inspectUndo') }}
                </v-btn>
                <v-btn color="primary" :disabled="!components.length" :loading="submitting" @click="emit('apply')">
                    {{ tt('personalFinance.loans.settlement.apply') }}
                </v-btn>
            </div>

            <template v-if="undoImpact">
                <v-divider class="my-5" />
                <div class="undo-impact pa-4" :class="{ blocked: !undoImpact.canUndoRelationships }">
                    <div>
                        <div class="font-weight-bold">{{ tt('personalFinance.loans.settlement.undoImpact') }}</div>
                        <div class="text-body-small text-medium-emphasis mt-1">
                            {{ tt('personalFinance.loans.settlement.undoImpactCounts', {
                                allocations: undoImpact.activeAllocationCount,
                                transactions: undoImpact.affectedTransactionCount,
                                modified: undoImpact.modifiedTransactionCount + undoImpact.missingTransactionCount
                            }) }}
                        </div>
                    </div>
                    <v-spacer />
                    <v-btn
                        color="error"
                        variant="tonal"
                        :disabled="!undoImpact.canUndoRelationships || submitting"
                        @click="emit('undo', undoImpact.actionId)"
                    >
                        {{ tt('personalFinance.loans.settlement.undoRelationships') }}
                    </v-btn>
                </div>
                <div class="text-body-small text-medium-emphasis mt-2">
                    {{ tt('personalFinance.loans.settlement.undoKeepsTransactions') }}
                </div>
            </template>
        </div>

        <div class="empty-settlement pa-12 text-center" v-else>
            <v-icon color="medium-emphasis" size="54" :icon="mdiCallSplit" />
            <div class="text-h6 mt-4">{{ tt('personalFinance.loans.settlement.empty') }}</div>
            <div class="text-body-medium text-medium-emphasis mt-1">{{ tt('personalFinance.loans.settlement.emptyHint') }}</div>
        </div>
    </v-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { mdiCallSplit, mdiReceiptTextOutline, mdiSwapHorizontal } from '@mdi/js';

import { useI18n } from '@/locales/helpers.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';

import type {
    LoanComponentType,
    LoanInstallment,
    LoanSettlementCandidate,
    LoanSettlementCandidateGroup,
    LoanSettlementCandidatesResult,
    LoanSettlementComponent,
    LoanSettlementUndoImpact
} from '../../models.ts';
import { getLoanComponentTypeKey } from '../../presentation.ts';

interface OutstandingComponent {
    readonly type: Exclude<LoanComponentType, 'disbursement'>;
    readonly amount: number;
}

const props = withDefaults(defineProps<{
    installment?: LoanInstallment | null;
    currency: string;
    candidates?: LoanSettlementCandidatesResult | null;
    components?: LoanSettlementComponent[];
    undoImpact?: LoanSettlementUndoImpact | null;
    loadingComponent?: LoanComponentType;
    submitting?: boolean;
    canInspectUndo?: boolean;
}>(), {
    installment: null,
    candidates: null,
    components: () => [],
    undoImpact: null,
    loadingComponent: undefined,
    submitting: false,
    canInspectUndo: false
});

const emit = defineEmits<{
    (e: 'loadCandidates', componentType: LoanComponentType): void;
    (e: 'selectCandidate', componentType: LoanComponentType, candidate: LoanSettlementCandidate): void;
    (e: 'createDraft', componentType: LoanComponentType): void;
    (e: 'apply'): void;
    (e: 'inspectUndo'): void;
    (e: 'undo', actionId: string): void;
}>();

const { tt, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();

const outstandingComponents = computed<OutstandingComponent[]>(() => {
    if (!props.installment) {
        return [];
    }
    return [
        { type: 'principal' as const, amount: props.installment.progress.outstandingPrincipalAmount },
        { type: 'interest' as const, amount: props.installment.progress.outstandingInterestAmount },
        { type: 'fee' as const, amount: props.installment.progress.outstandingFeeAmount }
    ].filter(component => component.amount > 0);
});

function candidateGroup(componentType: LoanComponentType): LoanSettlementCandidateGroup | undefined {
    return props.candidates?.groups.find(group => group.componentType === componentType);
}

function isSelectedCandidate(componentType: LoanComponentType, transactionId: string): boolean {
    return props.components.some(component => component.componentType === componentType && component.existingTransactionId === transactionId);
}

function formatAmount(amount: number): string {
    return formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(amount), props.currency);
}
</script>

<style scoped>
.settlement-panel {
    min-height: 520px;
}

.component-card {
    overflow: hidden;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    border-radius: 14px;
}

.component-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
}

.candidate-list {
    display: grid;
}

.candidate-row {
    width: 100%;
    border: 0;
    border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 13px 16px;
    color: inherit;
    text-align: start;
    background: transparent;
    cursor: pointer;
}

.candidate-row:last-child {
    border-bottom: 0;
}

.candidate-row:hover:not(:disabled),
.candidate-row.selected {
    background: rgba(var(--v-theme-primary), 0.06);
}

.candidate-row:disabled {
    cursor: not-allowed;
    opacity: 0.68;
}

.candidate-icon {
    width: 38px;
    height: 38px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    color: rgb(var(--v-theme-primary));
    background: rgba(var(--v-theme-primary), 0.09);
}

.candidate-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
}

.candidate-copy small {
    overflow: hidden;
    color: rgba(var(--v-theme-on-surface), 0.62);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.selection-summary,
.undo-impact {
    border-radius: 12px;
    background: rgba(var(--v-theme-primary), 0.05);
}

.undo-impact {
    display: flex;
    align-items: center;
    gap: 16px;
}

.undo-impact.blocked {
    background: rgba(var(--v-theme-error), 0.05);
}

@media (max-width: 599px) {
    .candidate-row {
        grid-template-columns: auto minmax(0, 1fr);
    }

    .candidate-row .v-chip {
        grid-column: 2;
        justify-self: start;
    }

    .undo-impact {
        align-items: flex-start;
        flex-direction: column;
    }
}
</style>
