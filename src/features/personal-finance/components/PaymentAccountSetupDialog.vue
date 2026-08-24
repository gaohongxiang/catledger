<template>
    <v-dialog max-width="900" :persistent="submitting" v-model="showState">
        <v-card class="payment-account-dialog">
            <v-card-title class="dialog-heading">
                <div>
                    <div class="text-h6">{{ tt('personalFinance.paymentAccount.title') }}</div>
                    <div class="dialog-subtitle">{{ tt('personalFinance.paymentAccount.subtitle') }}</div>
                </div>
                <v-btn density="compact" variant="text" :icon="mdiClose" :disabled="submitting" @click="showState = false" />
            </v-card-title>

            <v-divider />
            <v-progress-linear indeterminate v-if="loading" />

            <v-card-text class="dialog-body" v-else>
                <p class="scope-hint">{{ tt('personalFinance.paymentAccount.scopeHint') }}</p>

                <div class="mapping-list" v-if="drafts.length">
                    <section class="payment-account-item" :key="`${draft.batchId}:${draft.group.sampleRowId}`" v-for="draft in drafts">
                        <div class="payment-account-summary">
                            <v-avatar color="primary" size="34" variant="tonal">
                                <v-icon size="18" :icon="mdiCreditCardOutline" />
                            </v-avatar>
                            <div>
                                <div class="payment-account-name">
                                    <strong>{{ draft.group.displayName }}</strong>
                                    <v-chip size="x-small" variant="tonal">{{ draft.group.currency }}</v-chip>
                                    <v-chip size="x-small" color="success" variant="tonal" v-if="draft.group.mapped">
                                        {{ tt('personalFinance.paymentAccount.mapped') }}
                                    </v-chip>
                                </div>
                                <small>{{ tt(`personalFinance.source.${draft.group.sourceType}`) }} · {{ tt('personalFinance.paymentAccount.affectedRows', { count: draft.group.rowCount }) }}</small>
                            </div>
                        </div>

                        <v-select
                            class="account-select"
                            density="compact"
                            hide-details
                            variant="outlined"
                            item-title="title"
                            item-value="value"
                            :items="accountOptions(draft)"
                            :label="tt('personalFinance.paymentAccount.ledgerAccount')"
                            :disabled="submitting"
                            v-model="draft.selection"
                        />

                        <div class="suggestion" v-if="draft.recommendedAccountId && draft.selection === draft.recommendedAccountId && !draft.group.mapped">
                            {{ tt('personalFinance.paymentAccount.existingSuggested') }}
                        </div>

                        <div class="create-account-fields" v-if="draft.selection === CREATE_ACCOUNT_VALUE">
                            <v-text-field
                                density="compact"
                                hide-details="auto"
                                maxlength="64"
                                :label="tt('personalFinance.paymentAccount.newAccountName')"
                                :disabled="submitting"
                                v-model="draft.accountName"
                            />
                            <v-select
                                density="compact"
                                hide-details
                                item-title="title"
                                item-value="value"
                                :items="accountCategoryOptions"
                                :label="tt('Account Category')"
                                :disabled="submitting"
                                v-model="draft.accountCategory"
                            />
                            <small>{{ tt('personalFinance.paymentAccount.createHint') }}</small>
                        </div>
                    </section>
                </div>

                <div class="empty-state" v-else>{{ tt('personalFinance.paymentAccount.none') }}</div>
            </v-card-text>

            <v-divider />
            <v-card-actions class="dialog-actions">
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
    readonly batchId: string;
    readonly group: PersonalFinancePaymentAccountGroup;
    readonly initialLedgerAccountId?: string;
    readonly recommendedAccountId?: string;
    selection: string;
    accountName: string;
    accountCategory: number;
}

interface PaymentAccountDialogOptions {
    readonly unresolvedOnly?: boolean;
}

const CREATE_ACCOUNT_VALUE = '__create_account__';

const emit = defineEmits<{
    (e: 'saved'): void;
}>();

const { tt } = useI18n();
const accountsStore = useAccountsStore();
const personalFinanceStore = usePersonalFinanceStore();
const snackbar = useTemplateRef<SnackBarType>('snackbar');

const showState = ref(false);
const loading = ref(false);
const submitting = ref(false);
const drafts = ref<PaymentAccountDraft[]>([]);

const accountCategoryOptions = computed(() => [
    AccountCategory.Cash,
    AccountCategory.CheckingAccount,
    AccountCategory.SavingsAccount,
    AccountCategory.CreditCard,
    AccountCategory.VirtualAccount
].map(category => ({ title: tt(category.name), value: category.type })));

