<template>
    <v-row class="match-height">
        <v-col cols="12">
            <v-card class="reconciliation-workbench overflow-hidden">
                <div class="reconciliation-hero pa-6 pa-lg-8">
                    <div class="d-flex flex-wrap align-center ga-4">
                        <div class="hero-copy">
                            <div class="text-overline text-primary">{{ tt('personalFinance.reconciliation.eyebrow') }}</div>
                            <h2 class="text-h4 font-weight-bold mt-1">{{ tt('personalFinance.reconciliation.title') }}</h2>
                            <p class="text-body-large text-medium-emphasis mt-2 mb-0">
                                {{ tt('personalFinance.reconciliation.subtitle') }}
                            </p>
                        </div>
                        <v-spacer />
                        <div class="anchor-control d-flex flex-wrap align-center ga-2">
                            <v-select
                                density="comfortable"
                                hide-details
                                item-title="title"
                                item-value="value"
                                min-width="270"
                                variant="outlined"
                                :items="anchorBatchItems"
                                :label="tt('personalFinance.reconciliation.anchorBatch')"
                                v-model="anchorBatchId"
                            />
                            <v-btn
                                color="primary"
                                size="large"
                                :disabled="!anchorBatchId"
                                :loading="reconciliationStore.submitting"
                                :prepend-icon="mdiAutoFix"
                                @click="generateCandidates"
                            >
                                {{ tt('personalFinance.reconciliation.generate') }}
                            </v-btn>
                        </div>
                    </div>
                </div>

                <v-divider />

                <div class="summary-strip px-5 py-4">
                    <div class="summary-item">
                        <span class="summary-value text-primary">{{ reconciliationStore.pendingCaseCount }}</span>
                        <span class="text-body-small text-medium-emphasis">{{ tt('personalFinance.reconciliation.pending') }}</span>
                    </div>
                    <v-divider vertical />
                    <div class="summary-item">
                        <span class="summary-value">{{ reconciliationStore.totalCaseCount }}</span>
                        <span class="text-body-small text-medium-emphasis">{{ tt('personalFinance.reconciliation.total') }}</span>
                    </div>
                    <v-spacer />
                    <v-btn
                        color="secondary"
                        variant="text"
                        :icon="mdiRefresh"
                        :loading="reconciliationStore.loadingCases"
                        @click="reload"
                    >
                        <v-tooltip activator="parent">{{ tt('Refresh') }}</v-tooltip>
                    </v-btn>
                </div>

                <v-divider />

                <v-row class="ma-0">
                    <v-col cols="12" lg="4" class="case-column pa-0">
                        <div class="filter-bar px-4 py-3">
                            <v-btn-toggle
                                class="status-filter"
                                color="primary"
                                density="compact"
                                divided
                                mandatory
                                variant="outlined"
                                v-model="statusFilter"
                            >
                                <v-btn value="all">{{ tt('personalFinance.reconciliation.filter.all') }}</v-btn>
                                <v-btn value="open">{{ tt('personalFinance.reconciliation.filter.pending') }}</v-btn>
                                <v-btn value="action_required">{{ tt('personalFinance.reconciliation.filter.action') }}</v-btn>
                                <v-btn value="resolved">{{ tt('personalFinance.reconciliation.filter.resolved') }}</v-btn>
                            </v-btn-toggle>
                        </div>

                        <v-divider />

                        <v-skeleton-loader type="list-item-three-line@4" v-if="reconciliationStore.loadingCases && !reconciliationStore.cases.length" />

                        <v-list class="case-list pa-0" lines="three" v-else-if="reconciliationStore.cases.length">
                            <template :key="reconciliationCase.id" v-for="(reconciliationCase, index) in reconciliationStore.cases">
                                <v-list-item
                                    class="case-item px-5 py-4"
                                    color="primary"
                                    :active="reconciliationStore.selectedCase?.id === reconciliationCase.id"
                                    @click="openCase(reconciliationCase.id)"
                                >
                                    <template #prepend>
                                        <div class="score-ring" :class="`score-${getScoreBand(reconciliationCase.candidateScore)}`">
                                            <strong>{{ reconciliationCase.candidateScore }}</strong>
                                            <small>{{ tt('personalFinance.reconciliation.score') }}</small>
                                        </div>
                                    </template>
                                    <v-list-item-title class="font-weight-medium">
                                        {{ tt(getReconciliationDecisionTypeKey(reconciliationCase.suggestedRelationType)) }}
                                    </v-list-item-title>
                                    <v-list-item-subtitle class="mt-1">
                                        <v-chip size="x-small" :color="getReconciliationCaseStatusColor(reconciliationCase.status)" variant="tonal">
                                            {{ tt(getReconciliationCaseStatusKey(reconciliationCase.status)) }}
                                        </v-chip>
                                        <span class="ms-2">{{ formatTime(reconciliationCase.updatedUnixTime) }}</span>
                                    </v-list-item-subtitle>
                                    <v-list-item-subtitle class="mt-1 reason-preview">
                                        {{ firstReasonText(reconciliationCase.reasonCodes) }}
                                    </v-list-item-subtitle>
                                </v-list-item>
                                <v-divider v-if="index < reconciliationStore.cases.length - 1" />
                            </template>
                        </v-list>

                        <div class="empty-state pa-10 text-center" v-else>
                            <v-icon color="medium-emphasis" size="52" :icon="mdiFileSearchOutline" />
                            <div class="text-h6 mt-4">{{ tt('personalFinance.reconciliation.noCases') }}</div>
                            <div class="text-body-medium text-medium-emphasis mt-1">{{ tt('personalFinance.reconciliation.noCasesHint') }}</div>
                        </div>

                        <v-pagination
                            class="my-3"
                            density="comfortable"
                            :length="casePageCount"
                            v-if="casePageCount > 1"
                            v-model="casePage"
                        />
                    </v-col>

                    <v-divider vertical class="d-none d-lg-block" />

                    <v-col cols="12" lg="8" class="detail-column pa-0">
                        <v-skeleton-loader class="pa-6" type="heading, paragraph, image, paragraph" v-if="reconciliationStore.loadingDetail && !reconciliationStore.selectedCase" />

                        <div class="empty-state pa-12 text-center" v-else-if="!reconciliationStore.selectedCase">
                            <v-icon color="medium-emphasis" size="58" :icon="mdiInformationOutline" />
                            <div class="text-h6 mt-4">{{ tt('personalFinance.reconciliation.selectCase') }}</div>
                            <div class="text-body-medium text-medium-emphasis mt-1">{{ tt('personalFinance.reconciliation.selectCaseHint') }}</div>
                        </div>

                        <template v-else>
                            <div class="detail-header pa-5 pa-lg-6">
                                <div class="d-flex flex-wrap align-start ga-3">
                                    <div>
                                        <div class="d-flex flex-wrap align-center ga-2">
                                            <h3 class="text-h5 font-weight-bold">{{ tt('personalFinance.reconciliation.caseTitle') }}</h3>
                                            <v-chip size="small" :color="getReconciliationCaseStatusColor(reconciliationStore.selectedCase.status)" variant="tonal">
                                                {{ tt(getReconciliationCaseStatusKey(reconciliationStore.selectedCase.status)) }}
                                            </v-chip>
                                        </div>
                                        <div class="text-body-small text-medium-emphasis mt-1">
                                            {{ tt('personalFinance.reconciliation.version', { version: reconciliationStore.selectedCase.version }) }} ·
                                            {{ tt('personalFinance.reconciliation.lastEvaluated', { time: formatTime(reconciliationStore.selectedCase.lastEvaluatedUnixTime) }) }}
                                        </div>
                                    </div>
                                    <v-spacer />
                                    <v-btn
                                        variant="tonal"
                                        :disabled="!canInspectUndo || reconciliationStore.submitting"
                                        :prepend-icon="mdiBackupRestore"
                                        @click="inspectUndo"
                                    >
                                        {{ tt('personalFinance.reconciliation.undo.inspect') }}
                                    </v-btn>
                                </div>

                                <div class="reason-panel mt-5 pa-4 rounded-lg">
                                    <div class="d-flex align-center ga-2">
                                        <v-icon color="primary" :icon="mdiInformationOutline" />
                                        <span class="font-weight-bold">{{ tt('personalFinance.reconciliation.whyMatched') }}</span>
                                        <v-chip class="ms-auto" size="small" color="primary" variant="outlined">
                                            {{ tt('personalFinance.reconciliation.scoreValue', { score: reconciliationStore.selectedCase.candidateScore }) }}
                                        </v-chip>
                                    </div>
                                    <div class="reason-grid mt-3">
                                        <div class="reason-item" :key="`${reason.code}-${index}`" v-for="(reason, index) in reconciliationStore.selectedCase.reasonCodes">
                                            {{ reasonText(reason) }}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <v-divider />

                            <div class="evidence-section pa-5 pa-lg-6">
                                <div class="section-heading">
                                    <div class="text-subtitle-1 font-weight-bold">{{ tt('personalFinance.reconciliation.evidenceTitle') }}</div>
                                    <div class="text-body-small text-medium-emphasis">{{ tt('personalFinance.reconciliation.evidencePrivacy') }}</div>
                                </div>

                                <div class="evidence-grid mt-4">
                                    <article class="evidence-card pa-5" :key="`${member.order}-${index}`" v-for="(member, index) in reconciliationStore.selectedCase.members">
                                        <div class="d-flex align-center ga-3">
                                            <v-avatar color="primary" variant="tonal">
                                                <v-icon :icon="getSourceIcon(member.sourceType)" />
                                            </v-avatar>
                                            <div>
                                                <div class="font-weight-bold">{{ tt(getSourceTypeKey(member.sourceType)) }}</div>
                                                <div class="text-body-small text-medium-emphasis">
                                                    {{ member.sourceDisplayName || tt('personalFinance.reconciliation.maskedSource') }}
                                                </div>
                                            </div>
                                        </div>
                                        <div class="evidence-amount mt-5">{{ formatAmount(member.normalizedAmount, member.currency) }}</div>
                                        <div class="text-body-small text-medium-emphasis mt-1">
                                            {{ tt(`personalFinance.reconciliation.direction.${member.normalizedDirection}`) }} · {{ formatTime(member.normalizedUnixTime) }}
                                        </div>
                                        <v-divider class="my-4" />
                                        <dl class="evidence-fields">
                                            <div>
                                                <dt>{{ tt('personalFinance.reconciliation.counterparty') }}</dt>
                                                <dd>{{ member.counterparty || tt('Unknown') }}</dd>
                                            </div>
                                            <div>
                                                <dt>{{ tt('personalFinance.reconciliation.item') }}</dt>
                                                <dd>{{ member.item || tt('Unknown') }}</dd>
                                            </div>
                                            <div>
                                                <dt>{{ tt('personalFinance.reconciliation.paymentMethod') }}</dt>
                                                <dd>{{ member.paymentMethod || tt('Unknown') }}</dd>
                                            </div>
                                        </dl>
                                    </article>
                                </div>
                            </div>

                            <v-divider />

                            <div class="decision-section pa-5 pa-lg-6">
                                <div class="section-heading">
                                    <div class="text-subtitle-1 font-weight-bold">{{ tt('personalFinance.reconciliation.decisionTitle') }}</div>
                                    <div class="text-body-small text-medium-emphasis">{{ tt('personalFinance.reconciliation.decisionHint') }}</div>
                                </div>

                                <v-alert class="mt-4" type="success" variant="tonal" v-if="reconciliationStore.selectedCase.currentDecision">
                                    {{ tt('personalFinance.reconciliation.currentDecision', {
                                        decision: tt(getReconciliationDecisionTypeKey(reconciliationStore.selectedCase.currentDecision.decisionType))
                                    }) }}
                                </v-alert>

                                <v-radio-group class="decision-options mt-3" hide-details v-model="selectedDecision" v-if="canDecide">
                                    <div class="decision-option" :key="decisionType" v-for="decisionType in reconciliationDecisionTypes">
                                        <v-radio :value="decisionType">
                                            <template #label>
                                                <div>
                                                    <div class="font-weight-medium">{{ tt(getReconciliationDecisionTypeKey(decisionType)) }}</div>
                                                    <div class="text-body-small text-medium-emphasis">{{ tt(`personalFinance.reconciliation.decisionHintByType.${decisionType}`) }}</div>
                                                </div>
                                            </template>
                                        </v-radio>
                                    </div>
                                </v-radio-group>

                                <div class="d-flex justify-end mt-4" v-if="canDecide">
                                    <v-btn color="primary" :disabled="!selectedDecision" :loading="reconciliationStore.submitting" @click="showDecisionDialog = true">
                                        {{ tt('personalFinance.reconciliation.confirmDecision') }}
                                    </v-btn>
                                </div>
                            </div>
                        </template>
                    </v-col>
                </v-row>
            </v-card>
        </v-col>
    </v-row>

    <v-dialog width="560" v-model="showDecisionDialog">
        <v-card>
            <v-card-title class="pa-5">{{ tt('personalFinance.reconciliation.confirm.title') }}</v-card-title>
            <v-card-text class="px-5 pb-5">
                <p class="mb-3">{{ tt('personalFinance.reconciliation.confirm.message', {
                    decision: selectedDecision ? tt(getReconciliationDecisionTypeKey(selectedDecision)) : ''
                }) }}</p>
                <v-alert type="info" variant="tonal">{{ tt('personalFinance.reconciliation.confirm.versionNotice') }}</v-alert>
            </v-card-text>
            <v-card-actions class="px-5 pb-5">
                <v-spacer />
                <v-btn variant="text" @click="showDecisionDialog = false">{{ tt('Cancel') }}</v-btn>
                <v-btn color="primary" :loading="reconciliationStore.submitting" @click="submitDecision">
                    {{ tt('Confirm') }}
                </v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>

    <v-dialog width="640" v-model="showUndoDialog">
        <v-card>
            <v-card-title class="pa-5">{{ tt('personalFinance.reconciliation.undo.title') }}</v-card-title>
            <v-card-text class="px-5 pb-5">
                <v-progress-linear indeterminate v-if="loadingUndoImpact" />
                <template v-else-if="undoImpact">
                    <v-alert :type="undoImpact.automaticUndoAllowed ? 'warning' : 'error'" variant="tonal">
                        {{ tt(undoImpact.automaticUndoAllowed
                            ? 'personalFinance.reconciliation.undo.allowed'
                            : 'personalFinance.reconciliation.undo.actionRequired') }}
                    </v-alert>
                    <v-row class="mt-3">
                        <v-col cols="6" sm="4" :key="metric.label" v-for="metric in undoMetrics">
                            <div class="undo-metric pa-3 rounded-lg">
                                <div class="text-h6 font-weight-bold">{{ metric.value }}</div>
                                <div class="text-body-small text-medium-emphasis">{{ tt(metric.label) }}</div>
                            </div>
                        </v-col>
                    </v-row>
                    <div class="mt-4" v-if="undoImpact.reasonCodes.length">
                        <div class="font-weight-medium">{{ tt('personalFinance.reconciliation.undo.reasons') }}</div>
                        <div class="reason-grid mt-2">
                            <div class="reason-item" :key="`${reason.code}-${index}`" v-for="(reason, index) in undoImpact.reasonCodes">
                                {{ reasonText(reason) }}
                            </div>
                        </div>
                    </div>
                </template>
            </v-card-text>
            <v-card-actions class="px-5 pb-5">
                <v-spacer />
                <v-btn variant="text" @click="showUndoDialog = false">{{ tt('Cancel') }}</v-btn>
                <v-btn
                    color="error"
                    :disabled="!undoImpact"
                    :loading="reconciliationStore.submitting"
                    @click="submitUndo"
                >
                    {{ tt(undoImpact?.automaticUndoAllowed
                        ? 'personalFinance.reconciliation.undo.confirm'
                        : 'personalFinance.reconciliation.undo.confirmActionRequired') }}
                </v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>

    <snack-bar ref="snackbar" />
