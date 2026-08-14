<template>
    <v-dialog width="760" :persistent="submitting" v-model="showState">
        <v-card>
            <v-card-title class="d-flex align-center py-4 px-5">
                <span>{{ action === 'create_or_reuse' ? tt('personalFinance.posting.reuseTitle') : tt('personalFinance.posting.title') }}</span>
                <v-spacer />
                <v-btn density="compact" variant="text" :icon="mdiClose" :disabled="submitting" @click="showState = false" />
            </v-card-title>

            <v-divider />

            <v-card-text class="pa-5" v-if="row">
                <v-alert type="warning" variant="tonal" class="mb-5">
                    <div class="font-weight-medium">{{ tt(getIdentityStateKey(row.identityState)) }}</div>
                    <div class="mt-1">{{ tt(getRowExplanationKey(row)) }}</div>
                </v-alert>

                <div class="source-preview rounded-lg pa-4 mb-5">
                    <div class="text-body-small text-medium-emphasis">{{ tt('personalFinance.posting.sourceEvidence') }}</div>
                    <div class="font-weight-medium mt-1">{{ row.rawCounterparty || row.rawItem || tt('Unknown') }}</div>
                    <div class="text-body-small mt-1">
                        {{ row.rawTransactionTime || formatUnixTime(row.normalizedUnixTime) }} ·
                        {{ row.rawAmount || formatAmount(row.normalizedAmount, row.currency) }}
                    </div>
                    <div class="text-body-small mt-2" v-if="row.rawPaymentMethod">
                        <span class="text-medium-emphasis">{{ tt('personalFinance.paymentAccount.paymentMethod') }}：</span>
                        <span class="font-weight-medium">{{ getSafePaymentAccountDisplayName(row.rawPaymentMethod) }}</span>
                    </div>
                </div>

                <template v-if="action !== 'blocked'">
                    <v-alert type="error" variant="tonal" class="mb-5" v-if="availableSourceAccounts.length < 1">
                        {{ tt('personalFinance.posting.noMatchingAccount', { currency: row.currency }) }}
                    </v-alert>

                    <v-row>
                        <v-col cols="12" md="4">
                            <v-select
                                item-title="title"
                                item-value="value"
                                :items="transactionTypes"
                                :label="tt('Transaction Type')"
                                :disabled="submitting"
                                v-model="transactionType"
                            />
                        </v-col>
                        <v-col cols="12" md="8">
                            <v-select
                                item-title="title"
                                item-value="value"
                                :items="categoryOptions"
                                :label="tt('Category')"
                                :disabled="submitting"
                                v-model="categoryId"
                            />
                        </v-col>
                        <v-col cols="12" md="6">
                            <v-select
                                item-title="name"
                                item-value="id"
                                :items="availableSourceAccounts"
                                :label="tt('personalFinance.posting.ledgerAccount')"
                                :disabled="submitting"
                                v-model="sourceAccountId"
                            />
                        </v-col>
                        <v-col cols="12" md="6" v-if="transactionType === TransactionType.Transfer">
                            <v-select
                                item-title="name"
                                item-value="id"
                                :items="availableDestinationAccounts"
                                :label="tt('Destination Account')"
                                :disabled="submitting"
                                v-model="destinationAccountId"
                            />
                        </v-col>
                        <v-col cols="12" md="6">
                            <amount-input
                                :currency="sourceCurrency"
                                :show-currency="true"
                                :label="tt('Amount')"
                                :disabled="submitting"
                                v-model="sourceAmount"
                            />
                        </v-col>
                        <v-col cols="12" md="6" v-if="transactionType === TransactionType.Transfer">
                            <amount-input
                                :currency="destinationCurrency"
                                :show-currency="true"
                                :label="tt('Transfer In Amount')"
                                :disabled="submitting"
                                v-model="destinationAmount"
                            />
                        </v-col>
                        <v-col cols="12" md="6">
                            <v-text-field
                                type="datetime-local"
                                :label="tt('Transaction Time')"
                                :disabled="submitting"
                                v-model="localDateTime"
                            />
                        </v-col>
                        <v-col cols="12">
                            <v-text-field
                                maxlength="255"
                                :label="tt('Description')"
                                :disabled="submitting"
                                v-model="comment"
                            />
                        </v-col>
                    </v-row>
                </template>
            </v-card-text>

            <v-divider />

            <v-card-actions class="px-5 py-4">
                <v-spacer />
                <v-btn variant="text" :disabled="submitting" @click="showState = false">{{ tt('Cancel') }}</v-btn>
                <v-btn color="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">
                    {{ action === 'create_or_reuse' ? tt('personalFinance.posting.confirmDuplicate') : tt('personalFinance.posting.confirm') }}
                </v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>

    <snack-bar ref="snackbar" />
