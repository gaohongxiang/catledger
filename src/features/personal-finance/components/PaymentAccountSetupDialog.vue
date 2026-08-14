<template>
    <v-dialog width="880" :persistent="submitting" v-model="showState">
        <v-card class="payment-account-dialog">
            <v-card-title class="d-flex align-center px-5 py-4">
                <div>
                    <div class="text-h6">{{ tt('personalFinance.paymentAccount.title') }}</div>
                    <div class="text-body-small text-medium-emphasis mt-1">
                        {{ tt('personalFinance.paymentAccount.subtitle') }}
                    </div>
                </div>
                <v-spacer />
                <v-btn density="compact" variant="text" :icon="mdiClose" :disabled="submitting" @click="showState = false" />
            </v-card-title>

            <v-divider />

            <v-card-text class="pa-5">
                <v-alert class="mb-4" type="info" variant="tonal">
                    {{ tt('personalFinance.paymentAccount.scopeHint') }}
                </v-alert>

                <v-progress-linear indeterminate v-if="loading" />

                <div class="d-flex flex-column ga-3" v-else>
                    <div class="payment-account-item rounded-lg pa-4" :key="draft.group.sampleRowId" v-for="draft in drafts">
                        <div class="d-flex flex-wrap align-start ga-3">
                            <v-avatar color="primary" size="40" variant="tonal">
                                <v-icon :icon="mdiCreditCardOutline" />
                            </v-avatar>
                            <div class="flex-grow-1">
                                <div class="d-flex flex-wrap align-center ga-2">
                                    <span class="font-weight-bold">{{ draft.group.displayName }}</span>
                                    <v-chip size="x-small" variant="tonal">{{ draft.group.currency }}</v-chip>
                                    <v-chip size="x-small" color="success" variant="tonal" v-if="draft.group.mapped">
                                        {{ tt('personalFinance.paymentAccount.mapped') }}
                                    </v-chip>
                                </div>
                                <div class="text-body-small text-medium-emphasis mt-1">
                                    {{ tt('personalFinance.paymentAccount.affectedRows', { count: draft.group.rowCount }) }}
                                </div>
                            </div>
                        </div>

                        <v-select
                            class="mt-4"
                            item-title="title"
                            item-value="value"
                            :items="accountOptions(draft)"
                            :label="tt('personalFinance.paymentAccount.ledgerAccount')"
                            :disabled="submitting"
                            v-model="draft.selection"
                        />

                        <v-alert class="mt-n1 mb-3" density="compact" type="success" variant="tonal" v-if="draft.recommendedAccountId && draft.selection === draft.recommendedAccountId && !draft.group.mapped">
                            {{ tt('personalFinance.paymentAccount.existingSuggested') }}
                        </v-alert>

                        <v-row v-if="draft.selection === CREATE_ACCOUNT_VALUE">
                            <v-col cols="12" md="7">
                                <v-text-field
                                    maxlength="64"
                                    counter="64"
                                    :label="tt('personalFinance.paymentAccount.newAccountName')"
                                    :disabled="submitting"
                                    v-model="draft.accountName"
                                />
                            </v-col>
                            <v-col cols="12" md="5">
                                <v-select
                                    item-title="title"
                                    item-value="value"
                                    :items="accountCategoryOptions"
                                    :label="tt('Account Category')"
                                    :disabled="submitting"
                                    v-model="draft.accountCategory"
                                />
                            </v-col>
                            <v-col class="pt-0" cols="12">
                                <div class="text-body-small text-medium-emphasis">
                                    {{ tt('personalFinance.paymentAccount.createHint') }}
                                </div>
                            </v-col>
                        </v-row>
                    </div>

                    <div class="text-center text-medium-emphasis py-6" v-if="drafts.length < 1">
                        {{ tt('personalFinance.paymentAccount.none') }}
                    </div>
                </div>
            </v-card-text>

            <v-divider />

            <v-card-actions class="px-5 py-4">
                <v-spacer />
                <v-btn variant="text" :disabled="submitting" @click="showState = false">{{ tt('Cancel') }}</v-btn>
                <v-btn color="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">
                    {{ tt('personalFinance.paymentAccount.confirm') }}
                </v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>

    <snack-bar ref="snackbar" />
</template>

<script setup lang="ts">
import SnackBar from '@/components/desktop/SnackBar.vue';

import { computed, ref, useTemplateRef } from 'vue';

import { AccountCategory } from '@/core/account.ts';
import { Account } from '@/models/account.ts';
import { useI18n } from '@/locales/helpers.ts';
import { getCurrentUnixTime } from '@/lib/datetime.ts';
import { generateRandomUUID } from '@/lib/misc.ts';
import { useAccountsStore } from '@/stores/account.ts';

import type { PersonalFinancePaymentAccountGroup } from '../models.ts';
import { inferPaymentAccountCategory, suggestPaymentAccount } from '../state.ts';
import { usePersonalFinanceStore } from '../store.ts';

import { mdiClose, mdiCreditCardOutline } from '@mdi/js';

type SnackBarType = InstanceType<typeof SnackBar>;

interface PaymentAccountDraft {
    readonly group: PersonalFinancePaymentAccountGroup;
    readonly initialLedgerAccountId?: string;
    readonly recommendedAccountId?: string;
    selection: string;
    accountName: string;
    accountCategory: number;
}

