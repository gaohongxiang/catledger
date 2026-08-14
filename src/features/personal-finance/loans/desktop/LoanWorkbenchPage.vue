<template>
    <v-row class="match-height">
        <v-col cols="12">
            <v-card class="loan-workbench overflow-hidden">
                <div class="loan-hero pa-6 pa-lg-8">
                    <div>
                        <div class="text-overline text-primary">{{ tt('personalFinance.loans.eyebrow') }}</div>
                        <h2 class="text-h4 font-weight-bold mt-1">{{ tt('personalFinance.loans.title') }}</h2>
                        <p class="text-body-large text-medium-emphasis mt-2 mb-0">
                            {{ tt('personalFinance.loans.subtitle') }}
                        </p>
                    </div>
                </div>

                <v-divider />

                <div class="toolbar px-5 py-3">
                    <v-btn-toggle color="primary" density="compact" divided mandatory variant="outlined" :model-value="status" @update:model-value="changeFilter">
                        <v-btn value="active">{{ tt('personalFinance.loans.status.active') }}</v-btn>
                        <v-btn value="closed">{{ tt('personalFinance.loans.status.closed') }}</v-btn>
                        <v-btn value="cancelled">{{ tt('personalFinance.loans.status.cancelled') }}</v-btn>
                    </v-btn-toggle>
                    <v-spacer />
                    <v-btn :icon="mdiRefresh" variant="text" :loading="loadingList" @click="refresh">
                        <v-tooltip activator="parent">{{ tt('Refresh') }}</v-tooltip>
                    </v-btn>
                </div>

                <v-divider />

                <v-row class="ma-0">
                    <v-col cols="12" lg="4" class="pa-0 contract-column">
                        <loan-contract-list
                            :items="items"
                            :loading="loadingList"
                            :has-more="!!nextCursor"
                            :selected-contract-id="selectedDetail?.contract.id"
                            @create="startCreate"
                            @load-more="loadMore"
                            @select="openContract"
                        />
                    </v-col>

                    <v-divider vertical class="d-none d-lg-block" />

                    <v-col cols="12" lg="8" class="pa-0 detail-column">
                        <v-skeleton-loader class="pa-6" type="heading, paragraph, image, paragraph" v-if="loadingDetail && !selectedDetail" />

                        <div class="empty-detail pa-12 text-center" v-else-if="!selectedDetail">
                            <v-icon color="medium-emphasis" size="58" :icon="mdiBankOutline" />
                            <div class="text-h6 mt-4">{{ tt('personalFinance.loans.selectContract') }}</div>
                            <div class="text-body-medium text-medium-emphasis mt-1">{{ tt('personalFinance.loans.selectContractHint') }}</div>
                        </div>

                        <template v-else>
                            <div class="detail-header pa-5 pa-lg-6">
                                <div>
                                    <div class="d-flex flex-wrap align-center ga-2">
                                        <h3 class="text-h5 font-weight-bold">{{ selectedDetail.contract.name }}</h3>
                                        <v-chip size="small" :color="getLoanStatusColor(selectedDetail.contract.status)" variant="tonal">
                                            {{ tt(getLoanContractStatusKey(selectedDetail.contract.status)) }}
                                        </v-chip>
                                        <v-chip v-if="selectedDetail.actionRequired || selectedDetail.liabilityComparison.actionRequired" size="small" color="error" variant="tonal">
                                            {{ tt('personalFinance.loans.actionRequired') }}
                                        </v-chip>
                                    </div>
                                    <div class="text-body-small text-medium-emphasis mt-2">
                                        {{ tt(getLoanContractTypeKey(selectedDetail.contract.contractType)) }} ·
                                        {{ tt(getLoanRepaymentMethodKey(selectedDetail.currentRevision.input.repaymentMethod)) }} ·
                                        {{ selectedDetail.contract.currency }}
                                    </div>
                                </div>
                                <v-spacer />
                                <div class="d-flex flex-wrap ga-2">
                                    <v-btn v-if="selectedDetail.contract.status === 'active'" variant="tonal" :disabled="!canReviseLoanContract(selectedDetail)" @click="startRevise">
                                        {{ tt('personalFinance.loans.schedule.revise') }}
                                    </v-btn>
                                    <v-menu v-if="selectedDetail.contract.status === 'active'">
                                        <template #activator="{ props }">
                                            <v-btn v-bind="props" variant="text" :icon="mdiDotsVertical" />
                                        </template>
                                        <v-list>
                                            <v-list-item :title="tt('personalFinance.loans.lifecycle.close')" @click="showCloseDialog = true" />
                                            <v-list-item :disabled="!canCancelLoanContract(selectedDetail)" :title="tt('personalFinance.loans.lifecycle.cancel')" @click="confirmCancel" />
                                        </v-list>
                                    </v-menu>
                                    <v-btn v-else-if="selectedDetail.contract.status === 'closed'" color="primary" variant="tonal" :loading="submitting" @click="confirmReopen">
                                        {{ tt('personalFinance.loans.lifecycle.reopen') }}
                                    </v-btn>
                                </div>
                            </div>

                            <div class="px-5 px-lg-6 pb-5" v-if="allDetailReasons.length">
                                <v-alert type="warning" variant="tonal">
                                    <div class="font-weight-bold">{{ tt('personalFinance.loans.actionRequired') }}</div>
                                    <div class="mt-1" :key="`${reason.code}-${index}`" v-for="(reason, index) in allDetailReasons">
                                        {{ reasonText(reason.code, reason.count) }}
                                    </div>
                                </v-alert>
                            </div>

                            <v-divider />

                            <v-expansion-panels class="calculation-disclosure pa-5 pa-lg-6" variant="accordion">
                                <v-expansion-panel elevation="0">
                                    <v-expansion-panel-title>
                                        <div>
                                            <strong>{{ tt('personalFinance.loans.advanced.title') }}</strong>
                                            <div class="text-body-small text-medium-emphasis mt-1">
                                                {{ tt('personalFinance.loans.advanced.hint') }}
                                            </div>
                                        </div>
                                    </v-expansion-panel-title>
                                    <v-expansion-panel-text>
                                        <loan-calculation-result-panel
                                            :input="selectedDetail.currentRevision.input"
                                            :result="selectedDetail.currentRevision.calculation"
                                            :currency="selectedDetail.contract.currency"
                                            :show-installments="false"
                                        />
                                    </v-expansion-panel-text>
                                </v-expansion-panel>
                            </v-expansion-panels>

                            <v-divider />

                            <div class="pa-5 pa-lg-6" v-if="canRecordFundingComponents && !selectedInstallmentId">
                                <v-alert class="disbursement-callout" type="info" variant="tonal">
                                    <template #title>{{ tt('personalFinance.loans.disbursement.title') }}</template>
                                    {{ tt('personalFinance.loans.disbursement.hint') }}
                                    <div class="funding-component mt-4" v-if="canRecordDisbursement">
                                        <div>
                                            <strong>{{ tt('personalFinance.loans.component.disbursement') }}</strong>
                                            <div class="text-body-small text-medium-emphasis">
                                                {{ tt('personalFinance.loans.settlement.outstanding', { amount: formatAmount(disbursementOutstanding, selectedDetail.contract.currency) }) }}
                                            </div>
                                        </div>
                                        <v-spacer />
                                        <v-btn size="small" variant="tonal" :loading="loadingComponent === 'disbursement'" @click="loadFundingCandidates('disbursement')">
                                            {{ tt('personalFinance.loans.settlement.findCandidates') }}
                                        </v-btn>
                                        <v-btn size="small" variant="text" @click="openFundingDraft('disbursement')">
                                            {{ tt('personalFinance.loans.settlement.createLedgerDraft') }}
                                        </v-btn>
                                    </div>
                                    <div class="funding-component mt-3" v-if="canRecordUpfrontFee">
                                        <div>
                                            <strong>{{ tt('personalFinance.loans.component.upfrontFee') }}</strong>
                                            <div class="text-body-small text-medium-emphasis">
                                                {{ tt('personalFinance.loans.settlement.outstanding', { amount: formatAmount(upfrontFeeOutstanding, selectedDetail.contract.currency) }) }}
                                            </div>
                                        </div>
                                        <v-spacer />
                                        <v-btn size="small" variant="tonal" :loading="loadingComponent === 'fee'" @click="loadFundingCandidates('fee')">
                                            {{ tt('personalFinance.loans.settlement.findCandidates') }}
                                        </v-btn>
                                        <v-btn size="small" variant="text" @click="openFundingDraft('fee')">
                                            {{ tt('personalFinance.loans.settlement.createLedgerDraft') }}
                                        </v-btn>
                                    </div>
                                </v-alert>
                                <div :key="componentType" v-for="componentType in fundingCandidateTypes">
                                    <div class="text-body-small font-weight-bold mt-3">{{ tt(getLoanComponentTypeKey(componentType)) }}</div>
                                    <div class="candidate-rail mt-2">
                                        <v-btn
                                            :key="candidate.transactionId"
                                            v-for="candidate in candidateGroup(componentType)?.candidates"
                                            variant="outlined"
                                            :disabled="!candidate.eligible"
                                            @click="openCandidate(componentType, candidate)"
                                        >
                                            {{ candidate.transactionDate }} · {{ formatAmount(candidate.amount, selectedDetail.contract.currency) }}
                                        </v-btn>
                                    </div>
                                </div>
                                <div class="d-flex flex-wrap justify-space-between align-center ga-2 mt-4" v-if="components.length && !selectedInstallmentId">
                                    <div class="d-flex flex-wrap ga-2">
                                        <v-chip :key="component.componentType" v-for="component in components" color="primary" variant="tonal">
                                            {{ tt(component.componentType === 'fee' ? 'personalFinance.loans.component.upfrontFee' : getLoanComponentTypeKey(component.componentType)) }} ·
                                            {{ formatAmount(component.allocatedAmount, selectedDetail.contract.currency) }}
                                        </v-chip>
                                    </div>
                                    <v-btn color="primary" :loading="submitting" @click="apply">
                                        {{ tt('personalFinance.loans.settlement.apply') }}
                                    </v-btn>
                                </div>
                                <div class="d-flex justify-end mt-4" v-if="lastSettlementActionId && !undoImpact">
                                    <v-btn variant="text" :loading="submitting" @click="inspectUndo">
                                        {{ tt('personalFinance.loans.settlement.inspectUndo') }}
                                    </v-btn>
                                </div>
                                <v-alert class="mt-4" :type="undoImpact?.canUndoRelationships ? 'warning' : 'error'" variant="tonal" v-if="undoImpact">
                                    <div class="font-weight-bold">{{ tt('personalFinance.loans.settlement.undoImpact') }}</div>
                                    <div class="mt-1">
                                        {{ tt('personalFinance.loans.settlement.undoImpactCounts', {
                                            allocations: undoImpact.activeAllocationCount,
                                            transactions: undoImpact.affectedTransactionCount,
                                            modified: undoImpact.modifiedTransactionCount + undoImpact.missingTransactionCount
                                        }) }}
                                    </div>
                                    <div class="mt-2">{{ tt('personalFinance.loans.settlement.undoKeepsTransactions') }}</div>
                                    <div class="d-flex justify-end mt-3">
                                        <v-btn color="error" variant="tonal" :disabled="!undoImpact.canUndoRelationships" @click="confirmUndo(undoImpact.actionId)">
                                            {{ tt('personalFinance.loans.settlement.undoRelationships') }}
                                        </v-btn>
                                    </div>
                                </v-alert>
                            </div>

                            <loan-schedule-panel
                                :detail="selectedDetail"
                                :selected-installment-id="selectedInstallmentId"
                                @revise="startRevise"
                                @select-installment="selectInstallment"
                                @settle="selectInstallment"
                            />

                            <div class="pa-5 pa-lg-6">
                                <loan-settlement-panel
                                    :installment="selectedInstallment"
                                    :currency="selectedDetail.contract.currency"
                                    :candidates="candidates"
                                    :components="components"
                                    :undo-impact="undoImpact"
                                    :loading-component="loadingComponent"
                                    :submitting="submitting"
                                    :can-inspect-undo="!!lastSettlementActionId"
                                    @load-candidates="loadCandidates"
                                    @select-candidate="openCandidate"
                                    @create-draft="openDraft"
                                    @apply="apply"
                                    @inspect-undo="inspectUndo"
                                    @undo="confirmUndo"
                                />
                            </div>
                        </template>
                    </v-col>
                </v-row>
            </v-card>
        </v-col>
    </v-row>

    <v-dialog max-width="1040" scrollable v-model="showComposer">
        <v-card>
            <v-card-title class="d-flex align-center px-5 pt-5">
                <span>{{ tt(composerMode === 'create' ? 'personalFinance.loans.create.title' : 'personalFinance.loans.revise.title') }}</span>
                <v-spacer />
                <v-btn :icon="mdiClose" variant="text" @click="closeComposer" />
            </v-card-title>
            <v-card-text class="pa-5">
                <v-alert class="mb-5" type="info" variant="tonal" v-if="composerMode === 'revise'">
                    {{ tt('personalFinance.loans.revise.identityLocked') }}
                </v-alert>
                <loan-contract-form
                    v-if="composerMode === 'create'"
                    :model-value="identity"
                    :liability-accounts="liabilityAccountOptions"
                    :payment-accounts="compatiblePaymentAccountOptions"
                    :disabled="submitting"
                    @update:model-value="updateIdentity"
                />
                <loan-calculator-panel
                    class="mt-5"
                    :model-value="calculationInput"
                    :result="calculationResult"
                    :currency="composerCurrency"
                    :loading="calculating"
                    :disabled="submitting"
                    @update:model-value="updateCalculation"
                    @calculate="runCalculation"
                />
            </v-card-text>
            <v-card-actions class="px-5 pb-5">
                <v-spacer />
                <v-btn variant="text" :disabled="submitting" @click="closeComposer">{{ tt('Cancel') }}</v-btn>
                <v-btn color="primary" :disabled="!calculationResult || !canSubmitComposer" :loading="submitting" @click="submitComposer">
                    {{ tt(composerMode === 'create' ? 'personalFinance.loans.create.submit' : 'personalFinance.loans.revise.submit') }}
                </v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>

    <v-dialog max-width="680" v-model="showDraftDialog">
        <v-card>
            <v-card-title class="px-5 pt-5">{{ tt('personalFinance.loans.settlement.draftTitle') }}</v-card-title>
            <v-card-text class="px-5 pb-2">
                <v-alert class="mb-4" type="warning" variant="tonal">{{ tt('personalFinance.loans.settlement.categoryRequired') }}</v-alert>
                <v-row>
                    <v-col cols="12" sm="6">
                        <v-select item-title="name" item-value="id" :items="draftSourceAccounts" :label="tt('personalFinance.loans.settlement.sourceAccount')" v-model="draft.sourceAccountId" />
                    </v-col>
                    <v-col cols="12" sm="6" v-if="draftNeedsDestination">
                        <v-select item-title="name" item-value="id" :items="draftDestinationAccounts" :label="tt('personalFinance.loans.settlement.destinationAccount')" v-model="draft.destinationAccountId" />
                    </v-col>
                    <v-col cols="12" sm="6">
                        <v-select item-title="name" item-value="id" :items="draftCategories" :label="tt('personalFinance.loans.settlement.category')" v-model="draft.categoryId" />
                    </v-col>
                    <v-col cols="12" sm="6">
                        <v-text-field type="date" :label="tt('personalFinance.loans.settlement.transactionDate')" v-model="draft.transactionDate" />
                    </v-col>
                    <v-col cols="12" sm="6">
                        <amount-input :label="tt('personalFinance.loans.settlement.allocatedAmount')"
                                      :currency="selectedDetail?.contract.currency ?? userStore.currentUserDefaultCurrency" show-currency
                                      v-model="draft.amount" />
                        <div class="text-caption text-medium-emphasis mt-1">{{ tt('personalFinance.loans.settlement.draftAmountHint') }}</div>
                    </v-col>
                    <v-col cols="12" sm="6">
                        <v-text-field readonly :label="tt('Currency')" :model-value="selectedDetail?.contract.currency" />
                    </v-col>
                </v-row>
            </v-card-text>
            <v-card-actions class="px-5 pb-5">
                <v-spacer />
                <v-btn variant="text" @click="showDraftDialog = false">{{ tt('Cancel') }}</v-btn>
                <v-btn color="primary" :disabled="!draftValid" @click="saveDraft">{{ tt('personalFinance.loans.settlement.useDraft') }}</v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>

    <v-dialog max-width="520" v-model="showCloseDialog">
        <v-card>
            <v-card-title class="px-5 pt-5">{{ tt('personalFinance.loans.lifecycle.close') }}</v-card-title>
            <v-card-text class="px-5 pb-2">
                <v-select item-title="title" item-value="value" :items="closeReasonOptions" :label="tt('personalFinance.loans.lifecycle.closeReason')" v-model="closeReason" />
                <v-alert type="warning" variant="tonal">{{ tt('personalFinance.loans.lifecycle.closeHint') }}</v-alert>
            </v-card-text>
            <v-card-actions class="px-5 pb-5">
                <v-spacer />
                <v-btn variant="text" @click="showCloseDialog = false">{{ tt('Cancel') }}</v-btn>
                <v-btn color="warning" :loading="submitting" @click="confirmClose">{{ tt('personalFinance.loans.lifecycle.close') }}</v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>

    <confirm-dialog ref="confirmDialog" />
    <snack-bar ref="snackbar" />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, useTemplateRef } from 'vue';
