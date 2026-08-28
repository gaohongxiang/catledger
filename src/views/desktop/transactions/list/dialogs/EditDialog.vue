<template>
    <v-dialog width="1000" :persistent="isTransactionModified || recognizing" v-model="showState">
        <two-column-dialog-layout :disabled="loading || submitting || recognizing" :loading="loading"
                                  :title="tt(title)" :cancel-button-title="tt(cancelButtonTitle)"
                                  @cancel="cancel">
            <template #after-title>
                <v-btn density="compact" color="default" variant="text" class="ms-2" :icon="true"
                       :disabled="loading || submitting || recognizing"
                       v-if="mode === TransactionEditPageMode.View && originalTransactionEditable"
                       @click="edit">
                    <v-icon :icon="mdiPencilOutline" size="22"/>
                    <v-tooltip activator="parent">{{ tt('Edit') }}</v-tooltip>
                </v-btn>
                <v-btn density="compact" color="default" variant="text" class="ms-2" :icon="true"
                       :disabled="loading || submitting || recognizing"
                       v-if="mode === TransactionEditPageMode.View && !!transaction.id"
                       @click="transactionEvidenceDialog?.open(transaction.id)">
                    <v-icon :icon="mdiFileDocumentCheckOutline" size="22"/>
                    <v-tooltip activator="parent">{{ tt('personalFinance.evidence.title') }}</v-tooltip>
                </v-btn>
                <v-btn density="compact" color="default" variant="text" class="ms-2" :icon="true"
                       :disabled="loading || submitting || recognizing"
                       v-if="mode !== TransactionEditPageMode.View && activeTab === 'basicInfo' && isTransactionFromAITextRecognitionEnabled()"
                       @click="recognizeFromClipboard">
                    <v-icon :icon="mdiMagicStaff" size="22" v-if="!recognizing"/>
                    <v-tooltip activator="parent">{{ tt('AI Clipboard Text Recognition') }}</v-tooltip>
                    <v-progress-circular indeterminate size="22" v-if="recognizing"></v-progress-circular>
                </v-btn>
                <small class="ms-2 text-truncate" v-if="recognizing">{{ tt('AI can make mistakes. Check important info.') }}</small>
            </template>

            <template #toolbar>
                <v-btn density="compact" color="default" variant="text" class="ms-2" :icon="true"
                       :disabled="loading || submitting || recognizing" v-if="mode !== TransactionEditPageMode.View && activeTab === 'basicInfo'">
                    <v-icon :icon="mdiDotsVertical" size="22" />
                    <v-menu activator="parent">
                        <v-list v-if="activeTab === 'basicInfo'">
                            <v-list-item :prepend-icon="mdiSwapHorizontal"
                                         :title="tt('Swap Account')"
                                         v-if="transaction.type === TransactionType.Transfer"
                                         @click="swapTransactionData(true, false)"></v-list-item>
                            <v-list-item :prepend-icon="mdiSwapHorizontal"
                                         :title="tt('Swap Amount')"
                                         v-if="transaction.type === TransactionType.Transfer"
                                         @click="swapTransactionData(false, true)"></v-list-item>
                            <v-list-item :prepend-icon="mdiSwapHorizontal"
                                         :title="tt('Swap Account and Amount')"
                                         v-if="transaction.type === TransactionType.Transfer"
                                         @click="swapTransactionData(true, true)"></v-list-item>
                            <v-divider v-if="transaction.type === TransactionType.Transfer" />
                            <v-list-item :prepend-icon="mdiEyeOutline"
                                         :title="tt('Show Amount')"
                                         v-if="transaction.hideAmount" @click="transaction.hideAmount = false"></v-list-item>
                            <v-list-item :prepend-icon="mdiEyeOffOutline"
                                         :title="tt('Hide Amount')"
                                         v-if="!transaction.hideAmount" @click="transaction.hideAmount = true"></v-list-item>
                        </v-list>
                    </v-menu>
                </v-btn>
            </template>

            <template #content-left-column>
                <div class="px-4">
                    <v-tabs class="v-tabs-pill" direction="vertical" :class="{ 'readonly': mode !== TransactionEditPageMode.Add && mode !== TransactionEditPageMode.Edit }"
                            :disabled="loading || submitting || recognizing" v-model="transaction.type">
                        <v-tab :value="TransactionType.Expense" :disabled="mode !== TransactionEditPageMode.Add && mode !== TransactionEditPageMode.Edit && transaction.type !== TransactionType.Expense" v-if="transaction.type !== TransactionType.ModifyBalance">
                            <span>{{ tt('Expense') }}</span>
                        </v-tab>
                        <v-tab :value="TransactionType.Income" :disabled="mode !== TransactionEditPageMode.Add && mode !== TransactionEditPageMode.Edit && transaction.type !== TransactionType.Income" v-if="transaction.type !== TransactionType.ModifyBalance">
                            <span>{{ tt('Income') }}</span>
                        </v-tab>
                        <v-tab :value="TransactionType.Transfer" :disabled="mode !== TransactionEditPageMode.Add && mode !== TransactionEditPageMode.Edit && transaction.type !== TransactionType.Transfer" v-if="transaction.type !== TransactionType.ModifyBalance">
                            <span>{{ tt('Transfer') }}</span>
                        </v-tab>
                        <v-tab :value="TransactionType.ModifyBalance" v-if="transaction.type === TransactionType.ModifyBalance">
                            <span>{{ tt('Modify Balance') }}</span>
                        </v-tab>
                    </v-tabs>
                </div>
                <v-divider class="my-2"/>
                <div class="px-4">
                    <v-tabs direction="vertical" :disabled="loading || submitting || recognizing" v-model="activeTab">
                        <v-tab value="basicInfo">
                            <span>{{ tt('Basic Information') }}</span>
                        </v-tab>
                        <v-tab value="pictures" :disabled="mode !== TransactionEditPageMode.Add && mode !== TransactionEditPageMode.Edit && (!transaction.pictures || !transaction.pictures.length)" v-if="isTransactionPicturesEnabled()">
                            <span>{{ tt('Pictures') }}</span>
                        </v-tab>
                    </v-tabs>
                </div>
            </template>

            <template #content-right-column>
                <v-window class="d-flex flex-grow-1 disable-tab-transition w-100-window-container"
                          v-model="activeTab">
                    <v-window-item value="basicInfo">
                        <v-form class="my-4">
                            <v-row>
                                <v-col cols="12" :md="transaction.type === TransactionType.Transfer ? 6 : 12">
                                    <amount-input class="transaction-edit-amount font-weight-bold"
                                                  :color="sourceAmountColor"
                                                  :currency="sourceAccountCurrency"
                                                  :show-currency="true"
                                                  :readonly="mode === TransactionEditPageMode.View"
                                                  :disabled="loading || submitting || recognizing"
                                                  :persistent-placeholder="true"
                                                  :hide="transaction.hideAmount"
                                                  :label="sourceAmountTitle"
                                                  :placeholder="tt(sourceAmountName)"
                                                  :enable-formula="mode !== TransactionEditPageMode.View"
                                                  v-model="transaction.sourceAmount"/>
                                </v-col>
                                <v-col cols="12" :md="6" v-if="transaction.type === TransactionType.Transfer">
                                    <amount-input class="transaction-edit-amount font-weight-bold" color="primary"
                                                  :currency="destinationAccountCurrency"
                                                  :show-currency="true"
                                                  :readonly="mode === TransactionEditPageMode.View"
                                                  :disabled="loading || submitting || recognizing"
                                                  :persistent-placeholder="true"
                                                  :hide="transaction.hideAmount"
                                                  :label="transferInAmountTitle"
                                                  :placeholder="tt('Transfer In Amount')"
                                                  :enable-formula="mode !== TransactionEditPageMode.View"
                                                  v-model="transaction.destinationAmount"/>
                                </v-col>
                                <v-col cols="12" md="12" v-if="transaction.type === TransactionType.Expense">
                                    <v-tooltip :disabled="hasVisibleExpenseCategories" :text="hasVisibleExpenseCategories ? '' : tt('No secondary expense categories are available')">
                                        <template v-slot:activator="{ props }">
                                            <div v-bind="props" class="d-block">
                                                <two-column-select primary-key-field="id" primary-value-field="id" primary-title-field="name"
                                                                   primary-icon-field="icon" primary-icon-type="category" primary-color-field="color"
                                                                   primary-hidden-field="hidden" primary-sub-items-field="subCategories"
                                                                   secondary-key-field="id" secondary-value-field="id" secondary-title-field="name"
                                                                   secondary-icon-field="icon" secondary-icon-type="category" secondary-color-field="color"
                                                                   secondary-hidden-field="hidden"
                                                                   :readonly="mode === TransactionEditPageMode.View"
                                                                   :disabled="loading || submitting || recognizing || !hasVisibleExpenseCategories"
                                                                   :enable-filter="true" :filter-placeholder="tt('Find category')" :filter-no-items-text="tt('No available category')"
                                                                   :show-selection-primary-text="true"
                                                                   :custom-selection-primary-text="getTransactionPrimaryCategoryName(transaction.expenseCategoryId, allCategories[CategoryType.Expense])"
                                                                   :custom-selection-secondary-text="getTransactionSecondaryCategoryName(transaction.expenseCategoryId, allCategories[CategoryType.Expense])"
                                                                   :label="tt('Category')" :placeholder="tt('Category')"
                                                                   :items="allCategories[CategoryType.Expense] || []"
                                                                   v-model="transaction.expenseCategoryId">
                                                </two-column-select>
                                            </div>
                                        </template>
                                    </v-tooltip>
                                </v-col>
                                <v-col cols="12" md="12" v-if="transaction.type === TransactionType.Income">
                                    <v-tooltip :disabled="hasVisibleIncomeCategories" :text="hasVisibleIncomeCategories ? '' : tt('No secondary income categories are available')">
                                        <template v-slot:activator="{ props }">
                                            <div v-bind="props" class="d-block">
                                                <two-column-select primary-key-field="id" primary-value-field="id" primary-title-field="name"
                                                                   primary-icon-field="icon" primary-icon-type="category" primary-color-field="color"
                                                                   primary-hidden-field="hidden" primary-sub-items-field="subCategories"
                                                                   secondary-key-field="id" secondary-value-field="id" secondary-title-field="name"
                                                                   secondary-icon-field="icon" secondary-icon-type="category" secondary-color-field="color"
                                                                   secondary-hidden-field="hidden"
                                                                   :readonly="mode === TransactionEditPageMode.View"
                                                                   :disabled="loading || submitting || recognizing || !hasVisibleIncomeCategories"
                                                                   :enable-filter="true" :filter-placeholder="tt('Find category')" :filter-no-items-text="tt('No available category')"
                                                                   :show-selection-primary-text="true"
                                                                   :custom-selection-primary-text="getTransactionPrimaryCategoryName(transaction.incomeCategoryId, allCategories[CategoryType.Income])"
                                                                   :custom-selection-secondary-text="getTransactionSecondaryCategoryName(transaction.incomeCategoryId, allCategories[CategoryType.Income])"
                                                                   :label="tt('Category')" :placeholder="tt('Category')"
                                                                   :items="allCategories[CategoryType.Income] || []"
                                                                   v-model="transaction.incomeCategoryId">
                                                </two-column-select>
                                            </div>
                                        </template>
                                    </v-tooltip>
                                </v-col>
                                <v-col cols="12" md="12" v-if="transaction.type === TransactionType.Transfer">
                                    <v-tooltip :disabled="hasVisibleTransferCategories" :text="hasVisibleTransferCategories ? '' : tt('No secondary transfer categories are available')">
                                        <template v-slot:activator="{ props }">
                                            <div v-bind="props" class="d-block">
                                                <two-column-select primary-key-field="id" primary-value-field="id" primary-title-field="name"
                                                                   primary-icon-field="icon" primary-icon-type="category" primary-color-field="color"
                                                                   primary-hidden-field="hidden" primary-sub-items-field="subCategories"
                                                                   secondary-key-field="id" secondary-value-field="id" secondary-title-field="name"
                                                                   secondary-icon-field="icon" secondary-icon-type="category" secondary-color-field="color"
                                                                   secondary-hidden-field="hidden"
                                                                   :readonly="mode === TransactionEditPageMode.View"
                                                                   :disabled="loading || submitting || recognizing || !hasVisibleTransferCategories"
                                                                   :enable-filter="true" :filter-placeholder="tt('Find category')" :filter-no-items-text="tt('No available category')"
                                                                   :show-selection-primary-text="true"
                                                                   :custom-selection-primary-text="getTransactionPrimaryCategoryName(transaction.transferCategoryId, allCategories[CategoryType.Transfer])"
                                                                   :custom-selection-secondary-text="getTransactionSecondaryCategoryName(transaction.transferCategoryId, allCategories[CategoryType.Transfer])"
                                                                   :label="tt('Category')" :placeholder="tt('Category')"
                                                                   :items="allCategories[CategoryType.Transfer] || []"
                                                                   v-model="transaction.transferCategoryId">
                                                </two-column-select>
                                            </div>
                                        </template>
                                    </v-tooltip>
                                </v-col>
                                <v-col cols="12" :md="transaction.type === TransactionType.Transfer ? 6 : 12">
                                    <v-tooltip :disabled="!!allVisibleAccounts.length" :text="allVisibleAccounts.length ? '' : tt('No available account')">
                                        <template v-slot:activator="{ props }">
                                            <div v-bind="props" class="d-block">
                                                <two-column-select primary-key-field="id" primary-value-field="category"
                                                                   primary-title-field="name" primary-footer-field="displayBalance"
                                                                   primary-icon-field="icon" primary-icon-type="account"
                                                                   primary-sub-items-field="accounts"
                                                                   :primary-title-i18n="true"
                                                                   secondary-key-field="id" secondary-value-field="id"
                                                                   secondary-title-field="name" secondary-footer-field="displayBalance"
                                                                   secondary-icon-field="icon" secondary-icon-type="account" secondary-color-field="color"
                                                                   :readonly="mode === TransactionEditPageMode.View"
                                                                   :disabled="loading || submitting || recognizing || !allVisibleAccounts.length || (mode === TransactionEditPageMode.Edit && transaction.type === TransactionType.ModifyBalance)"
                                                                   :enable-filter="true" :filter-placeholder="tt('Find account')" :filter-no-items-text="tt('No available account')"
                                                                   :custom-selection-primary-text="sourceAccountName"
                                                                   :label="tt(sourceAccountTitle)"
                                                                   :placeholder="tt(sourceAccountTitle)"
                                                                   :items="allVisibleCategorizedAccounts"
                                                                   v-model="transaction.sourceAccountId">
                                                </two-column-select>
                                            </div>
                                        </template>
                                    </v-tooltip>
                                </v-col>
                                <v-col cols="12" md="6" v-if="transaction.type === TransactionType.Transfer">
                                    <v-tooltip :disabled="!!allVisibleAccounts.length" :text="allVisibleAccounts.length ? '' : tt('No available account')">
                                        <template v-slot:activator="{ props }">
                                            <div v-bind="props" class="d-block">
                                                <two-column-select primary-key-field="id" primary-value-field="category"
                                                                   primary-title-field="name" primary-footer-field="displayBalance"
                                                                   primary-icon-field="icon" primary-icon-type="account"
                                                                   primary-sub-items-field="accounts"
                                                                   :primary-title-i18n="true"
                                                                   secondary-key-field="id" secondary-value-field="id"
                                                                   secondary-title-field="name" secondary-footer-field="displayBalance"
                                                                   secondary-icon-field="icon" secondary-icon-type="account" secondary-color-field="color"
                                                                   :readonly="mode === TransactionEditPageMode.View"
                                                                   :disabled="loading || submitting || recognizing || !allVisibleAccounts.length"
                                                                   :enable-filter="true" :filter-placeholder="tt('Find account')" :filter-no-items-text="tt('No available account')"
                                                                   :custom-selection-primary-text="destinationAccountName"
                                                                   :label="tt('Destination Account')"
                                                                   :placeholder="tt('Destination Account')"
                                                                   :items="allVisibleCategorizedAccounts"
                                                                   v-model="transaction.destinationAccountId">
                                                </two-column-select>
                                            </div>
                                        </template>
                                    </v-tooltip>
                                </v-col>
                                <v-col cols="12" md="6">
                                    <date-time-select
                                        :readonly="mode === TransactionEditPageMode.View"
                                        :disabled="loading || submitting || recognizing || (mode === TransactionEditPageMode.Edit && transaction.type === TransactionType.ModifyBalance)"
                                        :label="tt('Transaction Time')"
                                        :timezone-utc-offset="transaction.utcOffset"
                                        :model-value="transaction.time"
                                        @update:model-value="updateTransactionTime"
                                        @error="onShowDateTimeError" />
                                </v-col>
                                <v-col cols="12" md="6">
                                    <v-autocomplete
                                        class="transaction-edit-timezone"
                                        item-title="displayNameWithUtcOffset"
                                        item-value="name"
                                        auto-select-first
                                        persistent-placeholder
                                        :readonly="mode === TransactionEditPageMode.View"
                                        :disabled="loading || submitting || recognizing || (mode === TransactionEditPageMode.Edit && transaction.type === TransactionType.ModifyBalance)"
                                        :label="tt('Transaction Timezone')"
                                        :placeholder="!transaction.timeZone && transaction.timeZone !== '' ? `(${transactionDisplayTimezone}) ${transactionTimezoneTimeDifference}` : tt('Timezone')"
                                        :items="allTimezones"
                                        :no-data-text="tt('No results')"
                                        :model-value="transaction.timeZone"
                                        @update:model-value="updateTransactionTimezone"
                                    >
                                        <template #selection="{ internalItem }">
                                                <span class="text-truncate" v-if="transaction.timeZone || transaction.timeZone === ''">
                                                    {{ internalItem.title }}
                                                </span>
                                        </template>
                                    </v-autocomplete>
                                </v-col>
                                <v-col cols="12" md="12">
                                    <v-textarea
                                        type="text"
                                        persistent-placeholder
                                        rows="3"
                                        :readonly="mode === TransactionEditPageMode.View"
                                        :disabled="loading || submitting || recognizing"
                                        :label="transactionDescriptionTitle"
                                        :placeholder="tt('Your transaction description (optional)')"
                                        v-model="transaction.comment"
                                    />
                                </v-col>
                            </v-row>
                        </v-form>
                    </v-window-item>
                    <v-window-item value="pictures">
                        <v-row class="transaction-pictures align-content-start ma-0 pt-3" :class="{ 'readonly': submitting || uploadingPicture || removingPictureId }">
                            <v-col :key="picIdx" cols="6" md="3" v-for="(pictureInfo, picIdx) in transaction.pictures">
                                <v-avatar rounded="lg" variant="tonal" size="160"
                                          class="cursor-pointer transaction-picture"
                                          color="rgba(0,0,0,0)" @click="viewOrRemovePicture(pictureInfo)">
                                    <v-img :src="getTransactionPictureUrl(pictureInfo)">
                                        <template #placeholder>
                                            <div class="d-flex align-center justify-center bg-light-primary">
                                                <v-progress-circular color="grey-500" indeterminate size="48"></v-progress-circular>
                                            </div>
                                        </template>
                                        <template #error>
                                            <div class="d-flex align-center justify-center bg-light-primary">
                                                <span class="text-body-large">{{ tt('Failed to load image, please check whether the config "domain" and "root_url" are set correctly.') }}</span>
                                            </div>
                                        </template>
                                    </v-img>
                                    <div class="picture-control-icon" :class="{ 'show-control-icon': pictureInfo.pictureId === removingPictureId }">
                                        <v-icon size="64" :icon="mdiTrashCanOutline" v-if="(mode === TransactionEditPageMode.Add || mode === TransactionEditPageMode.Edit) && pictureInfo.pictureId !== removingPictureId"/>
                                        <v-progress-circular color="grey-500" indeterminate size="48" v-if="(mode === TransactionEditPageMode.Add || mode === TransactionEditPageMode.Edit) && pictureInfo.pictureId === removingPictureId"></v-progress-circular>
                                        <v-icon size="64" :icon="mdiFullscreen" v-if="mode !== TransactionEditPageMode.Add && mode !== TransactionEditPageMode.Edit"/>
                                    </div>
                                </v-avatar>
                            </v-col>
                            <v-col cols="6" md="3" v-if="canAddTransactionPicture">
                                <v-avatar rounded="lg" variant="tonal" size="160"
                                          class="transaction-picture transaction-picture-add"
                                          :class="{ 'enabled': !submitting, 'cursor-pointer': !submitting }"
                                          color="rgba(0,0,0,0)" @click="showOpenPictureDialog">
                                    <v-tooltip activator="parent" v-if="!submitting">{{ tt('Add Picture') }}</v-tooltip>
                                    <v-icon class="transaction-picture-add-icon" size="56" :icon="mdiImagePlusOutline" v-if="!uploadingPicture"/>
                                    <v-progress-circular color="grey-500" indeterminate size="48" v-if="uploadingPicture"></v-progress-circular>
                                </v-avatar>
                            </v-col>
                        </v-row>
                    </v-window-item>
                </v-window>
            </template>

            <template #footer>
                <v-btn color="error" variant="tonal" :disabled="loading || submitting || recognizing"
                       v-if="mode === TransactionEditPageMode.View && originalTransactionEditable" @click="remove">
                    {{ tt('Delete') }}
                    <v-progress-circular indeterminate size="22" class="ms-2" v-if="submitting"></v-progress-circular>
                </v-btn>
                <v-spacer/>
                <v-tooltip :disabled="!inputIsEmpty" :text="inputEmptyProblemMessage ? tt(inputEmptyProblemMessage) : ''">
                    <template v-slot:activator="{ props }">
                        <div v-bind="props" class="d-inline-block">
                            <v-btn-group density="comfortable" v-if="mode === TransactionEditPageMode.Add || mode === TransactionEditPageMode.Edit">
                                <v-btn color="primary" :disabled="inputIsEmpty || loading || submitting || recognizing" @click="save(AfterSaveAction.GoBack)">
                                    {{ tt(saveButtonTitle) }}
                                    <v-progress-circular indeterminate size="22" class="ms-2" v-if="submitting"></v-progress-circular>
                                </v-btn>
                                <v-btn color="primary" density="compact"
                                       :disabled="inputIsEmpty || loading || submitting || recognizing" :icon="true"
                                       v-if="mode === TransactionEditPageMode.Add">
                                    <v-icon :icon="mdiMenuDown" size="24" />
                                    <v-menu activator="parent">
                                        <v-list>
                                            <v-list-item :title="tt(TransactionQuickAddButtonActionType.SaveAndAddNewTransaction.name)"
                                                         @click="save(AfterSaveAction.StayWithNewTransaction)"></v-list-item>
                                            <v-list-item :title="tt(TransactionQuickAddButtonActionType.SaveAndKeepCurrentData.name)"
                                                         @click="save(AfterSaveAction.StayWithCurrentTransaction)"></v-list-item>
                                        </v-list>
                                    </v-menu>
                                </v-btn>
                            </v-btn-group>
                        </div>
                    </template>
                </v-tooltip>
                <v-btn-group variant="tonal" density="comfortable"
                             v-if="mode === TransactionEditPageMode.View && transaction.type !== TransactionType.ModifyBalance">
                    <v-btn :disabled="loading || submitting || recognizing"
                           @click="duplicate(false)">{{ tt('Duplicate') }}</v-btn>
                    <v-btn density="compact" :disabled="loading || submitting || recognizing" :icon="true">
                        <v-icon :icon="mdiMenuDown" size="24" />
                        <v-menu activator="parent">
                            <v-list>
                                <v-list-item :title="tt('Duplicate (With Time)')"
                                             @click="duplicate(true)"></v-list-item>
                            </v-list>
                        </v-menu>
                    </v-btn>
                </v-btn-group>
            </template>
        </two-column-dialog-layout>
    </v-dialog>

    <v-dialog width="600" v-model="showPasteTextDialog">
        <one-column-dialog-layout content-class="pa-0" :disabled="recognizing"
                                  :title="tt('AI Clipboard Text Recognition')" :cancel-button-title="tt('Cancel')"
                                  @cancel="showPasteTextDialog = false; pastedText = '';">
            <template #toolbar>
                <v-btn class="me-2" density="comfortable" variant="outlined"
                       :disabled="!pastedText || !pastedText.trim() || recognizing"
                       @click="showPasteTextDialog = false; recognizeText(pastedText);">{{ tt('Recognize') }}</v-btn>
            </template>

            <template #content>
                <v-textarea no-resize persistent-placeholder
                            class="w-100 h-100 ps-4 always-cursor-text"
                            rows="10" density="compact" variant="plain" :rounded="false"
                            :disabled="recognizing"
                            :placeholder="tt('Click here to paste a transaction description')"
                            v-model="pastedText"></v-textarea>
            </template>
        </one-column-dialog-layout>
    </v-dialog>

    <confirm-dialog ref="confirmDialog"/>
    <transaction-evidence-dialog ref="transactionEvidenceDialog" />
    <snack-bar ref="snackbar" />
    <input ref="pictureInput" type="file" style="display: none" :accept="SUPPORTED_IMAGE_EXTENSIONS" @change="onUploadPicture($event)" />