</template>

<script setup lang="ts">
import SnackBar from '@/components/desktop/SnackBar.vue';

import { computed, onMounted, ref, useTemplateRef, watch } from 'vue';

import { useI18n } from '@/locales/helpers.ts';
import { parseDateTimeFromUnixTimeWithBrowserTimezone } from '@/lib/datetime.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';

import { usePersonalFinanceStore } from '../../store.ts';
import { getSourceTypeKey } from '../../presentation.ts';
import type { PersonalFinanceSourceType } from '../../models.ts';
import type {
    ReconciliationDecisionType,
    ReconciliationReason,
    ReconciliationUndoImpact
} from '../models.ts';
import {
    getReconciliationCaseStatusColor,
    getReconciliationCaseStatusKey,
    getReconciliationDecisionTypeKey,
    getReconciliationReasonKey
} from '../presentation.ts';
import {
    canDecideReconciliationCase,
    canInspectReconciliationUndo,
    reconciliationDecisionTypes
} from '../state.ts';
import { useReconciliationStore } from '../store.ts';

import {
    mdiAutoFix,
    mdiBackupRestore,
    mdiBankOutline,
    mdiChatOutline,
    mdiFileSearchOutline,
    mdiInformationOutline,
    mdiRefresh,
    mdiWalletOutline
} from '@mdi/js';

