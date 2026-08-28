<template>
    <v-card class="loan-workbench overflow-hidden">
        <div class="loan-hero px-5 py-4">
            <div class="loan-hero-copy">
                <div class="text-overline text-primary">{{ tt('personalFinance.loans.eyebrow') }}</div>
                <div class="loan-title-row">
                    <h2 class="text-h5 font-weight-bold">{{ tt('personalFinance.loans.title') }}</h2>
                    <p class="text-body-medium text-medium-emphasis mb-0">
                        {{ tt('personalFinance.loans.subtitle') }}
                    </p>
                </div>
            </div>
            <div class="loan-hero-actions">
                <v-btn color="primary" size="small" variant="tonal" :prepend-icon="mdiPlus" @click="startCreate">
                    {{ tt('personalFinance.loans.contracts.create') }}
                </v-btn>
                <v-btn :icon="mdiRefresh" size="small" variant="text" :loading="loadingList || loadingInstallmentCandidates" @click="refresh">
                    <v-tooltip activator="parent">{{ tt('Refresh') }}</v-tooltip>
                </v-btn>
            </div>
        </div>

        <v-divider />

        <nav class="workspace-nav px-5 py-3" :aria-label="tt('personalFinance.loans.workspace.label')">
            <v-btn-toggle color="primary" density="compact" divided mandatory variant="outlined" :model-value="workspaceView" @update:model-value="changeWorkspace">
                <v-btn value="active">{{ tt('personalFinance.loans.workspace.active') }}</v-btn>
                <v-btn value="incomplete">
                    {{ tt('personalFinance.loans.workspace.incomplete') }}
                    <span class="workspace-count" v-if="installmentCandidates.length">{{ installmentCandidates.length }}</span>
                </v-btn>
            </v-btn-toggle>
        </nav>

        <v-divider />

        <section class="installment-inbox px-5 py-4" v-if="workspaceView === 'incomplete'">
            <div class="installment-inbox-heading">
                <div>
                    <div class="text-subtitle-1 font-weight-bold">
                        {{ tt('personalFinance.loans.candidates.title') }}
                        <span class="text-primary">{{ installmentCandidates.length }}</span>
                    </div>
                    <div class="text-body-small text-medium-emphasis">{{ tt('personalFinance.loans.candidates.hint') }}</div>
                </div>
                <v-progress-circular v-if="loadingInstallmentCandidates" color="primary" indeterminate size="24" width="2" />
            </div>
            <div class="installment-candidate-list mt-3" v-if="installmentCandidates.length">
                <div class="installment-candidate-row" :key="candidate.id" v-for="candidate in installmentCandidates">
                    <div class="installment-candidate-copy">
                        <strong>{{ candidateName(candidate) }}</strong>
                        <span class="text-body-small text-medium-emphasis">
                            {{ candidateFacts(candidate).join(' · ') }}
                        </span>
                    </div>
                    <v-btn color="primary" size="small" variant="tonal" @click="completeInstallmentCandidate(candidate)">
                        {{ tt('personalFinance.loans.candidates.complete') }}
                    </v-btn>
                </div>
            </div>
            <div class="installment-empty py-16 text-center" v-else-if="!loadingInstallmentCandidates">
                <v-icon color="medium-emphasis" size="48" :icon="mdiFileDocumentOutline" />
                <div class="text-subtitle-1 font-weight-bold mt-3">{{ tt('personalFinance.loans.workspace.incompleteEmpty') }}</div>
                <div class="text-body-small text-medium-emphasis mt-1">{{ tt('personalFinance.loans.workspace.incompleteEmptyHint') }}</div>
            </div>
        </section>

        <div class="workbench-grid" v-else>
                    <aside class="contract-column" v-if="!selectedDetail">
                        <section class="portfolio-overview px-5 py-4">
                            <div class="portfolio-heading">
                                <div>
                                    <h3 class="text-h6 font-weight-bold">{{ tt('personalFinance.loans.portfolio.title') }}</h3>
                                    <p class="text-body-small text-medium-emphasis mb-0">{{ tt('personalFinance.loans.portfolio.hint') }}</p>
                                </div>
                                <span class="portfolio-record-count">
                                    {{ tt('personalFinance.loans.portfolio.recordCount', { count: items.length }) }}
                                </span>
                            </div>
                            <div class="portfolio-currency-grid mt-4" v-if="portfolioSummaries.length">
                                <article class="portfolio-currency-card" :key="summary.currency" v-for="summary in portfolioSummaries">
                                    <div class="portfolio-primary">
                                        <div class="portfolio-card-label">
                                            {{ tt('personalFinance.loans.portfolio.remainingPayment') }}
                                            <v-chip size="x-small" variant="tonal">{{ summary.currency }}</v-chip>
                                        </div>
                                        <strong>{{ formatAmount(summary.outstandingPaymentAmount, summary.currency) }}</strong>
                                        <span>
                                            {{ tt('personalFinance.loans.portfolio.activeCount', { count: summary.recordCount }) }}
                                            <template v-if="summary.actionRequiredCount">
                                                · {{ tt('personalFinance.loans.portfolio.actionCount', { count: summary.actionRequiredCount }) }}
                                            </template>
                                        </span>
                                    </div>
                                    <div class="portfolio-metrics">
                                        <div>
                                            <span>{{ tt('personalFinance.loans.result.principal') }}</span>
                                            <strong>{{ formatAmount(summary.totalPrincipalAmount, summary.currency) }}</strong>
                                        </div>
                                        <div>
                                            <span>{{ tt('personalFinance.loans.result.totalCost') }}</span>
                                            <strong>{{ formatAmount(summary.totalCostAmount, summary.currency) }}</strong>
                                        </div>
                                        <div>
                                            <span>{{ tt('personalFinance.loans.result.remainingPrincipal') }}</span>
                                            <strong>{{ formatAmount(summary.outstandingPrincipalAmount, summary.currency) }}</strong>
                                        </div>
                                        <div>
                                            <span>{{ tt('personalFinance.loans.portfolio.remainingCost') }}</span>
                                            <strong>{{ formatAmount(summary.outstandingCostAmount, summary.currency) }}</strong>
                                        </div>
                                        <div>
                                            <span>{{ tt('personalFinance.loans.portfolio.nextPayment') }}</span>
                                            <strong v-if="summary.nextDueDate">{{ formatAmount(summary.nextDueAmount, summary.currency) }}</strong>
                                            <strong v-else>—</strong>
                                            <small>{{ summary.nextDueDate ?? tt('personalFinance.loans.portfolio.completed') }}</small>
                                        </div>
                                    </div>
                                </article>
                            </div>
                        </section>
                        <v-divider />
                        <div class="record-list-heading px-5 py-3">
                            <div>
                                <div class="text-subtitle-1 font-weight-bold">{{ tt('personalFinance.loans.contracts.title') }}</div>
                                <div class="text-body-small text-medium-emphasis">{{ tt('personalFinance.loans.contracts.listHint') }}</div>
                            </div>
                        </div>
                        <loan-contract-list
                            :items="items"
                            :loading="loadingList"
                            :has-more="!!nextCursor"
                            @load-more="loadMore"
                            @select="openContract"
                        />
                    </aside>

                    <main class="detail-column" v-else>
                        <v-skeleton-loader class="pa-6" type="heading, paragraph, image, paragraph" v-if="loadingDetail && !selectedDetail" />

                        <div class="empty-detail pa-12 text-center" v-else-if="!selectedDetail">
                            <v-icon color="medium-emphasis" size="58" :icon="mdiBankOutline" />
                            <div class="text-h6 mt-4">{{ tt('personalFinance.loans.selectContract') }}</div>
                            <div class="text-body-medium text-medium-emphasis mt-1">{{ tt('personalFinance.loans.selectContractHint') }}</div>
                        </div>

                        <template v-else>
                            <div class="detail-header px-5 py-4">
                                <v-btn :icon="mdiArrowLeft" size="small" variant="text" @click="closeDetail">
                                    <v-tooltip activator="parent">{{ tt('Back') }}</v-tooltip>
                                </v-btn>
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

                            <div class="px-5 pb-4" v-if="allDetailReasons.length">
                                <v-alert density="compact" type="warning" variant="tonal">
                                    <div class="font-weight-bold">{{ tt('personalFinance.loans.actionRequired') }}</div>
                                    <div class="mt-1" :key="`${reason.code}-${index}`" v-for="(reason, index) in allDetailReasons">
                                        {{ reasonText(reason.code, reason.count) }}
                                    </div>
                                </v-alert>
                            </div>

                            <v-divider />

                            <section class="calculation-summary px-5 py-4">
                                <loan-calculation-result-panel
                                    :input="selectedDetail.currentRevision.input"
                                    :result="selectedDetail.currentRevision.calculation"
                                    :currency="selectedDetail.contract.currency"
                                    :show-actual-disbursement="selectedDetail.contract.contractType !== 'credit_card_installment'"
                                    :show-installments="false"
                                />
                            </section>

                            <v-divider />

                            <div class="px-5 py-4" v-if="canRecordFundingComponents && !selectedInstallmentId">
                                <v-alert class="disbursement-callout" density="compact" type="info" variant="tonal">
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
                                @select-installment="selectInstallment"
                                @settle="selectInstallment"
                            />

                            <div class="settlement-wrap px-5 py-4" v-if="selectedInstallment">
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
                    </main>
        </div>
    </v-card>

    <v-dialog :max-width="composerMode === 'revise' ? 900 : 1040" scrollable v-model="showComposer">
        <v-card>
            <v-card-title class="d-flex align-center px-5 pt-5">
                <span>{{ tt(composerMode === 'create' ? 'personalFinance.loans.create.title' : 'personalFinance.loans.revise.title') }}</span>
                <v-spacer />
                <v-btn :icon="mdiClose" variant="text" @click="closeComposer" />
            </v-card-title>
            <v-card-text class="pa-5">
                <v-alert class="mb-5" type="info" variant="tonal" v-if="composerCandidate">
                    {{ tt('personalFinance.loans.candidates.composerHint', {
                        term: composerCandidate.termCount ?? tt('personalFinance.loans.candidates.unknown'),
                        period: composerCandidate.currentPeriod ?? tt('personalFinance.loans.candidates.unknown')
                    }) }}
                </v-alert>
                <div class="edit-installment-note mb-4" v-if="composerMode === 'revise' && selectedDetail">
                    <div>
                        <strong>{{ selectedDetail.contract.name }}</strong>
                        <span>{{ selectedLiabilityAccountName }}</span>
                    </div>
                    <p>{{ tt('personalFinance.loans.revise.identityLocked') }}</p>
                </div>
                <loan-contract-form
                    v-if="composerMode === 'create'"
                    :model-value="identity"
                    :liability-accounts="liabilityAccountOptions"
                    :payment-accounts="compatiblePaymentAccountOptions"
                    :disabled="composerSubmitting"
                    @update:model-value="updateIdentity"
                />
                <loan-calculator-panel
                    :class="{ 'mt-5': composerMode === 'create' }"
                    :model-value="calculationInput"
                    :result="calculationResult"
                    :currency="composerCurrency"
                    :loading="calculating"
                    :disabled="composerSubmitting"
                    :embedded="composerMode === 'revise'"
                    :compact-installment="composerMode === 'revise' && selectedDetail?.contract.contractType === 'credit_card_installment'"
                    :show-opening-completed-installment-count="composerMode !== 'revise'"
                    :purpose="composerMode === 'revise' ? 'installment-record' : 'calculation'"
                    @update:model-value="updateCalculation"
                    @calculate="runCalculation"
                >
                    <template #compact-liability-account v-if="composerMode === 'revise'">
                        <v-text-field
                            readonly
                            :label="tt('personalFinance.loans.field.liabilityAccount')"
                            :model-value="selectedLiabilityAccountName"
                        />
                    </template>
                </loan-calculator-panel>
            </v-card-text>
            <v-card-actions class="px-5 pb-5">
                <v-spacer />
                <v-btn variant="text" :disabled="composerSubmitting" @click="closeComposer">{{ tt('Cancel') }}</v-btn>
                <v-btn color="primary" :disabled="!calculationResult || !canSubmitComposer" :loading="composerSubmitting" @click="submitComposer">
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
import { useRoute, useRouter } from 'vue-router';
import { mdiArrowLeft, mdiBankOutline, mdiClose, mdiDotsVertical, mdiFileDocumentOutline, mdiPlus, mdiRefresh } from '@mdi/js';

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

