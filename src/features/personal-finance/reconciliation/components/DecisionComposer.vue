<template>
    <v-radio-group class="decision-options mt-3" hide-details :disabled="submitting" v-model="selectedDecision">
        <div class="decision-option" :key="decisionType" v-for="decisionType in reconciliationDecisionTypes">
            <v-radio :value="decisionType">
                <template #label>
                    <div>
                        <div class="font-weight-medium">{{ tt(getReconciliationDecisionTypeKey(decisionType)) }}</div>
                        <div class="text-body-small text-medium-emphasis">{{ tt(`personalFinance.reconciliation.decisionHintByType.${decisionType}`) }}</div>
                    </div>
                </template>
            </v-radio>
        </div>
    </v-radio-group>

    <div class="d-flex justify-end mt-4">
        <v-btn color="primary" :disabled="!selectedDecision" :loading="submitting" @click="open">
            {{ tt('personalFinance.reconciliation.confirmDecision') }}
        </v-btn>
    </div>

    <v-dialog width="780" :persistent="submitting" v-model="showDialog">
        <v-card>
            <v-card-title class="pa-5">{{ tt('personalFinance.reconciliation.composer.title') }}</v-card-title>
            <v-card-text class="px-5 pb-5">
                <v-alert class="mb-5" type="info" variant="tonal">
                    {{ tt('personalFinance.reconciliation.composer.privacy') }}
                </v-alert>

                <v-row>
                    <v-col cols="12" md="6">
                        <v-select
                            item-title="title"
                            item-value="value"
                            :items="memberOptions"
                            :label="tt('personalFinance.reconciliation.composer.accountSource')"
                            :disabled="submitting || loadingOptions"
                            v-model="accountAmountMemberOrder"
                            @update:model-value="syncDrafts"
                        />
                    </v-col>
                    <v-col cols="12" md="6">
                        <v-select
                            item-title="title"
                            item-value="value"
                            :items="memberOptions"
                            :label="tt('personalFinance.reconciliation.composer.merchantSource')"
                            :disabled="submitting || loadingOptions"
                            v-model="merchantItemMemberOrder"
                        />
                    </v-col>
                    <v-col cols="12" v-if="selectedDecision === 'refund_reversal'">
                        <v-select
                            item-title="title"
                            item-value="value"
                            :items="memberOptions"
                            :label="tt('personalFinance.reconciliation.composer.refundOriginal')"
                            :disabled="submitting || loadingOptions"
                            v-model="refundOriginalMemberOrder"
                            @update:model-value="syncDrafts"
                        />
                    </v-col>
                </v-row>

                <v-progress-linear class="my-4" indeterminate v-if="loadingOptions" />

                <template v-else>
                    <v-alert class="mb-4" type="success" variant="tonal" v-if="requiredDrafts.length === 0 && sourcesSelected">
                        {{ tt('personalFinance.reconciliation.composer.noDraft') }}
                    </v-alert>

                    <section class="draft-card pa-4 mb-4" :key="draft.role" v-for="draft in requiredDrafts">
                        <div class="d-flex flex-wrap align-start ga-3 mb-4">
                            <div>
                                <div class="text-subtitle-1 font-weight-bold">{{ tt(draft.label) }}</div>
                                <div class="text-body-small text-medium-emphasis">
                                    {{ memberTitle(draft.evidence.order) }}
                                </div>
                            </div>
                            <v-spacer />
                            <v-chip color="primary" size="small" variant="tonal">
                                {{ formatAmount(draft.evidence.normalizedAmount, draft.evidence.currency) }}
                            </v-chip>
                        </div>

                        <v-row>
                            <v-col cols="12" sm="4">
                                <v-select
                                    item-title="title"
                                    item-value="value"
                                    :items="transactionTypeOptions(draft.role)"
                                    :label="tt('Transaction Type')"
                                    :disabled="submitting || draft.role === 'primary' && selectedDecision === 'internal_transfer'"
                                    v-model="draftForms[draft.role].type"
                                    @update:model-value="resetCategory(draft.role)"
                                />
                            </v-col>
                            <v-col cols="12" sm="8">
                                <v-select
                                    item-title="title"
                                    item-value="value"
                                    :items="categoryOptions(draftForms[draft.role].type)"
                                    :label="tt('Category')"
                                    :disabled="submitting"
                                    v-model="draftForms[draft.role].categoryId"
                                />
                            </v-col>
                            <v-col cols="12" :sm="draftForms[draft.role].type === TransactionType.Transfer ? 6 : 12">
                                <v-select
                                    item-title="name"
                                    item-value="id"
                                    :items="accountOptions(draft.evidence.currency)"
                                    :label="tt('personalFinance.reconciliation.composer.sourceAccount')"
                                    :disabled="submitting"
                                    v-model="draftForms[draft.role].sourceAccountId"
                                />
                            </v-col>
                            <v-col cols="12" sm="6" v-if="draftForms[draft.role].type === TransactionType.Transfer">
                                <v-select
                                    item-title="name"
                                    item-value="id"
                                    :items="accountOptions(draft.evidence.currency, draftForms[draft.role].sourceAccountId)"
                                    :label="tt('Destination Account')"
                                    :disabled="submitting"
                                    v-model="draftForms[draft.role].destinationAccountId"
                                />
                            </v-col>
                        </v-row>

                        <div class="immutable-grid mt-1">
                            <div>
                                <span>{{ tt('Amount') }}</span>
                                <strong>{{ formatAmount(draft.evidence.normalizedAmount, draft.evidence.currency) }}</strong>
                            </div>
                            <div>
                                <span>{{ tt('Transaction Time') }}</span>
                                <strong>{{ formatEvidenceTime(draft.evidence) }}</strong>
                            </div>
                        </div>
                    </section>
                </template>

                <v-alert class="mt-4" type="error" variant="tonal" v-if="validationCode">
                    {{ tt(`personalFinance.reconciliation.composer.validation.${validationCode}`) }}
                </v-alert>
                <v-alert class="mt-4" type="info" variant="tonal">
                    {{ tt('personalFinance.reconciliation.confirm.versionNotice') }}
                </v-alert>
            </v-card-text>
            <v-card-actions class="px-5 pb-5">
                <v-spacer />
                <v-btn variant="text" :disabled="submitting" @click="close">{{ tt('Cancel') }}</v-btn>
                <v-btn color="primary" :disabled="!!validationCode || loadingOptions" :loading="submitting" @click="submit">
                    {{ tt('Confirm') }}
                </v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';

