<template>
    <div class="results-flow">
        <v-alert type="error" variant="tonal" closable v-model="showError">
            {{ tt('personalFinance.organizerV2.error') }}
        </v-alert>

        <section class="empty-stage" v-if="!update && !loading">
            <div>
                <span class="kicker">{{ tt('personalFinance.organizerV2.start.eyebrow') }}</span>
                <h2>{{ tt('personalFinance.organizerV2.start.title') }}</h2>
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
            <div class="actions">
                <import-upload-button size="large" @changed="onImportChanged" />
                <v-btn color="primary" size="large" :loading="busy" :disabled="selectedBatchIds.length < 1" @click="createAndOrganize">
                    {{ tt('personalFinance.organizerV2.start.action', { count: selectedBatchIds.length }) }}
                </v-btn>
            </div>
        </section>

        <template v-else-if="update">
            <section class="overview-card">
                <div class="steps">
                    <button @click="activeWorkflowStep = 1" :class="{ active: activeWorkflowStep === 1 }">
                        <b>1</b><span>{{ tt('personalFinance.organizerV2.workflow.upload') }}<strong>{{ update.sourceCount }}</strong></span>
                    </button>
                    <button class="attention" @click="showEventStep('needs_action')" :class="{ active: activeWorkflowStep === 2 }">
                        <b>2</b><span>{{ tt('personalFinance.organizerV2.workflow.review') }}<strong>{{ issueGroupCount }}</strong><small>{{ update.needsActionEventCount }} 笔记录</small></span>
                    </button>
                    <button @click="showEventStep('ready')" :class="{ active: activeWorkflowStep === 3 }">
                        <b>3</b><span>{{ tt('personalFinance.organizerV2.workflow.ready') }}<strong>{{ update.readyEventCount }}</strong></span>
                    </button>
                </div>
                <footer>
                    <div class="overview-controls" v-if="activeWorkflowStep !== 1">
                        <v-btn-toggle density="compact" divided mandatory variant="outlined" v-model="eventFilter">
                            <v-btn :value="filter" :key="filter" v-for="filter in visibleFilters">
                                {{ tt(`personalFinance.organizerV2.filter.${filter}`) }} <b>{{ eventFilterCount(filter) }}</b>
                            </v-btn>
                        </v-btn-toggle>
                        <small class="conservation-inline" :class="{ invalid: !conservationHolds }">
                            {{ tt('personalFinance.organizerV2.audit.compactConservation', { evidence: update.validEvidenceCount, supporting: update.duplicateEvidenceCount, events: update.finalEventCount, excluded: update.excludedEventCount, ready: update.readyEventCount, pending: update.needsActionEventCount, posted: update.postedEventCount }) }}
                        </small>
                    </div>
                    <small class="round-meta">#{{ update.id }} · {{ tt(`personalFinance.organizerV2.status.${update.status}`) }} · {{ syncLabel }}</small>
                    <div class="actions" v-if="(update.needsActionEventCount > 0 && activeWorkflowStep !== 2) || canPostUpdate(update) || canUndoUpdate(update)">
                        <v-btn color="primary" v-if="update.needsActionEventCount > 0 && activeWorkflowStep !== 2" @click="showEventStep('needs_action')">
                            {{ tt('personalFinance.organizerV2.action.continueReview', { count: issueGroupCount }) }}
                        </v-btn>
                        <v-btn color="primary" :loading="busy" v-else-if="canPostUpdate(update)" @click="postAllReady">
                            {{ tt('personalFinance.organizerV2.action.confirmAndPost', { count: update.readyEventCount }) }}
                        </v-btn>
                        <v-btn variant="text" color="warning" v-if="canUndoUpdate(update)" @click="inspectUndo">
                            {{ tt('personalFinance.organizerV2.action.undo') }}
                        </v-btn>
                    </div>
                </footer>
            </section>

            <section class="source-stage" v-if="activeWorkflowStep === 1">
                <header>
                    <div><h3>{{ tt('personalFinance.organizerV2.sources.title') }}</h3><p>{{ tt('personalFinance.organizerV2.sources.lockedHint') }}</p></div>
                    <v-btn variant="outlined" color="warning" v-if="canAbandonUpdate(update)" @click="showAbandon = true">
                        {{ tt('personalFinance.organizerV2.action.abandonAndReselect') }}
                    </v-btn>
                    <import-upload-button v-else-if="update.status === 'posted' || update.status === 'undone'" @changed="onImportChanged" />
                </header>
                <article :key="item.source.id" v-for="item in currentSources">
                    <div><strong>{{ item.batch?.file?.originalFileName || tt(getSourceTypeKey(item.source.sourceType)) }}</strong><small>{{ tt(getSourceTypeKey(item.source.sourceType)) }} · {{ item.batch?.validRowCount ?? 0 }} 条</small></div>
                    <span>{{ tt('personalFinance.organizerV2.sources.selected') }}</span>
                </article>
            </section>

            <section class="evidence-audit" v-if="activeWorkflowStep !== 1 && eventFilter === 'audit'">
                <header>
                    <div>
                        <span class="kicker">{{ tt('personalFinance.organizerV2.audit.eyebrow') }}</span>
                        <h3>{{ tt('personalFinance.organizerV2.audit.title') }}</h3>
                        <p>{{ tt('personalFinance.organizerV2.audit.hint') }}</p>
                    </div>
                    <div class="audit-total">
                        <strong>{{ update.duplicateEvidenceCount }}</strong>
                        <span>{{ tt('personalFinance.organizerV2.audit.additionalEvidence') }}</span>
                        <small>{{ tt('personalFinance.organizerV2.audit.groupCount', { count: auditEvents.length }) }}</small>
                    </div>
                </header>
                <v-skeleton-loader type="list-item-two-line@4" v-if="loadingAudit" />
                <div class="audit-list" v-else-if="auditEvents.length">
                    <article :key="event.id" v-for="event in visibleAuditEvents">
                        <div class="audit-kind">
                            <span>{{ auditGroupLabel(event) }}</span>
                            <small>{{ auditGroupEquation(event) }}</small>
                        </div>
                        <time><b>{{ eventDay(event.eventUnixTime) }}</b><small>{{ eventMonth(event.eventUnixTime) }}</small></time>
                        <div class="audit-result">
                            <strong>{{ eventDisplayLabel(event) || tt('personalFinance.organizerV2.events.unnamed') }}</strong>
                            <small>{{ eventAccountName(event) }} · {{ tt(`personalFinance.organizerV2.nature.${event.economicNature}`) }} · {{ eventCategoryName(event) }}</small>
                        </div>
                        <p>{{ auditGroupRule(event) }}</p>
                        <b class="amount" :class="event.flowDirection">{{ formatEventAmount(event) }}</b>
                        <v-btn class="raw-record-action" size="small" variant="text" @click="openEvidence(event)">{{ tt('personalFinance.organizerV2.audit.reviewRecords', { count: event.evidenceCount }) }}</v-btn>
                    </article>
                </div>
                <footer v-if="auditEvents.length > auditPreviewLimit">
                    <v-btn size="small" variant="text" color="primary" @click="showAllAuditEvents = !showAllAuditEvents">
                        {{ tt(showAllAuditEvents ? 'personalFinance.organizerV2.audit.collapse' : 'personalFinance.organizerV2.audit.showAll', { count: auditEvents.length }) }}
                    </v-btn>
                </footer>
                <p class="audit-empty" v-if="!loadingAudit && !auditEvents.length">{{ tt('personalFinance.organizerV2.audit.empty') }}</p>
            </section>

            <section class="workbench" v-if="activeWorkflowStep !== 1 && eventFilter !== 'audit'">
                <header>
                    <div><span class="kicker">{{ tt('personalFinance.organizerV2.events.eyebrow') }}</span><h3>{{ eventFilter === 'needs_action' ? '必须处理的问题' : tt(`personalFinance.organizerV2.filter.${eventFilter}`) }}</h3><p>{{ eventFilter === 'needs_action' ? '一张卡片只问一个决定；相同答案可一次应用，多来源疑似重复必须明确裁决。' : tt('personalFinance.organizerV2.events.hint') }}</p></div>
                </header>

                <v-skeleton-loader type="list-item-three-line@4" v-if="loadingEvents" />

                <div class="issue-list" v-else-if="eventFilter === 'needs_action' && reviewIssues.length">
                    <article class="issue-card" :key="issue.id" v-for="issue in reviewIssues">
                        <header>
                            <div class="issue-heading"><span>{{ reviewIssueLabel(issue) }}</span><small>{{ reviewIssueHint(issue) }}</small></div>
                            <div class="issue-actions">
                                <em>{{ issue.memberCount }} 项</em>
                                <template v-if="issue.type === 'same_event'">
                                    <v-btn size="small" density="compact" color="primary" :loading="busy" @click="confirmSame(issue)">确认是同一笔</v-btn>
                                    <v-btn size="small" density="compact" variant="outlined" :loading="busy" @click="confirmDistinct(issue)">确认是多笔独立交易</v-btn>
                                </template>
                                <v-btn size="small" density="compact" color="primary" :loading="busy" v-else-if="issue.type === 'refund_relation'" @click="openIssueResolve(issue)">选择退款原交易</v-btn>
                                <v-btn size="small" density="compact" color="primary" :loading="busy" v-else @click="openIssueResolve(issue)">{{ issue.memberCount > 1 ? '批量处理' : tt('personalFinance.organizerV2.events.resolve') }}</v-btn>
                                <v-btn size="small" density="compact" color="warning" variant="text" :loading="busy" @click="excludeIssue(issue)">排除本问题中的记录</v-btn>
                            </div>
                        </header>
                        <div class="issue-events">
                            <div class="issue-event" :key="event.id" v-for="event in issueEvents(issue)">
                                <time><b>{{ eventDay(event.eventUnixTime) }}</b><small>{{ eventMonth(event.eventUnixTime) }}</small></time>
                                <div><strong>{{ eventDisplayLabel(event) || tt('personalFinance.organizerV2.events.unnamed') }}</strong><small>{{ eventDescription(event) || eventReasonTranslationKeys(event).map(key => tt(key)).join(' · ') }}</small><span>{{ tt(`personalFinance.organizerV2.nature.${event.economicNature}`) }} · {{ eventAccountName(event) }} · {{ eventCategoryName(event) }}</span></div>
                                <b class="amount" :class="event.flowDirection">{{ formatEventAmount(event) }}</b>
                                <v-btn class="raw-record-action" size="small" variant="text" @click="openEvidence(event)">{{ tt('personalFinance.organizerV2.events.evidenceCount', { count: event.evidenceCount }) }}</v-btn>
                            </div>
                        </div>
                    </article>
                </div>

                <div class="event-list" v-else-if="events.length">
                    <article class="event-row" :key="event.id" v-for="event in events">
                        <time><b>{{ eventDay(event.eventUnixTime) }}</b><small>{{ eventMonth(event.eventUnixTime) }}</small></time>
                        <div><span>{{ tt(`personalFinance.organizerV2.nature.${event.economicNature}`) }}</span><strong>{{ eventDisplayLabel(event) || tt('personalFinance.organizerV2.events.unnamed') }}</strong><small>{{ eventDescription(event) }}</small></div>
                        <div class="context">{{ eventAccountName(event) }} · {{ eventCategoryName(event) }}</div>
                        <b class="amount" :class="event.flowDirection">{{ formatEventAmount(event) }}</b>
                        <v-btn class="raw-record-action" size="small" variant="text" @click="openEvidence(event)">{{ tt('personalFinance.organizerV2.events.evidenceCount', { count: event.evidenceCount }) }}</v-btn>
                    </article>
                </div>
                <div class="empty" v-else>{{ tt('personalFinance.organizerV2.events.empty') }}</div>
            </section>
        </template>

        <v-skeleton-loader type="heading, image, list-item-three-line@3" v-else />

        <v-dialog max-width="980" v-model="showEvidence">
            <v-card class="evidence-dialog">
                <v-card-title class="evidence-dialog-title">
                    <span>{{ tt('personalFinance.organizerV2.evidence.title') }}</span>
                    <small v-if="evidence">{{ tt('personalFinance.organizerV2.events.evidenceCount', { count: evidence.evidence.length }) }}</small>
                </v-card-title>
                <v-card-text class="evidence-dialog-body">
                    <v-skeleton-loader type="list-item-three-line@3" v-if="loadingEvidence" />
                    <div class="evidence-list" v-else>
                        <aside class="audit-explanation" v-if="selectedEvidenceEvent && selectedEvidenceEvent.evidenceCount > 1">
                            <div><span>{{ auditGroupLabel(selectedEvidenceEvent) }}</span><strong>{{ auditGroupEquation(selectedEvidenceEvent) }}</strong></div>
                            <p>{{ auditGroupRule(selectedEvidenceEvent) }}</p>
                            <small>{{ tt('personalFinance.organizerV2.audit.amountWarning') }}</small>
                        </aside>
                        <article class="evidence-record" :class="item.evidenceRole" :key="item.id" v-for="item in evidence?.evidence">
                            <header>
                                <div><strong>{{ evidenceFileName(item) }}</strong><small>{{ evidenceSourceMeta(item) }}</small></div>
                                <span>{{ evidenceRoleLabel(item) }} · {{ tt('personalFinance.organizerV2.evidence.originalFields', { count: item.row.rawFields.length }) }}</span>
                            </header>
                            <dl class="raw-fields" v-if="item.row.rawFields.length">
                                <div :key="`${index}-${field.name}`" v-for="(field, index) in item.row.rawFields">
                                    <dt>{{ field.name || tt('personalFinance.organizerV2.evidence.unnamedField') }}</dt>
                                    <dd>{{ field.value || '—' }}</dd>
                                </div>
                            </dl>
                            <p class="empty-fields" v-else>{{ tt('personalFinance.organizerV2.evidence.emptyFields') }}</p>
                        </article>
                        <p v-if="!evidence?.evidence.length">{{ tt('personalFinance.organizerV2.evidence.empty') }}</p>
                    </div>
                </v-card-text>
                <v-card-actions><v-spacer /><v-btn @click="showEvidence = false">{{ tt('Close') }}</v-btn></v-card-actions>
            </v-card>
        </v-dialog>

        <v-dialog max-width="780" v-model="showResolve">
            <v-card>
                <v-card-title>{{ selectedIssue?.type === 'refund_relation' ? '选择退款对应的原交易' : tt('personalFinance.organizerV2.resolve.title') }}</v-card-title>
                <v-card-text>
                    <div class="resolve-preview" v-if="selectedEvent">
                        <div><strong>{{ eventDisplayLabel(selectedEvent) || tt('personalFinance.organizerV2.events.unnamed') }}</strong><small>{{ reviewIssueLabel(selectedIssue) }} · {{ selectedIssue?.memberCount || 1 }} 项将一起处理</small></div>
                        <b :class="selectedEvent.flowDirection">{{ formatEventAmount(selectedEvent) }}</b>
                    </div>
                    <template v-if="selectedIssue?.type === 'refund_relation'">
                        <p class="hint">请选择原消费。系统会校验币种、金额、时间和累计退款金额；退款只冲减消费，不计为收入。</p>
                        <v-select :loading="loadingRefundCandidates" :items="refundCandidateOptions" item-title="title" item-value="value" variant="outlined" label="原消费" v-model="selectedRefundTargetEventId" />
                    </template>
                    <template v-else>
                        <p class="hint">本次答案会原子应用到问题中的全部记录；每笔交易仍保持独立身份。</p>
                        <v-row dense>
                            <v-col cols="12" md="6"><v-select :items="natureOptions" item-title="title" item-value="value" variant="outlined" :label="tt('personalFinance.organizerV2.resolve.nature')" v-model="selectedNature" /></v-col>
                            <v-col cols="12" md="6"><v-select :items="availableLedgerAccounts" item-title="name" item-value="id" variant="outlined" :label="tt('personalFinance.organizerV2.resolve.ledgerAccount')" v-model="selectedLedgerAccountId" /></v-col>
                            <v-col cols="12" md="6" v-if="needsCounterpartyAccount"><v-select :items="availableCounterpartyAccounts" item-title="name" item-value="id" variant="outlined" :label="tt('personalFinance.organizerV2.resolve.counterpartyAccount')" v-model="selectedCounterpartyLedgerAccountId" /></v-col>
                            <v-col cols="12" :md="needsCounterpartyAccount ? 6 : 12"><v-select clearable :items="categoryOptions" item-title="title" item-value="value" variant="outlined" :label="tt('personalFinance.organizerV2.resolve.category')" :hint="tt('personalFinance.organizerV2.resolve.categoryHint')" persistent-hint v-model="selectedCategoryId" /></v-col>
                        </v-row>
                    </template>
                </v-card-text>
                <v-card-actions><v-spacer /><v-btn variant="text" @click="showResolve = false">{{ tt('Cancel') }}</v-btn><v-btn color="primary" :disabled="!canResolveSelected" :loading="busy" @click="resolveSelected">{{ tt('personalFinance.organizerV2.resolve.save') }}</v-btn></v-card-actions>
            </v-card>
        </v-dialog>

        <v-dialog max-width="560" v-model="showAbandon">
            <v-card>
                <v-card-title>{{ tt('personalFinance.organizerV2.abandon.title') }}</v-card-title>
                <v-card-text>
                    <p>{{ tt('personalFinance.organizerV2.abandon.hint') }}</p>
                    <v-alert type="info" variant="tonal">{{ tt('personalFinance.organizerV2.abandon.kept') }}</v-alert>
                </v-card-text>
                <v-card-actions><v-spacer /><v-btn @click="showAbandon = false">{{ tt('Cancel') }}</v-btn><v-btn color="warning" :loading="busy" @click="abandonAndReselect">{{ tt('personalFinance.organizerV2.abandon.confirm') }}</v-btn></v-card-actions>
            </v-card>
        </v-dialog>

        <v-dialog max-width="560" v-model="showUndo">
            <v-card><v-card-title>{{ tt('personalFinance.organizerV2.undo.title') }}</v-card-title><v-card-text><p>{{ tt('personalFinance.organizerV2.undo.impact', { transactions: undoImpact?.transactionCount ?? 0 }) }}</p><v-alert type="warning" variant="tonal" v-if="undoImpact && !undoImpact.safeToApply">{{ tt('personalFinance.organizerV2.undo.unsafe') }}</v-alert></v-card-text><v-card-actions><v-spacer /><v-btn @click="showUndo = false">{{ tt('Cancel') }}</v-btn><v-btn color="warning" :disabled="!undoImpact?.safeToApply" :loading="busy" @click="undoCurrent">{{ tt('personalFinance.organizerV2.action.undo') }}</v-btn></v-card-actions></v-card>
        </v-dialog>
    </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
