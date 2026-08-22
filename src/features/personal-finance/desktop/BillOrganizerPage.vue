<template>
    <div class="bill-organizer">
        <v-card class="organizer-intro overflow-hidden">
            <div class="organizer-heading px-6 py-5 px-lg-8">
                <div class="organizer-copy">
                    <div class="text-overline text-primary">{{ tt('personalFinance.organizer.eyebrow') }}</div>
                    <h2 class="text-h4 font-weight-bold mt-1">{{ tt('personalFinance.organizer.title') }}</h2>
                    <p class="text-body-large text-medium-emphasis mt-2 mb-0">
                        {{ tt('personalFinance.organizer.subtitle') }}
                    </p>
                </div>

                <ol class="organizer-steps" :aria-label="tt('personalFinance.organizer.flowLabel')">
                    <li>
                        <span>1</span>
                        <div>
                            <strong>{{ tt('personalFinance.organizer.step.upload') }}</strong>
                            <small>{{ tt('personalFinance.organizer.step.uploadHint') }}</small>
                        </div>
                    </li>
                    <li>
                        <span>2</span>
                        <div>
                            <strong>{{ tt('personalFinance.organizer.step.resolve') }}</strong>
                            <small>{{ tt('personalFinance.organizer.step.resolveHint') }}</small>
                        </div>
                    </li>
                    <li>
                        <span>3</span>
                        <div>
                            <strong>{{ tt('personalFinance.organizer.step.result') }}</strong>
                            <small>{{ tt('personalFinance.organizer.step.resultHint') }}</small>
                        </div>
                    </li>
                </ol>
            </div>

            <v-divider />

            <v-tabs class="organizer-tabs px-3 px-lg-5" color="primary" v-model="activeView">
                <v-tab value="task" :prepend-icon="mdiClipboardCheckOutline">
                    {{ tt('personalFinance.organizer.tab.task') }}
                </v-tab>
                <v-tab value="imports" :prepend-icon="mdiTrayArrowDown">
                    {{ tt('personalFinance.organizer.tab.imports') }}
                </v-tab>
                <v-tab value="reconciliation" :prepend-icon="mdiLinkVariant">
                    {{ tt('personalFinance.organizer.tab.reconciliation') }}
                </v-tab>
            </v-tabs>
        </v-card>

        <personal-finance-results-flow-page class="mt-4" v-if="activeView === 'task'" @open-imports="activeView = 'imports'" />
        <personal-finance-import-workbench-page class="mt-4" :embedded="true" v-else-if="activeView === 'imports'" />
        <personal-finance-reconciliation-workbench-page class="mt-4" :embedded="true" v-else />
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { mdiClipboardCheckOutline, mdiLinkVariant, mdiTrayArrowDown } from '@mdi/js';

import { useI18n } from '@/locales/helpers.ts';

import PersonalFinanceResultsFlowPage from '../organizer/desktop/ResultsFlowPage.vue';
import PersonalFinanceImportWorkbenchPage from './ImportWorkbenchPage.vue';
import PersonalFinanceReconciliationWorkbenchPage from '../reconciliation/desktop/ReconciliationWorkbenchPage.vue';

type BillOrganizerView = 'task' | 'imports' | 'reconciliation';

const { tt } = useI18n();
const route = useRoute();
const router = useRouter();

const activeView = computed<BillOrganizerView>({
    get: () => {
        if (route.query['view'] === 'imports' || route.query['view'] === 'reconciliation') {
            return route.query['view'];
        }
        return 'task';
    },
    set: view => {
        if (view === activeView.value) {
            return;
        }

        router.replace({
            path: '/personal-finance/bills',
            query: view === 'task' ? {} : { view }
        });
    }
});
</script>

<style scoped>
.bill-organizer {
    --organizer-rule: rgba(var(--v-theme-on-surface), 0.11);
    max-width: 1500px;
    margin-inline: auto;
}

.organizer-intro {
    border: 1px solid var(--organizer-rule);
    border-radius: 22px 6px 22px 6px;
    box-shadow: none;
}

.organizer-heading {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    align-items: center;
    gap: 28px;
    padding-block: 22px;
    background:
        linear-gradient(120deg, rgba(var(--v-theme-primary), 0.1), transparent 48%),
        rgb(var(--v-theme-surface));
}

.organizer-copy p {
    max-width: 680px;
    line-height: 1.65;
}

.organizer-steps {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1px;
    margin: 0;
    padding: 1px;
    border: 1px solid var(--organizer-rule);
    background: var(--organizer-rule);
    list-style: none;
}

.organizer-steps li {
    display: flex;
    min-height: 0;
    gap: 10px;
    padding: 12px 14px;
    background: rgb(var(--v-theme-surface));
}

.organizer-steps span {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 999px;
    background: rgba(var(--v-theme-primary), 0.12);
    color: rgb(var(--v-theme-primary));
    font-weight: 700;
}

.organizer-steps small {
    display: block;
    margin-top: 4px;
    color: rgba(var(--v-theme-on-surface), 0.6);
}

.organizer-tabs {
    min-height: 64px;
}

@media (max-width: 1100px) {
    .organizer-heading {
        grid-template-columns: 1fr;
    }

    .organizer-steps {
        grid-template-columns: 1fr;
    }
}
</style>
