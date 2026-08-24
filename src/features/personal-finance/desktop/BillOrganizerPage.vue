<template>
    <div class="bill-organizer">
        <v-card class="organizer-shell" elevation="0">
            <div class="organizer-bar">
                <div class="organizer-copy">
                    <div class="text-overline text-primary">{{ tt('personalFinance.organizer.eyebrow') }}</div>
                    <div class="organizer-title-row">
                        <h2>{{ tt('personalFinance.organizer.title') }}</h2>
                        <p>{{ tt('personalFinance.organizer.subtitle') }}</p>
                        <small class="organizer-sync" v-if="activeView === 'review' && organizerSyncLabel">{{ organizerSyncLabel }}</small>
                    </div>
                </div>

                <v-tabs class="organizer-tabs" color="primary" density="compact" v-model="activeView">
                    <v-tab value="review" :prepend-icon="mdiClipboardCheckOutline">
                        {{ tt('personalFinance.organizer.tab.review') }}
                    </v-tab>
                    <v-tab value="records" :prepend-icon="mdiFileDocumentMultipleOutline">
                        {{ tt('personalFinance.organizer.tab.records') }}
                    </v-tab>
                </v-tabs>
            </div>
        </v-card>

        <keep-alive>
            <personal-finance-results-flow-page
                class="organizer-content"
                v-if="activeView === 'review'"
                @sync-label="organizerSyncLabel = $event"
            />
            <personal-finance-import-workbench-page class="organizer-content" :embedded="true" v-else />
        </keep-alive>
    </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { mdiClipboardCheckOutline, mdiFileDocumentMultipleOutline } from '@mdi/js';

import { useI18n } from '@/locales/helpers.ts';

import PersonalFinanceResultsFlowPage from '../organizer/desktop/ResultsFlowPage.vue';
import PersonalFinanceImportWorkbenchPage from './ImportWorkbenchPage.vue';

type BillOrganizerView = 'review' | 'records';

const { tt } = useI18n();
const activeView = ref<BillOrganizerView>('review');
const organizerSyncLabel = ref('');
</script>

<style scoped>
.bill-organizer {
    --organizer-rule: rgba(var(--v-theme-on-surface), 0.11);
    display: grid;
    max-width: 1500px;
    margin-inline: auto;
    gap: 10px;
}

.organizer-shell {
    border: 1px solid var(--organizer-rule);
    border-radius: 10px;
    box-shadow: none;
}

.organizer-bar {
    display: flex;
    align-items: end;
    justify-content: space-between;
    min-height: 88px;
    gap: 24px;
    padding: 12px 18px 0;
    background: linear-gradient(105deg, rgba(var(--v-theme-primary), 0.07), transparent 42%);
}

.organizer-copy {
    min-width: 0;
    padding-bottom: 13px;
}

.organizer-copy .text-overline {
    line-height: 1.2;
}

.organizer-title-row {
    display: flex;
    align-items: baseline;
    gap: 14px;
    margin-top: 4px;
}

.organizer-title-row h2 {
    margin: 0;
    font-size: 1.45rem;
    letter-spacing: -0.025em;
    white-space: nowrap;
}

.organizer-title-row p {
    max-width: 680px;
    margin: 0;
    color: rgba(var(--v-theme-on-surface), 0.58);
    font-size: 0.78rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.organizer-sync {
    flex: 0 0 auto;
    color: rgba(var(--v-theme-on-surface), 0.46);
    font-size: 0.68rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}

.organizer-tabs {
    flex: 0 0 auto;
    min-height: 42px;
}

.organizer-content {
    margin-top: 0 !important;
}

@media (max-width: 900px) {
    .organizer-bar {
        align-items: stretch;
        flex-direction: column;
        gap: 0;
        padding-inline: 14px;
    }

    .organizer-copy {
        padding-top: 12px;
        padding-bottom: 4px;
    }

    .organizer-title-row {
        display: block;
    }

    .organizer-title-row p {
        margin-top: 4px;
        white-space: normal;
    }
}
</style>