</template>

<script setup lang="ts">
import ConfirmDialog from '@/components/desktop/ConfirmDialog.vue';
import SnackBar from '@/components/desktop/SnackBar.vue';
import TransactionEvidenceDialog from '@/features/personal-finance/components/TransactionEvidenceDialog.vue';

import { ref, computed, useTemplateRef } from 'vue';

import { useI18n } from '@/locales/helpers.ts';
import {
    TransactionEditPageMode,
    TransactionEditPageType,
    AfterSaveAction,
    useTransactionEditPageBase
} from '@/views/base/transactions/TransactionEditPageBase.ts';

import { useSettingsStore } from '@/stores/setting.ts';
import { useUserStore } from '@/stores/user.ts';
import { useAccountsStore } from '@/stores/account.ts';
import { useTransactionCategoriesStore } from '@/stores/transactionCategory.ts';
import { useTransactionsStore } from '@/stores/transaction.ts';

import { CategoryType } from '@/core/category.ts';
import { TransactionType, TransactionEditScopeType, TransactionQuickAddButtonActionType } from '@/core/transaction.ts';
import { KnownFileType } from '@/core/file.ts';

import { KnownErrorCode } from '@/consts/api.ts';
import { SUPPORTED_IMAGE_EXTENSIONS } from '@/consts/file.ts';

