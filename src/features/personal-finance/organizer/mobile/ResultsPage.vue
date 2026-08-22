<template>
    <f7-page ptr @ptr:refresh="pullRefresh">
        <f7-navbar :title="tt('personalFinance.organizerV2.mobile.title')" :back-link="tt('Back')" />

        <f7-block class="text-align-center" v-if="loading && !update"><f7-preloader /></f7-block>
        <f7-block strong inset class="mobile-error" v-else-if="error">{{ tt('personalFinance.organizerV2.error') }}</f7-block>

        <template v-if="update">
            <f7-block strong inset class="result-head" :class="{ warning: update.needsActionEventCount > 0 }">
                <div class="result-kicker">{{ tt('personalFinance.organizerV2.result.eyebrow') }} · #{{ update.id }}</div>
                <h2>{{ update.needsActionEventCount ? tt('personalFinance.organizerV2.result.needsAction', { count: update.needsActionEventCount }) : tt('personalFinance.organizerV2.result.ready') }}</h2>
                <p>{{ tt(`personalFinance.organizerV2.status.${update.status}`) }}</p>
            </f7-block>

            <div class="metric-grid">
                <button @click="selectFilter('posted')"><span>{{ tt('personalFinance.organizerV2.metric.posted') }}</span><strong>{{ update.postedEventCount }}</strong></button>
                <button @click="selectFilter('ready')"><span>{{ tt('personalFinance.organizerV2.metric.ready') }}</span><strong>{{ update.readyEventCount }}</strong></button>
                <button class="attention" @click="selectFilter('needs_action')"><span>{{ tt('personalFinance.organizerV2.metric.needsAction') }}</span><strong>{{ update.needsActionEventCount }}</strong></button>
                <button @click="selectFilter('excluded')"><span>{{ tt('personalFinance.organizerV2.metric.excluded') }}</span><strong>{{ update.excludedEventCount }}</strong></button>
            </div>

            <f7-block strong inset class="conservation" :class="{ invalid: !conservationHolds }">
                <strong>{{ update.validEvidenceCount }} − {{ update.duplicateEvidenceCount }} = {{ update.finalEventCount }}</strong>
                <span>{{ tt(conservationHolds ? 'personalFinance.organizerV2.conservation.ok' : 'personalFinance.organizerV2.conservation.invalid') }}</span>
            </f7-block>

            <f7-block-title>{{ tt(`personalFinance.organizerV2.filter.${eventFilter}`) }}</f7-block-title>
            <f7-list strong inset media-list dividers v-if="events.length">
                <f7-list-item :key="event.id" :title="eventDisplayLabel(event)" :subtitle="tt(`personalFinance.organizerV2.nature.${event.economicNature}`)"
                              :after="formatEventAmount(event)" v-for="event in events" />
            </f7-list>
            <f7-block strong inset v-else>{{ tt('personalFinance.organizerV2.events.empty') }}</f7-block>
            <f7-block><f7-button fill href="/personal-finance/imports">{{ tt('personalFinance.organizerV2.mobile.desktopAction') }}</f7-button></f7-block>
        </template>

        <template v-else-if="!loading">
            <f7-block strong inset class="empty-block">
                <h2>{{ tt('personalFinance.organizerV2.start.title') }}</h2>
                <p>{{ tt('personalFinance.organizerV2.start.hint') }}</p>
            </f7-block>
            <f7-block><f7-button fill href="/personal-finance/imports">{{ tt('personalFinance.organizerV2.start.import') }}</f7-button></f7-block>
        </template>
    </f7-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { f7 } from 'framework7-vue';

import { useI18n } from '@/locales/helpers.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';

import type { EconomicEvent, EconomicEventStatus, FinanceUpdate } from '../models.ts';
import { organizerApi } from '../service.ts';
import { RESULT_UPDATE_STATUSES, eventDisplayLabel, selectCurrentUpdate, updateConservationHolds } from '../state.ts';

const { tt, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
const loading = ref(false);
const error = ref(false);
const update = ref<FinanceUpdate>();
const events = ref<readonly EconomicEvent[]>([]);
const eventFilter = ref<EconomicEventStatus>('needs_action');
const conservationHolds = computed(() => !!update.value && updateConservationHolds(update.value));

function formatEventAmount(event: EconomicEvent): string {
    return event.amount ? formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(event.amount), event.currency) : '—';
}
async function load(): Promise<void> {
    loading.value = true; error.value = false;
    try {
        const pages = await Promise.all(RESULT_UPDATE_STATUSES.map(status => organizerApi.listUpdates(status)));
        update.value = selectCurrentUpdate(pages.map(page => [...page.items]));
        events.value = update.value ? (await organizerApi.listEvents(update.value.id, eventFilter.value)).items : [];
    } catch { error.value = true; }
    finally { loading.value = false; }
}
async function selectFilter(filter: EconomicEventStatus): Promise<void> { eventFilter.value = filter; await load(); }
async function pullRefresh(done?: () => void): Promise<void> {
    try { await load(); } finally { done?.(); }
}

onMounted(async () => {
    await load();
    if (error.value) f7.toast.create({ text: tt('personalFinance.organizerV2.error'), closeTimeout: 3000 }).open();
});
</script>

<style scoped>
.result-head { border-radius: 18px 5px 18px 5px; border-inline-start: 4px solid var(--f7-color-green); }
.result-head.warning { border-inline-start-color: var(--f7-color-orange); }
.result-head h2 { margin: 5px 0; font-size: 1.55rem; letter-spacing: -.035em; }
.result-head p { margin-bottom: 0; color: var(--f7-text-color-secondary); }
.result-kicker { color: var(--f7-theme-color); font-size: .67rem; font-weight: 800; letter-spacing: .11em; text-transform: uppercase; }
.metric-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 0 16px; }
.metric-grid button { display: flex; align-items: end; justify-content: space-between; min-height: 78px; padding: 13px; border: 0; border-radius: 5px 14px 5px 14px; background: var(--f7-block-strong-bg-color); color: var(--f7-text-color); text-align: start; }
.metric-grid button.attention { box-shadow: inset 0 3px var(--f7-color-orange); }
.metric-grid span { max-width: 70%; color: var(--f7-text-color-secondary); font-size: .7rem; }
.metric-grid strong { font-size: 1.65rem; }
.conservation { display: flex; justify-content: space-between; gap: 12px; border-inline-start: 3px solid var(--f7-color-green); }
.conservation.invalid { border-color: var(--f7-color-red); }
.conservation span { color: var(--f7-text-color-secondary); font-size: .72rem; }
.mobile-error { color: var(--f7-color-red); border-inline-start: 3px solid var(--f7-color-red); }
.empty-block h2 { margin: 0; }
.empty-block p { color: var(--f7-text-color-secondary); }
</style>