import { mdiBankOutline, mdiClose, mdiDotsVertical, mdiRefresh } from '@mdi/js';

import ConfirmDialog from '@/components/desktop/ConfirmDialog.vue';
import AmountInput from '@/components/desktop/AmountInput.vue';
import SnackBar from '@/components/desktop/SnackBar.vue';
import { AccountCategory, AccountType } from '@/core/account.ts';
import { CategoryType } from '@/core/category.ts';
import { useI18n } from '@/locales/helpers.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';
import type { Account } from '@/models/account.ts';
import type { TransactionCategory } from '@/models/transaction_category.ts';
import { useAccountsStore } from '@/stores/account.ts';
import { useTransactionCategoriesStore } from '@/stores/transactionCategory.ts';
import { useUserStore } from '@/stores/user.ts';

import { createLoanWorkbenchController } from '../controller.ts';
import { loanApi } from '../service.ts';
import type {
    LoanActionResult,
    LoanCloseReason,
    LoanComponentType,
    LoanContractIdentityInput,
    LoanContractStatus,
    LoanReason,
    LoanSettlementCandidate
} from '../models.ts';
import {
    getLoanComponentTypeKey,
    getLoanContractStatusKey,
    getLoanContractTypeKey,
    getLoanReasonKey,
    getLoanRepaymentMethodKey,
    getLoanStatusColor
} from '../presentation.ts';
import { canCancelLoanContract, canReviseLoanContract, createDefaultLoanCalculationInput, getLoanSettlementDraftDate } from '../state.ts';
import LoanCalculatorPanel from './components/LoanCalculatorPanel.vue';
import LoanCalculationResultPanel from './components/LoanCalculationResultPanel.vue';
import LoanContractForm from './components/LoanContractForm.vue';
import LoanContractList from './components/LoanContractList.vue';
import LoanSchedulePanel from './components/LoanSchedulePanel.vue';
import LoanSettlementPanel from './components/LoanSettlementPanel.vue';