import type { TransactionPictureInfoBasicResponse } from '@/models/transaction_picture_info.ts';
import { Transaction } from '@/models/transaction.ts';

import { isDefined, isEquals } from '@/lib/common.ts';
import {
    getTimezoneOffsetMinutes,
    getCurrentUnixTime
} from '@/lib/datetime.ts';
import { generateRandomUUID } from '@/lib/misc.ts';
import {
    getTransactionPrimaryCategoryName,
    getTransactionSecondaryCategoryName
} from '@/lib/category.ts';
import { type SetTransactionOptions } from '@/lib/transaction.ts';
import {
    isTransactionFromAITextRecognitionEnabled,
    isTransactionPicturesEnabled
} from '@/lib/server_settings.ts';
import { compressJpgImageByQuality } from '@/lib/ui/common.ts';
import logger from '@/lib/logger.ts';

import {
    mdiMagicStaff,
    mdiDotsVertical,
    mdiPencilOutline,
    mdiEyeOffOutline,
    mdiEyeOutline,
    mdiSwapHorizontal,
    mdiMenuDown,
    mdiImagePlusOutline,
    mdiTrashCanOutline,
    mdiFullscreen,
    mdiFileDocumentCheckOutline
} from '@mdi/js';

export interface TransactionEditOptions extends SetTransactionOptions {
    id?: string;
    currentTransaction?: Transaction;
    autoUploadPicture?: File;
    autoRecognizeClipboardText?: string;
    noTransactionDraft?: boolean;
}

