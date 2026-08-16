<template>
    <v-dialog width="720" :persistent="submitting" v-model="showState">
        <v-card class="ceb-credit-dialog">
            <v-card-title class="d-flex align-center py-4 px-5">
                <v-icon class="me-3" color="primary" :icon="mdiCreditCardOutline" />
                <span>{{ tt('personalFinance.cebCredit.title') }}</span>
                <v-spacer />
                <v-btn density="compact" variant="text" :icon="mdiClose" :disabled="submitting" @click="close" />
            </v-card-title>

            <v-divider />

            <v-card-text class="pa-0">
                <div class="pa-5">
                    <v-alert type="info" variant="tonal">
                        <div class="font-weight-medium">{{ tt('personalFinance.cebCredit.templateNotice') }}</div>
                        <div class="text-body-small mt-1">{{ tt('personalFinance.cebCredit.privacyNotice') }}</div>
                        <div class="text-body-small mt-1">{{ tt('personalFinance.cebCredit.twoCardHint') }}</div>
                    </v-alert>
                </div>

                <v-divider />

                <section class="pa-5">
                    <div class="text-subtitle-1 font-weight-bold">{{ tt('personalFinance.genericBank.sourceSection') }}</div>
                    <div class="text-body-small text-medium-emphasis mt-1 mb-4">
                        {{ tt('personalFinance.genericBank.sourceHint') }}
                    </div>

                    <v-btn-toggle mandatory divided color="primary" class="mb-4" v-model="sourceMode">
                        <v-btn value="existing">{{ tt('personalFinance.sourceDialog.useExisting') }}</v-btn>
                        <v-btn value="create">{{ tt('personalFinance.sourceDialog.createNew') }}</v-btn>
                    </v-btn-toggle>

                    <template v-if="sourceMode === 'existing'">
                        <v-select
                            item-title="displayName"
                            item-value="id"
                            :items="usableBankSourceAccounts"
                            :label="tt('personalFinance.sourceAccount')"
                            :no-data-text="tt('personalFinance.genericBank.noUsableSourceAccount')"
                            :disabled="submitting"
                            v-model="selectedSourceAccountId"
                        >
                            <template #item="{ props: itemProps, item }">
                                <v-list-item v-bind="itemProps" :subtitle="ledgerAccountName(item.ledgerAccountId)" />
                            </template>
                        </v-select>
                        <v-alert type="warning" variant="tonal" density="compact" v-if="unmappedBankSourceAccountCount > 0">
                            {{ tt('personalFinance.genericBank.unmappedProfiles', { count: unmappedBankSourceAccountCount }) }}
                        </v-alert>
                    </template>

                    <v-row v-else>
                        <v-col cols="12" md="6">
                            <v-text-field
                                :label="tt('personalFinance.sourceDialog.displayName')"
                                maxlength="128"
                                :disabled="submitting"
                                v-model="displayName"
                            />
                        </v-col>
                        <v-col cols="12" md="6">
                            <v-select
                                item-title="name"
                                item-value="id"
                                :items="accountsStore.allVisiblePlainAccounts"
                                :label="tt('personalFinance.sourceDialog.ledgerMapping')"
                                :hint="tt('personalFinance.genericBank.ledgerRequired')"
                                persistent-hint
                                :disabled="submitting"
                                v-model="ledgerAccountId"
                            />
                        </v-col>
                    </v-row>
                </section>
            </v-card-text>

            <v-divider />

            <v-card-actions class="px-5 py-4">
                <v-spacer />
                <v-btn variant="text" :disabled="submitting" @click="close">{{ tt('Cancel') }}</v-btn>
                <v-btn color="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">
                    {{ tt('personalFinance.cebCredit.parse') }}
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

import type { PersonalFinanceSourceAccount } from '../models.ts';
import { buildCebCreditReparseRequest, getCompatibleSourceAccounts, getUsableBankSourceAccounts } from '../state.ts';
import { usePersonalFinanceStore } from '../store.ts';

import { mdiClose, mdiCreditCardOutline } from '@mdi/js';

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
const fileId = ref<string>('');
const currency = ref<string>('');
const timezoneUtcOffset = ref<number>(0);
const reasonCode = ref<string>('user_selected_ceb_credit_pdf');
const sourceMode = ref<'existing' | 'create'>('existing');
const selectedSourceAccountId = ref<string>('');
const displayName = ref<string>('');
const ledgerAccountId = ref<string | null>(null);

const bankSourceAccounts = computed(() => getCompatibleSourceAccounts(personalFinanceStore.sourceAccounts, 'bank'));
const usableBankSourceAccounts = computed(() => getUsableBankSourceAccounts(personalFinanceStore.sourceAccounts));
const unmappedBankSourceAccountCount = computed(() => bankSourceAccounts.value.length - usableBankSourceAccounts.value.length);
const selectedSourceAccount = computed<PersonalFinanceSourceAccount | undefined>(() =>
    usableBankSourceAccounts.value.find(account => account.id === selectedSourceAccountId.value)
);
const canSubmit = computed<boolean>(() => {
    if (submitting.value) {
        return false;
    }

    return sourceMode.value === 'existing'
        ? !!selectedSourceAccount.value
        : !!displayName.value.trim() && !!ledgerAccountId.value;
});

function ledgerAccountName(accountId?: string): string {
    if (!accountId) {
        return tt('personalFinance.sourceDialog.noLedgerMapping');
    }

    return accountsStore.allAccountsMap[accountId]?.name ?? tt('personalFinance.sourceDialog.noLedgerMapping');
}

function close(): void {
    if (!submitting.value) {
        showState.value = false;
    }
}

function open(options: {
    fileId: string;
    currency: string;
    timezoneUtcOffset: number;
    reasonCode?: string;
}): void {
    showState.value = true;
    fileId.value = options.fileId;
    currency.value = options.currency;
    timezoneUtcOffset.value = options.timezoneUtcOffset;
    reasonCode.value = options.reasonCode ?? 'user_selected_ceb_credit_pdf';
    sourceMode.value = 'existing';
    selectedSourceAccountId.value = '';
    displayName.value = '';
    ledgerAccountId.value = null;

    Promise.all([
        personalFinanceStore.loadSourceAccounts(),
        accountsStore.loadAllAccounts({ force: false })
    ]).then(() => {
        const first = usableBankSourceAccounts.value[0];

        if (first) {
            selectedSourceAccountId.value = first.id;
        } else {
            sourceMode.value = 'create';
        }
    }).catch(() => snackbar.value?.showMessage('personalFinance.error.operationFailed'));
}

async function submit(): Promise<void> {
    if (!canSubmit.value) {
        return;
    }

    submitting.value = true;

    try {
        let sourceAccount = selectedSourceAccount.value;

        if (sourceMode.value === 'create') {
            sourceAccount = await personalFinanceStore.saveSourceAccount({
                sourceType: 'bank',
                displayName: displayName.value.trim(),
                ledgerAccountId: ledgerAccountId.value!,
                status: 'active'
            });
        }

        const result = await personalFinanceStore.reparseFile(buildCebCreditReparseRequest({
            fileId: fileId.value,
            sourceAccount,
            currency: currency.value,
            timezoneUtcOffset: timezoneUtcOffset.value,
            reasonCode: reasonCode.value
        }));

        if (!result.batch) {
            throw new Error('ceb credit parser did not create a batch');
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

<style scoped>
.ceb-credit-dialog {
    display: flex;
    flex-direction: column;
    max-height: min(720px, calc(100vh - 48px));
}

.ceb-credit-dialog > .v-card-text {
    overflow-y: auto;
}
</style>