import { useI18n } from '@/locales/helpers.ts';
import { useAccountsStore } from '@/stores/account.ts';
import { useTransactionCategoriesStore } from '@/stores/transactionCategory.ts';

import { CategoryType } from '@/core/category.ts';
import { TransactionType } from '@/core/transaction.ts';
import type { TransactionCategory } from '@/models/transaction_category.ts';

import { parseDateTimeFromUnixTimeWithTimezoneOffset } from '@/lib/datetime.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';

import { getSourceTypeKey } from '../../presentation.ts';
import type {
    ReconciliationCaseDetail,
    ReconciliationDecisionComposition,
    ReconciliationDecisionType,
    ReconciliationDraftForm,
    ReconciliationEvidenceCard,
    ReconciliationMemberOrder
} from '../models.ts';
import { getReconciliationDecisionTypeKey } from '../presentation.ts';
import {
    buildReconciliationDecisionRequest,
    reconciliationDecisionTypes,
    ReconciliationDecisionValidationError,
    type ReconciliationDecisionBuildContext,
    type ReconciliationDecisionValidationCode
} from '../state.ts';

type DraftRole = 'primary' | 'refundOriginal' | 'refundTransaction';

interface MemberOption {
    readonly title: string;
    readonly value: ReconciliationMemberOrder;
    readonly evidence: ReconciliationEvidenceCard[];
}

interface RequiredDraft {
    readonly role: DraftRole;
    readonly label: string;
    readonly evidence: ReconciliationEvidenceCard;
}

interface CategoryOption {
    readonly title: string;
    readonly value: string;
}

const props = defineProps<{
    reconciliationCase: ReconciliationCaseDetail;
    submitting: boolean;
}>();

const emit = defineEmits<{
    (e: 'submit', composition: ReconciliationDecisionComposition, context: ReconciliationDecisionBuildContext): void;
}>();