interface TransactionEditResponse {
    message: string;
}

type ConfirmDialogType = InstanceType<typeof ConfirmDialog>;
type SnackBarType = InstanceType<typeof SnackBar>;
type TransactionEvidenceDialogType = InstanceType<typeof TransactionEvidenceDialog>;

defineProps<{
    type: TransactionEditPageType;
    persistent?: boolean;
    show?: boolean;
}>();

const { tt } = useI18n();

const {
    mode,
    editId,
    addByTemplateId,
    duplicateFromId,
    clientSessionId,
    loading,
    recognizing,
    submitting,
    submitted,
    uploadingPicture,
    transaction,
    defaultCurrency,
    imageUploadQualityType,
    allTimezones,
    allVisibleAccounts,
    allVisibleCategorizedAccounts,
    allCategories,
    firstVisibleAccountId,
    hasVisibleExpenseCategories,
    hasVisibleIncomeCategories,
    hasVisibleTransferCategories,
    canAddTransactionPicture,
    title,
    saveButtonTitle,
    cancelButtonTitle,
    sourceAmountName,
    sourceAmountTitle,
    sourceAccountTitle,
    transferInAmountTitle,
    sourceAccountName,
    destinationAccountName,
    sourceAccountCurrency,
    destinationAccountCurrency,
    transactionDisplayTimezone,
    transactionTimezoneTimeDifference,
    transactionDescriptionTitle,
    inputEmptyProblemMessage,
    inputIsEmpty,
    createNewTransactionModel,
    setTransactionModel,
    updateTransactionModelFromRecognizedResponse,
    updateTransactionModelByAfterSaveAction,
    updateTransactionTime,
    updateTransactionTimezone,
    swapTransactionData,
    getTransactionPictureUrl
} = useTransactionEditPageBase();