type SnackBarType = InstanceType<typeof SnackBar>;
type StatusFilter = 'all' | 'open' | 'action_required' | 'resolved';

const CASE_PAGE_SIZE = 20;

const { tt, formatDateTimeToShortDateTime, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
const personalFinanceStore = usePersonalFinanceStore();
const reconciliationStore = useReconciliationStore();
const snackbar = useTemplateRef<SnackBarType>('snackbar');

const anchorBatchId = ref<string>('');
const casePage = ref<number>(1);
const statusFilter = ref<StatusFilter>('all');
const selectedDecision = ref<ReconciliationDecisionType | null>(null);
const showDecisionDialog = ref<boolean>(false);
const showUndoDialog = ref<boolean>(false);
const loadingUndoImpact = ref<boolean>(false);
const undoImpact = ref<ReconciliationUndoImpact | null>(null);

const anchorBatchItems = computed(() => personalFinanceStore.batches
    .filter(batch => !!batch.sourceAccountId && batch.status !== 'receiving' && batch.status !== 'parsing' &&
        batch.status !== 'awaiting_source_account' && batch.status !== 'failed' && batch.status !== 'discarded')
    .map(batch => ({
        value: batch.id,
        title: `${tt(getSourceTypeKey(batch.sourceType))} · ${formatTime(batch.createdUnixTime)}`
    })));
const casePageCount = computed<number>(() => Math.max(1, Math.ceil(reconciliationStore.totalCaseCount / CASE_PAGE_SIZE)));
const canDecide = computed<boolean>(() => canDecideReconciliationCase(reconciliationStore.selectedCase));
const canInspectUndo = computed<boolean>(() => canInspectReconciliationUndo(reconciliationStore.selectedCase));
const undoMetrics = computed(() => undoImpact.value ? [
    { label: 'personalFinance.reconciliation.undo.metric.affected', value: undoImpact.value.affectedTransactionCount },
    { label: 'personalFinance.reconciliation.undo.metric.created', value: undoImpact.value.createdTransactionCount },
    { label: 'personalFinance.reconciliation.undo.metric.attached', value: undoImpact.value.attachedExistingTransactionCount },
    { label: 'personalFinance.reconciliation.undo.metric.modified', value: undoImpact.value.modifiedTransactionCount },
    { label: 'personalFinance.reconciliation.undo.metric.missing', value: undoImpact.value.missingTransactionCount },
    { label: 'personalFinance.reconciliation.undo.metric.shared', value: undoImpact.value.sharedDependencyCount }
] : []);

function formatTime(unixTime?: number): string {
    return unixTime
        ? formatDateTimeToShortDateTime(parseDateTimeFromUnixTimeWithBrowserTimezone(unixTime))
        : tt('Unknown');
}

function formatAmount(amount?: string, currency?: string): string {
    return amount && currency
        ? formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(amount), currency)
        : tt('Unknown');
}