</template>

<script setup lang="ts">
import AmountInput from '@/components/desktop/AmountInput.vue';
import SnackBar from '@/components/desktop/SnackBar.vue';

import { computed, ref, useTemplateRef, watch } from 'vue';

import { useI18n } from '@/locales/helpers.ts';
import { useAccountsStore } from '@/stores/account.ts';
import { useTransactionCategoriesStore } from '@/stores/transactionCategory.ts';

import { CategoryType } from '@/core/category.ts';
import { TransactionType } from '@/core/transaction.ts';
import type { TransactionCategory } from '@/models/transaction_category.ts';

import { parseBigDecimal } from '@/lib/numeral.ts';
import { parseDateTimeFromUnixTimeWithTimezoneOffset } from '@/lib/datetime.ts';

import type {
    PersonalFinanceImportBatch,
    PersonalFinanceImportRow,
    PersonalFinancePostingDraft
} from '../models.ts';
import { getIdentityStateKey, getRowExplanationKey } from '../presentation.ts';
import { getRowAction, getSafePaymentAccountDisplayName, getSuggestedTransactionType, type PersonalFinanceRowAction } from '../state.ts';
import { usePersonalFinanceStore } from '../store.ts';

import { mdiClose } from '@mdi/js';

type SnackBarType = InstanceType<typeof SnackBar>;

interface CategoryOption {
    readonly title: string;
    readonly value: string;
}

const emit = defineEmits<{
    (e: 'posted'): void;
}>();

const { tt, formatDateTimeToLongDateTime, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
const accountsStore = useAccountsStore();
const categoriesStore = useTransactionCategoriesStore();
const personalFinanceStore = usePersonalFinanceStore();
const snackbar = useTemplateRef<SnackBarType>('snackbar');

const showState = ref<boolean>(false);
const submitting = ref<boolean>(false);
const row = ref<PersonalFinanceImportRow | null>(null);
const batch = ref<PersonalFinanceImportBatch | null>(null);
const action = ref<PersonalFinanceRowAction>('blocked');
const transactionType = ref<TransactionType>(TransactionType.Expense);
const categoryId = ref<string>('');
const sourceAccountId = ref<string>('');
const destinationAccountId = ref<string>('');
const sourceAmount = ref<number>(0);
const destinationAmount = ref<number>(0);
const localDateTime = ref<string>('');
const timezoneUtcOffset = ref<number>(0);
const comment = ref<string>('');

const transactionTypes = computed(() => [
    { title: tt('Expense'), value: TransactionType.Expense },
    { title: tt('Income'), value: TransactionType.Income },
    { title: tt('Transfer'), value: TransactionType.Transfer }
]);
const availableSourceAccounts = computed(() => {
    if (!row.value) {
        return [];
    }

    return accountsStore.allVisiblePlainAccounts.filter(account => account.currency === row.value?.currency);
});
const availableDestinationAccounts = computed(() => accountsStore.allVisiblePlainAccounts.filter(account => account.id !== sourceAccountId.value));
const sourceCurrency = computed<string>(() => accountsStore.allAccountsMap[sourceAccountId.value]?.currency ?? row.value?.currency ?? 'CNY');
const destinationCurrency = computed<string>(() => accountsStore.allAccountsMap[destinationAccountId.value]?.currency ?? sourceCurrency.value);
const categoryType = computed<CategoryType>(() => {
    if (transactionType.value === TransactionType.Income) {
        return CategoryType.Income;
    }

    if (transactionType.value === TransactionType.Transfer) {
        return CategoryType.Transfer;
    }

    return CategoryType.Expense;
});
const categoryOptions = computed<CategoryOption[]>(() => flattenCategories(categoriesStore.allTransactionCategories[categoryType.value] ?? []));
const canSubmit = computed<boolean>(() => {
    if (submitting.value || !row.value || action.value === 'blocked') {
        return false;
    }

    if (!categoryId.value || !sourceAccountId.value || !localDateTime.value || !Number.isSafeInteger(sourceAmount.value) || sourceAmount.value < 0) {
        return false;
    }

    return transactionType.value !== TransactionType.Transfer ||
        (!!destinationAccountId.value && destinationAccountId.value !== sourceAccountId.value && Number.isSafeInteger(destinationAmount.value) && destinationAmount.value >= 0);
});

function flattenCategories(categories: TransactionCategory[]): CategoryOption[] {
    const options: CategoryOption[] = [];

    for (const category of categories) {
        for (const subCategory of category.subCategories ?? []) {
            if (!category.hidden && !subCategory.hidden) {
                options.push({ title: `${category.name} / ${subCategory.name}`, value: subCategory.id });
            }
        }
    }

    return options;
}

function toLocalDateTimeInput(unixTime: number, utcOffset: number): string {
    return new Date((unixTime + utcOffset * 60) * 1000).toISOString().slice(0, 16);
}

function formatUnixTime(unixTime?: number): string {
    if (!unixTime) {
        return tt('Unknown');
    }

    const offset = row.value?.normalizedTimezoneUtcOffset ?? 0;
    return formatDateTimeToLongDateTime(parseDateTimeFromUnixTimeWithTimezoneOffset(unixTime, offset));
}

function formatAmount(amount: string | undefined, currency: string): string {
    return amount ? formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(amount), currency) : tt('Unknown');
}

