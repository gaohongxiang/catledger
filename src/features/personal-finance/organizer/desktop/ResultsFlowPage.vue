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
                        <small>{{ batch.sourceType }} · {{ batch.validRowCount }} {{ tt('personalFinance.organizerV2.rows') }}</small>
                    </span>
                </label>
            </div>
            <div class="empty-actions">
                <v-btn color="primary" size="large" :loading="busy" :disabled="selectedBatchIds.length < 1" @click="createAndOrganize">
                    {{ tt('personalFinance.organizerV2.start.action', { count: selectedBatchIds.length }) }}
                </v-btn>
                <v-btn variant="text" @click="$emit('open-imports')">{{ tt('personalFinance.organizerV2.start.import') }}</v-btn>
            </div>
        </section>

        <template v-else-if="update">
            <section class="result-hero">
                <div class="result-hero__copy">
                    <div class="result-kicker">{{ tt('personalFinance.organizerV2.result.eyebrow') }} · #{{ update.id }}</div>
                    <h3>{{ resultTitle }}</h3>
                    <p>{{ resultHint }}</p>
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
                </div>
                <div class="result-score" :class="{ warning: update.needsActionEventCount > 0 }">
                    <span>{{ tt('personalFinance.organizerV2.result.finalEvents') }}</span>
                    <strong>{{ update.finalEventCount }}</strong>
                    <small>{{ tt(`personalFinance.organizerV2.status.${update.status}`) }}</small>
                </div>
            </section>

            <section class="result-ledger">
                <button :class="{ active: eventFilter === 'posted' }" @click="eventFilter = 'posted'">
                    <span>{{ tt('personalFinance.organizerV2.metric.posted') }}</span><strong>{{ update.postedEventCount }}</strong>
                </button>
                <button :class="{ active: eventFilter === 'ready' }" @click="eventFilter = 'ready'">
                    <span>{{ tt('personalFinance.organizerV2.metric.ready') }}</span><strong>{{ update.readyEventCount }}</strong>
                </button>
                <button class="attention" :class="{ active: eventFilter === 'needs_action' }" @click="eventFilter = 'needs_action'">
                    <span>{{ tt('personalFinance.organizerV2.metric.needsAction') }}</span><strong>{{ update.needsActionEventCount }}</strong>
                </button>
                <button :class="{ active: eventFilter === 'excluded' }" @click="eventFilter = 'excluded'">
                    <span>{{ tt('personalFinance.organizerV2.metric.excluded') }}</span><strong>{{ update.excludedEventCount }}</strong>
                </button>
            </section>

            <section class="conservation" :class="{ invalid: !conservationHolds }">
                <div>
                    <span>{{ tt('personalFinance.organizerV2.conservation.evidence') }}</span>
                    <strong>{{ update.validEvidenceCount }}</strong>
                </div>
                <b>−</b>
                <div>
                    <span>{{ tt('personalFinance.organizerV2.conservation.duplicates') }}</span>
                    <strong>{{ update.duplicateEvidenceCount }}</strong>
                </div>
                <b>=</b>
                <div>
                    <span>{{ tt('personalFinance.organizerV2.conservation.events') }}</span>
                    <strong>{{ update.finalEventCount }}</strong>
                </div>
                <small>{{ tt(conservationHolds ? 'personalFinance.organizerV2.conservation.ok' : 'personalFinance.organizerV2.conservation.invalid') }}</small>
            </section>

            <section class="event-workbench">
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
                    <article :key="event.id" v-for="event in events">
                        <div class="event-date">
                            <strong>{{ eventDay(event.eventUnixTime) }}</strong>
                            <span>{{ eventMonth(event.eventUnixTime) }}</span>
                        </div>
                        <div class="event-main">
                            <span class="event-nature">{{ tt(`personalFinance.organizerV2.nature.${event.economicNature}`) }}</span>
                            <strong>{{ eventDisplayLabel(event) }}</strong>
                            <small v-if="eventReasonCodes(event).length">{{ eventReasonCodes(event).join(' · ') }}</small>
                        </div>
                        <div class="event-amount" :class="event.flowDirection">
                            {{ formatEventAmount(event) }}
                            <small>{{ tt(`personalFinance.organizerV2.status.${event.status}`) }}</small>
                        </div>
                        <div class="event-buttons">
                            <v-btn size="small" variant="text" @click="openEvidence(event)">{{ tt('personalFinance.organizerV2.events.evidence') }}</v-btn>
                            <v-btn size="small" variant="outlined" color="warning" v-if="event.status === 'needs_action'" @click="openResolve(event)">
                                {{ tt('personalFinance.organizerV2.events.resolve') }}
                            </v-btn>
                        </div>
                    </article>
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

        <v-dialog max-width="520" v-model="showResolve">
            <v-card>
                <v-card-title>{{ tt('personalFinance.organizerV2.resolve.title') }}</v-card-title>
                <v-card-text>
                    <p>{{ tt('personalFinance.organizerV2.resolve.hint') }}</p>
                    <v-select :items="natureOptions" item-title="title" item-value="value" variant="outlined" v-model="selectedNature" />
                </v-card-text>
                <v-card-actions>
                    <v-btn color="warning" variant="text" :loading="busy" @click="excludeSelected">{{ tt('personalFinance.organizerV2.resolve.exclude') }}</v-btn>
                    <v-spacer />
                    <v-btn variant="text" @click="showResolve = false">{{ tt('Cancel') }}</v-btn>
                    <v-btn color="primary" :loading="busy" @click="resolveSelected">{{ tt('personalFinance.organizerV2.resolve.save') }}</v-btn>
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

