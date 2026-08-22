<template>
    <div class="results-flow">
        <v-alert class="mb-4" type="error" variant="tonal" closable v-model="showError">
            {{ tt('personalFinance.organizerV2.error') }}
        </v-alert>

        <section class="empty-stage" v-if="!update && !loading">
            <div class="empty-copy">
                <span>{{ tt('personalFinance.organizerV2.start.eyebrow') }}</span>
                <h3>{{ tt('personalFinance.organizerV2.start.title') }}</h3>
                <p>{{ tt('personalFinance.organizerV2.start.hint') }}</p>
            </div>
            <div class="source-picker" v-if="readyBatches.length">
                <label :class="{ selected: selectedBatchIds.includes(batch.id) }" :key="batch.id" v-for="batch in readyBatches">
                    <v-checkbox-btn :model-value="selectedBatchIds.includes(batch.id)" @update:model-value="toggleBatch(batch.id)" />
                    <span>
                        <strong>{{ batch.file?.originalFileName || `${tt('personalFinance.organizerV2.start.batch')} #${batch.id}` }}</strong>
                        <small>{{ tt(getSourceTypeKey(batch.sourceType)) }} · {{ batch.validRowCount }} {{ tt('personalFinance.organizerV2.rows') }}</small>
                    </span>
                </label>
            </div>
            <div class="empty-actions">
                <import-upload-button size="large" @changed="onImportChanged" />
                <v-btn color="primary" size="large" :loading="busy" :disabled="selectedBatchIds.length < 1" @click="createAndOrganize">
                    {{ tt('personalFinance.organizerV2.start.action', { count: selectedBatchIds.length }) }}
                </v-btn>
            </div>
        </section>

        <template v-else-if="update">
            <section class="workflow-overview">
                <header>
                    <div>
                        <span class="workflow-kicker">{{ tt('personalFinance.organizerV2.workflow.eyebrow') }}</span>
                        <h3>{{ tt('personalFinance.organizerV2.workflow.title') }}</h3>
                        <p>{{ tt('personalFinance.organizerV2.workflow.hint') }}</p>
                    </div>
                    <small>#{{ update.id }} · {{ tt(`personalFinance.organizerV2.status.${update.status}`) }}</small>
                </header>

                <div class="workflow-stages">
                    <button class="workflow-stage" :class="{ active: activeWorkflowStep === 1 }" @click="activeWorkflowStep = 1">
                        <span class="stage-number">1</span>
                        <span class="stage-copy">
                            <small>{{ tt('personalFinance.organizerV2.workflow.upload') }}</small>
                            <strong>{{ tt('personalFinance.organizerV2.workflow.sourceCount', { count: update.sourceCount }) }}</strong>
                            <em>{{ tt('personalFinance.organizerV2.workflow.uploadAction') }}</em>
                        </span>
                    </button>
                    <button class="workflow-stage attention" :class="{ active: activeWorkflowStep === 2 }" @click="showEventStep('needs_action')">
                        <span class="stage-number">2</span>
                        <span class="stage-copy">
                            <small>{{ tt('personalFinance.organizerV2.workflow.review') }}</small>
                            <strong>{{ tt('personalFinance.organizerV2.workflow.groupCount', { count: issueGroupCount }) }}</strong>
                            <em>{{ tt('personalFinance.organizerV2.workflow.eventCount', { count: update.needsActionEventCount }) }}</em>
                        </span>
                    </button>
                    <button class="workflow-stage" :class="{ active: activeWorkflowStep === 3 }" @click="showEventStep('ready')">
                        <span class="stage-number">3</span>
                        <span class="stage-copy">
                            <small>{{ tt('personalFinance.organizerV2.workflow.ready') }}</small>
                            <strong>{{ tt('personalFinance.organizerV2.workflow.readyCount', { count: update.readyEventCount }) }}</strong>
                            <em>{{ tt('personalFinance.organizerV2.workflow.readyHint') }}</em>
                        </span>
                    </button>
                </div>

                <div class="workflow-sources" v-if="activeWorkflowStep !== 1 && updateSourceNames.length">
                    <span :key="`${source}-${index}`" v-for="(source, index) in updateSourceNames">{{ source }}</span>
                </div>

                <footer v-if="activeWorkflowStep !== 1">
                    <div class="result-actions">
                        <v-btn color="primary" :loading="busy" :disabled="!canPostUpdate(update)" @click="postAllReady">
                            {{ tt('personalFinance.organizerV2.action.postAll', { count: update.readyEventCount }) }}
                        </v-btn>
                        <v-btn variant="outlined" :loading="busy" v-if="canOrganizeUpdate(update.status)" @click="organizeCurrent">
                            {{ tt('personalFinance.organizerV2.action.organize') }}
                        </v-btn>
                        <v-btn variant="text" :prepend-icon="mdiRefresh" :loading="loading" @click="load">{{ tt('Refresh') }}</v-btn>
                        <v-btn variant="text" color="warning" v-if="canUndoUpdate(update)" @click="inspectUndo">
                            {{ tt('personalFinance.organizerV2.action.undo') }}
                        </v-btn>
                        <v-btn variant="text" v-if="update.status === 'posted' || update.status === 'undone'" @click="startNewUpdate">
                            {{ tt('personalFinance.organizerV2.action.new') }}
                        </v-btn>
                    </div>
                    <p>{{ tt('personalFinance.organizerV2.workflow.summary', { total: update.finalEventCount, excluded: update.excludedEventCount, posted: update.postedEventCount }) }}</p>
                </footer>
            </section>

            <section class="round-sources" v-if="activeWorkflowStep === 1">
                <header>
                    <div>
                        <span>{{ tt('personalFinance.organizerV2.sources.eyebrow') }}</span>
                        <h3>{{ tt('personalFinance.organizerV2.sources.title') }}</h3>
                        <p>{{ tt('personalFinance.organizerV2.sources.lockedHint') }}</p>
                    </div>
                    <import-upload-button @changed="onImportChanged" />
                </header>
                <div class="round-source-list">
                    <article :key="item.source.id" v-for="item in currentSources">
                        <v-checkbox-btn :model-value="true" disabled />
                        <div>
                            <strong>{{ item.batch?.file?.originalFileName || tt(getSourceTypeKey(item.source.sourceType)) }}</strong>
                            <small>
                                {{ tt(getSourceTypeKey(item.source.sourceType)) }} ·
                                {{ item.batch ? tt('personalFinance.organizerV2.sources.rowCount', { count: item.batch.validRowCount }) : item.source.parserVersion }}
                            </small>
                        </div>
                        <span>{{ tt('personalFinance.organizerV2.sources.selected') }}</span>
                    </article>
                </div>
                <footer>
                    <p>{{ tt('personalFinance.organizerV2.sources.nextRoundHint') }}</p>
                    <v-btn color="primary" @click="showEventStep('needs_action')">
                        {{ tt('personalFinance.organizerV2.sources.continue') }}
                    </v-btn>
                </footer>
            </section>

            <details class="verification" :class="{ invalid: !conservationHolds }" v-if="activeWorkflowStep !== 1">
                <summary>{{ tt('personalFinance.organizerV2.workflow.verify') }}</summary>
                <div>
                    <span>{{ update.validEvidenceCount }} {{ tt('personalFinance.organizerV2.conservation.evidence') }}</span>
                    <b>−</b>
                    <span>{{ update.duplicateEvidenceCount }} {{ tt('personalFinance.organizerV2.conservation.duplicates') }}</span>
                    <b>=</b>
                    <span>{{ update.finalEventCount }} {{ tt('personalFinance.organizerV2.conservation.events') }}</span>
                    <small>{{ tt(conservationHolds ? 'personalFinance.organizerV2.conservation.ok' : 'personalFinance.organizerV2.conservation.invalid') }}</small>
                </div>
            </details>

            <section class="event-workbench" v-if="activeWorkflowStep !== 1">
                <header>
                    <div>
                        <span>{{ tt('personalFinance.organizerV2.events.eyebrow') }}</span>
                        <h3>{{ tt(`personalFinance.organizerV2.filter.${eventFilter}`) }}</h3>
                        <p>{{ tt('personalFinance.organizerV2.events.hint') }}</p>
                    </div>
                    <v-btn-toggle density="compact" divided mandatory variant="outlined" v-model="eventFilter">
                        <v-btn :value="filter" :key="filter" v-for="filter in visibleFilters">
                            {{ tt(`personalFinance.organizerV2.filter.${filter}`) }}
                        </v-btn>
                    </v-btn-toggle>
                </header>

                <v-skeleton-loader type="list-item-three-line@4" v-if="loadingEvents" />
                <div class="event-list" v-else-if="events.length">
                    <div class="event-group" :key="group[0].id" v-for="group in displayedEventGroups">
                    <article class="event-row">
                        <div class="event-date">
                            <strong>{{ eventDay(group[0].eventUnixTime) }}</strong>
                            <span>{{ eventMonth(group[0].eventUnixTime) }}</span>
                        </div>
                        <div class="event-main">
                            <span class="event-nature">{{ tt(`personalFinance.organizerV2.nature.${group[0].economicNature}`) }}</span>
                            <strong>{{ eventDisplayLabel(group[0]) || tt('personalFinance.organizerV2.events.unnamed') }}</strong>
                            <p v-if="eventDescription(group[0])">{{ eventDescription(group[0]) }}</p>
                            <span class="similar-badge" v-if="group.length > 1">{{ tt('personalFinance.organizerV2.workflow.similar', { count: group.length }) }}</span>
                        </div>
                        <div class="event-context">
                            <div class="event-meta">
                                <span v-if="group[0].paymentMethod">{{ group[0].paymentMethod }}</span>
                                <span>{{ eventAccountName(group[0]) }}</span>
                                <span>{{ eventCategoryName(group[0]) }}</span>
                                <span>{{ tt('personalFinance.organizerV2.events.evidenceCount', { count: group[0].evidenceCount }) }}</span>
                            </div>
                            <small v-if="eventReasonTranslationKeys(group[0]).length">{{ eventReasonTranslationKeys(group[0]).map(key => tt(key)).join(' · ') }}</small>
                        </div>
                        <div class="event-amount" :class="group[0].flowDirection">
                            {{ formatEventAmount(group[0]) }}
                            <small>{{ tt(`personalFinance.organizerV2.status.${group[0].status}`) }}</small>
                        </div>
                        <div class="event-buttons">
                            <v-btn size="small" variant="outlined" v-if="group.length > 1" @click="toggleGroup(group[0].id)">
                                {{ tt(expandedGroupIds.has(group[0].id) ? 'personalFinance.organizerV2.workflow.collapse' : 'personalFinance.organizerV2.workflow.expand', { count: group.length }) }}
                            </v-btn>
                            <v-btn size="small" variant="text" v-if="group.length === 1" @click="openEvidence(group[0])">{{ tt('personalFinance.organizerV2.events.evidence') }}</v-btn>
                            <v-btn size="small" variant="outlined" color="warning" v-if="group.length === 1 && group[0].status === 'needs_action'" @click="openResolve(group[0])">
                                {{ tt('personalFinance.organizerV2.events.resolve') }}
                            </v-btn>
                        </div>
                    </article>
                    <div class="similar-list" v-if="group.length > 1 && expandedGroupIds.has(group[0].id)">
                        <div class="similar-row" :key="event.id" v-for="(event, index) in group">
                            <span class="similar-index">{{ tt('personalFinance.organizerV2.workflow.item', { index: index + 1 }) }}</span>
                            <div>
                                <strong>{{ eventDisplayLabel(event) || tt('personalFinance.organizerV2.events.unnamed') }}</strong>
                                <small>{{ eventDescription(event) || eventReasonTranslationKeys(event).map(key => tt(key)).join(' · ') }}</small>
                            </div>
                            <div class="event-amount" :class="event.flowDirection">{{ formatEventAmount(event) }}</div>
                            <div class="event-buttons">
                                <v-btn size="small" variant="text" @click="openEvidence(event)">{{ tt('personalFinance.organizerV2.events.evidence') }}</v-btn>
                                <v-btn size="small" variant="outlined" color="warning" v-if="event.status === 'needs_action'" @click="openResolve(event)">
                                    {{ tt('personalFinance.organizerV2.events.resolve') }}
                                </v-btn>
                            </div>
                        </div>
                    </div>
                    </div>
                </div>
                <div class="event-empty" v-else>{{ tt('personalFinance.organizerV2.events.empty') }}</div>
            </section>
        </template>

        <v-skeleton-loader type="heading, image, list-item-three-line@3" v-else />

        <v-dialog max-width="720" v-model="showEvidence">
            <v-card>
                <v-card-title>{{ tt('personalFinance.organizerV2.evidence.title') }}</v-card-title>
                <v-card-text>
                    <v-skeleton-loader type="list-item-three-line@3" v-if="loadingEvidence" />
                    <div class="evidence-list" v-else>
                        <article :key="item.id" v-for="item in evidence?.evidence">
                            <strong>{{ item.row.counterparty || item.row.item || `#${item.row.rowNumber}` }}</strong>
                            <span>{{ item.row.item }}</span>
                            <small>{{ item.row.paymentMethod }} · {{ item.row.amount || '—' }} {{ item.row.currency }}</small>
                        </article>
                        <p v-if="!evidence?.evidence.length">{{ tt('personalFinance.organizerV2.evidence.empty') }}</p>
                    </div>
                </v-card-text>
                <v-card-actions><v-spacer /><v-btn @click="showEvidence = false">{{ tt('Close') }}</v-btn></v-card-actions>
            </v-card>
        </v-dialog>

        <v-dialog max-width="760" v-model="showResolve">
            <v-card>
                <v-card-title>{{ tt('personalFinance.organizerV2.resolve.title') }}</v-card-title>
                <v-card-text>
                    <div class="resolve-preview" v-if="selectedEvent">
                        <div>
                            <strong>{{ eventDisplayLabel(selectedEvent) || tt('personalFinance.organizerV2.events.unnamed') }}</strong>
                            <small>{{ eventReasonTranslationKeys(selectedEvent).map(key => tt(key)).join(' · ') }}</small>
                        </div>
                        <b :class="selectedEvent.flowDirection">{{ formatEventAmount(selectedEvent) }}</b>
                    </div>
                    <p class="resolve-hint">{{ tt('personalFinance.organizerV2.resolve.hint') }}</p>
                    <v-row dense>
                        <v-col cols="12" md="6">
                            <v-select
                                :items="natureOptions"
                                item-title="title"
                                item-value="value"
                                variant="outlined"
                                :label="tt('personalFinance.organizerV2.resolve.nature')"
                                v-model="selectedNature"
                            />
                        </v-col>
                        <v-col cols="12" md="6">
                            <v-select
                                :items="availableLedgerAccounts"
                                item-title="name"
                                item-value="id"
                                variant="outlined"
                                :label="tt('personalFinance.organizerV2.resolve.ledgerAccount')"
                                v-model="selectedLedgerAccountId"
                            />
                        </v-col>
                        <v-col cols="12" md="6" v-if="needsCounterpartyAccount">
                            <v-select
                                :items="availableCounterpartyAccounts"
                                item-title="name"
                                item-value="id"
                                variant="outlined"
                                :label="tt('personalFinance.organizerV2.resolve.counterpartyAccount')"
                                v-model="selectedCounterpartyLedgerAccountId"
                            />
                        </v-col>
                        <v-col cols="12" :md="needsCounterpartyAccount ? 6 : 12">
                            <v-select
                                clearable
                                :items="categoryOptions"
                                item-title="title"
                                item-value="value"
                                variant="outlined"
                                :label="tt('personalFinance.organizerV2.resolve.category')"
                                :hint="tt('personalFinance.organizerV2.resolve.categoryHint')"
                                persistent-hint
                                v-model="selectedCategoryId"
                            />
                        </v-col>
                    </v-row>
                </v-card-text>
                <v-card-actions>
                    <v-btn color="warning" variant="text" :loading="busy" @click="excludeSelected">{{ tt('personalFinance.organizerV2.resolve.exclude') }}</v-btn>
                    <v-spacer />
                    <v-btn variant="text" @click="showResolve = false">{{ tt('Cancel') }}</v-btn>
                    <v-btn color="primary" :disabled="!canResolveSelected" :loading="busy" @click="resolveSelected">{{ tt('personalFinance.organizerV2.resolve.save') }}</v-btn>
                </v-card-actions>
            </v-card>
        </v-dialog>

        <v-dialog max-width="560" v-model="showUndo">
            <v-card>
                <v-card-title>{{ tt('personalFinance.organizerV2.undo.title') }}</v-card-title>
                <v-card-text>
                    <p>{{ tt('personalFinance.organizerV2.undo.impact', { transactions: undoImpact?.transactionCount ?? 0 }) }}</p>
                    <v-alert type="warning" variant="tonal" v-if="undoImpact && !undoImpact.safeToApply">
                        {{ tt('personalFinance.organizerV2.undo.unsafe') }}
                    </v-alert>
                </v-card-text>
                <v-card-actions><v-spacer /><v-btn @click="showUndo = false">{{ tt('Cancel') }}</v-btn><v-btn color="warning" :disabled="!undoImpact?.safeToApply" :loading="busy" @click="undoCurrent">{{ tt('personalFinance.organizerV2.action.undo') }}</v-btn></v-card-actions>
            </v-card>
        </v-dialog>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { mdiRefresh } from '@mdi/js';