const { tt, formatDateTimeToLongDateTime, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
const accountsStore = useAccountsStore();
const categoriesStore = useTransactionCategoriesStore();

const showDialog = ref<boolean>(false);
const loadingOptions = ref<boolean>(false);
const selectedDecision = ref<ReconciliationDecisionType | null>(props.reconciliationCase.suggestedRelationType);
const accountAmountMemberOrder = ref<ReconciliationMemberOrder | null>(null);
const merchantItemMemberOrder = ref<ReconciliationMemberOrder | null>(null);
const refundOriginalMemberOrder = ref<ReconciliationMemberOrder | null>(null);
const draftForms = reactive<Record<DraftRole, ReconciliationDraftForm>>({
    primary: emptyDraftForm(),
    refundOriginal: emptyDraftForm(),
    refundTransaction: emptyDraftForm()
});

const memberOptions = computed<MemberOption[]>(() => {
    const members = new Map<ReconciliationMemberOrder, ReconciliationEvidenceCard[]>();
    for (const evidence of props.reconciliationCase.evidence) {
        if (evidence.order !== 0 && evidence.order !== 1 && evidence.order !== 2) {
            continue;
        }
        const order = evidence.order as ReconciliationMemberOrder;
        members.set(order, [...(members.get(order) ?? []), evidence]);
    }
    return [...members.entries()].map(([value, evidence]) => ({
        value,
        evidence,
        title: `${tt(getSourceTypeKey(evidence[0]!.sourceType))} · ${evidence[0]!.maskedSourceAccount || tt('personalFinance.reconciliation.maskedSource')}`
    }));
});
const sourcesSelected = computed<boolean>(() => accountAmountMemberOrder.value !== null && merchantItemMemberOrder.value !== null &&
    (selectedDecision.value !== 'refund_reversal' || refundOriginalMemberOrder.value !== null));
const requiredDrafts = computed<RequiredDraft[]>(() => {
    if (!selectedDecision.value || !sourcesSelected.value || selectedDecision.value === 'independent' || selectedDecision.value === 'defer') {
        return [];
    }
    if (selectedDecision.value === 'same_event' || selectedDecision.value === 'internal_transfer') {
        if (props.reconciliationCase.evidence.some(evidence => evidence.transactionCount > 0)) {
            return [];
        }
        const evidence = representative(accountAmountMemberOrder.value);
        return evidence ? [{ role: 'primary', label: 'personalFinance.reconciliation.composer.primaryDraft', evidence }] : [];
    }
    const originalEvidence = representative(refundOriginalMemberOrder.value);
    const refundOrder = memberOptions.value.find(member => member.value !== refundOriginalMemberOrder.value)?.value ?? null;
    const refundEvidence = representative(refundOrder);
    const drafts: RequiredDraft[] = [];
    if (originalEvidence && !memberHasTransaction(refundOriginalMemberOrder.value)) {
        drafts.push({ role: 'refundOriginal', label: 'personalFinance.reconciliation.composer.originalDraft', evidence: originalEvidence });
    }
    if (refundEvidence && !memberHasTransaction(refundOrder)) {
        drafts.push({ role: 'refundTransaction', label: 'personalFinance.reconciliation.composer.refundDraft', evidence: refundEvidence });
    }
    return drafts;
});
const buildContext = computed<ReconciliationDecisionBuildContext>(() => ({
    accountCurrencies: Object.fromEntries(accountsStore.allVisiblePlainAccounts.map(account => [account.id, account.currency])),
    categoryTypes: Object.fromEntries(visibleCategories().map(category => [category.id, category.type]))
}));
const validationCode = computed<ReconciliationDecisionValidationCode | null>(() => {
    if (!selectedDecision.value || accountAmountMemberOrder.value === null || merchantItemMemberOrder.value === null) {
        return 'field_source_required';
    }
    if (selectedDecision.value === 'refund_reversal' && refundOriginalMemberOrder.value === null) {
        return 'refund_original_required';
    }
    try {
        buildReconciliationDecisionRequest({
            reconciliationCase: props.reconciliationCase,
            composition: createComposition(),
            context: buildContext.value,
            idempotencyKey: 'validation-only'
        });
        return null;
    } catch (error) {
        return error instanceof ReconciliationDecisionValidationError ? error.code : 'evidence_incomplete';
    }
});

function emptyDraftForm(): ReconciliationDraftForm {
    return { type: null, categoryId: '', sourceAccountId: '', destinationAccountId: '' };
}

function representative(order: ReconciliationMemberOrder | null): ReconciliationEvidenceCard | undefined {
    return order === null ? undefined : memberOptions.value.find(member => member.value === order)?.evidence[0];
}

function memberHasTransaction(order: ReconciliationMemberOrder | null): boolean {
    return order !== null && !!memberOptions.value.find(member => member.value === order)?.evidence.some(evidence => evidence.transactionCount > 0);
}

function memberTitle(order: number): string {
    return memberOptions.value.find(member => member.value === order)?.title ?? tt('Unknown');
}

function accountOptions(currency: string, excludedId = '') {
    return accountsStore.allVisiblePlainAccounts.filter(account => account.currency === currency && account.id !== excludedId);
}

function visibleCategories(): TransactionCategory[] {
    return Object.values(categoriesStore.allTransactionCategories).flatMap(categories => categories.flatMap(category =>
        category.hidden ? [] : (category.subCategories ?? []).filter(subCategory => !subCategory.hidden)));
}

function categoryType(type: TransactionType | null): CategoryType | null {
    if (type === TransactionType.Income) {
        return CategoryType.Income;
    }
    if (type === TransactionType.Expense) {
        return CategoryType.Expense;
    }
    if (type === TransactionType.Transfer) {
        return CategoryType.Transfer;
    }
    return null;
}

function categoryOptions(type: TransactionType | null): CategoryOption[] {
    const requiredType = categoryType(type);
    if (requiredType === null) {
        return [];
    }
    const options: CategoryOption[] = [];
    for (const category of categoriesStore.allTransactionCategories[requiredType] ?? []) {
        for (const subCategory of category.subCategories ?? []) {
            if (!category.hidden && !subCategory.hidden) {
                options.push({ title: `${category.name} / ${subCategory.name}`, value: subCategory.id });
            }
        }
    }
    return options;
}

function transactionTypeOptions(role: DraftRole) {
    if (role === 'primary' && selectedDecision.value === 'internal_transfer') {
        return [{ title: tt('Transfer'), value: TransactionType.Transfer }];
    }
    return [
        { title: tt('Expense'), value: TransactionType.Expense },
        { title: tt('Income'), value: TransactionType.Income }
    ];
}

function suggestedType(evidence: ReconciliationEvidenceCard, role: DraftRole): TransactionType | null {
    if (role === 'primary' && selectedDecision.value === 'internal_transfer') {
        return TransactionType.Transfer;
    }
    if (evidence.normalizedDirection === 'income') {
        return TransactionType.Income;
    }
    if (evidence.normalizedDirection === 'expense') {
        return TransactionType.Expense;
    }
    return null;
}

function initializeDraft(draft: RequiredDraft): void {
    const form = draftForms[draft.role];
    form.type = suggestedType(draft.evidence, draft.role);
    form.sourceAccountId = accountOptions(draft.evidence.currency)[0]?.id ?? '';
    form.destinationAccountId = form.type === TransactionType.Transfer
        ? (accountOptions(draft.evidence.currency, form.sourceAccountId)[0]?.id ?? '')
        : '';
    form.categoryId = categoryOptions(form.type)[0]?.value ?? '';
}

function syncDrafts(): void {
    for (const draft of requiredDrafts.value) {
        initializeDraft(draft);
    }
}

function resetCategory(role: DraftRole): void {
    const form = draftForms[role];
    form.categoryId = categoryOptions(form.type)[0]?.value ?? '';
    if (form.type !== TransactionType.Transfer) {
        form.destinationAccountId = '';
    }
}

function formatAmount(amount: string, currency: string): string {
    return formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(amount), currency);
}