import { usePersonalFinanceStore } from '../../store.ts';
import type { EconomicEvent, EconomicEventStatus, EconomicNature, FinanceUpdate, OrganizerEventEvidence, OrganizerImpact } from '../models.ts';
import { organizerApi } from '../service.ts';
import { RESULT_UPDATE_STATUSES, canOrganizeUpdate, canPostUpdate, canUndoUpdate, eventDisplayLabel, eventReasonCodes, selectCurrentUpdate, updateConservationHolds } from '../state.ts';

defineEmits<{ (e: 'open-imports'): void }>();

const { tt, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
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
const showEvidence = ref(false);
const evidence = ref<OrganizerEventEvidence>();
const showResolve = ref(false);
const selectedEvent = ref<EconomicEvent>();
const selectedNature = ref<EconomicNature>('expense');
const showUndo = ref(false);
const undoImpact = ref<OrganizerImpact>();
const visibleFilters: readonly EconomicEventStatus[] = ['needs_action', 'ready', 'posted', 'excluded'];
const natures: readonly EconomicNature[] = ['expense', 'income', 'refund', 'fee', 'repayment', 'borrow', 'internal_transfer', 'balance_adjustment'];
const readyBatches = computed(() => personalFinanceStore.batches.filter(batch => batch.status === 'ready'));
const conservationHolds = computed(() => !!update.value && updateConservationHolds(update.value));
const natureOptions = computed(() => natures.map(value => ({ value, title: tt(`personalFinance.organizerV2.nature.${value}`) })));
const resultTitle = computed(() => update.value?.needsActionEventCount
    ? tt('personalFinance.organizerV2.result.needsAction', { count: update.value.needsActionEventCount })
    : tt('personalFinance.organizerV2.result.ready'));
const resultHint = computed(() => update.value?.needsActionEventCount
    ? tt('personalFinance.organizerV2.result.needsActionHint') : tt('personalFinance.organizerV2.result.readyHint'));

watch(eventFilter, loadEvents);

function idempotencyKey(action: string): string { return `pf-organizer-ui-v2:${action}:${generateRandomUUID()}`; }
function toggleBatch(id: string): void {
    selectedBatchIds.value = selectedBatchIds.value.includes(id)
        ? selectedBatchIds.value.filter(value => value !== id) : [...selectedBatchIds.value, id];
}
function eventDay(unixTime?: number): string { return unixTime ? String(new Date(unixTime * 1000).getDate()).padStart(2, '0') : '—'; }
function eventMonth(unixTime?: number): string { return unixTime ? new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(unixTime * 1000)) : ''; }
function formatEventAmount(event: EconomicEvent): string {
    return event.amount ? formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(event.amount), event.currency) : '—';
}
function directionForNature(nature: EconomicNature): EconomicEvent['flowDirection'] {
    if (nature === 'income' || nature === 'borrow' || nature === 'refund') return 'inflow';
    if (nature === 'internal_transfer' || nature === 'balance_adjustment') return 'neutral';
    return 'outflow';
}

