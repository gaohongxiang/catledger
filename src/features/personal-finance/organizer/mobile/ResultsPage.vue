<template>
    <f7-page ptr @ptr:refresh="pullRefresh">
        <f7-navbar :title="tt('personalFinance.organizerV2.mobile.title')" :back-link="tt('Back')" />

        <f7-block class="text-align-center" v-if="loading && !update"><f7-preloader /></f7-block>
        <f7-block strong inset class="mobile-error" v-else-if="error">{{ tt('personalFinance.organizerV2.error') }}</f7-block>

        <template v-if="update">
            <f7-block strong inset class="result-head" :class="{ warning: update.needsActionEventCount > 0 }">
                <div class="result-kicker">{{ tt('personalFinance.organizerV2.result.eyebrow') }}</div>
                <h2>{{ update.needsActionEventCount ? `${reviewIssues.length || update.needsActionEventCount} 个问题待处理` : tt('personalFinance.organizerV2.result.ready') }}</h2>
                <p>一张卡片只问一个决定；批量处理不会合并独立交易。</p>
            </f7-block>

            <div class="metric-grid">
                <button @click="selectFilter('posted')"><span>{{ tt('personalFinance.organizerV2.metric.posted') }}</span><strong>{{ update.postedEventCount }}</strong></button>
                <button @click="selectFilter('ready')"><span>{{ tt('personalFinance.organizerV2.metric.ready') }}</span><strong>{{ update.readyEventCount }}</strong></button>
                <button class="attention" @click="selectFilter('needs_action')"><span>必须处理的问题</span><strong>{{ reviewIssues.length || update.needsActionEventCount }}</strong></button>
                <button @click="selectFilter('excluded')"><span>{{ tt('personalFinance.organizerV2.metric.excluded') }}</span><strong>{{ update.excludedEventCount }}</strong></button>
            </div>

            <f7-block strong inset class="conservation" :class="{ invalid: !conservationHolds }">
                <strong>
                    {{ update.validEvidenceCount }} {{ tt('personalFinance.organizerV2.conservation.evidence') }} −
                    {{ update.duplicateEvidenceCount }} {{ tt('personalFinance.organizerV2.conservation.duplicates') }} =
                    {{ update.finalEventCount }} {{ tt('personalFinance.organizerV2.conservation.events') }}
                </strong>
                <span>{{ tt(conservationHolds ? 'personalFinance.organizerV2.conservation.ok' : 'personalFinance.organizerV2.conservation.invalid') }}</span>
            </f7-block>

            <template v-if="eventFilter === 'needs_action' && reviewIssues.length">
                <f7-block-title>必须处理</f7-block-title>
                <f7-card class="issue-card" :key="issue.id" v-for="issue in sortedReviewIssues">
                    <f7-card-header>
                        <div><small>{{ issueLabel(issue) }}</small><strong>{{ issueTitle(issue) }}</strong></div>
                        <span>{{ tt('personalFinance.organizerV2.issue.count', { count: issuePresentation(issue).count }) }}</span>
                    </f7-card-header>
                    <f7-card-content>
                        <div class="issue-event" :key="event.id" v-for="event in issueEvents(issue)">
                            <div><strong>{{ eventDisplayLabel(event) || tt('personalFinance.organizerV2.events.unnamed') }}</strong><small>{{ mobileEventDetail(event) }}</small></div>
                            <b>{{ formatEventAmount(event) }}</b>
                        </div>
                    </f7-card-content>
                    <f7-card-footer v-if="issue.type === 'same_event'">
                        <f7-button fill small :disabled="busy" @click="confirmSame(issue)">同一笔</f7-button>
                        <f7-button outline small :disabled="busy" @click="confirmDistinct(issue)">多笔独立</f7-button>
                    </f7-card-footer>
                    <f7-card-footer v-else>
                        <span>{{ issueHint(issue) }}</span>
                        <f7-link href="/personal-finance/imports">处理</f7-link>
                    </f7-card-footer>
                </f7-card>
            </template>

            <template v-else>
                <f7-block-title>{{ tt(`personalFinance.organizerV2.filter.${eventFilter}`) }}</f7-block-title>
                <f7-list strong inset media-list dividers v-if="events.length">
                    <f7-list-item :key="event.id" :title="eventDisplayLabel(event) || tt('personalFinance.organizerV2.events.unnamed')" :subtitle="tt(`personalFinance.organizerV2.nature.${event.economicNature}`)"
                                  :text="mobileEventDetail(event)" :after="formatEventAmount(event)" v-for="event in events" />
                </f7-list>
                <f7-block strong inset v-else>{{ tt('personalFinance.organizerV2.events.empty') }}</f7-block>
            </template>

            <f7-block><f7-button fill href="/personal-finance/imports">打开完整问题工作台</f7-button></f7-block>
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
import { generateRandomUUID } from '@/lib/misc.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';

import type { EconomicEvent, EconomicEventStatus, FinanceUpdate, ReviewIssue, ReviewIssueMember } from '../models.ts';
import { organizerApi } from '../service.ts';
import { RESULT_UPDATE_STATUSES, eventDisplayLabel, reviewIssuePresentation, selectCurrentUpdate, sortEconomicEventsOldestFirst, updateConservationHolds } from '../state.ts';