import type { EconomicEvent, EconomicEventStatus, EconomicNature, FinanceUpdate, OrganizerEventEvidence, OrganizerEvidenceItem, OrganizerImpact, ReviewIssue, ReviewIssueMember } from '../models.ts';
import { organizerApi } from '../service.ts';
import { RESULT_UPDATE_STATUSES, canAbandonUpdate, canPostUpdate, canUndoUpdate, eventDisplayLabel, eventReasonTranslationKeys, selectCurrentUpdate, updateConservationHolds } from '../state.ts';

const { tt, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
const accountsStore = useAccountsStore();
const categoriesStore = useTransactionCategoriesStore();
const personalFinanceStore = usePersonalFinanceStore();
const loading = ref(true);
const syncing = ref(false);
const lastSyncedAt = ref(0);
const loadingEvents = ref(false);
const loadingAudit = ref(false);
const loadingEvidence = ref(false);
const loadingRefundCandidates = ref(false);
const busy = ref(false);
const showError = ref(false);
const update = ref<FinanceUpdate>();
const events = ref<readonly EconomicEvent[]>([]);
const auditEvents = ref<readonly EconomicEvent[]>([]);
const showAllAuditEvents = ref(false);
const reviewIssues = ref<readonly ReviewIssue[]>([]);
const reviewMembers = ref<readonly ReviewIssueMember[]>([]);
type ResultsFilter = EconomicEventStatus | 'audit';

const eventFilter = ref<ResultsFilter>('needs_action');
const selectedBatchIds = ref<string[]>([]);
const activeWorkflowStep = ref<1 | 2 | 3>(2);
const showEvidence = ref(false);
const evidence = ref<OrganizerEventEvidence>();
const selectedEvidenceEvent = ref<EconomicEvent>();
const showResolve = ref(false);
const selectedIssue = ref<ReviewIssue>();
const selectedEvent = ref<EconomicEvent>();
const selectedNature = ref<EconomicNature>('expense');
const selectedLedgerAccountId = ref('');
const selectedCounterpartyLedgerAccountId = ref('');
const selectedCategoryId = ref('');
const selectedRefundTargetEventId = ref('');
const refundCandidates = ref<readonly EconomicEvent[]>([]);
const showAbandon = ref(false);
const showUndo = ref(false);
const undoImpact = ref<OrganizerImpact>();
const visibleFilters: readonly ResultsFilter[] = ['needs_action', 'ready', 'posted', 'excluded', 'audit'];
const auditPreviewLimit = 6;
const natures: readonly EconomicNature[] = ['expense', 'income', 'refund', 'fee', 'repayment', 'borrow', 'internal_transfer', 'balance_adjustment'];
const readyBatches = computed(() => personalFinanceStore.batches.filter(batch => batch.status === 'ready'));
const conservationHolds = computed(() => !!update.value && updateConservationHolds(update.value));
const visibleAuditEvents = computed(() => showAllAuditEvents.value ? auditEvents.value : auditEvents.value.slice(0, auditPreviewLimit));
const syncLabel = computed(() => {
    if (syncing.value) return tt('personalFinance.organizerV2.sync.syncing');
    if (!lastSyncedAt.value) return tt('personalFinance.organizerV2.sync.pending');
    const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(lastSyncedAt.value);
    return tt('personalFinance.organizerV2.sync.syncedAt', { time });
});
const natureOptions = computed(() => natures.map(value => ({ value, title: tt(`personalFinance.organizerV2.nature.${value}`) })));
const availableLedgerAccounts = computed(() => accountsStore.allVisiblePlainAccounts.filter(account => !selectedEvent.value?.currency || account.currency === selectedEvent.value.currency));
const needsCounterpartyAccount = computed(() => ['internal_transfer', 'repayment', 'borrow'].includes(selectedNature.value));
const availableCounterpartyAccounts = computed(() => accountsStore.allVisiblePlainAccounts.filter(account => account.id !== selectedLedgerAccountId.value && (!selectedEvent.value?.currency || account.currency === selectedEvent.value.currency)));
const categoryType = computed(() => {
    if (selectedNature.value === 'income' || selectedNature.value === 'refund') return CategoryType.Income;
    if (needsCounterpartyAccount.value) return CategoryType.Transfer;
    return CategoryType.Expense;
});
const categoryOptions = computed(() => flattenCategories(categoriesStore.allTransactionCategories[categoryType.value] ?? []));
const canResolveSelected = computed(() => {
    if (!selectedIssue.value || !selectedEvent.value) return false;
    if (selectedIssue.value.type === 'refund_relation') return !!selectedRefundTargetEventId.value;
    return !!selectedLedgerAccountId.value && selectedNature.value !== 'unknown' && (!needsCounterpartyAccount.value || (!!selectedCounterpartyLedgerAccountId.value && selectedCounterpartyLedgerAccountId.value !== selectedLedgerAccountId.value));
});
const issueGroupCount = computed(() => reviewIssues.value.length || update.value?.needsActionEventCount || 0);
const eventMap = computed(() => new Map(events.value.map(event => [event.id, event])));
const memberMap = computed(() => {
    const result = new Map<string, ReviewIssueMember[]>();
    for (const member of reviewMembers.value) {
        const values = result.get(member.issueId) ?? [];
        values.push(member); result.set(member.issueId, values);
    }
    return result;
});
const refundCandidateOptions = computed(() => refundCandidates.value.map(event => ({ value: event.id, title: `${eventDay(event.eventUnixTime)} ${eventMonth(event.eventUnixTime)} · ${eventDisplayLabel(event) || '未命名消费'} · ${formatEventAmount(event)}` })));
const currentSources = computed(() => {
    const batches = new Map(personalFinanceStore.batches.map(batch => [batch.id, batch]));
    return (update.value?.sources ?? []).map(source => ({ source, batch: batches.get(source.batchId) }));
});

watch(eventFilter, () => {
    if (activeWorkflowStep.value !== 1) activeWorkflowStep.value = eventFilter.value === 'ready' ? 3 : 2;
    if (eventFilter.value !== 'audit') void loadEvents();
});
watch(selectedNature, () => { if (!needsCounterpartyAccount.value) selectedCounterpartyLedgerAccountId.value = ''; if (selectedCategoryId.value && !categoryOptions.value.some(option => option.value === selectedCategoryId.value)) selectedCategoryId.value = ''; });

function idempotencyKey(action: string): string { return `pf-review-ui-v1:${action}:${generateRandomUUID()}`; }
function toggleBatch(id: string): void { selectedBatchIds.value = selectedBatchIds.value.includes(id) ? selectedBatchIds.value.filter(value => value !== id) : [...selectedBatchIds.value, id]; }
function showEventStep(filter: EconomicEventStatus): void { activeWorkflowStep.value = filter === 'ready' ? 3 : 2; eventFilter.value = filter; }
function eventFilterCount(filter: ResultsFilter): number {
    if (!update.value) return 0;
    if (filter === 'audit') return auditEvents.value.length;
    if (filter === 'needs_action') return update.value.needsActionEventCount;
    if (filter === 'ready') return update.value.readyEventCount;
    if (filter === 'posted') return update.value.postedEventCount;
    if (filter === 'excluded') return update.value.excludedEventCount;
    return 0;
}
function eventDay(unixTime?: number): string { return unixTime ? String(new Date(unixTime * 1000).getDate()).padStart(2, '0') : '—'; }
function eventMonth(unixTime?: number): string { return unixTime ? new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(unixTime * 1000)) : ''; }
function formatEventAmount(event: EconomicEvent): string { return event.amount ? formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(event.amount), event.currency) : '—'; }
function eventDescription(event: EconomicEvent): string { const title = eventDisplayLabel(event); return [...new Set([event.item, event.note].filter(value => value && value !== title))].join(' · '); }
function eventAccountName(event: EconomicEvent): string { return event.ledgerAccountId ? accountsStore.allAccountsMap[event.ledgerAccountId]?.name || '账户待确认' : '账户待确认'; }
function eventCategoryName(event: EconomicEvent): string { return event.categoryId ? categoriesStore.allTransactionCategoriesMap[event.categoryId]?.name || '暂未分类' : '暂未分类'; }
function evidenceBatch(item: OrganizerEvidenceItem) { return personalFinanceStore.batches.find(batch => batch.id === item.row.batchId); }
function evidenceFileName(item: OrganizerEvidenceItem): string { const batch = evidenceBatch(item); return batch?.file?.originalFileName || tt('personalFinance.organizerV2.evidence.source'); }
function evidenceSourceMeta(item: OrganizerEvidenceItem): string { const batch = evidenceBatch(item); const source = batch ? tt(getSourceTypeKey(batch.sourceType)) : tt('personalFinance.organizerV2.evidence.source'); return `${source} · ${tt('personalFinance.organizerV2.evidence.rowNumber', { number: item.row.rowNumber })}`; }
function evidenceRoleLabel(item: OrganizerEvidenceItem): string { return tt(`personalFinance.organizerV2.audit.role.${item.evidenceRole}`); }
function eventReasonCodes(event: EconomicEvent): readonly string[] { try { const value: unknown = JSON.parse(event.reasonCodesJson || '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; } catch { return []; } }
function auditGroupType(event: EconomicEvent): 'sameEvent' | 'transfer' | 'repayment' | 'sourceIdentity' {
    const reasons = eventReasonCodes(event);
    if (reasons.includes('auto_same_event')) return 'sameEvent';
    if (reasons.includes('auto_repayment_pair')) return 'repayment';
    if (reasons.includes('auto_transfer_pair')) return 'transfer';
    return 'sourceIdentity';
}
function auditGroupLabel(event: EconomicEvent): string { return tt(`personalFinance.organizerV2.audit.kind.${auditGroupType(event)}`); }
function auditGroupRule(event: EconomicEvent): string { return tt(`personalFinance.organizerV2.audit.rule.${auditGroupType(event)}`); }
function auditGroupEquation(event: EconomicEvent): string { return tt('personalFinance.organizerV2.audit.equation', { records: event.evidenceCount }); }
function issueEvents(issue: ReviewIssue): EconomicEvent[] { return (memberMap.value.get(issue.id) ?? []).filter(member => member.role === 'subject' && member.objectType === 'event').map(member => eventMap.value.get(member.objectId)).filter((event): event is EconomicEvent => !!event); }
function reviewIssueLabel(issue?: ReviewIssue): string {
    const labels: Record<string, string> = { account_mapping: '账户待确认', shared_fields: '多笔需要相同判断', same_event: '疑似同一笔交易', refund_relation: '退款关系待确认', transfer_accounts: '转账双方待确认', identity_conflict: '来源身份冲突', field_conflict: '字段冲突' };
    return issue ? labels[issue.type] || '必须处理' : '必须处理';
}
function reviewIssueHint(issue: ReviewIssue): string {
    const hints: Record<string, string> = { same_event: '请选择它们是同一笔经济事件，还是多笔真实交易。', refund_relation: '退款必须关联原消费，系统才会冲减消费而不是增加收入。', shared_fields: '一次设置性质、账户和分类，不会合并独立交易。', account_mapping: '确认记账账户后，本组记录会一起更新。', transfer_accounts: '请选择资金转出和转入账户。', identity_conflict: '来源身份存在冲突，需要人工确认。', field_conflict: '来源核心字段不一致，需要人工裁决。' };
    return hints[issue.type] || '请完成必要决定后再入账。';
}
function directionForNature(nature: EconomicNature): EconomicEvent['flowDirection'] { if (nature === 'income' || nature === 'refund') return 'inflow'; if (['internal_transfer', 'repayment', 'borrow', 'balance_adjustment'].includes(nature)) return 'neutral'; return 'outflow'; }
function flattenCategories(categories: TransactionCategory[]): { title: string; value: string }[] { const result: { title: string; value: string }[] = []; for (const category of categories) for (const child of category.subCategories ?? []) if (!category.hidden && !child.hidden) result.push({ title: `${category.name} / ${child.name}`, value: child.id }); return result; }
function amountAtLeast(left?: string, right?: string): boolean { try { return !!left && !!right && BigInt(left) >= BigInt(right); } catch { return false; } }

async function load(silent = false): Promise<void> {
    if (syncing.value) return;
    if (!silent) loading.value = true;
    syncing.value = true;
    showError.value = false;
    try {
        const pages = await Promise.all(RESULT_UPDATE_STATUSES.map(status => organizerApi.listUpdates(status)));
        const selected = selectCurrentUpdate(pages.map(page => [...page.items]));
        update.value = selected ? await organizerApi.getUpdate(selected.id) : undefined;
        await Promise.all([personalFinanceStore.loadBatches(0, 100), Promise.allSettled([accountsStore.loadAllAccounts({ force: false }), categoriesStore.loadAllCategories({ force: false })])]);
        if (update.value) await Promise.all([loadEvents(silent), loadEvidenceAudit(silent)]);
        lastSyncedAt.value = Date.now();
    } catch { showError.value = true; }
    finally { loading.value = false; syncing.value = false; }
}

async function listAllEvents(updateId: string, status: EconomicEventStatus): Promise<EconomicEvent[]> {
    const result: EconomicEvent[] = [];
    let cursor: { updatedUnixTime: number; eventId: string } | undefined;
    do {
        const page = await organizerApi.listEvents(updateId, status, 100, cursor);
        result.push(...page.items);
        cursor = page.nextCursor;
    } while (cursor);
    return result;
}

async function loadEvidenceAudit(silent = false): Promise<void> {
    if (!update.value || update.value.duplicateEvidenceCount < 1) { auditEvents.value = []; return; }
    if (!silent) loadingAudit.value = true;
    try {
        const pages = await Promise.all(visibleFilters.filter((status): status is EconomicEventStatus => status !== 'audit').map(status => listAllEvents((update.value as FinanceUpdate).id, status)));
        auditEvents.value = pages.flat().filter(event => event.evidenceCount > 1).sort((left, right) =>
            (left.eventUnixTime ?? Number.MAX_SAFE_INTEGER) - (right.eventUnixTime ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id));
    } catch { showError.value = true; }
    finally { if (!silent) loadingAudit.value = false; }
}

async function loadEvents(silent = false): Promise<void> {
    if (!update.value || eventFilter.value === 'audit') return;
    if (!silent) loadingEvents.value = true;
    try {
        if (eventFilter.value === 'needs_action') {
            const [eventPage, issuePage] = await Promise.all([organizerApi.listEvents(update.value.id, 'needs_action'), organizerApi.listReviewIssues(update.value.id)]);
            events.value = eventPage.items; reviewIssues.value = issuePage.items; reviewMembers.value = issuePage.members;
        } else {
            events.value = (await organizerApi.listEvents(update.value.id, eventFilter.value)).items; reviewIssues.value = []; reviewMembers.value = [];
        }
    } catch { showError.value = true; }
    finally { if (!silent) loadingEvents.value = false; }
}

function resetToSourceSelection(batchIds: readonly string[] = []): void {
    update.value = undefined;
    events.value = [];
    auditEvents.value = [];
    showAllAuditEvents.value = false;
    reviewIssues.value = [];
    reviewMembers.value = [];
    selectedBatchIds.value = [...batchIds];
    activeWorkflowStep.value = 1;
}
async function onImportChanged(batchId: string): Promise<void> {
    await personalFinanceStore.loadBatches(0, 100);
    if (!readyBatches.value.some(batch => batch.id === batchId)) return;
    if (update.value?.status === 'posted' || update.value?.status === 'undone') {
        resetToSourceSelection([batchId]);
    } else if (!update.value && !selectedBatchIds.value.includes(batchId)) {
        selectedBatchIds.value = [...selectedBatchIds.value, batchId];
    }
}
async function runMutation(operation: () => Promise<{ update: FinanceUpdate }>): Promise<void> { busy.value = true; try { update.value = (await operation()).update; await Promise.all([loadEvents(), loadEvidenceAudit()]); lastSyncedAt.value = Date.now(); } catch { showError.value = true; } finally { busy.value = false; } }
async function createAndOrganize(): Promise<void> { busy.value = true; try { const created = await organizerApi.createUpdate(selectedBatchIds.value, idempotencyKey('create')); update.value = (await organizerApi.organize(created, idempotencyKey('organize'))).update; activeWorkflowStep.value = 2; eventFilter.value = 'needs_action'; await Promise.all([loadEvents(), loadEvidenceAudit()]); lastSyncedAt.value = Date.now(); } catch { showError.value = true; } finally { busy.value = false; } }
async function postAllReady(): Promise<void> { if (update.value) await runMutation(() => organizerApi.postAllReady(update.value as FinanceUpdate, idempotencyKey('post-all'))); }

async function abandonAndReselect(): Promise<void> {
    const current = update.value;
    if (!current || !canAbandonUpdate(current)) return;
    const previousBatchIds = (current.sources ?? []).map(source => source.batchId);
    busy.value = true;
    try {
        await organizerApi.abandon(current, idempotencyKey('abandon'));
        await personalFinanceStore.loadBatches(0, 100);
        const selectable = new Set(readyBatches.value.map(batch => batch.id));
        resetToSourceSelection(previousBatchIds.filter(batchId => selectable.has(batchId)));
        showAbandon.value = false;
        lastSyncedAt.value = Date.now();
    } catch { showError.value = true; }
    finally { busy.value = false; }
}
async function openEvidence(event: EconomicEvent): Promise<void> { selectedEvidenceEvent.value = event; showEvidence.value = true; loadingEvidence.value = true; evidence.value = undefined; try { evidence.value = await organizerApi.getEvidence(event.id); } catch { showError.value = true; showEvidence.value = false; } finally { loadingEvidence.value = false; } }

async function openIssueResolve(issue: ReviewIssue): Promise<void> {
    const representative = issueEvents(issue)[0]; if (!representative) return;
    selectedIssue.value = issue; selectedEvent.value = representative;
    selectedNature.value = representative.economicNature === 'unknown' ? 'expense' : representative.economicNature;
    selectedLedgerAccountId.value = representative.ledgerAccountId ?? '';
    selectedCounterpartyLedgerAccountId.value = representative.counterpartyLedgerAccountId ?? '';
    selectedCategoryId.value = representative.categoryId ?? '';
    selectedRefundTargetEventId.value = ''; refundCandidates.value = [];
    showResolve.value = true;
    if (issue.type === 'refund_relation') await loadRefundCandidates(representative);
}

async function loadRefundCandidates(refund: EconomicEvent): Promise<void> {
    if (!update.value) return;
    loadingRefundCandidates.value = true;
    try {
        const [ready, posted] = await Promise.all([organizerApi.listEvents(update.value.id, 'ready'), organizerApi.listEvents(update.value.id, 'posted')]);
        refundCandidates.value = [...ready.items, ...posted.items].filter(event => event.id !== refund.id && event.economicNature === 'expense' && event.currency === refund.currency && amountAtLeast(event.amount, refund.amount) && (event.eventUnixTime || 0) <= (refund.eventUnixTime || Number.MAX_SAFE_INTEGER));
        if (refundCandidates.value.length === 1) selectedRefundTargetEventId.value = (refundCandidates.value[0] as EconomicEvent).id;
    } catch { showError.value = true; }
    finally { loadingRefundCandidates.value = false; }
}

async function resolveSelected(): Promise<void> {
    if (!update.value || !selectedIssue.value || !selectedEvent.value || !canResolveSelected.value) return;
    const issue = selectedIssue.value; const currentUpdate = update.value;
    if (issue.type === 'refund_relation') {
        await runMutation(() => organizerApi.resolveReviewIssue({ updateId: currentUpdate.id, issueId: issue.id, expectedUpdateVersion: currentUpdate.version, expectedIssueVersion: issue.version, idempotencyKey: idempotencyKey('refund'), decision: 'link_refund', targetEventId: selectedRefundTargetEventId.value }));
    } else {
        let fieldMask = 1 | 4 | 8;
        if (needsCounterpartyAccount.value) fieldMask |= 2;
        if (selectedCategoryId.value) fieldMask |= 128;
        await runMutation(() => organizerApi.resolveReviewIssue({ updateId: currentUpdate.id, issueId: issue.id, expectedUpdateVersion: currentUpdate.version, expectedIssueVersion: issue.version, idempotencyKey: idempotencyKey('apply-fields'), decision: 'apply_fields', fieldMask, economicNature: selectedNature.value, flowDirection: directionForNature(selectedNature.value), ledgerAccountId: selectedLedgerAccountId.value, counterpartyLedgerAccountId: needsCounterpartyAccount.value ? selectedCounterpartyLedgerAccountId.value : undefined, categoryId: selectedCategoryId.value || undefined }));
    }
    showResolve.value = false;
}

async function confirmSame(issue: ReviewIssue): Promise<void> { const primary = issueEvents(issue)[0]; if (!update.value || !primary) return; const current = update.value; await runMutation(() => organizerApi.resolveReviewIssue({ updateId: current.id, issueId: issue.id, expectedUpdateVersion: current.version, expectedIssueVersion: issue.version, idempotencyKey: idempotencyKey('same'), decision: 'confirm_same', primaryEventId: primary.id })); }
async function confirmDistinct(issue: ReviewIssue): Promise<void> { if (!update.value) return; const current = update.value; await runMutation(() => organizerApi.resolveReviewIssue({ updateId: current.id, issueId: issue.id, expectedUpdateVersion: current.version, expectedIssueVersion: issue.version, idempotencyKey: idempotencyKey('distinct'), decision: 'confirm_distinct' })); }
async function excludeIssue(issue: ReviewIssue): Promise<void> { if (!update.value) return; const current = update.value; await runMutation(() => organizerApi.resolveReviewIssue({ updateId: current.id, issueId: issue.id, expectedUpdateVersion: current.version, expectedIssueVersion: issue.version, idempotencyKey: idempotencyKey('exclude'), decision: 'exclude_events' })); }
async function inspectUndo(): Promise<void> { if (!update.value) return; busy.value = true; try { undoImpact.value = await organizerApi.getUndoImpact(update.value.id); showUndo.value = true; } catch { showError.value = true; } finally { busy.value = false; } }
async function undoCurrent(): Promise<void> { if (!update.value) return; await runMutation(() => organizerApi.undo(update.value as FinanceUpdate, idempotencyKey('undo'))); showUndo.value = false; }

function autoSync(): void {
    if (document.visibilityState === 'visible' && !busy.value) void load(true);
}

onMounted(() => {
    window.addEventListener('focus', autoSync);
    document.addEventListener('visibilitychange', autoSync);
    void load();
});
onBeforeUnmount(() => {
    window.removeEventListener('focus', autoSync);
    document.removeEventListener('visibilitychange', autoSync);
});
</script>

<style scoped>
.results-flow { --rule: rgba(var(--v-theme-on-surface), .12); display: grid; gap: 10px; }
.kicker { color: rgb(var(--v-theme-primary)); font-size: .68rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.empty-stage, .overview-card, .source-stage, .evidence-audit, .workbench { border: 1px solid var(--rule); border-radius: 12px; background: rgb(var(--v-theme-surface)); overflow: hidden; }
.empty-stage { display: flex; flex-direction: column; min-height: 420px; padding: clamp(28px, 5vw, 62px); background: linear-gradient(125deg, rgba(var(--v-theme-primary), .09), transparent 48%), rgb(var(--v-theme-surface)); }
.empty-stage h2 { margin: 8px 0; font-size: clamp(1.8rem, 4vw, 3rem); }
.empty-stage p, .overview-card p, .workbench p, .source-stage p { color: rgba(var(--v-theme-on-surface), .6); }
.source-picker { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 9px; margin: 28px 0 20px; }
.source-picker label { display: flex; gap: 10px; padding: 13px; border: 1px solid var(--rule); cursor: pointer; }
.source-picker label.selected { border-color: rgb(var(--v-theme-primary)); box-shadow: inset 3px 0 rgb(var(--v-theme-primary)); }
.source-picker label span { display: grid; min-width: 0; }
.source-picker strong, .source-picker small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-picker small { color: rgba(var(--v-theme-on-surface), .55); }
.actions { display: flex; flex-wrap: wrap; gap: 6px; }
.empty-stage > .actions { justify-content: flex-end; margin-top: auto; }
.workbench > header, .source-stage > header { display: flex; align-items: start; justify-content: space-between; gap: 16px; padding: 12px 14px; background: rgba(var(--v-theme-primary), .035); }
.overview-card h3, .workbench h3, .source-stage h3 { margin: 0; }
.workbench header p, .source-stage header p { margin: 2px 0 0; font-size: .78rem; }
.steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--rule); border-block: 1px solid var(--rule); }
.steps button { display: flex; align-items: center; gap: 9px; min-height: 56px; padding: 8px 14px; border: 0; background: rgb(var(--v-theme-surface)); color: inherit; cursor: pointer; text-align: start; }
.steps button.active { box-shadow: inset 0 3px rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .05); }
.steps button.attention.active { box-shadow: inset 0 3px rgb(var(--v-theme-warning)); }
.steps button > b { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: rgba(var(--v-theme-primary), .1); color: rgb(var(--v-theme-primary)); font-size: .78rem; }
.steps button span { display: grid; color: rgba(var(--v-theme-on-surface), .58); font-size: .72rem; }
.steps button strong { color: rgb(var(--v-theme-on-surface)); font-size: 1rem; line-height: 1.15; }
.steps button small { color: rgb(var(--v-theme-warning)); }
.overview-card > footer { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 48px; padding: 8px 14px; }
.overview-card > footer > .actions { justify-content: flex-end; margin-inline-start: auto; }
.overview-controls { display: flex; align-items: center; gap: 12px; min-width: 0; }
.overview-controls .v-btn b { margin-inline-start: 5px; color: rgb(var(--v-theme-primary)); font-size: .72rem; font-variant-numeric: tabular-nums; }
.conservation-inline { overflow: hidden; color: rgba(var(--v-theme-on-surface), .48); font-size: .68rem; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
.conservation-inline.invalid { color: rgb(var(--v-theme-error)); }
.round-meta { margin-inline-start: auto; color: rgba(var(--v-theme-on-surface), .46); font-size: .67rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.source-stage > header { align-items: center; padding-block: 10px; }
.source-stage > header > div { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.source-stage > header p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-stage article { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 12px; min-height: 54px; padding: 7px 14px; border-top: 1px solid var(--rule); }
.source-stage article > div { display: grid; min-width: 0; line-height: 1.25; }
.source-stage article strong, .source-stage article small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-stage article small { margin-top: 2px; color: rgba(var(--v-theme-on-surface), .55); font-size: .7rem; }
.source-stage article > span { padding: 3px 7px; border-radius: 999px; background: rgba(var(--v-theme-success), .08); color: rgb(var(--v-theme-success)); font-size: .68rem; white-space: nowrap; }
.evidence-audit > header { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 10px 14px; border-bottom: 1px solid var(--rule); background: rgba(var(--v-theme-primary), .035); }
.evidence-audit > header > div:first-child { display: grid; grid-template-columns: auto auto minmax(0,1fr); align-items: baseline; gap: 10px; min-width: 0; }
.evidence-audit h3 { margin: 0; font-size: 1rem; }
.evidence-audit > header p { margin: 0; overflow: hidden; color: rgba(var(--v-theme-on-surface), .58); font-size: .74rem; text-overflow: ellipsis; white-space: nowrap; }
.audit-total { display: grid; grid-template-columns: auto auto; align-items: baseline; gap: 0 5px; flex: none; text-align: end; }
.audit-total strong { color: rgb(var(--v-theme-primary)); font-size: 1.1rem; font-variant-numeric: tabular-nums; }
.audit-total span { font-size: .7rem; font-weight: 700; }
.audit-total small { grid-column: 1 / -1; color: rgba(var(--v-theme-on-surface), .52); font-size: .65rem; }
.audit-list { display: grid; }
.audit-list article { display: grid; grid-template-columns: minmax(150px,.55fr) 44px minmax(180px,.8fr) minmax(280px,1.4fr) minmax(110px,auto) auto; align-items: center; gap: 10px; min-height: 58px; padding: 7px 12px; border-top: 1px solid var(--rule); }
.audit-list article:first-child { border-top: 0; }
.audit-kind, .audit-result { display: grid; min-width: 0; }
.audit-kind span { color: rgb(var(--v-theme-primary)); font-size: .7rem; font-weight: 800; }
.audit-kind small, .audit-result small { overflow: hidden; color: rgba(var(--v-theme-on-surface), .54); font-size: .68rem; text-overflow: ellipsis; white-space: nowrap; }
.audit-list time { display: grid; border-inline-start: 1px solid var(--rule); text-align: center; }
.audit-list time b { font-size: .9rem; }
.audit-list time small { color: rgba(var(--v-theme-on-surface), .5); font-size: .62rem; }
.audit-result strong { overflow: hidden; font-size: .8rem; text-overflow: ellipsis; white-space: nowrap; }
.audit-list article > p { margin: 0; overflow: hidden; color: rgba(var(--v-theme-on-surface), .62); font-size: .7rem; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.evidence-audit > footer { display: flex; justify-content: center; padding: 5px 12px; border-top: 1px solid var(--rule); }
.audit-empty { margin: 0; padding: 28px; color: rgba(var(--v-theme-on-surface), .55); text-align: center; }
.issue-list { display: grid; gap: 7px; padding: 10px; background: rgba(var(--v-theme-on-surface), .025); }
.issue-card { border: 1px solid var(--rule); border-radius: 10px; background: rgb(var(--v-theme-surface)); overflow: hidden; }
.issue-card > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 10px; background: rgba(var(--v-theme-warning), .055); }
.issue-heading { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.issue-card > header span { color: rgb(var(--v-theme-warning)); font-size: .68rem; font-weight: 800; }
.issue-card > header small { overflow: hidden; color: rgba(var(--v-theme-on-surface), .56); font-size: .72rem; text-overflow: ellipsis; white-space: nowrap; }
.issue-card > header em { padding: 4px 8px; border-radius: 999px; background: rgba(var(--v-theme-warning), .12); color: rgb(var(--v-theme-warning)); font-size: .7rem; font-style: normal; white-space: nowrap; }
.issue-actions { display: flex; align-items: center; justify-content: flex-end; gap: 4px; flex: none; }
.issue-events { display: grid; }
.issue-event, .event-row { display: grid; grid-template-columns: 52px minmax(0,1fr) minmax(130px,auto) auto; align-items: center; gap: 10px; padding: 8px 10px; border-top: 1px solid var(--rule); }
.issue-event time, .event-row time { display: grid; text-align: center; border-inline-end: 1px solid var(--rule); }
.issue-event time b, .event-row time b { font-size: 1.05rem; }
.issue-event time small, .event-row time small { color: rgba(var(--v-theme-on-surface), .5); font-size: .65rem; }
.issue-event > div, .event-row > div { display: grid; min-width: 0; }
.issue-event > div > small, .issue-event > div > span, .event-row > div > small, .event-row .context { color: rgba(var(--v-theme-on-surface), .55); font-size: .72rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.event-list { display: grid; }
.event-row { grid-template-columns: 52px minmax(220px,.8fr) minmax(260px,1.2fr) minmax(130px,auto) auto; }
.event-row > div > span { color: rgb(var(--v-theme-primary)); font-size: .68rem; }
.amount { text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; }
.amount.inflow, .resolve-preview b.inflow { color: rgb(var(--v-theme-success)); }
.amount.outflow, .resolve-preview b.outflow { color: rgb(var(--v-theme-error)); }
.raw-record-action { font-size: .72rem; font-weight: 700; white-space: nowrap; }
.empty { padding: 56px; color: rgba(var(--v-theme-on-surface), .55); text-align: center; }
.evidence-dialog-title { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding: 18px 20px 12px; }
.evidence-dialog-title small { color: rgba(var(--v-theme-on-surface), .52); font-size: .76rem; font-weight: 600; }
.evidence-dialog-body { max-height: min(72vh, 720px); padding: 0 20px 16px; overflow-y: auto; }
.evidence-list { display: grid; gap: 12px; }
.audit-explanation { display: grid; gap: 5px; padding: 10px 12px; border-inline-start: 3px solid rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .055); }
.audit-explanation > div { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.audit-explanation span { color: rgb(var(--v-theme-primary)); font-size: .7rem; font-weight: 800; }
.audit-explanation strong { font-size: .78rem; }
.audit-explanation p { margin: 0; color: rgba(var(--v-theme-on-surface), .72); font-size: .76rem; }
.audit-explanation small { color: rgba(var(--v-theme-on-surface), .52); font-size: .68rem; }
.evidence-record { overflow: hidden; border: 1px solid var(--rule); border-radius: 10px; background: rgb(var(--v-theme-surface)); }
.evidence-record > header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 9px 12px; border-bottom: 1px solid var(--rule); background: rgba(var(--v-theme-primary), .045); }
.evidence-record > header > div { display: grid; min-width: 0; }
.evidence-record > header strong, .evidence-record > header small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.evidence-record > header small { color: rgba(var(--v-theme-on-surface), .55); font-size: .7rem; }
.evidence-record > header > span { color: rgb(var(--v-theme-primary)); font-size: .7rem; font-weight: 700; white-space: nowrap; }
.evidence-record.discarded { opacity: .62; }
.raw-fields { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); margin: 0; }
.raw-fields > div { display: grid; grid-template-columns: minmax(92px,.38fr) minmax(0,1fr); align-items: baseline; gap: 10px; min-height: 34px; padding: 7px 11px; border-bottom: 1px solid rgba(var(--v-theme-on-surface), .07); }
.raw-fields > div:nth-child(odd) { border-inline-end: 1px solid rgba(var(--v-theme-on-surface), .07); }
.raw-fields dt { overflow: hidden; color: rgba(var(--v-theme-on-surface), .52); font-size: .68rem; text-overflow: ellipsis; white-space: nowrap; }
.raw-fields dd { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: .76rem; line-height: 1.35; }
.empty-fields { margin: 0; padding: 24px; color: rgba(var(--v-theme-on-surface), .55); text-align: center; }
.resolve-preview { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px; border-inline-start: 3px solid rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .05); }
.resolve-preview > div { display: grid; min-width: 0; }
.resolve-preview small { color: rgba(var(--v-theme-on-surface), .58); }
.resolve-preview b { white-space: nowrap; }
.hint { margin: 14px 0 10px; font-size: .82rem; }
@media (max-width: 900px) {
    .steps { grid-template-columns: 1fr; }
    .overview-card > footer, .workbench > header, .source-stage > header { align-items: start; flex-direction: column; }
    .source-stage > header > div { display: grid; gap: 2px; }
    .overview-controls { align-items: stretch; flex-direction: column; width: 100%; }
    .overview-controls .v-btn-toggle { align-self: stretch; overflow-x: auto; }
    .conservation-inline { white-space: normal; }
    .round-meta { margin-inline-start: 0; }
    .overview-card > footer > .actions { align-self: stretch; }
    .issue-card > header { align-items: stretch; flex-direction: column; }
    .evidence-audit > header { align-items: start; }
    .evidence-audit > header > div:first-child { grid-template-columns: auto 1fr; }
    .evidence-audit > header p { grid-column: 1 / -1; white-space: normal; }
    .audit-list article { grid-template-columns: 44px minmax(0,1fr) auto; }
    .audit-kind { grid-column: 1 / -1; grid-row: 1; }
    .audit-list article > p { grid-column: 2 / -1; white-space: normal; }
    .audit-list article > .amount { grid-column: 2; text-align: start; }
    .audit-list article > .v-btn { grid-column: 3; }
    .issue-actions { justify-content: flex-start; flex-wrap: wrap; }
    .issue-event, .event-row { grid-template-columns: 48px minmax(0,1fr) auto; }
    .issue-event > .amount, .event-row .context { grid-column: 2; text-align: start; }
    .issue-event > .v-btn, .event-row > .v-btn { grid-column: 3; }
    .raw-fields { grid-template-columns: 1fr; }
    .raw-fields > div:nth-child(odd) { border-inline-end: 0; }
}
</style>