type SnackBarType = InstanceType<typeof SnackBar>;
type ConfirmDialogType = InstanceType<typeof ConfirmDialog>;
type ComposerMode = 'create' | 'revise';

const { tt, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
const accountsStore = useAccountsStore();
const categoriesStore = useTransactionCategoriesStore();
const userStore = useUserStore();
const snackbar = useTemplateRef<SnackBarType>('snackbar');
const confirmDialog = useTemplateRef<ConfirmDialogType>('confirmDialog');
const controller = createLoanWorkbenchController({ service: loanApi });
const {
    status, items, nextCursor, selectedDetail, selectedInstallmentId, calculationInput, calculationResult,
    candidates, components, undoImpact, lastSettlementActionId, loadingList, loadingDetail, calculating,
    submitting, loadingComponent
} = controller;

const identity = ref<LoanContractIdentityInput>(createIdentity());
const allAccounts = ref<Account[]>([]);
const allCategories = ref<Record<number, TransactionCategory[]>>({});
const showComposer = ref(false);
const composerMode = ref<ComposerMode>('create');
const showDraftDialog = ref(false);
const draftComponent = ref<LoanComponentType>('principal');
const draft = reactive({ sourceAccountId: '', destinationAccountId: '', categoryId: '', transactionDate: '', amount: 0 });
const showCloseDialog = ref(false);
const closeReason = ref<LoanCloseReason>('paid_off');

const flattenedAccounts = computed(() => allAccounts.value.flatMap(account =>
    account.type === AccountType.MultiSubAccounts.type ? account.subAccounts ?? [] : [account]
));
const liabilityAccountOptions = computed(() => flattenedAccounts.value
    .filter(account => account.type === AccountType.SingleAccount.type && account.visible &&
        (account.category === AccountCategory.CreditCard.type || account.category === AccountCategory.DebtAccount.type))
    .map(toAccountOption));
const paymentAccountOptions = computed(() => flattenedAccounts.value
    .filter(account => account.type === AccountType.SingleAccount.type && account.visible && account.isAsset)
    .map(toAccountOption));
const compatiblePaymentAccountOptions = computed(() => paymentAccountOptions.value.filter(account => account.currency === identity.value.currency));
const selectedInstallment = computed(() => selectedDetail.value?.installments.find(item => item.id === selectedInstallmentId.value) ?? null);
const composerCurrency = computed(() => composerMode.value === 'create' ? identity.value.currency : selectedDetail.value?.contract.currency ?? userStore.currentUserDefaultCurrency);
const canSubmitComposer = computed(() => composerMode.value === 'revise' || (
    !!identity.value.name.trim() && !!identity.value.lenderName.trim() && !!identity.value.liabilityAccountId &&
    /^[A-Z]{3}$/.test(identity.value.currency) && liabilityAccountOptions.value.some(account => account.id === identity.value.liabilityAccountId && account.currency === identity.value.currency) &&
    (!identity.value.defaultPaymentAccountId || compatiblePaymentAccountOptions.value.some(account => account.id === identity.value.defaultPaymentAccountId))
));
const allDetailReasons = computed<LoanReason[]>(() => {
    const detail = selectedDetail.value;
    if (!detail) return [];
    const reasons = [...detail.reasonCodes, ...detail.liabilityComparison.reasonCodes];
    for (const installment of detail.installments) {
        if (installment.progress.actionRequired) reasons.push(...installment.progress.reasonCodes);
    }
    return reasons.filter((reason, index) => reasons.findIndex(item => item.code === reason.code) === index);
});
const disbursementOutstanding = computed(() => selectedDetail.value
    ? Math.max(0, selectedDetail.value.currentRevision.input.principalAmount - selectedDetail.value.allocations.allocatedDisbursementAmount)
    : 0);
const allocatedInstallmentFees = computed(() => selectedDetail.value?.installments.reduce((sum, item) => sum + item.progress.allocatedFeeAmount, 0) ?? 0);
const allocatedUpfrontFees = computed(() => selectedDetail.value
    ? Math.max(0, selectedDetail.value.allocations.allocatedFeeAmount - allocatedInstallmentFees.value)
    : 0);
const upfrontFeeOutstanding = computed(() => selectedDetail.value
    ? Math.max(0, selectedDetail.value.currentRevision.input.upfrontFeeAmount - allocatedUpfrontFees.value)
    : 0);
const canRecordDisbursement = computed(() => selectedDetail.value?.contract.status === 'active' &&
    selectedDetail.value.currentRevision.input.fundingType === 'cash_disbursement' &&
    disbursementOutstanding.value > 0);
const canRecordUpfrontFee = computed(() => selectedDetail.value?.contract.status === 'active' && upfrontFeeOutstanding.value > 0);
const canRecordFundingComponents = computed(() => canRecordDisbursement.value || canRecordUpfrontFee.value || !!lastSettlementActionId.value || !!undoImpact.value);
const fundingCandidateTypes = computed<LoanComponentType[]>(() => candidates.value?.installmentId
    ? []
    : candidates.value?.groups.map(group => group.componentType).filter(type => type === 'disbursement' || type === 'fee') ?? []);
const draftNeedsDestination = computed(() => draftComponent.value === 'disbursement' || draftComponent.value === 'principal');
const draftOutstanding = computed(() => candidateGroup(draftComponent.value)?.outstandingAmount ?? componentOutstanding(draftComponent.value));
const draftSourceAccounts = computed(() => {
    if (!selectedDetail.value) return [];
    return draftComponent.value === 'disbursement'
        ? liabilityAccountOptions.value.filter(account => account.id === selectedDetail.value!.contract.liabilityAccountId)
        : paymentAccountOptions.value.filter(account => account.currency === selectedDetail.value!.contract.currency);
});
const draftDestinationAccounts = computed(() => {
    if (!selectedDetail.value) return [];
    return draftComponent.value === 'disbursement'
        ? paymentAccountOptions.value.filter(account => account.currency === selectedDetail.value!.contract.currency)
        : liabilityAccountOptions.value.filter(account => account.id === selectedDetail.value!.contract.liabilityAccountId);
});
const draftCategories = computed(() => flattenCategories(draftNeedsDestination.value ? CategoryType.Transfer : CategoryType.Expense));
const draftValid = computed(() => !!selectedDetail.value && !!draft.sourceAccountId && !!draft.categoryId && !!draft.transactionDate &&
    (!draftNeedsDestination.value || (!!draft.destinationAccountId && draft.destinationAccountId !== draft.sourceAccountId)) &&
    Number.isSafeInteger(draft.amount) && draft.amount > 0 && draft.amount <= draftOutstanding.value);
const closeReasonOptions = computed(() => [
    { title: tt('personalFinance.loans.lifecycle.paidOff'), value: 'paid_off' },
    { title: tt('personalFinance.loans.lifecycle.manualClose'), value: 'manual_close' },
    { title: tt('personalFinance.loans.lifecycle.writtenOff'), value: 'written_off' }
]);

function createIdentity(): LoanContractIdentityInput {
    return { name: '', lenderName: '', contractType: 'bank_loan', liabilityAccountId: '', currency: userStore.currentUserDefaultCurrency || 'CNY', note: '' };
}

function toAccountOption(account: Account) {
    return { id: account.id, name: account.name, currency: account.currency };
}

function flattenCategories(type: CategoryType) {
    return (allCategories.value[type] ?? []).flatMap(category => category.subCategories ?? [])
        .filter(category => category.visible)
        .map(category => ({ id: category.id, name: category.name }));
}

function addOneMonth(dateText: string): string {
    const date = new Date(`${dateText}T00:00:00Z`);
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
    return date.toISOString().slice(0, 10);
}

function resetCalculation(): void {
    const today = new Date().toISOString().slice(0, 10);
    calculationInput.value = { ...createDefaultLoanCalculationInput(), effectiveDate: today, contractDate: today, firstDueDate: addOneMonth(today) };
    calculationResult.value = undefined;
}

function updateCalculation(value: typeof calculationInput.value): void {
    calculationInput.value = value;
    calculationResult.value = undefined;
}

function updateIdentity(value: LoanContractIdentityInput): void {
    const liability = liabilityAccountOptions.value.find(account => account.id === value.liabilityAccountId);
    const currency = liability?.currency ?? value.currency;
    const paymentStillCompatible = compatiblePaymentAccountOptions.value.some(account => account.id === value.defaultPaymentAccountId && account.currency === currency);
    identity.value = { ...value, currency, ...(paymentStillCompatible ? {} : { defaultPaymentAccountId: undefined }) };
}

function startCreate(): void {
    composerMode.value = 'create';
    identity.value = createIdentity();
    resetCalculation();
    showComposer.value = true;
}

function startRevise(): void {
    if (!selectedDetail.value || !canReviseLoanContract(selectedDetail.value)) return;
    composerMode.value = 'revise';
    calculationInput.value = { ...selectedDetail.value.currentRevision.input };
    calculationResult.value = undefined;
    showComposer.value = true;
}

function closeComposer(): void {
    showComposer.value = false;
    calculationResult.value = undefined;
}

async function runCalculation(): Promise<void> {
    await safely(async () => { await controller.calculate(); });
}

async function submitComposer(): Promise<void> {
    await safely(async () => {
        const result = composerMode.value === 'create'
            ? await controller.createContract(identity.value)
            : await controller.reviseContract();
        if (showActionResult(result, composerMode.value === 'create' ? 'personalFinance.loans.message.created' : 'personalFinance.loans.message.revised')) {
            showComposer.value = false;
        }
    });
}

async function changeFilter(value: LoanContractStatus): Promise<void> {
    await safely(() => controller.changeStatus(value));
}

async function refresh(): Promise<void> {
    await safely(() => controller.reload(!selectedDetail.value));
}

async function loadMore(): Promise<void> {
    await safely(() => controller.loadContracts(true));
}

async function openContract(contractId: string): Promise<void> {
    await safely(() => controller.openContract(contractId));
}

function selectInstallment(installmentId: string): void {
    controller.selectInstallment(installmentId);
}

function candidateGroup(componentType: LoanComponentType) {
    return candidates.value?.groups.find(group => group.componentType === componentType);
}

function componentOutstanding(componentType: LoanComponentType): number {
    if (componentType === 'disbursement') {
        return disbursementOutstanding.value;
    }
    if (componentType === 'fee' && !selectedInstallmentId.value) return upfrontFeeOutstanding.value;
    const installment = selectedInstallment.value;
    if (!installment) return 0;
    if (componentType === 'principal') return installment.progress.outstandingPrincipalAmount;
    if (componentType === 'interest') return installment.progress.outstandingInterestAmount;
    return installment.progress.outstandingFeeAmount;
}

async function loadFundingCandidates(componentType: 'disbursement' | 'fee'): Promise<void> {
    controller.selectInstallment(undefined);
    await loadCandidates(componentType);
}

async function loadCandidates(componentType: LoanComponentType): Promise<void> {
    await safely(() => controller.loadSettlementCandidates(componentType));
}

function openCandidate(componentType: LoanComponentType, candidate: LoanSettlementCandidate): void {
    controller.selectCandidate(componentType, candidate);
}

function openDraft(componentType: LoanComponentType): void {
    draftComponent.value = componentType;
    draft.sourceAccountId = '';
    draft.destinationAccountId = '';
    draft.categoryId = '';
    draft.transactionDate = selectedDetail.value
        ? getLoanSettlementDraftDate(selectedDetail.value, selectedInstallmentId.value, componentType)
        : '';
    draft.amount = draftOutstanding.value;
    showDraftDialog.value = true;
}

function openFundingDraft(componentType: 'disbursement' | 'fee'): void {
    controller.selectInstallment(undefined);
    openDraft(componentType);
}

function saveDraft(): void {
    if (!draftValid.value || !selectedDetail.value) return;
    const common = {
        transactionDate: draft.transactionDate,
        sourceAccountId: draft.sourceAccountId,
        categoryId: draft.categoryId,
        amount: draft.amount,
        currency: selectedDetail.value.contract.currency
    };
    controller.setLedgerDraft(draftComponent.value, draft.amount, draftNeedsDestination.value
        ? { ...common, transactionType: 'transfer', destinationAccountId: draft.destinationAccountId }
        : { ...common, transactionType: 'expense' });
    showDraftDialog.value = false;
}

async function apply(): Promise<void> {
    await safely(async () => {
        showActionResult(await controller.applySettlement(), 'personalFinance.loans.message.settlementApplied');
    });
}

async function inspectUndo(): Promise<void> {
    await safely(() => controller.inspectUndo());
}

async function confirmUndo(actionId: string): Promise<void> {
    try {
        await confirmDialog.value?.open('personalFinance.loans.lifecycle.confirmTitle', 'personalFinance.loans.settlement.undoConfirm');
        await safely(async () => {
            showActionResult(await controller.undoSettlement(actionId), 'personalFinance.loans.message.settlementUndone');
        });
    } catch { /* user cancelled */ }
}

async function confirmClose(): Promise<void> {
    await safely(async () => {
        if (showActionResult(await controller.closeContract(closeReason.value), 'personalFinance.loans.message.closed')) {
            showCloseDialog.value = false;
        }
    });
}

async function confirmReopen(): Promise<void> {
    try {
        await confirmDialog.value?.open('personalFinance.loans.lifecycle.confirmTitle', 'personalFinance.loans.lifecycle.reopenConfirm');
        await safely(async () => { showActionResult(await controller.reopenContract(), 'personalFinance.loans.message.reopened'); });
    } catch { /* user cancelled */ }
}

async function confirmCancel(): Promise<void> {
    try {
        await confirmDialog.value?.open('personalFinance.loans.lifecycle.confirmTitle', 'personalFinance.loans.lifecycle.cancelConfirm', { color: 'error' });
        await safely(async () => { showActionResult(await controller.cancelContract(), 'personalFinance.loans.message.cancelled'); });
    } catch { /* user cancelled */ }
}

function reasonText(code: string, count?: number): string {
    return tt(getLoanReasonKey(code), { code, count: count ?? 0 });
}

function showActionResult(result: LoanActionResult, successKey: string): boolean {
    if (result.status !== 'applied') {
        snackbar.value?.showMessage('personalFinance.loans.message.actionRequired');
        return false;
    }
    snackbar.value?.showMessage(successKey);
    return true;
}

function formatAmount(amount: number, currency: string): string {
    return formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(amount), currency);
}