const canSubmit = computed(() => !loading.value && !submitting.value && drafts.value.length > 0 && drafts.value.every(draft => {
    if (!draft.selection) return false;
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

function buildDraft(batchId: string, group: PersonalFinancePaymentAccountGroup): PaymentAccountDraft {
    const mappedAccount = group.ledgerAccountId
        ? accountsStore.allVisiblePlainAccounts.find(account => account.id === group.ledgerAccountId && account.currency === group.currency)
        : undefined;
    const suggestion = suggestPaymentAccount(group, accountsStore.allVisiblePlainAccounts);
    const recommendedAccount = suggestion.ledgerAccountId
        ? accountsStore.allVisiblePlainAccounts.find(account => account.id === suggestion.ledgerAccountId)
        : undefined;
    const selectedAccountId = mappedAccount?.id ?? recommendedAccount?.id;

    return {
        batchId,
        group,
        initialLedgerAccountId: mappedAccount?.id,
        recommendedAccountId: !mappedAccount ? recommendedAccount?.id : undefined,
        selection: selectedAccountId ?? CREATE_ACCOUNT_VALUE,
        accountName: truncateAccountName(group.displayName),
        accountCategory: inferPaymentAccountCategory(group.displayName, group.sourceType)
    };
}

async function open(currentBatchIds: string | readonly string[], options: PaymentAccountDialogOptions = {}): Promise<boolean> {
    const batchIds = [...new Set(Array.isArray(currentBatchIds) ? currentBatchIds : [currentBatchIds])].filter(Boolean);
    if (!batchIds.length) return false;

    showState.value = true;
    loading.value = true;
    submitting.value = false;
    drafts.value = [];

    try {
        await accountsStore.loadAllAccounts({ force: false });
        const groupsByBatch = await Promise.all(batchIds.map(async batchId => ({
            batchId,
            groups: await personalFinanceStore.loadPaymentAccounts(batchId)
        })));
        drafts.value = groupsByBatch.flatMap(({ batchId, groups }) => groups
            .filter(group => !options.unresolvedOnly || !group.mapped)
            .map(group => buildDraft(batchId, group)));
        if (!drafts.value.length) showState.value = false;
        return drafts.value.length > 0;
    } catch {
        showState.value = false;
        snackbar.value?.showMessage('personalFinance.error.operationFailed');
        throw new Error('unable to load payment account mappings');
    } finally {
        loading.value = false;
    }
}

async function createLedgerAccount(draft: PaymentAccountDraft): Promise<string> {
    const category = AccountCategory.valueOf(draft.accountCategory);
    if (!category) throw new Error('invalid account category');

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
    if (!canSubmit.value) return;
    submitting.value = true;

    try {
        for (const draft of drafts.value) {
            const ledgerAccountId = draft.selection === CREATE_ACCOUNT_VALUE
                ? await createLedgerAccount(draft)
                : draft.selection;

            if (draft.initialLedgerAccountId === ledgerAccountId) continue;
            await personalFinanceStore.confirmPaymentAccount({
                batchId: draft.batchId,
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
    max-height: min(86vh, 820px);
    color: rgb(var(--v-theme-on-surface));
}

.dialog-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    padding: 16px 20px 13px;
}

.dialog-subtitle,
.scope-hint,
.payment-account-summary small,
.create-account-fields small {
    color: rgba(var(--v-theme-on-surface), .62);
    font-size: .76rem;
    line-height: 1.45;
}

.dialog-subtitle {
    margin-top: 2px;
}

.dialog-body {
    min-height: 120px;
    padding: 12px 20px 16px;
    overflow-y: auto;
}

.scope-hint {
    margin: 0 0 10px;
    padding: 8px 10px;
    border-inline-start: 3px solid rgb(var(--v-theme-primary));
    background: rgba(var(--v-theme-primary), .055);
}

.mapping-list {
    display: grid;
    gap: 8px;
}

.payment-account-item {
    display: grid;
    grid-template-columns: minmax(230px, .9fr) minmax(300px, 1.25fr);
    align-items: center;
    gap: 10px 16px;
    padding: 11px 12px;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    border-radius: 8px;
    background: rgb(var(--v-theme-surface));
}

.payment-account-summary {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
}

.payment-account-summary > div {
    display: grid;
    min-width: 0;
}

.payment-account-name {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
}

.payment-account-name strong {
    overflow: hidden;
    font-size: .88rem;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.account-select {
    min-width: 0;
}

.suggestion,
.create-account-fields {
    grid-column: 2;
}

.suggestion {
    margin-top: -4px;
    color: rgb(var(--v-theme-success));
    font-size: .7rem;
}

.create-account-fields {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(180px, .65fr);
    gap: 8px;
}

.create-account-fields small {
    grid-column: 1 / -1;
}

.empty-state {
    padding: 32px;
    color: rgba(var(--v-theme-on-surface), .58);
    text-align: center;
}

.dialog-actions {
    flex: none;
    padding: 10px 20px 12px;
    background: rgb(var(--v-theme-surface));
}

@media (max-width: 720px) {
    .payment-account-item {
        grid-template-columns: 1fr;
    }

    .suggestion,
    .create-account-fields {
        grid-column: 1;
    }

    .create-account-fields {
        grid-template-columns: 1fr;
    }
}
</style>