function reasonText(reason: ReconciliationReason): string {
    const key = getReconciliationReasonKey(reason.code);
    return key.endsWith('.unknown')
        ? tt(key, { code: reason.code })
        : tt(key, { value: reason.value ?? 0 });
}

function firstReasonText(reasons: ReconciliationReason[]): string {
    return reasons[0] ? reasonText(reasons[0]) : tt('personalFinance.reconciliation.noReason');
}

function getSourceIcon(sourceType: PersonalFinanceSourceType): string {
    if (sourceType === 'alipay') {
        return mdiWalletOutline;
    }
    return sourceType === 'wechat' ? mdiChatOutline : mdiBankOutline;
}

function getScoreBand(score: number): string {
    if (score >= 80) {
        return 'high';
    }
    if (score >= 55) {
        return 'medium';
    }
    return 'low';
}

async function loadCases(openFirst = false): Promise<void> {
    try {
        await reconciliationStore.loadCases({
            status: statusFilter.value === 'all' ? undefined : statusFilter.value,
            page: casePage.value - 1,
            count: CASE_PAGE_SIZE
        });
        const selectedStillVisible = reconciliationStore.cases.some(item => item.id === reconciliationStore.selectedCase?.id);
        if ((openFirst || !selectedStillVisible) && reconciliationStore.cases[0]) {
            await reconciliationStore.openCase(reconciliationStore.cases[0].id);
        } else if (!reconciliationStore.cases.length) {
            reconciliationStore.clearSelection();
        }
    } catch {
        snackbar.value?.showMessage('personalFinance.reconciliation.error.operationFailed');
    }
}