function setFirstCategory(): void {
    categoryId.value = categoryOptions.value[0]?.value ?? '';
}

function open(currentRow: PersonalFinanceImportRow, currentBatch: PersonalFinanceImportBatch, paymentLedgerAccountId?: string): void {
    row.value = currentRow;
    batch.value = currentBatch;
    action.value = getRowAction(currentRow);
    transactionType.value = getSuggestedTransactionType(currentRow);
    sourceAmount.value = Number(currentRow.normalizedAmount ?? '0');
    destinationAmount.value = sourceAmount.value;
    categoryId.value = '';
    sourceAccountId.value = '';
    destinationAccountId.value = '';
    const unixTime = currentRow.normalizedUnixTime ?? Math.floor(Date.now() / 1000);
    timezoneUtcOffset.value = currentRow.normalizedTimezoneUtcOffset ?? -new Date(unixTime * 1000).getTimezoneOffset();
    localDateTime.value = toLocalDateTimeInput(unixTime, timezoneUtcOffset.value);
    comment.value = '';
    showState.value = true;

    Promise.all([
        accountsStore.loadAllAccounts({ force: false }),
        categoriesStore.loadAllCategories({ force: false })
    ]).then(() => {
        const mappedAccountId = paymentLedgerAccountId ?? (!currentRow.rawPaymentMethod.trim()
            ? (currentRow.ledgerAccountId ?? currentBatch.ledgerAccountId)
            : undefined);
        const mappedAccount = mappedAccountId ? accountsStore.allAccountsMap[mappedAccountId] : undefined;
        sourceAccountId.value = mappedAccount && !mappedAccount.hidden && mappedAccount.currency === currentRow.currency
            ? mappedAccount.id
            : (availableSourceAccounts.value[0]?.id ?? '');
        destinationAccountId.value = availableDestinationAccounts.value[0]?.id ?? '';
        setFirstCategory();
    }).catch(() => snackbar.value?.showMessage('personalFinance.error.operationFailed'));
}

async function submit(): Promise<void> {
    if (!canSubmit.value || !row.value) {
        return;
    }

    submitting.value = true;

    try {
        let draft: PersonalFinancePostingDraft | undefined;

        if (action.value !== 'blocked') {
            const wallTime = Date.parse(`${localDateTime.value}:00Z`);
            const unixTime = Math.floor(wallTime / 1000) - timezoneUtcOffset.value * 60;
            draft = {
                type: transactionType.value,
                categoryId: categoryId.value,
                time: unixTime,
                utcOffset: timezoneUtcOffset.value,
                sourceAccountId: sourceAccountId.value,
                destinationAccountId: transactionType.value === TransactionType.Transfer ? destinationAccountId.value : '0',
                sourceAmount: sourceAmount.value,
                destinationAmount: transactionType.value === TransactionType.Transfer ? destinationAmount.value : 0,
                hideAmount: false,
                tagIds: [],
                comment: comment.value.trim()
            };
        }

        await personalFinanceStore.postRow(row.value, draft);
        showState.value = false;
        emit('posted');
    } catch {
        snackbar.value?.showMessage('personalFinance.error.operationFailed');
    } finally {
        submitting.value = false;
    }
}

watch(transactionType, () => {
    setFirstCategory();

    if (transactionType.value !== TransactionType.Transfer) {
        destinationAccountId.value = '';
        destinationAmount.value = 0;
    } else {
        destinationAmount.value = sourceAmount.value;
        destinationAccountId.value = availableDestinationAccounts.value[0]?.id ?? '';
    }
});

defineExpose({ open });
</script>

<style scoped>
.source-preview {
    background: rgb(var(--v-theme-surface-variant));
}
</style>