const settingsStore = useSettingsStore();
const userStore = useUserStore();
const accountsStore = useAccountsStore();
const transactionCategoriesStore = useTransactionCategoriesStore();
const transactionsStore = useTransactionsStore();

const confirmDialog = useTemplateRef<ConfirmDialogType>('confirmDialog');
const snackbar = useTemplateRef<SnackBarType>('snackbar');
const transactionEvidenceDialog = useTemplateRef<TransactionEvidenceDialogType>('transactionEvidenceDialog');
const pictureInput = useTemplateRef<HTMLInputElement>('pictureInput');

let resolveFunc: ((response?: TransactionEditResponse) => void) | null = null;
let rejectFunc: ((reason?: unknown) => void) | null = null;

const showState = ref<boolean>(false);
const showPasteTextDialog = ref<boolean>(false);
const activeTab = ref<string>('basicInfo');
const initTransaction = ref<Transaction | null>(null);
const originalTransactionEditable = ref<boolean>(false);
const noTransactionDraft = ref<boolean>(false);
const removingPictureId = ref<string>('');
const pastedText = ref<string>('');

const initOptions = ref<TransactionEditOptions | undefined>(undefined);

const sourceAmountColor = computed<string | undefined>(() => {
    if (transaction.value.type === TransactionType.Expense) {
        return 'expense';
    } else if (transaction.value.type === TransactionType.Income) {
        return 'income';
    } else if (transaction.value.type === TransactionType.Transfer) {
        return 'primary';
    }

    return undefined;
});