async function reload(): Promise<void> {
    await loadCases();
    if (reconciliationStore.selectedCase) {
        try {
            await reconciliationStore.openCase(reconciliationStore.selectedCase.id);
        } catch {
            snackbar.value?.showMessage('personalFinance.reconciliation.error.operationFailed');
        }
    }
}

async function openCase(caseId: string): Promise<void> {
    selectedDecision.value = null;
    try {
        await reconciliationStore.openCase(caseId);
        selectedDecision.value = reconciliationStore.selectedCase?.suggestedRelationType ?? null;
    } catch {
        snackbar.value?.showMessage('personalFinance.reconciliation.error.operationFailed');
    }
}

async function generateCandidates(): Promise<void> {
    if (!anchorBatchId.value) {
        return;
    }
    try {
        const result = await reconciliationStore.generateCandidates(anchorBatchId.value);
        statusFilter.value = 'all';
        casePage.value = 1;
        await loadCases();
        if (result.cases[0]) {
            await openCase(result.cases[0].id);
        }
        snackbar.value?.showMessage(result.limitReached
            ? 'personalFinance.reconciliation.generatedWithLimit'
            : 'personalFinance.reconciliation.generated');
    } catch {
        snackbar.value?.showMessage('personalFinance.reconciliation.error.operationFailed');
    }
}