const { tt, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
const loading = ref(false);
const busy = ref(false);
const error = ref(false);
const update = ref<FinanceUpdate>();
const events = ref<readonly EconomicEvent[]>([]);
const reviewIssues = ref<readonly ReviewIssue[]>([]);
const reviewMembers = ref<readonly ReviewIssueMember[]>([]);
const eventFilter = ref<EconomicEventStatus>('needs_action');
const conservationHolds = computed(() => !!update.value && updateConservationHolds(update.value));
const eventMap = computed(() => new Map(events.value.map(event => [event.id, event])));
const membersByIssue = computed(() => {
    const result = new Map<string, ReviewIssueMember[]>();
    for (const member of reviewMembers.value) {
        const values = result.get(member.issueId) ?? [];
        values.push(member);
        result.set(member.issueId, values);
    }
    return result;
});
const sortedReviewIssues = computed(() => [...reviewIssues.value].sort((left, right) => {
    const leftEvent = issueEvents(left)[0];
    const rightEvent = issueEvents(right)[0];
    return (leftEvent?.eventUnixTime ?? Number.MAX_SAFE_INTEGER) - (rightEvent?.eventUnixTime ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id);
}));

function formatEventAmount(event: EconomicEvent): string {
    return event.amount ? formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(event.amount), event.currency) : '—';
}
function mobileEventDetail(event: EconomicEvent): string {
    const title = eventDisplayLabel(event);
    return [...new Set([event.item !== title ? event.item : '', event.paymentMethod, `${event.evidenceCount} 条来源记录`].filter(Boolean))].join(' · ');
}
function issueEvents(issue: ReviewIssue): EconomicEvent[] {
    return sortEconomicEventsOldestFirst((membersByIssue.value.get(issue.id) ?? []).filter(member => member.role === 'subject' && member.objectType === 'event')
        .map(member => eventMap.value.get(member.objectId)).filter((event): event is EconomicEvent => !!event));
}
function issueLabel(issue: ReviewIssue): string {
    return tt(issuePresentation(issue).labelKey);
}
function issueTitle(issue: ReviewIssue): string {
    const values = issueEvents(issue);
    return values.length === 1 ? eventDisplayLabel(values[0] as EconomicEvent) || '未命名交易' : `${values.length} 笔记录需要一个决定`;
}
function issueHint(issue: ReviewIssue): string {
    const presentation = issuePresentation(issue);
    return tt(presentation.hintKey, { count: presentation.count });
}
function issuePresentation(issue: ReviewIssue) { return reviewIssuePresentation(issue, issueEvents(issue)); }
function idempotencyKey(action: string): string { return `pf-review-mobile-v1:${action}:${generateRandomUUID()}`; }
async function listAllEvents(updateId: string, status: EconomicEventStatus): Promise<EconomicEvent[]> {
    const result: EconomicEvent[] = [];
    let cursor: { updatedUnixTime: number; eventId: string } | undefined;
    do {
        const page = await organizerApi.listEvents(updateId, status, 100, cursor);
        result.push(...page.items);
        cursor = page.nextCursor;
    } while (cursor);
    return sortEconomicEventsOldestFirst(result);
}
async function load(): Promise<void> {
    loading.value = true; error.value = false;
    try {
        const pages = await Promise.all(RESULT_UPDATE_STATUSES.map(status => organizerApi.listUpdates(status)));
        update.value = selectCurrentUpdate(pages.map(page => [...page.items]));
        if (!update.value) { events.value = []; reviewIssues.value = []; reviewMembers.value = []; return; }
        if (eventFilter.value === 'needs_action') {
            const [eventItems, issuePage] = await Promise.all([listAllEvents(update.value.id, 'needs_action'), organizerApi.listReviewIssues(update.value.id)]);
            events.value = eventItems; reviewIssues.value = issuePage.items; reviewMembers.value = issuePage.members;
        } else {
            events.value = await listAllEvents(update.value.id, eventFilter.value);
            reviewIssues.value = []; reviewMembers.value = [];
        }
    } catch { error.value = true; }
    finally { loading.value = false; }
}
async function selectFilter(filter: EconomicEventStatus): Promise<void> { eventFilter.value = filter; await load(); }
async function resolve(issue: ReviewIssue, decision: 'confirm_same' | 'confirm_distinct', primaryEventId?: string): Promise<void> {
    if (!update.value) return;
    busy.value = true;
    try {
        await organizerApi.resolveReviewIssue({ updateId: update.value.id, issueId: issue.id, expectedUpdateVersion: update.value.version, expectedIssueVersion: issue.version, idempotencyKey: idempotencyKey(decision), decision, primaryEventId });
        await load();
    } catch { error.value = true; }
    finally { busy.value = false; }
}
async function confirmSame(issue: ReviewIssue): Promise<void> { const primary = issueEvents(issue)[0]; if (primary) await resolve(issue, 'confirm_same', primary.id); }
async function confirmDistinct(issue: ReviewIssue): Promise<void> { await resolve(issue, 'confirm_distinct'); }
async function pullRefresh(done?: () => void): Promise<void> { try { await load(); } finally { done?.(); } }

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
.issue-card { margin-inline: 16px; }
.issue-card :deep(.card-header) { align-items: start; }
.issue-card :deep(.card-header) > div { display: grid; }
.issue-card :deep(.card-header) small { color: var(--f7-color-orange); font-weight: 700; }
.issue-card :deep(.card-header) span { color: var(--f7-text-color-secondary); font-size: .72rem; }
.issue-event { display: flex; align-items: start; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid var(--f7-list-item-border-color); }
.issue-event:first-child { border-top: 0; }
.issue-event > div { display: grid; min-width: 0; }
.issue-event small { color: var(--f7-text-color-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.issue-event b { white-space: nowrap; }
.mobile-error { color: var(--f7-color-red); border-inline-start: 3px solid var(--f7-color-red); }
.empty-block h2 { margin: 0; }
.empty-block p { color: var(--f7-text-color-secondary); }
</style>