const isTransactionModified = computed<boolean>(() => {
    if (mode.value === TransactionEditPageMode.Add) {
        return transactionsStore.isTransactionDraftModified(transaction.value, initOptions.value?.amount, initOptions.value?.categoryId, initOptions.value?.accountId, initOptions.value?.tagIds, firstVisibleAccountId.value);
    } else if (mode.value === TransactionEditPageMode.Edit) {
        return !!initTransaction.value && !isEquals(transaction.value.toModifyRequest(), initTransaction.value.toModifyRequest());
    } else {
        return false;
    }
});

function open(options: TransactionEditOptions): Promise<TransactionEditResponse | undefined> {
    addByTemplateId.value = null;
    duplicateFromId.value = null;
    showState.value = true;
    activeTab.value = 'basicInfo';
    loading.value = true;
    submitting.value = false;
    submitted.value = false;
    originalTransactionEditable.value = false;
    noTransactionDraft.value = options.noTransactionDraft || false;

    initOptions.value = options;

    const newTransaction = createNewTransactionModel(options.type);
    setTransactionModel(newTransaction, options, true);
    initTransaction.value = Transaction.of(transaction.value);

    const promises: Promise<unknown>[] = [
        accountsStore.loadAllAccounts({ force: false }),
        transactionCategoriesStore.loadAllCategories({ force: false })
    ];

    if (options.id) {
        if (options.currentTransaction) {
            setTransactionModel(options.currentTransaction, options, true);
        }

        mode.value = TransactionEditPageMode.View;
        editId.value = options.id;
        promises.push(transactionsStore.getTransaction({ transactionId: editId.value }));
    } else {
        mode.value = TransactionEditPageMode.Add;
        editId.value = null;

        if (!options.noTransactionDraft && (settingsStore.appSettings.autoSaveTransactionDraft === 'enabled' || settingsStore.appSettings.autoSaveTransactionDraft === 'confirmation') && transactionsStore.transactionDraft) {
            setTransactionModel(Transaction.ofDraft(transactionsStore.transactionDraft), options, false);
        }
    }

    if (options.type &&
        options.type >= TransactionType.Income &&
        options.type <= TransactionType.Transfer) {
        transaction.value.type = options.type;
    }

    if (mode.value === TransactionEditPageMode.Add) {
        clientSessionId.value = generateRandomUUID();
    }

    Promise.all(promises).then(function (responses) {
        if (editId.value && !responses[2]) {
            if (rejectFunc) {
                rejectFunc('Unable to retrieve transaction');
            }

            return;
        }

        if (options.id && responses[2] && responses[2] instanceof Transaction) {
            const transaction: Transaction = responses[2];
            setTransactionModel(transaction, options, true);
            initTransaction.value = Transaction.of(transaction);
            originalTransactionEditable.value = transaction.editable;
        } else {
            setTransactionModel(null, options, true);
            initTransaction.value = Transaction.of(transaction.value);
        }

        if (options.autoUploadPicture) {
            uploadPicture(options.autoUploadPicture);
        }

        loading.value = false;

        if (isDefined(options.autoRecognizeClipboardText)) {
            pastedText.value = options.autoRecognizeClipboardText;

            if (pastedText.value && !settingsStore.appSettings.alwaysRequireConfirmationOfClipboardContentBeforeSubmission) {
                recognizeText(pastedText.value);
            } else {
                showPasteTextDialog.value = true;
            }
        }
    }).catch(error => {
        logger.error('failed to load essential data for editing transaction', error);

        loading.value = false;
        showState.value = false;

        if (!error.processed) {
            if (rejectFunc) {
                rejectFunc(error);
            }
        }
    });

    return new Promise((resolve, reject) => {
        resolveFunc = resolve;
        rejectFunc = reject;
    });
}