const CREATE_ACCOUNT_VALUE = '__create_account__';

const emit = defineEmits<{
    (e: 'saved'): void;
}>();

const { tt } = useI18n();
const accountsStore = useAccountsStore();
const personalFinanceStore = usePersonalFinanceStore();
const snackbar = useTemplateRef<SnackBarType>('snackbar');

const showState = ref<boolean>(false);
const loading = ref<boolean>(false);
const submitting = ref<boolean>(false);
const batchId = ref<string>('');
const drafts = ref<PaymentAccountDraft[]>([]);

const accountCategoryOptions = computed(() => [
    AccountCategory.Cash,
    AccountCategory.CheckingAccount,
    AccountCategory.SavingsAccount,
    AccountCategory.CreditCard,
    AccountCategory.VirtualAccount
].map(category => ({ title: tt(category.name), value: category.type })));

const canSubmit = computed<boolean>(() => !loading.value && !submitting.value && drafts.value.length > 0 && drafts.value.every(draft => {
    if (!draft.selection) {
        return false;
    }
    return draft.selection !== CREATE_ACCOUNT_VALUE ||
        (!!draft.accountName.trim() && [...draft.accountName.trim()].length <= 64 && !!AccountCategory.valueOf(draft.accountCategory));
}));

function accountOptions(draft: PaymentAccountDraft): Array<{ title: string; value: string }> {
    const options = accountsStore.allVisiblePlainAccounts
        .filter(account => account.currency === draft.group.currency)
        .map(account => ({ title: account.name, value: account.id }));
    options.push({ title: tt('personalFinance.paymentAccount.createNew'), value: CREATE_ACCOUNT_VALUE });
    return options;
}

function truncateAccountName(value: string): string {
    return [...value.trim()].slice(0, 64).join('');
}

function buildDraft(group: PersonalFinancePaymentAccountGroup): PaymentAccountDraft {
    const mappedAccount = group.ledgerAccountId
        ? accountsStore.allVisiblePlainAccounts.find(account => account.id === group.ledgerAccountId && account.currency === group.currency)
        : undefined;
    const suggestion = suggestPaymentAccount(group, accountsStore.allVisiblePlainAccounts);
    const recommendedAccount = suggestion.ledgerAccountId
        ? accountsStore.allVisiblePlainAccounts.find(account => account.id === suggestion.ledgerAccountId)
        : undefined;
    const selectedAccountId = mappedAccount?.id ?? recommendedAccount?.id;

    return {
        group,
        initialLedgerAccountId: mappedAccount?.id,
        recommendedAccountId: !mappedAccount ? recommendedAccount?.id : undefined,
        selection: selectedAccountId ?? CREATE_ACCOUNT_VALUE,
        accountName: truncateAccountName(group.displayName),
        accountCategory: inferPaymentAccountCategory(group.displayName, group.sourceType)
    };
}

async function open(currentBatchId: string): Promise<void> {
    if (!currentBatchId) {
        return;
    }

    showState.value = true;
    loading.value = true;
    submitting.value = false;
    batchId.value = currentBatchId;
    drafts.value = [];

    try {
        const [, groups] = await Promise.all([
            accountsStore.loadAllAccounts({ force: false }),
            personalFinanceStore.loadPaymentAccounts(currentBatchId)
        ]);
        drafts.value = groups.map(buildDraft);
    } catch {
        showState.value = false;
        snackbar.value?.showMessage('personalFinance.error.operationFailed');
    } finally {
        loading.value = false;
    }
}

async function createLedgerAccount(draft: PaymentAccountDraft): Promise<string> {
    const category = AccountCategory.valueOf(draft.accountCategory);
    if (!category) {
        throw new Error('invalid account category');
    }

    const account = Account.createNewAccount(category, draft.group.currency, getCurrentUnixTime());
    account.name = truncateAccountName(draft.accountName);
    account.comment = tt('personalFinance.paymentAccount.createdComment', {
        source: tt(`personalFinance.source.${draft.group.sourceType}`)
    });
    const created = await accountsStore.saveAccount({
        account,
        subAccounts: [],
        isEdit: false,
        clientSessionId: generateRandomUUID()
    });
    draft.selection = created.id;
    return created.id;
}

async function submit(): Promise<void> {
    if (!canSubmit.value || !batchId.value) {
        return;
    }

    submitting.value = true;

    try {
        for (const draft of drafts.value) {
            const ledgerAccountId = draft.selection === CREATE_ACCOUNT_VALUE
                ? await createLedgerAccount(draft)
                : draft.selection;

            if (draft.initialLedgerAccountId === ledgerAccountId) {
                continue;
            }
            await personalFinanceStore.confirmPaymentAccount({
                batchId: batchId.value,
                rowId: draft.group.sampleRowId,
                ledgerAccountId
            });
        }

        showState.value = false;
        emit('saved');
    } catch {
        snackbar.value?.showMessage('personalFinance.error.operationFailed');
    } finally {
        submitting.value = false;
    }
}

defineExpose({ open });
</script>

<style scoped>
.payment-account-dialog {
    display: flex;
    flex-direction: column;
    max-height: min(88vh, 900px);
}

.payment-account-dialog :deep(.v-card-text) {
    overflow-y: auto;
}

.payment-account-item {
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    background: rgba(var(--v-theme-surface-variant), 0.28);
}
</style>