async function safely(command: () => Promise<unknown>): Promise<void> {
    try {
        await command();
    } catch {
        snackbar.value?.showMessage('personalFinance.loans.error.operationFailed');
    }
}

onMounted(async () => {
    try {
        const [accounts, categories] = await Promise.all([
            accountsStore.loadAllAccounts({ force: false }),
            categoriesStore.loadAllCategories({ force: false })
        ]);
        allAccounts.value = accounts;
        allCategories.value = categories;
    } catch {
        snackbar.value?.showMessage('personalFinance.loans.error.referenceDataFailed');
    }
    await safely(() => controller.reload(true));
});

onBeforeUnmount(() => controller.dispose());
</script>

<style scoped>
.loan-workbench { min-height: calc(100vh - 130px); }
.loan-hero { display: flex; align-items: center; gap: 28px; background: radial-gradient(circle at 92% 8%, rgba(var(--v-theme-primary), .14), transparent 28%), linear-gradient(135deg, rgba(var(--v-theme-primary), .045), transparent 50%); }
.toolbar, .detail-header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.contract-column { min-height: 680px; }
.detail-column { min-width: 0; }
.calculation-disclosure :deep(.v-expansion-panel) { border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.candidate-rail { display: flex; flex-wrap: wrap; gap: 8px; }
.funding-component { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 0; }
.funding-component + .funding-component { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.disbursement-callout { border-inline-start: 4px solid rgb(var(--v-theme-primary)); }
@media (max-width: 959px) { .loan-hero { align-items: flex-start; flex-direction: column; } .contract-column { min-height: auto; } }
</style>