function save(afterAction: AfterSaveAction): void {
    const problemMessage = inputEmptyProblemMessage.value;

    if (problemMessage) {
        snackbar.value?.showMessage(problemMessage);
        return;
    }

    if (mode.value === TransactionEditPageMode.Add || mode.value === TransactionEditPageMode.Edit) {
        const doSubmit = function () {
            submitting.value = true;

            transactionsStore.saveTransaction({
                transaction: transaction.value as Transaction,
                defaultCurrency: defaultCurrency.value,
                isEdit: mode.value === TransactionEditPageMode.Edit,
                clientSessionId: clientSessionId.value
            }).then(() => {
                submitting.value = false;
                submitted.value = true;

                if (mode.value === TransactionEditPageMode.Add && !noTransactionDraft.value && !addByTemplateId.value && !duplicateFromId.value) {
                    transactionsStore.clearTransactionDraft();
                }

                if (mode.value === TransactionEditPageMode.Add && (afterAction === AfterSaveAction.StayWithNewTransaction || afterAction === AfterSaveAction.StayWithCurrentTransaction)) {
                    snackbar.value?.showMessage('You have added a new transaction');
                    updateTransactionModelByAfterSaveAction(afterAction, initOptions.value);
                    clientSessionId.value = generateRandomUUID();
                } else {
                    if (resolveFunc) {
                        if (mode.value === TransactionEditPageMode.Add) {
                            resolveFunc({
                                message: 'You have added a new transaction'
                            });
                        } else if (mode.value === TransactionEditPageMode.Edit) {
                            resolveFunc({
                                message: 'You have saved this transaction'
                            });
                        }
                    }

                    showState.value = false;
                }
            }).catch(error => {
                submitting.value = false;

                if (error.error && (error.error.errorCode === KnownErrorCode.TransactionCannotCreateInThisTime || error.error.errorCode === KnownErrorCode.TransactionCannotModifyInThisTime)) {
                    confirmDialog.value?.open('You have set this time range to prevent editing transactions. Would you like to change the editable transaction range to All?').then(() => {
                        submitting.value = true;

                        userStore.updateUserTransactionEditScope({
                            transactionEditScope: TransactionEditScopeType.All.type
                        }).then(() => {
                            submitting.value = false;

                            snackbar.value?.showMessage('Your editable transaction range has been set to All');
                        }).catch(error => {
                            submitting.value = false;

                            if (!error.processed) {
                                snackbar.value?.showError(error);
                            }
                        });
                    });
                } else if (!error.processed) {
                    snackbar.value?.showError(error);
                }
            });
        };

        if (transaction.value.sourceAmount === 0) {
            confirmDialog.value?.open('Are you sure you want to save this transaction with a zero amount?').then(() => {
                doSubmit();
            });
        } else {
            doSubmit();
        }
    }
}

function recognizeText(text: string): void {
    if (recognizing.value || loading.value || submitting.value) {
        return;
    }

    if (!text || !text.trim()) {
        return;
    }

    recognizing.value = true;

    transactionsStore.recognizeTransactionText({ text }).then(response => {
        updateTransactionModelFromRecognizedResponse(response);
        recognizing.value = false;
    }).catch(error => {
        recognizing.value = false;

        if (!error.processed) {
            snackbar.value?.showError(error);
        }
    });
}

function recognizeFromClipboard(): void {
    if (recognizing.value || loading.value || submitting.value) {
        return;
    }

    pastedText.value = '';

    navigator.clipboard.readText().then(text => {
        pastedText.value = text && text.trim() ? text.trim() : '';

        if (pastedText.value && !settingsStore.appSettings.alwaysRequireConfirmationOfClipboardContentBeforeSubmission) {
            recognizeText(pastedText.value);
        } else {
            showPasteTextDialog.value = true;
        }
    }).catch(error => {
        logger.error('failed to read clipboard', error);
        showPasteTextDialog.value = true;
    });
}

function duplicate(withTime?: boolean): void {
    if (mode.value !== TransactionEditPageMode.View) {
        return;
    }

    editId.value = null;
    duplicateFromId.value = transaction.value.id;
    clientSessionId.value = generateRandomUUID();
    submitted.value = false;
    activeTab.value = 'basicInfo';
    transaction.value.id = '';

    if (!withTime) {
        transaction.value.time = getCurrentUnixTime();
        transaction.value.timeZone = settingsStore.appSettings.timeZone;
        transaction.value.utcOffset = getTimezoneOffsetMinutes(transaction.value.time, transaction.value.timeZone);
    }

    transaction.value.removeGeoLocation();

    transaction.value.clearPictures();
    mode.value = TransactionEditPageMode.Add;
}

function edit(): void {
    if (mode.value !== TransactionEditPageMode.View) {
        return;
    }

    mode.value = TransactionEditPageMode.Edit;
}

function remove(): void {
    if (mode.value !== TransactionEditPageMode.View) {
        return;
    }

    confirmDialog.value?.open('Are you sure you want to delete this transaction?').then(() => {
        submitting.value = true;

        transactionsStore.deleteTransaction({
            transaction: transaction.value as Transaction,
            defaultCurrency: defaultCurrency.value
        }).then(() => {
            if (resolveFunc) {
                resolveFunc();
            }

            submitting.value = false;
            showState.value = false;
        }).catch(error => {
            submitting.value = false;

            if (!error.processed) {
                snackbar.value?.showError(error);
            }
        });
    });
}