async function submitDecision(): Promise<void> {
    if (!selectedDecision.value) {
        return;
    }
    try {
        await reconciliationStore.decide(selectedDecision.value);
        await loadCases();
        showDecisionDialog.value = false;
        snackbar.value?.showMessage('personalFinance.reconciliation.decisionSaved');
    } catch {
        showDecisionDialog.value = false;
        snackbar.value?.showMessage('personalFinance.reconciliation.error.staleOrFailed');
    }
}

async function inspectUndo(): Promise<void> {
    if (!canInspectUndo.value) {
        return;
    }
    undoImpact.value = null;
    loadingUndoImpact.value = true;
    showUndoDialog.value = true;
    try {
        undoImpact.value = await reconciliationStore.getUndoImpact();
    } catch {
        showUndoDialog.value = false;
        snackbar.value?.showMessage('personalFinance.reconciliation.error.operationFailed');
    } finally {
        loadingUndoImpact.value = false;
    }
}

async function submitUndo(): Promise<void> {
    if (!undoImpact.value) {
        return;
    }
    try {
        await reconciliationStore.undo();
        await loadCases();
        showUndoDialog.value = false;
        snackbar.value?.showMessage('personalFinance.reconciliation.undo.saved');
    } catch {
        showUndoDialog.value = false;
        snackbar.value?.showMessage('personalFinance.reconciliation.error.staleOrFailed');
    }
}

