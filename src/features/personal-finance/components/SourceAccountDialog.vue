<template>
    <v-dialog width="680" :persistent="submitting" v-model="showState">
        <v-card>
            <v-card-title class="d-flex align-center py-4 px-5">
                <span>{{ tt('personalFinance.sourceDialog.title') }}</span>
                <v-spacer />
                <v-btn density="compact" variant="text" :icon="mdiClose" :disabled="submitting" @click="showState = false" />
            </v-card-title>

            <v-divider />

            <v-card-text class="pa-5">
                <v-alert type="info" variant="tonal" class="mb-5">
                    <div class="font-weight-medium">{{ tt(getSourceTypeKey(discovery.sourceType)) }}</div>
                    <div class="mt-1">{{ discovery.displayName || tt('personalFinance.sourceDialog.noDisplayName') }}</div>
                    <div class="text-body-small mt-2">{{ tt('personalFinance.sourceDialog.weakEvidence') }}</div>
                </v-alert>

                <v-btn-toggle mandatory divided color="primary" class="mb-5" v-model="mode">
                    <v-btn value="existing">{{ tt('personalFinance.sourceDialog.useExisting') }}</v-btn>
                    <v-btn value="create">{{ tt('personalFinance.sourceDialog.createNew') }}</v-btn>
                </v-btn-toggle>

                <template v-if="mode === 'existing'">
                    <v-select
                        item-title="displayName"
                        item-value="id"
                        :items="availableSourceAccounts"
                        :label="tt('personalFinance.sourceAccount')"
                        :no-data-text="tt('personalFinance.sourceDialog.noExisting')"
                        :disabled="submitting"
                        v-model="selectedSourceAccountId"
                    >
                        <template #item="{ props: itemProps, item }">
                            <v-list-item v-bind="itemProps" :subtitle="ledgerAccountName(item.ledgerAccountId)" />
                        </template>
                    </v-select>
                </template>

                <template v-else>
                    <v-text-field
                        :label="tt('personalFinance.sourceDialog.displayName')"
                        maxlength="128"
                        :disabled="submitting"
                        v-model="displayName"
                    />
                    <v-select
                        clearable
                        item-title="name"
                        item-value="id"
                        :items="accountsStore.allVisiblePlainAccounts"
                        :label="tt('personalFinance.sourceDialog.ledgerMapping')"
                        :hint="tt('personalFinance.sourceDialog.ledgerMappingHint')"
                        persistent-hint
                        :disabled="submitting"
                        v-model="ledgerAccountId"
                    />
                </template>
            </v-card-text>

            <v-divider />

            <v-card-actions class="px-5 py-4">
                <v-spacer />
                <v-btn variant="text" :disabled="submitting" @click="showState = false">{{ tt('Cancel') }}</v-btn>
                <v-btn color="primary" :loading="submitting" :disabled="!canContinue" @click="continueReparse">
                    {{ tt('Continue') }}
                </v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>

    <snack-bar ref="snackbar" />
</template>

<script setup lang="ts">
import SnackBar from '@/components/desktop/SnackBar.vue';

import { computed, ref, useTemplateRef } from 'vue';

import { useI18n } from '@/locales/helpers.ts';
import { useAccountsStore } from '@/stores/account.ts';

import { getSourceTypeKey } from '../presentation.ts';
import { getCompatibleSourceAccounts } from '../state.ts';
import { usePersonalFinanceStore } from '../store.ts';
import type { PersonalFinanceSourceAccountDiscovery } from '../models.ts';

import { mdiClose } from '@mdi/js';

type SnackBarType = InstanceType<typeof SnackBar>;

const emit = defineEmits<{
    (e: 'parsed', batchId: string): void;
}>();

const { tt } = useI18n();
const accountsStore = useAccountsStore();
const personalFinanceStore = usePersonalFinanceStore();
const snackbar = useTemplateRef<SnackBarType>('snackbar');

const showState = ref<boolean>(false);
const submitting = ref<boolean>(false);
const mode = ref<'existing' | 'create'>('existing');
const fileId = ref<string>('');
const currency = ref<string>('');
const timezoneUtcOffset = ref<number>(0);
const discovery = ref<PersonalFinanceSourceAccountDiscovery>({
    sourceType: 'alipay',
    evidenceKind: 'missing',
    displayName: '',
    discoveryMethod: 'missing'
});
const selectedSourceAccountId = ref<string>('');
const displayName = ref<string>('');
const ledgerAccountId = ref<string | null>(null);

const availableSourceAccounts = computed(() => getCompatibleSourceAccounts(personalFinanceStore.sourceAccounts, discovery.value.sourceType));
const canContinue = computed<boolean>(() => {
    if (submitting.value) {
        return false;
    }

    return mode.value === 'existing' ? !!selectedSourceAccountId.value : !!displayName.value.trim();
});

function ledgerAccountName(accountId?: string): string {
    if (!accountId) {
        return tt('personalFinance.sourceDialog.noLedgerMapping');
    }

    return accountsStore.allAccountsMap[accountId]?.name ?? tt('personalFinance.sourceDialog.noLedgerMapping');
}

function open(options: {
    fileId: string;
    discovery: PersonalFinanceSourceAccountDiscovery;
    currency: string;
    timezoneUtcOffset: number;
}): void {
    showState.value = true;
    mode.value = 'existing';
    fileId.value = options.fileId;
    currency.value = options.currency;
    timezoneUtcOffset.value = options.timezoneUtcOffset;
    discovery.value = options.discovery;
    selectedSourceAccountId.value = '';
    displayName.value = options.discovery.displayName;
    ledgerAccountId.value = null;

    Promise.all([
        personalFinanceStore.loadSourceAccounts(),
        accountsStore.loadAllAccounts({ force: false })
    ]).then(() => {
        const first = availableSourceAccounts.value[0];

        if (first) {
            selectedSourceAccountId.value = first.id;
        } else {
            mode.value = 'create';
        }
    }).catch(() => snackbar.value?.showMessage('personalFinance.error.operationFailed'));
}

async function continueReparse(): Promise<void> {
    if (!canContinue.value) {
        return;
    }

    submitting.value = true;

    try {
        let sourceAccountId = selectedSourceAccountId.value;

        if (mode.value === 'create') {
            const sourceAccount = await personalFinanceStore.saveSourceAccount({
                sourceType: discovery.value.sourceType,
                displayName: displayName.value.trim(),
                ledgerAccountId: ledgerAccountId.value || '0',
                status: 'active'
            });
            sourceAccountId = sourceAccount.id;
        }

        const result = await personalFinanceStore.reparseFile({
            fileId: fileId.value,
            sourceAccountId,
            currency: currency.value,
            timezoneUtcOffset: timezoneUtcOffset.value,
            reasonCode: 'user_selected_source'
        });

        if (result.alreadyPosted) {
            showState.value = false;
            snackbar.value?.showMessage('personalFinance.alreadyPosted');
            return;
        }

        if (!result.batch) {
            snackbar.value?.showMessage('personalFinance.error.operationFailed');
            return;
        }

        showState.value = false;
        emit('parsed', result.batch.id);
    } catch {
        snackbar.value?.showMessage('personalFinance.error.operationFailed');
    } finally {
        submitting.value = false;
    }
}

defineExpose({ open });
</script>