function cancel(): void {
    const doClose = function () {
        if (mode.value === TransactionEditPageMode.Add && submitted.value && resolveFunc) {
            resolveFunc({
                message: 'You have added a new transaction'
            });
        } else if (rejectFunc) {
            rejectFunc();
        }

        showState.value = false;
    };

    if (mode.value !== TransactionEditPageMode.Add || noTransactionDraft.value || addByTemplateId.value || duplicateFromId.value) {
        doClose();
        return;
    }

    if (settingsStore.appSettings.autoSaveTransactionDraft === 'confirmation') {
        if (transactionsStore.isTransactionDraftModified(transaction.value, initOptions.value?.amount, initOptions.value?.categoryId, initOptions.value?.accountId, initOptions.value?.tagIds, firstVisibleAccountId.value)) {
            confirmDialog.value?.open('Do you want to save this transaction draft?').then(() => {
                transactionsStore.saveTransactionDraft(transaction.value, initOptions.value?.amount, initOptions.value?.categoryId, initOptions.value?.accountId, initOptions.value?.tagIds, firstVisibleAccountId.value);
                doClose();
            }).catch(() => {
                transactionsStore.clearTransactionDraft();
                doClose();
            });
        } else {
            transactionsStore.clearTransactionDraft();
            doClose();
        }
    } else if (settingsStore.appSettings.autoSaveTransactionDraft === 'enabled') {
        transactionsStore.saveTransactionDraft(transaction.value, initOptions.value?.amount, initOptions.value?.categoryId, initOptions.value?.accountId, initOptions.value?.tagIds, firstVisibleAccountId.value);
        doClose();
    } else {
        doClose();
    }
}

function showOpenPictureDialog(): void {
    if (!canAddTransactionPicture.value || submitting.value) {
        return;
    }

    pictureInput.value?.click();
}

function uploadPicture(file: File): void {
    if (!file) {
        return;
    }

    uploadingPicture.value = true;
    submitting.value = true;

    compressJpgImageByQuality(file, imageUploadQualityType.value).then(blob => {
        return transactionsStore.uploadTransactionPicture({
            pictureFile: KnownFileType.JPG.createFileFromBlob(blob, "image")
        });
    }).then(response => {
        transaction.value.addPicture(response);
        uploadingPicture.value = false;
        submitting.value = false;
    }).catch(error => {
        uploadingPicture.value = false;
        submitting.value = false;

        if (!error.processed) {
            snackbar.value?.showError(error);
        }
    });
}

function viewOrRemovePicture(pictureInfo: TransactionPictureInfoBasicResponse): void {
    if (mode.value !== TransactionEditPageMode.Add && mode.value !== TransactionEditPageMode.Edit) {
        window.open(getTransactionPictureUrl(pictureInfo), '_blank');
        return;
    }

    confirmDialog.value?.open('Are you sure you want to remove this transaction picture?').then(() => {
        removingPictureId.value = pictureInfo.pictureId;
        submitting.value = true;

        transactionsStore.removeUnusedTransactionPicture({ pictureInfo }).then(response => {
            if (response) {
                transaction.value.removePicture(pictureInfo);
            }

            removingPictureId.value = '';
            submitting.value = false;
        }).catch(error => {
            if (error.error && error.error.errorCode === KnownErrorCode.TransactionPictureNotFound) {
                transaction.value.removePicture(pictureInfo);
            } else if (!error.processed) {
                snackbar.value?.showError(error);
            }

            removingPictureId.value = '';
            submitting.value = false;
        });
    });
}

function onUploadPicture(event: Event): void {
    if (!event || !event.target) {
        return;
    }

    const el = event.target as HTMLInputElement;

    if (!el.files || !el.files.length || !el.files[0]) {
        return;
    }

    const pictureFile = el.files[0] as File;

    el.value = '';
    uploadPicture(pictureFile);
}

function onShowDateTimeError(error: string): void {
    snackbar.value?.showError(error);
}

defineExpose({
    open
});
</script>

<style>
.transaction-edit-amount .v-field__prepend-inner,
.transaction-edit-amount .v-field__append-inner,
.transaction-edit-amount .v-field__field > input {
    font-size: 1.25rem;
}

.transaction-edit-timezone.v-input input::placeholder {
    color: rgba(var(--v-theme-on-background), var(--v-high-emphasis-opacity)) !important;
    opacity: unset;
}

@media (min-height: 620px) {
    @media (min-width: 960px) {
        .transaction-pictures {
            min-height: 416px;
        }
    }
}

@media (min-height: 700px) {
    @media (min-width: 960px) {
        .transaction-pictures {
            min-height: 514px;
        }
    }
}

.transaction-picture .picture-control-icon {
    display: none;
    position: absolute;
    width: 100% !important;
    height: 100% !important;
    background-color: rgba(0, 0, 0, 0.4);
}

.transaction-picture .picture-control-icon > i.v-icon {
    background-color: transparent;
    color: rgba(255, 255, 255, 0.8);
}

.transaction-picture:hover .picture-control-icon,
.transaction-picture .picture-control-icon.show-control-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    vertical-align: middle;
}

.transaction-picture:hover .transaction-picture-placeholder {
    display: none;
}

.transaction-picture-add {
    border: 2px dashed rgba(var(--v-theme-grey-500));

    .transaction-picture-add-icon {
        color: rgba(var(--v-theme-grey-500));
    }
}

.transaction-picture-add.enabled:hover {
    border: 2px dashed rgba(var(--v-theme-grey-700));

    .transaction-picture-add-icon {
        color: rgba(var(--v-theme-grey-700));
    }
}
</style>