watch(statusFilter, () => {
    casePage.value = 1;
    void loadCases(true);
});
watch(casePage, () => void loadCases(true));

onMounted(async () => {
    await Promise.allSettled([
        personalFinanceStore.loadBatches(0, 50),
        loadCases(true)
    ]);
    anchorBatchId.value = personalFinanceStore.batches[0]?.id ?? '';
    selectedDecision.value = reconciliationStore.selectedCase?.suggestedRelationType ?? null;
});
</script>

<style scoped>
.reconciliation-workbench {
    min-height: calc(100vh - 132px);
}

.reconciliation-hero {
    background:
        linear-gradient(115deg, rgba(var(--v-theme-primary), 0.10), transparent 46%),
        linear-gradient(180deg, rgba(var(--v-theme-surface), 0.98), rgba(var(--v-theme-surface), 0.92));
}

.hero-copy {
    max-width: 720px;
}

.anchor-control {
    min-width: min(100%, 430px);
}

.summary-strip,
.summary-item {
    display: flex;
    align-items: center;
}

.summary-strip {
    gap: 20px;
}

.summary-item {
    gap: 8px;
}

.summary-value {
    font-size: 1.4rem;
    font-weight: 750;
}

.case-column,
.detail-column {
    min-height: 650px;
}

.case-column {
    background: rgba(var(--v-theme-on-surface), 0.018);
}

.filter-bar {
    overflow-x: auto;
}

.status-filter {
    min-width: max-content;
}

.case-list {
    max-height: 690px;
    overflow-y: auto;
}

.case-item {
    min-height: 104px;
}

.score-ring {
    width: 54px;
    height: 54px;
    border: 2px solid rgba(var(--v-theme-primary), 0.35);
    border-radius: 50%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: rgb(var(--v-theme-primary));
}

.score-ring strong {
    line-height: 1;
}

.score-ring small {
    margin-top: 3px;
    font-size: 0.6rem;
    color: rgba(var(--v-theme-on-surface), 0.6);
}

.score-medium {
    border-color: rgba(var(--v-theme-warning), 0.55);
    color: rgb(var(--v-theme-warning));
}

.score-low {
    border-color: rgba(var(--v-theme-on-surface), 0.24);
    color: rgba(var(--v-theme-on-surface), 0.72);
}

.reason-preview {
    white-space: normal;
}

.reason-panel,
.undo-metric {
    background: rgba(var(--v-theme-primary), 0.055);
    border: 1px solid rgba(var(--v-theme-primary), 0.12);
}

.reason-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.reason-item {
    padding: 7px 10px;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    border-radius: 8px;
    background: rgb(var(--v-theme-surface));
    font-size: 0.78rem;
}

.evidence-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
}

.evidence-card {
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    border-radius: 14px;
    background: rgba(var(--v-theme-surface), 0.96);
    box-shadow: 0 10px 28px rgba(var(--v-theme-on-surface), 0.045);
}

.evidence-amount {
    font-size: 1.65rem;
    font-weight: 750;
    letter-spacing: -0.02em;
}

.evidence-fields {
    display: grid;
    gap: 12px;
    margin: 0;
}

.evidence-fields div {
    display: grid;
    grid-template-columns: 90px minmax(0, 1fr);
    gap: 10px;
}

.evidence-fields dt {
    color: rgba(var(--v-theme-on-surface), 0.58);
    font-size: 0.75rem;
}

.evidence-fields dd {
    margin: 0;
    overflow-wrap: anywhere;
}

.decision-options {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
}

.decision-option {
    padding: 12px 14px;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    border-radius: 10px;
}

@media (max-width: 700px) {
    .anchor-control,
    .anchor-control .v-select {
        width: 100%;
    }

    .evidence-grid,
    .decision-options {
        grid-template-columns: 1fr;
    }
}
</style>
