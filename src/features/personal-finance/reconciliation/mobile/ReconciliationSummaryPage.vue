<template>
    <f7-page ptr @ptr:refresh="reload">
        <f7-navbar :title="tt('personalFinance.reconciliation.mobile.title')" :back-link="tt('Back')" />

        <f7-block class="read-only-note margin-vertical-half">
            <div class="display-flex align-items-center">
                <f7-icon f7="lock_shield" size="22" />
                <span class="margin-left-half">{{ tt('personalFinance.reconciliation.mobile.readOnly') }}</span>
            </div>
        </f7-block>

        <f7-block class="case-summary margin-vertical-half">
            <div>
                <strong>{{ reconciliationStore.cases.length }}</strong>
                <span>{{ tt('personalFinance.reconciliation.mobile.loadedPending') }}</span>
            </div>
        </f7-block>

        <f7-block class="text-align-center" v-if="loading && !reconciliationStore.cases.length">
            <f7-preloader />
        </f7-block>

        <f7-list strong inset media-list dividers class="margin-vertical-half" v-else-if="reconciliationStore.cases.length">
            <f7-list-item
                link="#"
                :key="reconciliationCase.id"
                v-for="reconciliationCase in reconciliationStore.cases"
                @click="openCase(reconciliationCase.id)"
            >
                <template #media>
                    <div class="mobile-score">{{ reconciliationCase.candidateScore }}</div>
                </template>
                <template #title>
                    <span>{{ tt(getReconciliationDecisionTypeKey(reconciliationCase.suggestedRelationType)) }}</span>
                </template>
                <template #subtitle>
                    <span>{{ tt(getReconciliationCaseStatusKey(reconciliationCase.status)) }} · {{ formatTime(reconciliationCase.updatedUnixTime) }}</span>
                </template>
                <template #text>
                    <span>{{ reasonText(reconciliationCase.reasonCodes[0]) }}</span>
                </template>
                <template #after>
                    <f7-badge :color="getBadgeColor(reconciliationCase.status)">
                        {{ tt('personalFinance.reconciliation.mobile.version', { version: reconciliationCase.version }) }}
                    </f7-badge>
                </template>
            </f7-list-item>
        </f7-list>

        <f7-block v-if="reconciliationStore.nextCursor">
            <f7-button fill :loading="loading" @click="loadMore">
                {{ tt('personalFinance.reconciliation.loadMore') }}
            </f7-button>
        </f7-block>

        <f7-block class="empty-history text-align-center" v-else>
            <f7-icon f7="rectangle_stack_badge_person_crop" size="48" />
            <p class="font-weight-medium">{{ tt('personalFinance.reconciliation.noCases') }}</p>
            <p class="text-color-gray">{{ tt('personalFinance.reconciliation.mobile.desktopHint') }}</p>
        </f7-block>

        <f7-popup push :opened="showDetail" @popup:closed="showDetail = false">
            <f7-page>
                <f7-navbar :title="tt('personalFinance.reconciliation.caseTitle')">
                    <template #right>
                        <f7-link popup-close>{{ tt('Close') }}</f7-link>
                    </template>
                </f7-navbar>

                <f7-block class="text-align-center" v-if="reconciliationStore.loadingDetail">
                    <f7-preloader />
                </f7-block>

                <template v-else-if="reconciliationStore.selectedCase">
                    <f7-block strong inset class="detail-summary">
                        <div class="display-flex justify-content-space-between align-items-center">
                            <strong>{{ tt(getReconciliationDecisionTypeKey(reconciliationStore.selectedCase.suggestedRelationType)) }}</strong>
                            <f7-badge :color="getBadgeColor(reconciliationStore.selectedCase.status)">
                                {{ tt(getReconciliationCaseStatusKey(reconciliationStore.selectedCase.status)) }}
                            </f7-badge>
                        </div>
                        <p class="text-color-gray margin-bottom-half">
                            {{ tt('personalFinance.reconciliation.scoreValue', { score: reconciliationStore.selectedCase.candidateScore }) }} ·
                            {{ tt('personalFinance.reconciliation.mobile.version', { version: reconciliationStore.selectedCase.version }) }}
                        </p>
                    </f7-block>

                    <f7-block-title>{{ tt('personalFinance.reconciliation.whyMatched') }}</f7-block-title>
                    <f7-list strong inset dividers>
                        <f7-list-item
                            :key="`${reason.code}-${index}`"
                            :title="reasonText(reason)"
                            v-for="(reason, index) in reconciliationStore.selectedCase.reasonCodes"
                        />
                    </f7-list>

                    <f7-block-title>{{ tt('personalFinance.reconciliation.evidenceTitle') }}</f7-block-title>
                    <f7-list strong inset media-list dividers>
                        <f7-list-item :key="`${evidence.order}-${index}`" v-for="(evidence, index) in reconciliationStore.selectedCase.evidence">
                            <template #media>
                                <f7-icon :f7="getSourceIcon(evidence.sourceType)" />
                            </template>
                            <template #title>
                                <span>{{ tt(getSourceTypeKey(evidence.sourceType)) }} · {{ formatAmount(evidence.normalizedAmount, evidence.currency) }}</span>
                            </template>
                            <template #subtitle>
                                <span>{{ evidence.maskedSourceAccount || tt('personalFinance.reconciliation.maskedSource') }} · {{ formatTime(evidence.normalizedUnixTime) }}</span>
                            </template>
                            <template #text>
                                <span>
                                    {{ tt(`personalFinance.reconciliation.evidence.transactionTypeValue.${evidence.normalizedTransactionType}`) }} ·
                                    {{ tt(`personalFinance.reconciliation.evidence.processingStateValue.${evidence.processingState}`) }}
                                </span>
                            </template>
                        </f7-list-item>
                    </f7-list>

                    <f7-block strong inset class="privacy-note">
                        {{ tt('personalFinance.reconciliation.evidencePrivacy') }}
                    </f7-block>

                    <f7-block-title v-if="reconciliationStore.selectedCase.currentDecisionId">
                        {{ tt('personalFinance.reconciliation.decisionTitle') }}
                    </f7-block-title>
                    <f7-list strong inset v-if="reconciliationStore.selectedCase.currentDecisionId">
                        <f7-list-item
                            :title="tt('personalFinance.reconciliation.activeDecision')"
                            :after="tt('personalFinance.reconciliation.undo.inspectAvailable')"
                        />
                    </f7-list>
                </template>
            </f7-page>
        </f7-popup>
    </f7-page>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { useI18n } from '@/locales/helpers.ts';