import { useI18n } from '@/locales/helpers.ts';
import { generateRandomUUID } from '@/lib/misc.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';
import { useAccountsStore } from '@/stores/account.ts';
import { useTransactionCategoriesStore } from '@/stores/transactionCategory.ts';
import { CategoryType } from '@/core/category.ts';
import type { TransactionCategory } from '@/models/transaction_category.ts';

import ImportUploadButton from '../../components/ImportUploadButton.vue';
import { usePersonalFinanceStore } from '../../store.ts';
import { getSourceTypeKey } from '../../presentation.ts';
import type { EconomicEvent, EconomicEventStatus, EconomicNature, FinanceUpdate, OrganizerEventEvidence, OrganizerImpact } from '../models.ts';
import { organizerApi } from '../service.ts';
import { RESULT_UPDATE_STATUSES, canOrganizeUpdate, canPostUpdate, canUndoUpdate, eventDisplayLabel, eventReasonTranslationKeys, groupVisuallyIdenticalEvents, selectCurrentUpdate, updateConservationHolds } from '../state.ts';

const { tt, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
const accountsStore = useAccountsStore();
const categoriesStore = useTransactionCategoriesStore();
const personalFinanceStore = usePersonalFinanceStore();
const loading = ref(true);
const loadingEvents = ref(false);
const loadingEvidence = ref(false);
const busy = ref(false);
const showError = ref(false);
const update = ref<FinanceUpdate>();
const events = ref<readonly EconomicEvent[]>([]);
const eventFilter = ref<EconomicEventStatus>('needs_action');
const selectedBatchIds = ref<string[]>([]);
const activeWorkflowStep = ref<1 | 2 | 3>(2);
const showEvidence = ref(false);
const evidence = ref<OrganizerEventEvidence>();
const showResolve = ref(false);
const selectedEvent = ref<EconomicEvent>();
const selectedNature = ref<EconomicNature>('expense');
const selectedLedgerAccountId = ref('');
const selectedCounterpartyLedgerAccountId = ref('');
const selectedCategoryId = ref('');
const showUndo = ref(false);
const undoImpact = ref<OrganizerImpact>();
const needsActionGroupCount = ref<number>();
const expandedGroupIds = ref<ReadonlySet<string>>(new Set());
const visibleFilters: readonly EconomicEventStatus[] = ['needs_action', 'ready', 'posted', 'excluded'];
const natures: readonly EconomicNature[] = ['expense', 'income', 'refund', 'fee', 'repayment', 'borrow', 'internal_transfer', 'balance_adjustment'];
const readyBatches = computed(() => personalFinanceStore.batches.filter(batch => batch.status === 'ready'));
const conservationHolds = computed(() => !!update.value && updateConservationHolds(update.value));
const natureOptions = computed(() => natures.map(value => ({ value, title: tt(`personalFinance.organizerV2.nature.${value}`) })));
const availableLedgerAccounts = computed(() => accountsStore.allVisiblePlainAccounts.filter(account =>
    !selectedEvent.value?.currency || account.currency === selectedEvent.value.currency));
const needsCounterpartyAccount = computed(() => selectedNature.value === 'internal_transfer' || selectedNature.value === 'repayment');
const availableCounterpartyAccounts = computed(() => accountsStore.allVisiblePlainAccounts.filter(account =>
    account.id !== selectedLedgerAccountId.value && (!selectedEvent.value?.currency || account.currency === selectedEvent.value.currency)));
const categoryType = computed(() => {
    if (selectedNature.value === 'income' || selectedNature.value === 'refund' || selectedNature.value === 'borrow') {
        return CategoryType.Income;
    }
    if (needsCounterpartyAccount.value) {
        return CategoryType.Transfer;
    }
    return CategoryType.Expense;
});
const categoryOptions = computed(() => flattenCategories(categoriesStore.allTransactionCategories[categoryType.value] ?? []));
const canResolveSelected = computed(() => !!selectedEvent.value && !!selectedLedgerAccountId.value && selectedNature.value !== 'unknown' &&
    (!needsCounterpartyAccount.value || (!!selectedCounterpartyLedgerAccountId.value && selectedCounterpartyLedgerAccountId.value !== selectedLedgerAccountId.value)));
const displayedEventGroups = computed(() => eventFilter.value === 'needs_action'
    ? groupVisuallyIdenticalEvents(events.value) : events.value.map(event => [event] as const));
const issueGroupCount = computed(() => needsActionGroupCount.value ?? update.value?.needsActionEventCount ?? 0);
const updateSourceNames = computed(() => {
    if (!update.value?.sources) return [];

    const batches = new Map(personalFinanceStore.batches.map(batch => [batch.id, batch]));
    return update.value.sources.map(source => {
        const batch = batches.get(source.batchId);
        return batch?.file?.originalFileName || tt(getSourceTypeKey(source.sourceType));
    });
});
const currentSources = computed(() => {
    const batches = new Map(personalFinanceStore.batches.map(batch => [batch.id, batch]));
    return (update.value?.sources ?? []).map(source => ({ source, batch: batches.get(source.batchId) }));
});

watch(eventFilter, () => {
    if (activeWorkflowStep.value !== 1) {
        activeWorkflowStep.value = eventFilter.value === 'ready' ? 3 : 2;
    }
    expandedGroupIds.value = new Set();
    void loadEvents();
});

watch(selectedNature, () => {
    if (!needsCounterpartyAccount.value) {
        selectedCounterpartyLedgerAccountId.value = '';
    }
    if (selectedCategoryId.value && !categoryOptions.value.some(option => option.value === selectedCategoryId.value)) {
        selectedCategoryId.value = '';
    }
});

function idempotencyKey(action: string): string { return `pf-organizer-ui-v2:${action}:${generateRandomUUID()}`; }
function toggleBatch(id: string): void {
    selectedBatchIds.value = selectedBatchIds.value.includes(id)
        ? selectedBatchIds.value.filter(value => value !== id) : [...selectedBatchIds.value, id];
}
function showEventStep(filter: EconomicEventStatus): void {
    activeWorkflowStep.value = filter === 'ready' ? 3 : 2;
    eventFilter.value = filter;
}
function eventDay(unixTime?: number): string { return unixTime ? String(new Date(unixTime * 1000).getDate()).padStart(2, '0') : '—'; }
function eventMonth(unixTime?: number): string { return unixTime ? new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(unixTime * 1000)) : ''; }
function formatEventAmount(event: EconomicEvent): string {
    return event.amount ? formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(event.amount), event.currency) : '—';
}
function eventDescription(event: EconomicEvent): string {
    const title = eventDisplayLabel(event);
    return [...new Set([event.item, event.note].filter(value => value && value !== title))].join(' · ');
}
function eventAccountName(event: EconomicEvent): string {
    return event.ledgerAccountId ? accountsStore.allAccountsMap[event.ledgerAccountId]?.name || tt('personalFinance.organizerV2.events.accountPending')
        : tt('personalFinance.organizerV2.events.accountPending');
}
function eventCategoryName(event: EconomicEvent): string {
    return event.categoryId ? categoriesStore.allTransactionCategoriesMap[event.categoryId]?.name || tt('personalFinance.organizerV2.events.uncategorized')
        : tt('personalFinance.organizerV2.events.uncategorized');
}
function toggleGroup(id: string): void {
    const next = new Set(expandedGroupIds.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expandedGroupIds.value = next;
}
function directionForNature(nature: EconomicNature): EconomicEvent['flowDirection'] {
    if (nature === 'income' || nature === 'borrow' || nature === 'refund') return 'inflow';
    if (nature === 'internal_transfer' || nature === 'balance_adjustment') return 'neutral';
    return 'outflow';
}

function flattenCategories(categories: TransactionCategory[]): { title: string; value: string }[] {
    const options: { title: string; value: string }[] = [];
    for (const category of categories) {
        for (const subCategory of category.subCategories ?? []) {
            if (!category.hidden && !subCategory.hidden) {
                options.push({ title: `${category.name} / ${subCategory.name}`, value: subCategory.id });
            }
        }
    }
    return options;
}

async function load(): Promise<void> {
    loading.value = true;
    showError.value = false;
    try {
        const pages = await Promise.all(RESULT_UPDATE_STATUSES.map(status => organizerApi.listUpdates(status)));
        update.value = selectCurrentUpdate(pages.map(page => [...page.items]));
        await Promise.all([
            personalFinanceStore.loadBatches(0, 100),
            Promise.allSettled([accountsStore.loadAllAccounts({ force: false }), categoriesStore.loadAllCategories({ force: false })])
        ]);
        if (update.value) await loadEvents();
    } catch {
        showError.value = true;
    } finally {
        loading.value = false;
    }
}

async function loadEvents(): Promise<void> {
    if (!update.value) return;
    loadingEvents.value = true;
    try {
        events.value = (await organizerApi.listEvents(update.value.id, eventFilter.value)).items;
        if (eventFilter.value === 'needs_action') {
            needsActionGroupCount.value = groupVisuallyIdenticalEvents(events.value).length;
        }
    }
    catch { showError.value = true; }
    finally { loadingEvents.value = false; }
}
function startNewUpdate(): void {
    update.value = undefined;
    events.value = [];
    selectedBatchIds.value = [];
    needsActionGroupCount.value = undefined;
    expandedGroupIds.value = new Set();
    activeWorkflowStep.value = 1;
}

async function onImportChanged(batchId: string): Promise<void> {
    await personalFinanceStore.loadBatches(0, 100);
    if (!update.value && readyBatches.value.some(batch => batch.id === batchId) && !selectedBatchIds.value.includes(batchId)) {
        selectedBatchIds.value = [...selectedBatchIds.value, batchId];
    }
}

async function runMutation(operation: () => Promise<{ update: FinanceUpdate }>): Promise<void> {
    busy.value = true;
    try {
        update.value = (await operation()).update;
        await loadEvents();
    } catch { showError.value = true; }
    finally { busy.value = false; }
}

async function createAndOrganize(): Promise<void> {
    busy.value = true;
    try {
        const created = await organizerApi.createUpdate(selectedBatchIds.value, idempotencyKey('create'));
        update.value = (await organizerApi.organize(created, idempotencyKey('organize'))).update;
        activeWorkflowStep.value = 2;
        await loadEvents();
    } catch { showError.value = true; }
    finally { busy.value = false; }
}
async function organizeCurrent(): Promise<void> { if (update.value) await runMutation(() => organizerApi.organize(update.value as FinanceUpdate, idempotencyKey('organize'))); }
async function postAllReady(): Promise<void> { if (update.value) await runMutation(() => organizerApi.postAllReady(update.value as FinanceUpdate, idempotencyKey('post-all'))); }
async function openEvidence(event: EconomicEvent): Promise<void> {
    showEvidence.value = true; loadingEvidence.value = true; evidence.value = undefined;
    try { evidence.value = await organizerApi.getEvidence(event.id); }
    catch { showError.value = true; showEvidence.value = false; }
    finally { loadingEvidence.value = false; }
}
function openResolve(event: EconomicEvent): void {
    selectedEvent.value = event;
    selectedNature.value = event.economicNature === 'unknown' ? 'expense' : event.economicNature;
    selectedLedgerAccountId.value = event.ledgerAccountId ?? '';
    selectedCounterpartyLedgerAccountId.value = event.counterpartyLedgerAccountId ?? '';
    selectedCategoryId.value = event.categoryId ?? '';
    showResolve.value = true;
}
async function resolveSelected(): Promise<void> {
    if (!update.value || !selectedEvent.value || !canResolveSelected.value) return;
    const currentUpdate = update.value; const currentEvent = selectedEvent.value;
    let fieldMask = 1 | 4 | 8 | 256;
    if (needsCounterpartyAccount.value) fieldMask |= 2;
    if (selectedCategoryId.value) fieldMask |= 128;
    await runMutation(() => organizerApi.correctEvent({
        updateId: currentUpdate.id, eventId: currentEvent.id, expectedUpdateVersion: currentUpdate.version,
        expectedEventVersion: currentEvent.version, idempotencyKey: idempotencyKey('resolve'),
        fieldMask, status: 'ready', economicNature: selectedNature.value,
        flowDirection: directionForNature(selectedNature.value), ledgerAccountId: selectedLedgerAccountId.value,
        counterpartyLedgerAccountId: needsCounterpartyAccount.value ? selectedCounterpartyLedgerAccountId.value : undefined,
        categoryId: selectedCategoryId.value || undefined
    }));
    showResolve.value = false;
}
async function excludeSelected(): Promise<void> {
    if (!update.value || !selectedEvent.value) return;
    const currentUpdate = update.value; const currentEvent = selectedEvent.value;
    await runMutation(() => organizerApi.excludeEvent(currentUpdate, currentEvent, idempotencyKey('exclude')));
    showResolve.value = false;
}
async function inspectUndo(): Promise<void> {
    if (!update.value) return;
    busy.value = true;
    try { undoImpact.value = await organizerApi.getUndoImpact(update.value.id); showUndo.value = true; }
    catch { showError.value = true; }
    finally { busy.value = false; }
}
async function undoCurrent(): Promise<void> {
    if (!update.value) return;
    await runMutation(() => organizerApi.undo(update.value as FinanceUpdate, idempotencyKey('undo')));
    showUndo.value = false;
}

onMounted(load);
</script>

<style scoped>
.results-flow { --rule: rgba(var(--v-theme-on-surface), .12); display: grid; gap: 10px; }
.empty-stage { min-height: 430px; padding: clamp(28px, 5vw, 64px); border: 1px solid var(--rule); border-radius: 6px 28px 6px 28px; background: linear-gradient(125deg, rgba(var(--v-theme-primary), .09), transparent 48%), rgb(var(--v-theme-surface)); }
.empty-copy { max-width: 720px; }
.empty-copy span, .workflow-kicker, .event-workbench header span { color: rgb(var(--v-theme-primary)); font-size: .7rem; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
.empty-copy h3 { margin: 7px 0 0; font-size: clamp(1.8rem, 4vw, 3.1rem); letter-spacing: -.045em; line-height: 1.05; }
.empty-copy p { max-width: 700px; color: rgba(var(--v-theme-on-surface), .65); line-height: 1.7; }
.source-picker { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; margin-top: 28px; }
.source-picker label { display: flex; gap: 10px; padding: 14px; border: 1px solid var(--rule); background: rgb(var(--v-theme-surface)); cursor: pointer; }
.source-picker label.selected { border-color: rgb(var(--v-theme-primary)); box-shadow: inset 3px 0 rgb(var(--v-theme-primary)); }
.source-picker span { display: grid; gap: 4px; min-width: 0; }
.source-picker strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-picker small { color: rgba(var(--v-theme-on-surface), .58); }
.empty-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 26px; }
.workflow-overview { border: 1px solid var(--rule); border-radius: 10px; background: rgb(var(--v-theme-surface)); overflow: hidden; }
.workflow-overview > header { display: flex; align-items: start; justify-content: space-between; gap: 20px; padding: 12px 16px 10px; background: linear-gradient(105deg, rgba(var(--v-theme-primary), .06), transparent 42%); }
.workflow-overview h3 { display: inline; margin: 0 0 0 9px; font-size: 1.05rem; letter-spacing: -.02em; }
.workflow-overview header p { display: inline; max-width: 720px; margin: 0 0 0 12px; color: rgba(var(--v-theme-on-surface), .58); font-size: .74rem; line-height: 1.4; }
.workflow-overview header > small { color: rgba(var(--v-theme-on-surface), .46); font-variant-numeric: tabular-nums; white-space: nowrap; }
.workflow-stages { display: grid; grid-template-columns: repeat(3, 1fr); border-block: 1px solid var(--rule); background: var(--rule); gap: 1px; }
.workflow-stage { display: flex; align-items: center; min-height: 70px; gap: 10px; padding: 9px 14px; border: 0; background: rgb(var(--v-theme-surface)); color: inherit; cursor: pointer; text-align: start; }
.workflow-stage:hover, .workflow-stage.active { background: rgba(var(--v-theme-primary), .055); }
.workflow-stage.active { box-shadow: inset 0 2px rgb(var(--v-theme-primary)); }
.workflow-stage.attention.active { box-shadow: inset 0 2px rgb(var(--v-theme-warning)); }
.stage-number { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 999px; background: rgba(var(--v-theme-primary), .1); color: rgb(var(--v-theme-primary)); font-size: .78rem; font-weight: 800; }
.stage-copy { display: grid; min-width: 0; }
.stage-copy small { color: rgba(var(--v-theme-on-surface), .56); font-size: .68rem; }
.stage-copy strong { margin-top: 1px; font-size: 1.02rem; font-variant-numeric: tabular-nums; }
.stage-copy em { margin-top: 2px; color: rgb(var(--v-theme-primary)); font-size: .66rem; font-style: normal; }
.workflow-sources { display: flex; flex-wrap: wrap; gap: 5px; padding: 8px 16px 0; }
.workflow-sources span { max-width: 320px; padding: 5px 9px; border: 1px solid var(--rule); border-radius: 999px; color: rgba(var(--v-theme-on-surface), .62); font-size: .72rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workflow-overview > footer { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 10px 16px 12px; }
.workflow-overview footer p { margin: 0; color: rgba(var(--v-theme-on-surface), .52); font-size: .75rem; text-align: end; }
.result-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.round-sources { border: 1px solid var(--rule); border-radius: 10px; background: rgb(var(--v-theme-surface)); overflow: hidden; }
.round-sources > header { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 14px 16px; border-bottom: 1px solid var(--rule); background: rgba(var(--v-theme-primary), .035); }
.round-sources header span { color: rgb(var(--v-theme-primary)); font-size: .68rem; font-weight: 800; letter-spacing: .12em; }
.round-sources h3 { display: inline; margin: 0 0 0 8px; font-size: 1.05rem; }
.round-sources header p { margin: 3px 0 0; color: rgba(var(--v-theme-on-surface), .58); font-size: .76rem; }
.round-source-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1px; background: var(--rule); }
.round-source-list article { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 9px; min-height: 66px; padding: 9px 14px; background: rgb(var(--v-theme-surface)); }
.round-source-list article > div { display: grid; min-width: 0; }
.round-source-list strong { overflow: hidden; font-size: .82rem; text-overflow: ellipsis; white-space: nowrap; }
.round-source-list small { margin-top: 2px; color: rgba(var(--v-theme-on-surface), .55); font-size: .68rem; }
.round-source-list article > span { padding: 3px 7px; border-radius: 999px; background: rgba(var(--v-theme-success), .1); color: rgb(var(--v-theme-success)); font-size: .65rem; font-weight: 700; }
.round-sources > footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 16px; border-top: 1px solid var(--rule); }
.round-sources footer p { margin: 0; color: rgba(var(--v-theme-on-surface), .55); font-size: .72rem; }
.verification { padding: 0 14px; border-inline-start: 3px solid rgb(var(--v-theme-success)); background: rgba(var(--v-theme-success), .05); }
.verification.invalid { border-color: rgb(var(--v-theme-error)); background: rgba(var(--v-theme-error), .06); }
.verification summary { padding: 8px 2px; color: rgba(var(--v-theme-on-surface), .68); cursor: pointer; font-size: .72rem; font-weight: 700; }
.verification > div { display: flex; align-items: center; gap: 12px; padding: 0 2px 14px; color: rgba(var(--v-theme-on-surface), .62); font-size: .76rem; }
.verification small { margin-inline-start: auto; }
.event-workbench { border: 1px solid var(--rule); border-radius: 10px; background: rgb(var(--v-theme-surface)); overflow: hidden; }
.event-workbench > header { display: flex; align-items: end; justify-content: space-between; gap: 16px; padding: 12px 14px; border-bottom: 1px solid var(--rule); background: rgba(var(--v-theme-primary), .035); }
.event-workbench h3 { display: inline; margin: 0 0 0 8px; font-size: 1.05rem; }
.event-workbench header p { margin: 4px 0 0; color: rgba(var(--v-theme-on-surface), .6); font-size: .82rem; }
.event-group { border-bottom: 1px solid var(--rule); }
.event-group:last-child { border-bottom: 0; }
.event-row { display: grid; grid-template-columns: 48px minmax(200px, .7fr) minmax(300px, 1.3fr) minmax(130px, auto) auto; gap: 12px; align-items: center; padding: 10px 14px; }
.event-date { display: grid; text-align: center; border-inline-end: 1px solid var(--rule); }
.event-date strong { font-size: 1.1rem; line-height: 1; }
.event-date span { margin-top: 4px; color: rgba(var(--v-theme-on-surface), .52); font-size: .64rem; text-transform: uppercase; }
.event-main { display: grid; gap: 2px; min-width: 0; }
.event-main > strong { overflow: hidden; font-size: .9rem; text-overflow: ellipsis; white-space: nowrap; }
.event-main p { margin: 0; color: rgba(var(--v-theme-on-surface), .61); font-size: .76rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.event-nature { color: rgb(var(--v-theme-primary)); font-size: .68rem; font-weight: 750; }
.similar-badge { width: fit-content; margin-top: 3px; padding: 2px 7px; border-radius: 999px; background: rgba(var(--v-theme-warning), .12); color: rgb(var(--v-theme-warning)); font-size: .66rem; font-weight: 700; }
.event-context { display: grid; gap: 4px; min-width: 0; }
.event-meta { display: flex; flex-wrap: wrap; gap: 5px 14px; color: rgba(var(--v-theme-on-surface), .7); font-size: .76rem; }
.event-meta span { position: relative; white-space: nowrap; }
.event-meta span:not(:last-child)::after { position: absolute; inset-inline-end: -8px; color: rgba(var(--v-theme-on-surface), .22); content: "·"; }
.event-context small { color: rgba(var(--v-theme-on-surface), .5); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.event-amount { display: grid; text-align: end; font-weight: 750; font-variant-numeric: tabular-nums; }
.event-amount.inflow { color: rgb(var(--v-theme-success)); }
.event-amount.outflow { color: rgb(var(--v-theme-error)); }
.event-amount small { color: rgba(var(--v-theme-on-surface), .5); font-size: .66rem; font-weight: 500; }
.event-buttons { display: flex; gap: 5px; }
.similar-list { border-top: 1px dashed var(--rule); background: rgba(var(--v-theme-primary), .025); }
.similar-row { display: grid; grid-template-columns: 70px minmax(0, 1fr) minmax(130px, auto) auto; align-items: center; gap: 12px; padding: 9px 14px 9px 74px; border-bottom: 1px dashed var(--rule); }
.similar-row:last-child { border-bottom: 0; }
.similar-index { color: rgba(var(--v-theme-on-surface), .48); font-size: .7rem; }
.similar-row > div:nth-child(2) { display: grid; min-width: 0; }
.similar-row > div:nth-child(2) small { color: rgba(var(--v-theme-on-surface), .52); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.event-empty { padding: 56px; color: rgba(var(--v-theme-on-surface), .56); text-align: center; }
.evidence-list { display: grid; gap: 8px; }
.evidence-list article { display: grid; gap: 3px; padding: 13px; border-inline-start: 3px solid rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .055); }
.evidence-list span, .evidence-list small { color: rgba(var(--v-theme-on-surface), .62); }
.resolve-preview { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 11px 13px; border-inline-start: 3px solid rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .05); }
.resolve-preview > div { display: grid; gap: 3px; min-width: 0; }
.resolve-preview strong, .resolve-preview small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.resolve-preview small { color: rgba(var(--v-theme-on-surface), .58); }
.resolve-preview b { white-space: nowrap; font-variant-numeric: tabular-nums; }
.resolve-preview b.inflow { color: rgb(var(--v-theme-success)); }
.resolve-preview b.outflow { color: rgb(var(--v-theme-error)); }
.resolve-hint { margin: 14px 0 10px; color: rgba(var(--v-theme-on-surface), .66); font-size: .82rem; }
@media (max-width: 900px) {
    .workflow-stages { grid-template-columns: 1fr; }
    .workflow-overview > header, .workflow-overview > footer { align-items: start; flex-direction: column; }
    .workflow-overview footer p { text-align: start; }
    .round-sources > header, .round-sources > footer { align-items: start; flex-direction: column; }
    .verification > div { align-items: start; flex-wrap: wrap; }
    .verification small { width: 100%; margin-inline-start: 0; }
    .event-workbench > header { align-items: start; flex-direction: column; }
    .event-row { grid-template-columns: 48px minmax(0, 1fr) auto; }
    .event-context { grid-column: 2 / -1; }
    .event-buttons { grid-column: 2 / -1; }
    .similar-row { grid-template-columns: 64px minmax(0, 1fr); padding-inline-start: 68px; }
    .similar-row .event-amount, .similar-row .event-buttons { grid-column: 2; text-align: start; }
}
</style>
