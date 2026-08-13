<template>
    <f7-page ptr @ptr:refresh="reload">
        <f7-navbar :title="tt('personalFinance.mobile.title')" :back-link="tt('Back')" />

        <f7-block class="read-only-note margin-vertical-half">
            <div class="display-flex align-items-center">
                <f7-icon f7="lock_shield" size="22" />
                <span class="margin-left-half">{{ tt('personalFinance.mobile.readOnly') }}</span>
            </div>
        </f7-block>

        <f7-block class="text-align-center" v-if="loading && personalFinanceStore.batches.length < 1">
            <f7-preloader />
        </f7-block>

        <f7-list strong inset media-list dividers class="margin-vertical-half" v-else-if="personalFinanceStore.batches.length">
            <f7-list-item :key="batch.id" v-for="batch in personalFinanceStore.batches">
                <template #media>
                    <f7-icon :f7="batch.sourceType === 'alipay' ? 'creditcard' : 'chat_bubble_text'" />
                </template>
                <template #title>
                    <span>{{ batch.file?.originalFileName || tt(getSourceTypeKey(batch.sourceType)) }}</span>
                </template>
                <template #subtitle>
                    <span>{{ tt(getBatchStatusKey(batch.status)) }} · {{ formatTime(batch.createdUnixTime) }}</span>
                </template>
                <template #text>
                    <span>{{ tt('personalFinance.mobile.counts', {
                        pending: batch.pendingRowCount,
                        duplicate: batch.exactDuplicateRowCount,
                        conflict: batch.identityConflictRowCount,
                        posted: batch.postedRowCount
                    }) }}</span>
                </template>
                <template #after>
                    <f7-badge :color="getBadgeColor(batch.status)">{{ batch.pendingRowCount }}</f7-badge>
                </template>
            </f7-list-item>
        </f7-list>

        <f7-block class="empty-history text-align-center" v-else>
            <f7-icon f7="doc_text_search" size="48" />
            <p class="font-weight-medium">{{ tt('personalFinance.noHistory') }}</p>
            <p class="text-color-gray">{{ tt('personalFinance.mobile.desktopHint') }}</p>
        </f7-block>
    </f7-page>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { useI18n } from '@/locales/helpers.ts';
import { useI18nUIComponents } from '@/lib/ui/mobile.ts';
import { parseDateTimeFromUnixTimeWithBrowserTimezone } from '@/lib/datetime.ts';

import type { PersonalFinanceBatchStatus } from '../models.ts';
import { getBatchStatusKey, getSourceTypeKey } from '../presentation.ts';
import { usePersonalFinanceStore } from '../store.ts';

const { tt, formatDateTimeToShortDateTime } = useI18n();
const { showToast } = useI18nUIComponents();
const personalFinanceStore = usePersonalFinanceStore();

const loading = ref<boolean>(false);

function formatTime(unixTime: number): string {
    return formatDateTimeToShortDateTime(parseDateTimeFromUnixTimeWithBrowserTimezone(unixTime));
}

function getBadgeColor(status: PersonalFinanceBatchStatus): string {
    if (status === 'completed') {
        return 'green';
    }

    if (status === 'failed' || status === 'discarded') {
        return 'red';
    }

    return 'blue';
}

function reload(done?: () => void): void {
    if (loading.value) {
        done?.();
        return;
    }

    loading.value = true;
    personalFinanceStore.loadBatches(0, 50)
        .catch(() => showToast('personalFinance.error.operationFailed'))
        .finally(() => {
            loading.value = false;
            done?.();
        });
}

onMounted(() => reload());
</script>

<style scoped>
.read-only-note {
    color: var(--f7-theme-color);
}

.empty-history {
    margin-top: 28vh;
}
</style>