async function load(): Promise<void> {
    loading.value = true;
    showError.value = false;
    try {
        const pages = await Promise.all(RESULT_UPDATE_STATUSES.map(status => organizerApi.listUpdates(status)));
        update.value = selectCurrentUpdate(pages.map(page => [...page.items]));
        await personalFinanceStore.loadBatches(0, 100);
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
    try { events.value = (await organizerApi.listEvents(update.value.id, eventFilter.value)).items; }
    catch { showError.value = true; }
    finally { loadingEvents.value = false; }
}
function startNewUpdate(): void { update.value = undefined; events.value = []; selectedBatchIds.value = []; }

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
function openResolve(event: EconomicEvent): void { selectedEvent.value = event; selectedNature.value = event.economicNature === 'unknown' ? 'expense' : event.economicNature; showResolve.value = true; }
async function resolveSelected(): Promise<void> {
    if (!update.value || !selectedEvent.value) return;
    const currentUpdate = update.value; const currentEvent = selectedEvent.value;
    await runMutation(() => organizerApi.correctEvent({
        updateId: currentUpdate.id, eventId: currentEvent.id, expectedUpdateVersion: currentUpdate.version,
        expectedEventVersion: currentEvent.version, idempotencyKey: idempotencyKey('resolve'),
        fieldMask: 4 | 8 | 256, status: 'ready', economicNature: selectedNature.value,
        flowDirection: directionForNature(selectedNature.value)
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
.results-flow { --rule: rgba(var(--v-theme-on-surface), .12); display: grid; gap: 16px; }
.empty-stage { min-height: 430px; padding: clamp(28px, 5vw, 64px); border: 1px solid var(--rule); border-radius: 6px 28px 6px 28px; background: linear-gradient(125deg, rgba(var(--v-theme-primary), .09), transparent 48%), rgb(var(--v-theme-surface)); }
.empty-copy { max-width: 720px; }
.empty-copy span, .result-kicker, .event-workbench header span { color: rgb(var(--v-theme-primary)); font-size: .7rem; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
.empty-copy h3, .result-hero h3 { margin: 7px 0 0; font-size: clamp(1.8rem, 4vw, 3.1rem); letter-spacing: -.045em; line-height: 1.05; }
.empty-copy p, .result-hero p { max-width: 700px; color: rgba(var(--v-theme-on-surface), .65); line-height: 1.7; }
.source-picker { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; margin-top: 28px; }
.source-picker label { display: flex; gap: 10px; padding: 14px; border: 1px solid var(--rule); background: rgb(var(--v-theme-surface)); cursor: pointer; }
.source-picker label.selected { border-color: rgb(var(--v-theme-primary)); box-shadow: inset 3px 0 rgb(var(--v-theme-primary)); }
.source-picker span { display: grid; gap: 4px; min-width: 0; }
.source-picker strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-picker small { color: rgba(var(--v-theme-on-surface), .58); }
.empty-actions, .result-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 26px; }
.result-hero { display: grid; grid-template-columns: minmax(0, 1fr) 210px; gap: 28px; padding: clamp(24px, 4vw, 44px); border-radius: 6px 28px 6px 28px; background: #17352f; color: #f5f1df; }
.result-kicker { color: #9cd7c1; }
.result-hero p { color: rgba(245, 241, 223, .68); }
.result-score { display: flex; flex-direction: column; justify-content: center; padding: 24px; border: 1px solid rgba(245, 241, 223, .24); border-top: 4px solid #79c9aa; }
.result-score.warning { border-top-color: #efb45f; }
.result-score span { font-size: .74rem; opacity: .7; text-transform: uppercase; letter-spacing: .1em; }
.result-score strong { font-size: 4.5rem; line-height: 1; font-variant-numeric: tabular-nums; }
.result-score small { margin-top: 10px; opacity: .72; }
.result-ledger { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid var(--rule); background: var(--rule); gap: 1px; }
.result-ledger button { display: flex; align-items: end; justify-content: space-between; min-height: 100px; padding: 18px; border: 0; background: rgb(var(--v-theme-surface)); color: inherit; cursor: pointer; text-align: start; }
.result-ledger button.active { box-shadow: inset 0 4px rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .055); }
.result-ledger button.attention.active { box-shadow: inset 0 4px rgb(var(--v-theme-warning)); }
.result-ledger span { color: rgba(var(--v-theme-on-surface), .62); font-size: .78rem; }
.result-ledger strong { font-size: 2rem; font-variant-numeric: tabular-nums; }
.conservation { display: grid; grid-template-columns: 1fr auto 1fr auto 1fr minmax(200px, .8fr); gap: 16px; align-items: center; padding: 14px 20px; border-inline-start: 4px solid rgb(var(--v-theme-success)); background: rgba(var(--v-theme-success), .07); }
.conservation.invalid { border-color: rgb(var(--v-theme-error)); background: rgba(var(--v-theme-error), .07); }
.conservation div { display: flex; justify-content: space-between; gap: 8px; }
.conservation span, .conservation small { color: rgba(var(--v-theme-on-surface), .62); }
.event-workbench { border: 1px solid var(--rule); border-radius: 18px 4px 18px 4px; background: rgb(var(--v-theme-surface)); overflow: hidden; }
.event-workbench > header { display: flex; align-items: end; justify-content: space-between; gap: 20px; padding: 22px; border-bottom: 1px solid var(--rule); background: rgba(var(--v-theme-primary), .045); }
.event-workbench h3 { margin: 4px 0 0; font-size: 1.35rem; }
.event-workbench header p { margin: 4px 0 0; color: rgba(var(--v-theme-on-surface), .6); font-size: .82rem; }
.event-list article { display: grid; grid-template-columns: 58px minmax(0, 1fr) minmax(140px, auto) auto; gap: 16px; align-items: center; padding: 15px 20px; border-bottom: 1px solid var(--rule); }
.event-list article:last-child { border-bottom: 0; }
.event-date { display: grid; text-align: center; border-inline-end: 1px solid var(--rule); }
.event-date strong { font-size: 1.45rem; line-height: 1; }
.event-date span { margin-top: 4px; color: rgba(var(--v-theme-on-surface), .52); font-size: .64rem; text-transform: uppercase; }
.event-main { display: grid; gap: 3px; min-width: 0; }
.event-main > strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.event-main small { color: rgba(var(--v-theme-on-surface), .5); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.event-nature { color: rgb(var(--v-theme-primary)); font-size: .68rem; font-weight: 750; }
.event-amount { display: grid; text-align: end; font-weight: 750; font-variant-numeric: tabular-nums; }
.event-amount.inflow { color: rgb(var(--v-theme-success)); }
.event-amount.outflow { color: rgb(var(--v-theme-error)); }
.event-amount small { color: rgba(var(--v-theme-on-surface), .5); font-size: .66rem; font-weight: 500; }
.event-buttons { display: flex; gap: 5px; }
.event-empty { padding: 56px; color: rgba(var(--v-theme-on-surface), .56); text-align: center; }
.evidence-list { display: grid; gap: 8px; }
.evidence-list article { display: grid; gap: 3px; padding: 13px; border-inline-start: 3px solid rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .055); }
.evidence-list span, .evidence-list small { color: rgba(var(--v-theme-on-surface), .62); }
@media (max-width: 900px) {
    .result-hero { grid-template-columns: 1fr; }
    .result-ledger { grid-template-columns: repeat(2, 1fr); }
    .conservation { grid-template-columns: 1fr auto 1fr auto 1fr; }
    .conservation small { grid-column: 1 / -1; }
    .event-workbench > header { align-items: start; flex-direction: column; }
    .event-list article { grid-template-columns: 48px minmax(0, 1fr) auto; }
    .event-buttons { grid-column: 2 / -1; }
}
</style>