import { useI18nUIComponents } from '@/lib/ui/mobile.ts';
import { parseDateTimeFromUnixTimeWithBrowserTimezone } from '@/lib/datetime.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';

import { getSourceTypeKey } from '../../presentation.ts';
import type { PersonalFinanceSourceType } from '../../models.ts';
import type { ReconciliationCaseStatus, ReconciliationReason } from '../models.ts';
import {
    getReconciliationCaseStatusKey,
    getReconciliationDecisionTypeKey,
    getReconciliationReasonKey
} from '../presentation.ts';
import { useReconciliationStore } from '../store.ts';

const { tt, formatDateTimeToShortDateTime, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
const { showToast } = useI18nUIComponents();
const reconciliationStore = useReconciliationStore();

const loading = ref<boolean>(false);
const showDetail = ref<boolean>(false);

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

function reasonText(reason?: ReconciliationReason): string {
    if (!reason) {
        return tt('personalFinance.reconciliation.noReason');
    }
    const key = getReconciliationReasonKey(reason.code);
    return key.endsWith('.unknown')
        ? tt(key, { code: reason.code })
        : tt(key, { value: reason.value ?? 0 });
}

function getSourceIcon(sourceType: PersonalFinanceSourceType): string {
    if (sourceType === 'alipay') {
        return 'wallet_pass';
    }
    return sourceType === 'wechat' ? 'chat_bubble_text' : 'creditcard';
}

function getBadgeColor(status: ReconciliationCaseStatus): string {
    if (status === 'resolved') {
        return 'green';
    }
    if (status === 'action_required') {
        return 'red';
    }
    return status === 'deferred' ? 'orange' : 'blue';
}

function loadCases(append: boolean, done?: () => void): void {
    if (loading.value) {
        done?.();
        return;
    }
    loading.value = true;
    reconciliationStore.loadCases({ status: 'open', append, limit: 100 })
        .catch(() => showToast('personalFinance.reconciliation.error.operationFailed'))
        .finally(() => {
            loading.value = false;
            done?.();
        });
}

function reload(done?: () => void): void {
    loadCases(false, done);
}

function loadMore(): void {
    loadCases(true);
}

async function openCase(caseId: string): Promise<void> {
    showDetail.value = true;
    try {
        await reconciliationStore.openCase(caseId);
    } catch {
        showDetail.value = false;
        showToast('personalFinance.reconciliation.error.operationFailed');
    }
}

onMounted(() => reload());
</script>

<style scoped>
.read-only-note,
.privacy-note {
    color: var(--f7-theme-color);
}

.case-summary {
    display: block;
}

.case-summary div {
    padding: 14px;
    border: 1px solid var(--f7-list-item-border-color);
    border-radius: 12px;
    background: var(--f7-card-bg-color);
}

.case-summary strong,
.case-summary span {
    display: block;
}

.case-summary strong {
    color: var(--f7-theme-color);
    font-size: 1.55rem;
}

.mobile-score {
    width: 42px;
    height: 42px;
    border: 2px solid var(--f7-theme-color);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--f7-theme-color);
    font-weight: 700;
}

.empty-history {
    margin-top: 22vh;
}
</style>