import type { InstallmentCandidate } from '../../installments/models.ts';
import { installmentApi } from '../../installments/service.ts';
import { createLoanWorkbenchController } from '../controller.ts';
import { loanApi } from '../service.ts';
import type {
    LoanActionResult,
    LoanCloseReason,
    LoanComponentType,
    LoanContractIdentityInput,
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
type WorkspaceView = 'active' | 'incomplete';

const { tt, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
const route = useRoute();
const router = useRouter();
const accountsStore = useAccountsStore();
const categoriesStore = useTransactionCategoriesStore();
const userStore = useUserStore();
const snackbar = useTemplateRef<SnackBarType>('snackbar');
const confirmDialog = useTemplateRef<ConfirmDialogType>('confirmDialog');
const controller = createLoanWorkbenchController({ service: loanApi, pageLimit: 100 });
const {
    items, nextCursor, selectedDetail, selectedInstallmentId, calculationInput, calculationResult,
    candidates, components, undoImpact, lastSettlementActionId, loadingList, loadingDetail, calculating,
    submitting, loadingComponent
} = controller;

const identity = ref<LoanContractIdentityInput>(createIdentity());
const workspaceView = ref<WorkspaceView>('active');
const allAccounts = ref<Account[]>([]);
const allCategories = ref<Record<number, TransactionCategory[]>>({});
const showComposer = ref(false);
const composerMode = ref<ComposerMode>('create');
const composerCandidate = ref<InstallmentCandidate>();
const installmentCandidates = ref<InstallmentCandidate[]>([]);
const loadingInstallmentCandidates = ref(false);
const submittingInstallmentCandidate = ref(false);
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
const selectedLiabilityAccountName = computed(() => {
    const accountId = selectedDetail.value?.contract.liabilityAccountId;
    return liabilityAccountOptions.value.find(account => account.id === accountId)?.name ?? selectedDetail.value?.contract.lenderName ?? '';
});
const composerCurrency = computed(() => composerMode.value === 'create' ? identity.value.currency : selectedDetail.value?.contract.currency ?? userStore.currentUserDefaultCurrency);
const composerSubmitting = computed(() => submitting.value || submittingInstallmentCandidate.value);
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
const portfolioSummaries = computed(() => {
    const groups = new Map<string, {
        currency: string;
        recordCount: number;
        actionRequiredCount: number;
        totalPrincipalAmount: number;
        totalCostAmount: number;
        outstandingPrincipalAmount: number;
        outstandingPaymentAmount: number;
        outstandingCostAmount: number;
        nextDueDate?: string;
        nextDueAmount: number;
    }>();

    for (const item of items.value) {
        const currency = item.contract.currency;
        const summary = groups.get(currency) ?? {
            currency,
            recordCount: 0,
            actionRequiredCount: 0,
            totalPrincipalAmount: 0,
            totalCostAmount: 0,
            outstandingPrincipalAmount: 0,
            outstandingPaymentAmount: 0,
            outstandingCostAmount: 0,
            nextDueAmount: 0
        };
        summary.recordCount += 1;
        summary.actionRequiredCount += item.actionRequired ? 1 : 0;
        summary.totalPrincipalAmount += Math.max(0, item.calculation.totalPaymentAmount - item.calculation.totalCostAmount);
        summary.totalCostAmount += item.calculation.totalCostAmount;
        summary.outstandingPrincipalAmount += item.outstandingPrincipalAmount;
        summary.outstandingPaymentAmount += item.outstandingPaymentAmount;
        summary.outstandingCostAmount += Math.max(0, item.outstandingPaymentAmount - item.outstandingPrincipalAmount);

        const next = item.nextInstallment;
        if (next && (!summary.nextDueDate || next.dueDate <= summary.nextDueDate)) {
            if (next.dueDate < (summary.nextDueDate ?? '9999-12-31')) {
                summary.nextDueDate = next.dueDate;
                summary.nextDueAmount = 0;
            }
            summary.nextDueAmount += next.progress.outstandingPaymentAmount;
        }
        groups.set(currency, summary);
    }
    return [...groups.values()].sort((left, right) => left.currency.localeCompare(right.currency));
});

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
    composerCandidate.value = undefined;
    composerMode.value = 'create';
    identity.value = createIdentity();
    resetCalculation();
    showComposer.value = true;
}

function startRevise(): void {
    if (!selectedDetail.value || !canReviseLoanContract(selectedDetail.value)) return;
    composerCandidate.value = undefined;
    composerMode.value = 'revise';
    calculationInput.value = { ...selectedDetail.value.currentRevision.input };
    calculationResult.value = undefined;
    showComposer.value = true;
}

function closeDetail(): void {
    selectedDetail.value = null;
    selectedInstallmentId.value = undefined;
}

function closeComposer(): void {
    showComposer.value = false;
    composerCandidate.value = undefined;
    calculationResult.value = undefined;
}

function candidateName(candidate: InstallmentCandidate): string {
    return candidate.termCount
        ? tt('personalFinance.loans.candidates.defaultName', { count: candidate.termCount })
        : tt('personalFinance.loans.candidates.unknownTermName');
}

function candidateFacts(candidate: InstallmentCandidate): string[] {
    const facts: string[] = [];
    if (candidate.termCount) facts.push(tt('personalFinance.loans.candidates.termCount', { count: candidate.termCount }));
    if (candidate.currentPeriod) facts.push(tt('personalFinance.loans.candidates.currentPeriod', { count: candidate.currentPeriod }));
    facts.push(candidate.liabilityAccountId
        ? liabilityAccountOptions.value.find(account => account.id === candidate.liabilityAccountId)?.name ?? tt('personalFinance.loans.candidates.liabilityPending')
        : tt('personalFinance.loans.candidates.liabilityPending'));
    return facts;
}

async function loadInstallmentCandidates(): Promise<void> {
    loadingInstallmentCandidates.value = true;
    try {
        const result: InstallmentCandidate[] = [];
        let cursor: Awaited<ReturnType<typeof installmentApi.listCandidates>>['nextCursor'];
        do {
            const page = await installmentApi.listCandidates('needs_details', cursor, 100);
            result.push(...page.items);
            cursor = page.nextCursor;
        } while (cursor);
        installmentCandidates.value = result;
    } finally {
        loadingInstallmentCandidates.value = false;
    }
}

async function openRequestedInstallmentCandidate(): Promise<void> {
    const candidateId = typeof route.query['installmentCandidate'] === 'string'
        ? route.query['installmentCandidate']
        : '';
    if (!candidateId) return;

    const candidate = installmentCandidates.value.find(item => item.id === candidateId);
    if (candidate) {
        workspaceView.value = 'incomplete';
        completeInstallmentCandidate(candidate);
    }

    const query = { ...route.query };
    delete query['installmentCandidate'];
    await router.replace({ query });
}

function completeInstallmentCandidate(candidate: InstallmentCandidate): void {
    const liability = liabilityAccountOptions.value.find(account => account.id === candidate.liabilityAccountId);
    composerCandidate.value = candidate;
    composerMode.value = 'create';
    identity.value = {
        name: candidateName(candidate),
        lenderName: liability?.name ?? tt('personalFinance.loans.candidates.unknownLender'),
        contractType: 'credit_card_installment',
        liabilityAccountId: liability?.id ?? '',
        currency: liability?.currency ?? userStore.currentUserDefaultCurrency ?? 'CNY',
        note: tt('personalFinance.loans.candidates.note')
    };
    resetCalculation();
    calculationInput.value = {
        ...calculationInput.value,
        fundingType: 'purchase_installment',
        termCount: candidate.termCount ?? calculationInput.value.termCount
    };
    showComposer.value = true;
}

async function runCalculation(): Promise<void> {
    await safely(async () => { await controller.calculate(); });
}

async function submitComposer(): Promise<void> {
    await safely(async () => {
        if (composerMode.value === 'create' && composerCandidate.value) {
            submittingInstallmentCandidate.value = true;
            try {
                await installmentApi.confirmCandidate({
                    candidateId: composerCandidate.value.id,
                    expectedVersion: composerCandidate.value.version,
                    treatAsInstallment: true,
                    liabilityAccountId: identity.value.liabilityAccountId,
                    termCount: calculationInput.value.termCount,
                    contract: identity.value,
                    calculation: calculationInput.value
                });
                await Promise.all([controller.reload(true), loadInstallmentCandidates()]);
                workspaceView.value = 'active';
                showComposer.value = false;
                composerCandidate.value = undefined;
                snackbar.value?.showMessage('personalFinance.loans.candidates.created');
            } finally {
                submittingInstallmentCandidate.value = false;
            }
            return;
        }
        const result = composerMode.value === 'create'
            ? await controller.createContract(identity.value)
            : await controller.reviseContract();
        if (showActionResult(result, composerMode.value === 'create' ? 'personalFinance.loans.message.created' : 'personalFinance.loans.message.revised')) {
            if (composerMode.value === 'create') workspaceView.value = 'active';
            showComposer.value = false;
        }
    });
}

function changeWorkspace(value: WorkspaceView | null): void {
    if (value) workspaceView.value = value;
}

async function refresh(): Promise<void> {
    await safely(() => Promise.all([controller.reload(!selectedDetail.value), loadInstallmentCandidates()]));
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
    await safely(async () => {
        await Promise.all([controller.reload(false), loadInstallmentCandidates()]);
        await openRequestedInstallmentCandidate();
    });
});