function formatEvidenceTime(evidence: ReconciliationEvidenceCard): string {
    return formatDateTimeToLongDateTime(parseDateTimeFromUnixTimeWithTimezoneOffset(
        evidence.normalizedUnixTime,
        evidence.normalizedTimezoneUtcOffset
    ));
}

function createComposition(): ReconciliationDecisionComposition {
    return {
        decisionType: selectedDecision.value!,
        fieldSelection: {
            accountAmountMemberOrder: accountAmountMemberOrder.value!,
            merchantItemMemberOrder: merchantItemMemberOrder.value!,
            refundOriginalMemberOrder: selectedDecision.value === 'refund_reversal' ? refundOriginalMemberOrder.value! : 0
        },
        primaryDraft: requiredDrafts.value.some(draft => draft.role === 'primary') ? { ...draftForms.primary } : undefined,
        refundOriginalDraft: requiredDrafts.value.some(draft => draft.role === 'refundOriginal') ? { ...draftForms.refundOriginal } : undefined,
        refundTransactionDraft: requiredDrafts.value.some(draft => draft.role === 'refundTransaction') ? { ...draftForms.refundTransaction } : undefined
    };
}

async function open(): Promise<void> {
    accountAmountMemberOrder.value = null;
    merchantItemMemberOrder.value = null;
    refundOriginalMemberOrder.value = null;
    showDialog.value = true;
    loadingOptions.value = true;
    try {
        await Promise.all([
            accountsStore.loadAllAccounts({ force: false }),
            categoriesStore.loadAllCategories({ force: false })
        ]);
    } catch {
        // 账本选项不可用时，下方校验提示会保持提交禁用。
    } finally {
        loadingOptions.value = false;
    }
}

function close(): void {
    if (!props.submitting) {
        showDialog.value = false;
    }
}

function submit(): void {
    if (validationCode.value) {
        return;
    }
    emit('submit', createComposition(), buildContext.value);
}

watch(() => props.reconciliationCase.id, () => {
    selectedDecision.value = props.reconciliationCase.suggestedRelationType;
    showDialog.value = false;
});
watch(selectedDecision, () => {
    refundOriginalMemberOrder.value = null;
    syncDrafts();
});

defineExpose({ close });
</script>

<style scoped>
.draft-card {
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    border-radius: 14px;
    background: rgba(var(--v-theme-primary), 0.035);
}

.immutable-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
}

.immutable-grid > div {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 12px;
    border-radius: 9px;
    background: rgb(var(--v-theme-surface));
}

.immutable-grid span {
    color: rgba(var(--v-theme-on-surface), 0.64);
    font-size: 0.75rem;
}

@media (max-width: 599px) {
    .immutable-grid {
        grid-template-columns: 1fr;
    }
}
</style>
