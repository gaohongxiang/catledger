<template>
    <div class="bill-organizer">
        <v-card class="organizer-intro overflow-hidden">
            <div class="organizer-heading pa-6 pa-lg-8">
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
                            <strong>{{ tt('personalFinance.organizer.step.organize') }}</strong>
                            <small>{{ tt('personalFinance.organizer.step.organizeHint') }}</small>
                        </div>
                    </li>
                    <li>
                        <span>3</span>
                        <div>
                            <strong>{{ tt('personalFinance.organizer.step.review') }}</strong>
                            <small>{{ tt('personalFinance.organizer.step.reviewHint') }}</small>
                        </div>
                    </li>
                </ol>
            </div>

            <v-divider />

            <v-tabs class="organizer-tabs px-3 px-lg-5" color="primary" v-model="activeView">
                <v-tab value="imports" :prepend-icon="mdiTrayArrowDown">
                    {{ tt('personalFinance.organizer.tab.imports') }}
                </v-tab>
                <v-tab value="reconciliation" :prepend-icon="mdiLinkVariant">
                    {{ tt('personalFinance.organizer.tab.reconciliation') }}
                </v-tab>
            </v-tabs>
        </v-card>

        <personal-finance-import-workbench-page class="mt-4" :embedded="true" v-if="activeView === 'imports'" />
        <personal-finance-reconciliation-workbench-page class="mt-4" :embedded="true" v-else />
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { mdiLinkVariant, mdiTrayArrowDown } from '@mdi/js';

import { useI18n } from '@/locales/helpers.ts';

import PersonalFinanceImportWorkbenchPage from './ImportWorkbenchPage.vue';
import PersonalFinanceReconciliationWorkbenchPage from '../reconciliation/desktop/ReconciliationWorkbenchPage.vue';

type BillOrganizerView = 'imports' | 'reconciliation';

const { tt } = useI18n();
const route = useRoute();
const router = useRouter();

const activeView = computed<BillOrganizerView>({
    get: () => route.query['view'] === 'reconciliation' ? 'reconciliation' : 'imports',
    set: view => {
        if (view === activeView.value) {
            return;
        }

        router.replace({
            path: '/personal-finance/bills',
            query: { view }
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
    grid-template-columns: minmax(0, 1fr) minmax(520px, 0.9fr);
    align-items: center;
    gap: 44px;
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
    min-height: 104px;
    gap: 12px;
    padding: 16px;
    background: rgba(var(--v-theme-surface), 0.96);
}

.organizer-steps li > span {
    display: grid;
    width: 28px;
    height: 28px;
    flex: 0 0 28px;
    place-items: center;
    border-radius: 50%;
    background: rgba(var(--v-theme-primary), 0.12);
    color: rgb(var(--v-theme-primary));
    font-size: 0.75rem;
    font-weight: 800;
}

.organizer-steps strong,
.organizer-steps small {
    display: block;
}

.organizer-steps strong {
    font-size: 0.86rem;
}

.organizer-steps small {
    margin-top: 5px;
    color: rgba(var(--v-theme-on-surface), 0.6);
    font-size: 0.72rem;
    line-height: 1.45;
}

.organizer-tabs :deep(.v-tab) {
    min-height: 58px;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: none;
}

@media (max-width: 1180px) {
    .organizer-heading {
        grid-template-columns: 1fr;
        gap: 28px;
    }
}

@media (max-width: 720px) {
    .organizer-steps {
        grid-template-columns: 1fr;
    }
}
</style>