onBeforeUnmount(() => controller.dispose());
</script>

<style scoped>
.loan-workbench { min-height: calc(100vh - 118px); }
.loan-hero { display: flex; align-items: center; justify-content: space-between; gap: 24px; background: linear-gradient(90deg, rgba(var(--v-theme-primary), .055), transparent 55%); }
.loan-hero-copy { min-width: 0; }
.loan-title-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 18px; }
.loan-hero-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.workspace-nav { display: flex; align-items: center; min-height: 54px; background: rgb(var(--v-theme-surface)); }
.workspace-count { margin-inline-start: 7px; color: rgb(var(--v-theme-primary)); font-weight: 700; }
.installment-inbox { background: rgba(var(--v-theme-primary), .025); }
.installment-inbox-heading, .installment-candidate-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.installment-candidate-list { overflow: hidden; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 10px; background: rgb(var(--v-theme-surface)); }
.installment-candidate-row { min-height: 52px; padding: 7px 12px; }
.installment-candidate-row + .installment-candidate-row { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.installment-candidate-copy { display: grid; min-width: 0; gap: 2px; }
.installment-empty { color: rgba(var(--v-theme-on-surface), .68); }
.detail-header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.workbench-grid { display: block; }
.contract-column { min-height: 560px; background: rgba(var(--v-theme-on-surface), .012); }
.detail-column { min-width: 0; overflow: hidden; }
.portfolio-overview { background: linear-gradient(135deg, rgba(var(--v-theme-primary), .075), rgba(var(--v-theme-primary), .018) 55%, transparent); }
.portfolio-heading,
.record-list-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.portfolio-record-count { flex: none; padding: 5px 10px; border-radius: 999px; background: rgba(var(--v-theme-primary), .095); color: rgb(var(--v-theme-primary)); font-size: .75rem; font-weight: 700; }
.portfolio-currency-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(560px, 1fr)); gap: 12px; }
.portfolio-currency-card { display: grid; grid-template-columns: minmax(205px, .72fr) minmax(0, 1.8fr); overflow: hidden; border: 1px solid rgba(var(--v-theme-primary), .18); border-radius: 12px; background: rgba(var(--v-theme-surface), .96); box-shadow: 0 7px 22px rgba(var(--v-theme-on-surface), .035); }
.portfolio-primary { display: grid; align-content: center; gap: 7px; padding: 18px 20px; border-inline-end: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.portfolio-card-label { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: rgba(var(--v-theme-on-surface), .62); font-size: .76rem; }
.portfolio-primary > strong { font-size: 1.55rem; line-height: 1.1; letter-spacing: -.02em; }
.portfolio-primary > span { color: rgba(var(--v-theme-on-surface), .58); font-size: .72rem; }
.portfolio-metrics { display: grid; grid-template-columns: repeat(5, minmax(100px, 1fr)); align-items: stretch; }
.portfolio-metrics > div { display: grid; min-width: 0; align-content: center; gap: 4px; padding: 14px 12px; }
.portfolio-metrics > div + div { border-inline-start: 1px solid rgba(var(--v-border-color), calc(var(--v-border-opacity) * .7)); }
.portfolio-metrics span,
.portfolio-metrics small { overflow: hidden; color: rgba(var(--v-theme-on-surface), .56); font-size: .68rem; text-overflow: ellipsis; white-space: nowrap; }
.portfolio-metrics strong { overflow: hidden; font-size: .82rem; text-overflow: ellipsis; white-space: nowrap; }
.record-list-heading { background: rgb(var(--v-theme-surface)); }
.edit-installment-note { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 11px 14px; border-inline-start: 3px solid rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .045); }
.edit-installment-note > div { display: grid; min-width: 0; gap: 2px; }
.edit-installment-note strong,
.edit-installment-note span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.edit-installment-note span,
.edit-installment-note p { color: rgba(var(--v-theme-on-surface), .6); font-size: .75rem; }
.edit-installment-note p { max-width: 520px; margin: 0; text-align: end; }
.calculation-summary { background: rgba(var(--v-theme-on-surface), .008); }
.settlement-wrap { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.candidate-rail { display: flex; flex-wrap: wrap; gap: 8px; }
.funding-component { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 0; }
.funding-component + .funding-component { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.disbursement-callout { border-inline-start: 4px solid rgb(var(--v-theme-primary)); }
@media (max-width: 959px) {
    .loan-hero { align-items: flex-start; flex-direction: column; }
    .loan-hero-actions { width: 100%; justify-content: space-between; }
    .contract-column { min-height: auto; }
    .portfolio-currency-grid { grid-template-columns: 1fr; }
    .portfolio-currency-card { grid-template-columns: minmax(180px, .65fr) minmax(0, 1.75fr); }
    .portfolio-metrics { grid-template-columns: repeat(3, minmax(100px, 1fr)); }
    .portfolio-metrics > div:nth-child(4) { border-inline-start: 0; }
    .installment-candidate-row { align-items: flex-start; flex-direction: column; }
}
@media (max-width: 599px) {
    .loan-hero-actions :deep(.v-btn) { padding-inline: 9px; }
    .workspace-nav { padding-inline: 12px !important; }
    .portfolio-heading,
    .record-list-heading,
    .edit-installment-note { align-items: flex-start; flex-direction: column; }
    .portfolio-currency-card { grid-template-columns: 1fr; }
    .portfolio-primary { border-inline-end: 0; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
    .portfolio-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .portfolio-metrics > div:nth-child(odd) { border-inline-start: 0; }
    .edit-installment-note p { text-align: start; }
}
</style>
