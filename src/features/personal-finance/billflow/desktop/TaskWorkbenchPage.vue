<template>
    <v-card class="task-workbench overflow-hidden">
        <div class="task-toolbar">
            <div>
                <div class="task-kicker">{{ tt('personalFinance.billflow.title') }}</div>
                <div class="task-lead">{{ tt('personalFinance.billflow.subtitle') }}</div>
            </div>
            <v-spacer />
            <v-btn color="primary" variant="flat" :prepend-icon="mdiTrayArrowUp" :loading="busy" @click="fileInput?.click()">
                {{ tt('personalFinance.upload') }}
            </v-btn>
            <v-btn variant="text" :icon="mdiRefresh" :loading="loading" @click="reload" />
            <input
                ref="fileInput"
                type="file"
                class="d-none"
                multiple
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                @change="upload"
            />
        </div>

        <nav class="step-rail" :aria-label="tt('personalFinance.billflow.step.label')">
            <button
                type="button"
                :class="{
                    'is-current': currentStep === step,
                    'is-done': billflowWorkbenchStepIndex(step) < currentStepIndex,
                    'is-locked': !canOpenStep(step)
                }"
                :disabled="!canOpenStep(step)"
                :key="step"
                v-for="step in BILLFLOW_WORKBENCH_STEPS"
                @click="openStep(step)"
            >
                <span>{{ billflowWorkbenchStepIndex(step) + 1 }}</span>
                {{ tt(`personalFinance.billflow.step.${step}`) }}
            </button>
        </nav>

        <v-alert class="ma-4" type="error" variant="tonal" v-if="error">{{ tt('personalFinance.billflow.error') }}</v-alert>
        <v-alert class="mx-5 mt-4" type="warning" variant="tonal" v-if="task?.status === 'failed'">
            {{ tt('personalFinance.billflow.failed') }}
        </v-alert>

        <section class="files-panel" v-if="currentStep === 'files' && (task || eligibleFiles.length)">
            <div class="section-copy">
                <strong>{{ tt('personalFinance.billflow.files.title') }}</strong>
                <span v-if="task">{{ tt('personalFinance.billflow.files.inTask') }}</span>
                <span v-else>{{ tt('personalFinance.billflow.files.selected', { count: selectedFileIds.length }) }}</span>
            </div>
            <v-chip-group column multiple v-model="selectedFileIds" v-if="!task">
                <v-chip :value="file.fileId" filter :key="file.fileId" v-for="file in eligibleFiles">
                    {{ file.name }}
                </v-chip>
            </v-chip-group>
            <div class="reused-list" v-else>
                <div class="reused-item" :key="file.fileId" v-for="file in taskFiles">
                    <strong>{{ file.name }}</strong>
                </div>
            </div>
        </section>

        <div class="empty-state" v-else-if="currentStep === 'files' && !loading">
            <strong>{{ tt('personalFinance.billflow.files.empty') }}</strong>
            <p>{{ tt('personalFinance.billflow.files.emptyHint') }}</p>
            <v-btn color="primary" variant="flat" :prepend-icon="mdiTrayArrowUp" :loading="busy" @click="fileInput?.click()">
                {{ tt('personalFinance.upload') }}
            </v-btn>
        </div>

        <section class="work-section" v-if="currentStep === 'accounts'">
            <div class="bucket-bar">
                <v-btn-toggle
                    color="primary"
                    density="compact"
                    divided
                    mandatory
                    variant="outlined"
                    :model-value="accountBucket"
                    @update:model-value="value => setAccountBucket(value)"
                >
                    <v-btn :value="bucket" :key="bucket" v-for="bucket in BILLFLOW_ACCOUNT_BUCKETS">
                        {{ tt(`personalFinance.billflow.accounts.bucket.${bucket}`) }}
                        <span class="bucket-count">{{ bucketCounts[bucket] }}</span>
                    </v-btn>
                </v-btn-toggle>
                <p>{{ tt(accountBucketHintKey(accountBucket)) }}</p>
            </div>

            <template v-if="accountBucket === 'reused'">
                <div class="reused-list" v-if="accounts?.reused.length">
                    <div class="reused-item" :key="group.sampleRowId" v-for="group in accounts.reused">
                        <strong>{{ group.displayName }}</strong>
                        <span>{{ tt('personalFinance.billflow.accounts.rows', { count: group.rowCount }) }}</span>
                    </div>
                </div>
                <p class="bucket-empty" v-else>{{ tt('personalFinance.billflow.accounts.reusedEmpty') }}</p>
            </template>

            <template v-else-if="accountBucket === 'excluded'">
                <div class="reused-list" v-if="accounts?.excluded.length">
                    <div class="reused-item" :key="group.sampleRowId" v-for="group in accounts.excluded">
                        <strong>{{ group.displayName }}</strong>
                        <span>{{ tt('personalFinance.billflow.accounts.rows', { count: group.rowCount }) }}</span>
                        <v-btn size="x-small" variant="text" :loading="busy" @click="restoreAccount(group)">
                            {{ tt('personalFinance.billflow.accounts.restore') }}
                        </v-btn>
                    </div>
                </div>
                <p class="bucket-empty" v-else>{{ tt('personalFinance.billflow.accounts.excludedEmpty') }}</p>
            </template>

            <template v-else>
                <p class="bucket-empty" v-if="!accounts?.needsCreate.length">{{ tt('personalFinance.billflow.accounts.pendingEmpty') }}</p>
                <article
                    class="account-row-card"
                    :class="{ 'account-row-card--matched': !!matchedAccount(group), 'account-row-card--open': expandedSampleRowId === group.sampleRowId }"
                    :key="group.sampleRowId"
                    v-for="group in accounts?.needsCreate"
                >
                    <div class="account-row-card__main">
                        <div class="account-row-card__name">
                            <strong>{{ group.displayName }}</strong>
                            <span>{{ tt('personalFinance.billflow.accounts.rows', { count: group.rowCount }) }}</span>
                            <em v-if="matchedAccount(group)">{{ tt('personalFinance.billflow.accounts.matchedHint', { name: matchedAccount(group)?.name ?? '' }) }}</em>
                        </div>
                        <v-select
                            class="account-row-card__select"
                            density="compact"
                            hide-details
                            item-title="title"
                            item-value="value"
                            variant="outlined"
                            :items="ledgerOptions(group)"
                            :placeholder="tt('personalFinance.billflow.accounts.pickExisting')"
                            :model-value="selectedLedgerId(group)"
                            :disabled="busy"
                            v-if="ledgerOptions(group).length"
                            @update:model-value="value => setPickedLedgerId(group, value)"
                        />
                        <div class="account-row-card__actions">
                            <v-btn
                                size="small"
                                color="primary"
                                variant="flat"
                                :loading="busy"
                                v-if="selectedLedgerId(group)"
                                @click="reuseAccount(group)"
                            >
                                {{ tt('personalFinance.billflow.accounts.useExisting') }}
                            </v-btn>
                            <v-btn
                                size="small"
                                :color="selectedLedgerId(group) ? undefined : 'primary'"
                                :variant="selectedLedgerId(group) ? 'tonal' : 'flat'"
                                :loading="busy"
                                @click="createAccount(group)"
                            >
                                {{ tt('personalFinance.billflow.accounts.create') }}
                            </v-btn>
                            <v-btn size="small" variant="text" :loading="busy" @click="toggleRows(group)">
                                {{ expandedSampleRowId === group.sampleRowId ? tt('personalFinance.billflow.accounts.hideRows') : tt('personalFinance.billflow.accounts.showRows') }}
                            </v-btn>
                            <v-btn size="small" variant="text" :loading="busy" @click="excludeAccount(group)">
                                {{ tt('personalFinance.billflow.accounts.exclude') }}
                            </v-btn>
                        </div>
                    </div>
                    <div class="account-rows" v-if="expandedSampleRowId === group.sampleRowId && accountRows.length">
                        <label class="account-row" :class="{ 'account-row--skipped': row.skipped }" :key="row.id" v-for="row in accountRows">
                            <v-checkbox-btn v-model="selectedRowIds" :value="row.id" hide-details />
                            <div class="account-row__copy">
                                <strong>{{ row.label }}</strong>
                                <small>{{ formatAccountTime(row) }}</small>
                            </div>
                            <div class="account-row__facts">
                                <b>{{ formatAccountAmount(row) }}</b>
                                <v-chip size="x-small" variant="tonal" :color="directionColor(row.direction)" v-if="row.direction">
                                    {{ tt(billflowDirectionKey(row.direction)) }}
                                </v-chip>
                                <v-chip size="x-small" variant="text" v-if="row.skipped">
                                    {{ tt('personalFinance.billflow.accounts.skipped') }}
                                </v-chip>
                            </div>
                        </label>
                        <div class="account-row__batch" v-if="selectedRowIds.length">
                            <v-btn size="small" variant="tonal" :loading="busy" @click="skipSelectedRows">{{ tt('personalFinance.billflow.accounts.skipSelected') }}</v-btn>
                            <v-btn size="small" variant="text" :loading="busy" @click="restoreSelectedRows">{{ tt('personalFinance.billflow.accounts.restoreSelected') }}</v-btn>
                        </div>
                    </div>
                </article>
            </template>

            <template v-if="newBalanceAccounts.length">
                <div class="section-copy mt-5">
                    <strong>{{ tt('personalFinance.billflow.balance.title') }}</strong>
                    <span>{{ tt('personalFinance.billflow.balance.hint') }}</span>
                </div>
                <article class="account-card" :key="account.ledgerAccountId" v-for="account in newBalanceAccounts">
                    <div class="account-card__head">
                        <strong>{{ account.displayName }}</strong>
                    </div>
                    <amount-input
                        density="compact"
                        show-currency
                        :currency="account.currency"
                        :disabled="busy"
                        :label="tt('personalFinance.billflow.balance.amount')"
                        :model-value="balanceDrafts[account.ledgerAccountId] ?? 0"
                        @update:model-value="value => setBalanceDraft(account.ledgerAccountId, value)"
                    />
                    <div class="account-card__actions">
                        <v-btn size="small" variant="text" :loading="busy" @click="skipBalance(account)">{{ tt('personalFinance.billflow.balance.skip') }}</v-btn>
                        <v-btn size="small" color="primary" variant="tonal" :loading="busy" :disabled="!canSaveBalance(account.ledgerAccountId)" @click="verifyBalance(account)">
                            {{ tt('personalFinance.billflow.balance.save') }}
                        </v-btn>
                    </div>
                </article>
            </template>
        </section>

        <section class="work-section" v-if="currentStep === 'review' && task">
            <div class="bucket-bar">
                <v-btn-toggle
                    color="primary"
                    density="compact"
                    divided
                    mandatory
                    variant="outlined"
                    :model-value="categoryBucket"
                    @update:model-value="value => setCategoryBucket(value)"
                >
                    <v-btn :value="bucket" :key="bucket" v-for="bucket in BILLFLOW_CATEGORY_BUCKETS">
                        {{ tt(`personalFinance.billflow.todos.bucket.${bucket}`) }}
                        <span class="bucket-count">{{ categoryBucketCounts[bucket] }}</span>
                    </v-btn>
                </v-btn-toggle>
                <p>{{ tt(categoryBucketHintKey(categoryBucket)) }}</p>
            </div>

            <template v-if="categoryBucket === 'classified'">
                <p class="bucket-empty" v-if="!classifiedReviewTodos.length">{{ tt('personalFinance.billflow.todos.classifiedEmpty') }}</p>
                <article class="todo-row todo-row--done" :key="todo.id" v-for="todo in classifiedReviewTodos">
                    <div class="todo-row__copy">
                        <strong>{{ todoTitle(todo) }}</strong>
                        <small v-if="todoSubtitle(todo)">{{ todoSubtitle(todo) }}</small>
                    </div>
                    <div class="todo-row__facts">
                        <b v-if="formatTodoAmount(todo)">{{ formatTodoAmount(todo) }}</b>
                        <span>{{ categoryLabel(todo) }}</span>
                    </div>
                    <v-btn size="x-small" variant="text" :loading="busy" @click="restoreTodo(todo)">
                        {{ tt('personalFinance.billflow.todos.restore') }}
                    </v-btn>
                </article>
            </template>

            <template v-else>
                <div class="todo-toolbar" v-if="assignableReviewTodos.length">
                    <label class="todo-toolbar__check">
                        <v-checkbox-btn :model-value="allAssignableSelected" hide-details @click.stop="toggleAssignableSelection" />
                        {{ tt('personalFinance.billflow.todos.selectAll', { count: selectedAssignableTodos.length }) }}
                    </label>
                    <v-select
                        class="todo-toolbar__select"
                        density="compact"
                        hide-details
                        item-title="title"
                        item-value="value"
                        variant="outlined"
                        :items="batchCategoryOptions"
                        :placeholder="tt('personalFinance.billflow.todos.pickCategory')"
                        :disabled="busy"
                        :model-value="batchCategoryId"
                        @update:model-value="value => setBatchCategoryId(value)"
                    />
                    <v-btn size="small" color="primary" variant="flat" :loading="busy" :disabled="!canAssignSelected" @click="assignSelectedTodos">
                        {{ tt('personalFinance.billflow.todos.assignSelected') }}
                    </v-btn>
                    <v-btn size="small" variant="text" :loading="busy" :disabled="!selectedTodoIds.length" @click="skipSelectedTodos">
                        {{ tt('personalFinance.billflow.todos.skipSelected') }}
                    </v-btn>
                </div>
                <p class="bucket-empty" v-if="!reviewTodos.length">{{ tt('personalFinance.billflow.todos.pendingEmpty') }}</p>
                <article class="todo-row" :key="todo.id" v-for="todo in reviewTodos">
                    <label class="todo-row__check">
                        <v-checkbox-btn v-model="selectedTodoIds" :value="todo.id" hide-details />
                    </label>
                    <div class="todo-row__copy">
                        <strong>{{ todoTitle(todo) }}</strong>
                        <small v-if="todoSubtitle(todo)">{{ todoSubtitle(todo) }}</small>
                        <small v-if="!canAssignBillflowCategory(todo.todoKind)">{{ tt(todoKindKey(todo.todoKind)) }}</small>
                    </div>
                    <div class="todo-row__facts">
                        <b v-if="formatTodoAmount(todo)">{{ formatTodoAmount(todo) }}</b>
                        <em v-if="todo.direction">{{ tt(billflowDirectionKey(todo.direction)) }}</em>
                    </div>
                    <v-select
                        class="todo-row__select"
                        density="compact"
                        hide-details
                        item-title="title"
                        item-value="value"
                        variant="outlined"
                        :items="categoryOptionsFor(todo)"
                        :placeholder="tt('personalFinance.billflow.todos.pickCategory')"
                        :disabled="busy"
                        :model-value="categoryDrafts[todo.id]"
                        v-if="canAssignBillflowCategory(todo.todoKind)"
                        @update:model-value="value => setTodoCategory(todo.id, value)"
                    />
                    <div class="todo-row__actions">
                        <v-btn
                            size="x-small"
                            color="primary"
                            variant="flat"
                            :loading="busy"
                            :disabled="!categoryDrafts[todo.id]"
                            v-if="canAssignBillflowCategory(todo.todoKind)"
                            @click="assignOneTodo(todo)"
                        >
                            {{ tt('personalFinance.billflow.todos.saveCategory') }}
                        </v-btn>
                        <v-btn size="x-small" color="primary" variant="flat" :loading="busy" v-else @click="resolveTodo(todo, 'resolved')">
                            {{ tt('personalFinance.billflow.todos.resolve') }}
                        </v-btn>
                        <v-btn size="x-small" variant="text" :loading="busy" @click="resolveTodo(todo, 'dismissed')">
                            {{ tt('personalFinance.billflow.todos.dismiss') }}
                        </v-btn>
                    </div>
                </article>
            </template>
        </section>

        <section class="work-section" v-if="currentStep === 'others' && task">
            <p class="confirm-hint">{{ tt('personalFinance.billflow.othersHint') }}</p>
            <div class="section-copy mt-4">
                <strong>{{ tt('personalFinance.billflow.todos.othersTitle') }}</strong>
                <span v-if="!otherTodos.length">{{ tt('personalFinance.billflow.todos.othersEmpty') }}</span>
            </div>
            <article class="todo-row todo-row--plain" :key="todo.id" v-for="todo in otherTodos">
                <div class="todo-row__copy">
                    <strong>{{ todoTitle(todo) }}</strong>
                    <small v-if="todoSubtitle(todo)">{{ todoSubtitle(todo) }}</small>
                </div>
                <div class="todo-row__facts">
                    <b v-if="formatTodoAmount(todo)">{{ formatTodoAmount(todo) }}</b>
                    <em v-if="todo.direction">{{ tt(billflowDirectionKey(todo.direction)) }}</em>
                </div>
                <div class="todo-row__actions">
                    <v-btn size="x-small" variant="text" :loading="busy" @click="confirmInstallment(todo)">
                        {{ tt('personalFinance.billflow.todos.installment') }}
                    </v-btn>
                    <v-btn size="x-small" color="primary" variant="flat" :loading="busy" @click="resolveTodo(todo, 'resolved')">
                        {{ tt('personalFinance.billflow.todos.resolve') }}
                    </v-btn>
                    <v-btn size="x-small" variant="text" :loading="busy" @click="resolveTodo(todo, 'dismissed')">
                        {{ tt('personalFinance.billflow.todos.dismiss') }}
                    </v-btn>
                </div>
            </article>
        </section>

        <section class="work-section" v-if="currentStep === 'confirm' && task">
            <div class="summary-grid">
                <div class="summary-card summary-card--ink">
                    <span>{{ tt('personalFinance.billflow.summary.created') }}</span>
                    <strong>{{ task.createdAccountCount }}</strong>
                </div>
                <div class="summary-card">
                    <span>{{ tt(taskAwaitsConfirm(task.status) ? 'personalFinance.billflow.summary.willPost' : 'personalFinance.billflow.summary.posted') }}</span>
                    <strong>{{ task.autoPostedCount }}</strong>
                </div>
                <div class="summary-card" :class="{ 'summary-card--todo': task.todoOpenCount > 0 }">
                    <span>{{ tt('personalFinance.billflow.summary.todos') }}</span>
                    <strong>{{ task.todoOpenCount }}</strong>
                </div>
            </div>
            <p class="confirm-hint">{{ tt(taskAwaitsConfirm(task.status) ? 'personalFinance.billflow.confirmHint' : 'personalFinance.billflow.confirmDoneHint') }}</p>
        </section>

        <div class="next-bar" v-if="canGoBack || canGoForward">
            <v-btn variant="text" :disabled="!canGoBack || busy" @click="goBack">
                {{ tt('personalFinance.billflow.step.back') }}
            </v-btn>
            <span>{{ forwardHint }}</span>
            <v-btn color="primary" variant="flat" :disabled="!canGoForward || !!stepAction?.disabled" :loading="busy" v-if="canGoForward || stepAction?.disabled" @click="goForward">
                {{ forwardLabel }}
            </v-btn>
        </div>
    </v-card>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { mdiRefresh, mdiTrayArrowUp } from '@mdi/js';

import AmountInput from '@/components/desktop/AmountInput.vue';
import { useI18n } from '@/locales/helpers.ts';
import { getBrowserTimezoneOffsetMinutes, parseDateTimeFromUnixTimeWithBrowserTimezone } from '@/lib/datetime.ts';
import { generateRandomUUID } from '@/lib/misc.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';
import { useAccountsStore } from '@/stores/account.ts';
import { useTransactionCategoriesStore } from '@/stores/transactionCategory.ts';

import { CategoryType } from '@/core/category.ts';
import type { TransactionCategory } from '@/models/transaction_category.ts';

import type { BillflowAccountGroup, BillflowAccountRow, BillflowAccounts, BillflowTask, BillflowTodo, BillflowTodoStatus, CardCycleAccount } from '../models.ts';
import { todoKindKey } from '../presentation.ts';
import { billflowApi } from '../service.ts';
import {
    BILLFLOW_ACCOUNT_BUCKETS,
    BILLFLOW_CATEGORY_BUCKETS,
    BILLFLOW_OPENING_BALANCE_UNIX_TIME,
    BILLFLOW_WORKBENCH_STEPS,
    accountBucketHintKey,
    billflowDirectionKey,
    billflowWorkbenchStepIndex,
    canAutoRunAfterAccounts,
    canAssignBillflowCategory,
    canOpenBillflowWorkbenchStep,
    createdAccountsNeedingBalance,
    eligibleOrganizeFileIds,
    categoryBucketHintKey,
    categoryTodos,
    installmentTodos,
    matchedLedgerAccount,
    mergeSelectedOrganizeFileIds,
    nextBillflowWorkbenchStep,
    previousBillflowWorkbenchStep,
    rememberCreatedLedgerIds,
    resolveAccountBucket,
    resolveBillflowWorkbenchStep,
    resolveCategoryBucket,
    suggestedAccountCategory,
    taskAwaitsConfirm,
    taskNeedsAccounts,
    taskShowsTodos,
    type BillflowAccountBucket,
    type BillflowCategoryBucket,
    type BillflowWorkbenchStep
} from '../state.ts';
import { usePersonalFinanceStore } from '../../store.ts';
import { todayCivilDate } from '../../dashboard/state.ts';

const { tt, formatAmountToLocalizedNumeralsWithCurrency, formatDateTimeToShortDateTime } = useI18n();
const personalFinanceStore = usePersonalFinanceStore();
const accountsStore = useAccountsStore();
const categoriesStore = useTransactionCategoriesStore();
const fileInput = ref<HTMLInputElement>();
const loading = ref(false);
const busy = ref(false);
const error = ref(false);
const selectedFileIds = ref<string[]>([]);
const previousEligibleIds = ref<string[]>([]);
const task = ref<BillflowTask>();
const accounts = ref<BillflowAccounts>();
const expandedSampleRowId = ref<string>();
const accountRows = ref<readonly BillflowAccountRow[]>([]);
const selectedRowIds = ref<string[]>([]);
const pickedAccountIds = reactive<Record<string, string>>({});
const openTodos = ref<readonly BillflowTodo[]>([]);
const resolvedTodos = ref<readonly BillflowTodo[]>([]);
const selectedTodoIds = ref<string[]>([]);
const categoryDrafts = reactive<Record<string, string>>({});
const batchCategoryId = ref('');
const cardAccounts = ref<CardCycleAccount[]>([]);
const createdLedgerIds = ref<string[]>([]);
const answeredLedgerIds = ref<string[]>([]);
const balanceDrafts = reactive<Record<string, number>>({});
const userStep = ref<BillflowWorkbenchStep>();
const accountBucket = ref<BillflowAccountBucket>('pending');
const userPickedBucket = ref(false);
const categoryBucket = ref<BillflowCategoryBucket>('pending');
const userPickedCategoryBucket = ref(false);

const eligibleFiles = computed(() => {
    const ids = new Set(eligibleOrganizeFileIds(personalFinanceStore.batches));
    return personalFinanceStore.batches
        .filter(batch => ids.has(batch.fileId))
        .filter((batch, index, list) => list.findIndex(item => item.fileId === batch.fileId) === index)
        .map(batch => ({ fileId: batch.fileId, name: batch.file?.originalFileName || batch.fileId }));
});

const newBalanceAccounts = computed(() => createdAccountsNeedingBalance({
    createdLedgerIds: createdLedgerIds.value,
    reused: accounts.value?.reused ?? [],
    answeredLedgerIds: answeredLedgerIds.value,
    reviewedLedgerIds: cardAccounts.value
        .filter(card => !!card.balanceReview)
        .map(card => card.ledgerAccountId)
}));
const matchedNeedsCreate = computed(() => (accounts.value?.needsCreate ?? []).filter(group => !!selectedLedgerId(group)));
const taskFiles = computed(() => {
    if (!task.value) {
        return [];
    }
    const names = new Map(eligibleFiles.value.map(file => [file.fileId, file.name]));
    return task.value.members
        .filter((member, index, list) => list.findIndex(item => item.fileId === member.fileId) === index)
        .map(member => ({ fileId: member.fileId, name: names.get(member.fileId) || member.fileId }));
});
const stepInput = computed(() => ({
    hasTask: !!task.value,
    status: task.value?.status,
    needsCreateCount: accounts.value?.needsCreate.length ?? 0
}));
const currentStep = computed(() => resolveBillflowWorkbenchStep(userStep.value, stepInput.value));
const currentStepIndex = computed(() => billflowWorkbenchStepIndex(currentStep.value));
const reviewTodos = computed(() => categoryTodos(openTodos.value));
const classifiedReviewTodos = computed(() => resolvedTodos.value.filter(todo => canAssignBillflowCategory(todo.todoKind)));
const otherTodos = computed(() => installmentTodos(openTodos.value));
const assignableReviewTodos = computed(() => reviewTodos.value.filter(todo => canAssignBillflowCategory(todo.todoKind)));
const selectedAssignableTodos = computed(() => assignableReviewTodos.value.filter(todo => selectedTodoIds.value.includes(todo.id)));
const allAssignableSelected = computed(() => assignableReviewTodos.value.length > 0 && selectedAssignableTodos.value.length === assignableReviewTodos.value.length);
const batchCategoryOptions = computed(() => flattenCategoryOptions(CategoryType.Expense));
const canAssignSelected = computed(() => selectedAssignableTodos.value.length > 0 && !!batchCategoryId.value);
const canGoBack = computed(() => !!previousBillflowWorkbenchStep(currentStep.value));
const bucketCounts = computed(() => ({
    pending: accounts.value?.needsCreate.length ?? 0,
    reused: accounts.value?.reused.length ?? 0,
    excluded: accounts.value?.excluded.length ?? 0
}));
const categoryBucketCounts = computed(() => ({
    pending: reviewTodos.value.length,
    classified: classifiedReviewTodos.value.length
}));
const stepAction = computed(() => {
    if (currentStep.value === 'files' && !task.value && selectedFileIds.value.length > 0) {
        return {
            hint: tt('personalFinance.billflow.next.files', { count: selectedFileIds.value.length }),
            label: tt('personalFinance.billflow.files.create'),
            run: createTask
        };
    }
    const pendingCount = accounts.value?.needsCreate.length ?? 0;
    if (currentStep.value === 'accounts' && task.value) {
        if (taskNeedsAccounts(task.value.status, pendingCount) && pendingCount > 0 && matchedNeedsCreate.value.length > 0) {
            return {
                hint: tt('personalFinance.billflow.next.accounts', { count: pendingCount }),
                label: tt('personalFinance.billflow.accounts.reuseAll', { count: matchedNeedsCreate.value.length }),
                run: reuseMatchedAccounts
            };
        }
        if (canAutoRunAfterAccounts(task.value.status, pendingCount)) {
            return {
                hint: newBalanceAccounts.value.length
                    ? tt('personalFinance.billflow.next.accountsBalance')
                    : tt('personalFinance.billflow.next.accountsReady'),
                label: tt('personalFinance.billflow.run'),
                run: runTask
            };
        }
    }
    if (currentStep.value === 'review' && task.value && reviewTodos.value.length > 0) {
        return {
            hint: tt('personalFinance.billflow.next.reviewBlocked', { count: reviewTodos.value.length }),
            label: tt('personalFinance.billflow.step.next'),
            run: async (): Promise<void> => {},
            disabled: true
        };
    }
    if (currentStep.value === 'others' && task.value && otherTodos.value.length > 0) {
        return {
            hint: tt('personalFinance.billflow.next.othersBlocked', { count: otherTodos.value.length }),
            label: tt('personalFinance.billflow.step.next'),
            run: async (): Promise<void> => {},
            disabled: true
        };
    }
    if (currentStep.value === 'confirm' && task.value && taskAwaitsConfirm(task.value.status)) {
        return {
            hint: openTodos.value.length
                ? tt('personalFinance.billflow.next.reviewBlocked', { count: openTodos.value.length })
                : tt('personalFinance.billflow.next.confirm'),
            label: tt('personalFinance.billflow.confirmPost'),
            run: confirmPost,
            disabled: openTodos.value.length > 0
        };
    }
    return undefined;
});
const canAdvanceWithoutAction = computed(() => {
    const next = nextBillflowWorkbenchStep(currentStep.value);
    if (!next || !canOpenStep(next)) {
        return false;
    }
    if (currentStep.value === 'files') {
        return !!task.value;
    }
    if (currentStep.value === 'accounts') {
        return !!task.value && !canAutoRunAfterAccounts(task.value.status, accounts.value?.needsCreate.length ?? 0);
    }
    if (currentStep.value === 'review') {
        return reviewTodos.value.length < 1;
    }
    if (currentStep.value === 'others') {
        return otherTodos.value.length < 1;
    }
    return false;
});
const canGoForward = computed(() => (!!stepAction.value && !stepAction.value.disabled) || canAdvanceWithoutAction.value);
const forwardLabel = computed(() => stepAction.value?.label ?? tt('personalFinance.billflow.step.next'));
const forwardHint = computed(() => {
    if (stepAction.value?.hint) {
        return stepAction.value.hint;
    }
    if (currentStep.value === 'review' && reviewTodos.value.length > 0) {
        return tt('personalFinance.billflow.next.reviewBlocked', { count: reviewTodos.value.length });
    }
    if (currentStep.value === 'review') {
        return tt('personalFinance.billflow.next.review');
    }
    if (currentStep.value === 'others' && otherTodos.value.length > 0) {
        return tt('personalFinance.billflow.next.othersBlocked', { count: otherTodos.value.length });
    }
    if (currentStep.value === 'others') {
        return tt('personalFinance.billflow.next.others');
    }
    return '';
});

watch([currentStep, bucketCounts], () => {
    if (currentStep.value !== 'accounts') {
        userPickedBucket.value = false;
        return;
    }
    accountBucket.value = resolveAccountBucket(accountBucket.value, bucketCounts.value, userPickedBucket.value);
}, { immediate: true });

watch([currentStep, categoryBucketCounts], () => {
    if (currentStep.value !== 'review') {
        userPickedCategoryBucket.value = false;
        return;
    }
    categoryBucket.value = resolveCategoryBucket(categoryBucket.value, categoryBucketCounts.value, userPickedCategoryBucket.value);
}, { immediate: true });

function canOpenStep(step: BillflowWorkbenchStep): boolean {
    if (!canOpenBillflowWorkbenchStep(step, stepInput.value)) {
        return false;
    }
    if (!task.value || !taskAwaitsConfirm(task.value.status)) {
        return true;
    }
    if (step === 'others' && reviewTodos.value.length > 0) {
        return false;
    }
    if (step === 'confirm' && openTodos.value.length > 0) {
        return false;
    }
    return true;
}

function setAccountBucket(value: unknown): void {
    if (value !== 'pending' && value !== 'reused' && value !== 'excluded') {
        return;
    }
    userPickedBucket.value = true;
    accountBucket.value = value;
}

function setCategoryBucket(value: unknown): void {
    if (value !== 'pending' && value !== 'classified') {
        return;
    }
    userPickedCategoryBucket.value = true;
    categoryBucket.value = value;
}

function openStep(step: BillflowWorkbenchStep): void {
    if (!canOpenStep(step)) {
        return;
    }
    userStep.value = step;
}

function goBack(): void {
    const previous = previousBillflowWorkbenchStep(currentStep.value);
    if (previous) {
        userStep.value = previous;
    }
}

async function goForward(): Promise<void> {
    const stayOn = currentStep.value;
    if (stepAction.value) {
        if (stepAction.value.disabled) {
            return;
        }
        await stepAction.value.run();
        userStep.value = stayOn;
        return;
    }
    const next = nextBillflowWorkbenchStep(stayOn);
    if (next && canAdvanceWithoutAction.value && canOpenStep(next)) {
        userStep.value = next;
    }
}

watch(eligibleFiles, files => {
    const nextIds = files.map(file => file.fileId);
    selectedFileIds.value = mergeSelectedOrganizeFileIds(selectedFileIds.value, previousEligibleIds.value, nextIds);
    previousEligibleIds.value = nextIds;
}, { immediate: true });

function matchedAccount(group: BillflowAccountGroup) {
    return matchedLedgerAccount(group, accountsStore.allVisiblePlainAccounts);
}

function ledgerOptions(group: BillflowAccountGroup) {
    return accountsStore.allVisiblePlainAccounts
        .filter(account => account.currency === group.currency)
        .map(account => ({ title: account.name, value: account.id }));
}

function selectedLedgerId(group: BillflowAccountGroup): string | undefined {
    return pickedAccountIds[group.sampleRowId] || matchedAccount(group)?.id;
}

function setPickedLedgerId(group: BillflowAccountGroup, value: unknown): void {
    if (typeof value !== 'string' || value === '') {
        delete pickedAccountIds[group.sampleRowId];
        return;
    }
    pickedAccountIds[group.sampleRowId] = value;
}

function formatAccountAmount(row: BillflowAccountRow): string {
    return row.amount ? formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(row.amount), row.currency) : '';
}

function formatAccountTime(row: BillflowAccountRow): string {
    return row.unixTime ? formatDateTimeToShortDateTime(parseDateTimeFromUnixTimeWithBrowserTimezone(row.unixTime)) : '';
}

function formatTodoAmount(todo: BillflowTodo): string {
    return todo.amount ? formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(todo.amount), todo.currency || 'CNY') : '';
}

function formatTodoTime(todo: BillflowTodo): string {
    return todo.unixTime ? formatDateTimeToShortDateTime(parseDateTimeFromUnixTimeWithBrowserTimezone(todo.unixTime)) : '';
}

function todoTitle(todo: BillflowTodo): string {
    return todo.label || todo.item || tt(todoKindKey(todo.todoKind));
}

function todoSubtitle(todo: BillflowTodo): string {
    const title = todoTitle(todo);
    return [todo.item, todo.billType, formatTodoTime(todo)]
        .filter((part): part is string => !!part && part !== title)
        .filter((part, index, parts) => parts.indexOf(part) === index)
        .join(' · ');
}

function categoryLabel(todo: BillflowTodo): string {
    if (!todo.categoryId) {
        return '';
    }
    for (const type of [CategoryType.Expense, CategoryType.Income, CategoryType.Transfer]) {
        const match = flattenCategoryOptions(type).find(option => option.value === todo.categoryId);
        if (match) {
            return match.title;
        }
    }
    return tt('personalFinance.billflow.todos.classified');
}

function flattenCategoryOptions(type: CategoryType): { title: string, value: string }[] {
    const options: { title: string, value: string }[] = [];
    for (const category of (categoriesStore.allTransactionCategories[type] ?? []) as TransactionCategory[]) {
        for (const subCategory of category.subCategories ?? []) {
            if (!category.hidden && !subCategory.hidden) {
                options.push({ title: `${category.name} / ${subCategory.name}`, value: subCategory.id });
            }
        }
    }
    return options;
}

function categoryOptionsFor(todo: BillflowTodo): { title: string, value: string }[] {
    return flattenCategoryOptions(todo.direction === 'income' ? CategoryType.Income : CategoryType.Expense);
}

function setTodoCategory(todoId: string, value: unknown): void {
    if (typeof value !== 'string') {
        return;
    }
    categoryDrafts[todoId] = value;
}

function setBatchCategoryId(value: unknown): void {
    if (typeof value !== 'string') {
        return;
    }
    batchCategoryId.value = value;
}

function toggleAssignableSelection(): void {
    if (allAssignableSelected.value) {
        const assignable = new Set(assignableReviewTodos.value.map(todo => todo.id));
        selectedTodoIds.value = selectedTodoIds.value.filter(id => !assignable.has(id));
        return;
    }
    selectedTodoIds.value = [...new Set([...selectedTodoIds.value, ...assignableReviewTodos.value.map(todo => todo.id)])];
}

function directionColor(direction: string): string | undefined {
    if (direction === 'income') {
        return 'success';
    }
    if (direction === 'expense') {
        return 'error';
    }
    return undefined;
}

async function reload(): Promise<void> {
    loading.value = true;
    error.value = false;
    try {
        await Promise.all([
            personalFinanceStore.loadBatches(0, 50),
            accountsStore.loadAllAccounts({ force: false }),
            categoriesStore.loadAllCategories({ force: false })
        ]);
        const [pending, receiving, awaiting, ready] = await Promise.all([
            billflowApi.listTasks('accounts_pending'),
            billflowApi.listTasks('receiving'),
            billflowApi.listTasks('awaiting_confirm'),
            billflowApi.listTasks('ready')
        ]);
        const current = pending.items[0] ?? receiving.items[0] ?? awaiting.items[0] ?? ready.items[0] ?? task.value;
        if (current) {
            task.value = current;
            restoreBalanceMemory(current.id);
            await openTask(current.id);
        }
        cardAccounts.value = await billflowApi.listCardAccounts(todayCivilDate());
    } catch {
        error.value = true;
    } finally {
        loading.value = false;
    }
}

async function openTask(taskId: string): Promise<void> {
    task.value = await billflowApi.getTask(taskId);
    accounts.value = await billflowApi.getAccounts(taskId);
    if (expandedSampleRowId.value) {
        accountRows.value = await billflowApi.listAccountRows(taskId, expandedSampleRowId.value);
        selectedRowIds.value = selectedRowIds.value.filter(id => accountRows.value.some(row => row.id === id));
    }
    if (taskShowsTodos(task.value.status)) {
        const [open, resolved] = await Promise.all([
            billflowApi.listTodos(taskId, 'open', 100),
            billflowApi.listTodos(taskId, 'resolved', 100)
        ]);
        openTodos.value = open.items;
        resolvedTodos.value = resolved.items;
        selectedTodoIds.value = selectedTodoIds.value.filter(id => openTodos.value.some(todo => todo.id === id));
    } else {
        openTodos.value = [];
        resolvedTodos.value = [];
    }
}

async function upload(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length < 1) return;
    busy.value = true;
    try {
        for (const file of files) {
            await personalFinanceStore.uploadFile(file);
        }
        await personalFinanceStore.loadBatches(0, 50);
    } catch {
        error.value = true;
        await personalFinanceStore.loadBatches(0, 50).catch(() => undefined);
    } finally {
        busy.value = false;
    }
}

async function createTask(): Promise<void> {
    busy.value = true;
    try {
        const created = await billflowApi.createTask(selectedFileIds.value, generateRandomUUID());
        task.value = created;
        restoreBalanceMemory(created.id);
        await openTask(created.id);
        userStep.value = 'files';
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function createAccount(group: BillflowAccountGroup): Promise<void> {
    if (!task.value) return;
    busy.value = true;
    try {
        const previousIds = (accounts.value?.reused ?? []).map(item => item.ledgerAccountId).filter((id): id is string => !!id);
        accounts.value = await billflowApi.createAccount({
            taskId: task.value.id,
            expectedVersion: task.value.version,
            sampleRowId: group.sampleRowId,
            name: group.displayName,
            category: suggestedAccountCategory(group.suggestedType),
            currency: group.currency,
            idempotencyKey: generateRandomUUID()
        });
        createdLedgerIds.value = rememberCreatedLedgerIds(previousIds, accounts.value.reused, createdLedgerIds.value);
        persistBalanceMemory(task.value.id);
        await accountsStore.loadAllAccounts({ force: true });
        await openTask(task.value.id);
        cardAccounts.value = await billflowApi.listCardAccounts(todayCivilDate());
        userStep.value = 'accounts';
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function reuseAccount(group: BillflowAccountGroup, ledgerAccountId?: string): Promise<void> {
    if (!task.value) return;
    const accountId = ledgerAccountId || selectedLedgerId(group);
    if (!accountId) return;
    busy.value = true;
    try {
        accounts.value = await billflowApi.overrideAccount({
            taskId: task.value.id,
            expectedVersion: task.value.version,
            sampleRowId: group.sampleRowId,
            ledgerAccountId: accountId,
            idempotencyKey: generateRandomUUID()
        });
        delete pickedAccountIds[group.sampleRowId];
        await openTask(task.value.id);
        userStep.value = 'accounts';
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function reuseMatchedAccounts(): Promise<void> {
    if (!task.value) return;
    const groups = [...matchedNeedsCreate.value];
    if (groups.length < 1) return;
    busy.value = true;
    try {
        for (const group of groups) {
            const accountId = selectedLedgerId(group);
            if (!accountId) continue;
            const current = await billflowApi.getTask(task.value.id);
            accounts.value = await billflowApi.overrideAccount({
                taskId: current.id,
                expectedVersion: current.version,
                sampleRowId: group.sampleRowId,
                ledgerAccountId: accountId,
                idempotencyKey: generateRandomUUID()
            });
            delete pickedAccountIds[group.sampleRowId];
        }
        await openTask(task.value.id);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function excludeAccount(group: BillflowAccountGroup): Promise<void> {
    if (!task.value) return;
    busy.value = true;
    try {
        accounts.value = await billflowApi.excludeAccount({
            taskId: task.value.id,
            expectedVersion: task.value.version,
            sampleRowId: group.sampleRowId,
            idempotencyKey: generateRandomUUID()
        });
        expandedSampleRowId.value = undefined;
        accountRows.value = [];
        selectedRowIds.value = [];
        await openTask(task.value.id);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function restoreAccount(group: BillflowAccountGroup): Promise<void> {
    if (!task.value) return;
    busy.value = true;
    try {
        accounts.value = await billflowApi.restoreAccount({
            taskId: task.value.id,
            expectedVersion: task.value.version,
            sampleRowId: group.sampleRowId,
            idempotencyKey: generateRandomUUID()
        });
        await openTask(task.value.id);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function toggleRows(group: BillflowAccountGroup): Promise<void> {
    if (!task.value) return;
    if (expandedSampleRowId.value === group.sampleRowId) {
        expandedSampleRowId.value = undefined;
        accountRows.value = [];
        selectedRowIds.value = [];
        return;
    }
    busy.value = true;
    try {
        expandedSampleRowId.value = group.sampleRowId;
        selectedRowIds.value = [];
        accountRows.value = await billflowApi.listAccountRows(task.value.id, group.sampleRowId);
    } catch {
        error.value = true;
        expandedSampleRowId.value = undefined;
    } finally {
        busy.value = false;
    }
}

async function skipSelectedRows(): Promise<void> {
    await mutateSelectedRows(true);
}

async function restoreSelectedRows(): Promise<void> {
    await mutateSelectedRows(false);
}

async function mutateSelectedRows(skip: boolean): Promise<void> {
    if (!task.value || !expandedSampleRowId.value || selectedRowIds.value.length < 1) return;
    busy.value = true;
    try {
        const request = {
            taskId: task.value.id,
            expectedVersion: task.value.version,
            sampleRowId: expandedSampleRowId.value,
            rowIds: selectedRowIds.value,
            idempotencyKey: generateRandomUUID()
        };
        accounts.value = skip
            ? await billflowApi.skipAccountRows(request)
            : await billflowApi.restoreAccountRows(request);
        selectedRowIds.value = [];
        await openTask(task.value.id);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function runTask(): Promise<void> {
    if (!task.value) return;
    busy.value = true;
    try {
        await billflowApi.runTask(task.value.id, task.value.version, generateRandomUUID());
        await openTask(task.value.id);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function confirmPost(): Promise<void> {
    if (!task.value || openTodos.value.length > 0) return;
    busy.value = true;
    try {
        await billflowApi.confirmPost(task.value.id, task.value.version, generateRandomUUID());
        await openTask(task.value.id);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function resolveTodo(todo: BillflowTodo, status: BillflowTodoStatus): Promise<void> {
    busy.value = true;
    try {
        await billflowApi.resolveTodo(todo.id, todo.version, status, generateRandomUUID());
        if (task.value) await openTask(task.value.id);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function restoreTodo(todo: BillflowTodo): Promise<void> {
    await resolveTodo(todo, 'open');
}

async function assignTodos(todos: readonly BillflowTodo[], categoryId: string): Promise<void> {
    if (!categoryId || todos.length < 1) {
        return;
    }
    busy.value = true;
    try {
        await billflowApi.assignTodoCategories(
            todos.map(todo => ({ todoId: todo.id, expectedVersion: todo.version })),
            categoryId,
            generateRandomUUID()
        );
        batchCategoryId.value = '';
        for (const todo of todos) {
            delete categoryDrafts[todo.id];
        }
        if (task.value) await openTask(task.value.id);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function assignOneTodo(todo: BillflowTodo): Promise<void> {
    await assignTodos([todo], categoryDrafts[todo.id] ?? '');
}

async function assignSelectedTodos(): Promise<void> {
    await assignTodos(selectedAssignableTodos.value, batchCategoryId.value);
}

async function skipSelectedTodos(): Promise<void> {
    const selected = reviewTodos.value.filter(todo => selectedTodoIds.value.includes(todo.id));
    if (selected.length < 1) {
        return;
    }
    busy.value = true;
    try {
        for (const todo of selected) {
            await billflowApi.resolveTodo(todo.id, todo.version, 'dismissed', generateRandomUUID());
        }
        if (task.value) await openTask(task.value.id);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function confirmInstallment(todo: BillflowTodo): Promise<void> {
    busy.value = true;
    try {
        const candidate = await billflowApi.getInstallmentCandidate(todo.subjectId);
        await billflowApi.confirmInstallment({
            candidateId: candidate.id,
            expectedVersion: candidate.version,
            treatAsInstallment: true,
            liabilityAccountId: candidate.liabilityAccountId,
            termCount: candidate.termCount,
            purchaseRelation: candidate.purchaseRelation === 'unresolved' ? 'missing_candidate' : candidate.purchaseRelation,
            linkedPurchaseTransactionId: candidate.linkedPurchaseTransactionId
        });
        await resolveTodo(todo, 'resolved');
    } catch {
        error.value = true;
        busy.value = false;
    }
}

async function skipBalance(account: { ledgerAccountId: string }): Promise<void> {
    busy.value = true;
    try {
        await persistBalanceReview(account, 'unverified', '');
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

function setBalanceDraft(ledgerAccountId: string, value: unknown): void {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return;
    }
    balanceDrafts[ledgerAccountId] = value;
}

function canSaveBalance(ledgerAccountId: string): boolean {
    return Number.isSafeInteger(balanceDrafts[ledgerAccountId] ?? 0);
}

async function verifyBalance(account: { ledgerAccountId: string }): Promise<void> {
    const amount = balanceDrafts[account.ledgerAccountId] ?? 0;
    if (!Number.isSafeInteger(amount)) {
        return;
    }
    busy.value = true;
    try {
        await billflowApi.addOpeningBalance({
            accountId: account.ledgerAccountId,
            amount,
            time: BILLFLOW_OPENING_BALANCE_UNIX_TIME,
            utcOffset: getBrowserTimezoneOffsetMinutes(BILLFLOW_OPENING_BALANCE_UNIX_TIME),
            clientSessionId: generateRandomUUID()
        });
        await persistBalanceReview(account, 'verified', todayCivilDate());
        await accountsStore.loadAllAccounts({ force: true });
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function persistBalanceReview(account: { ledgerAccountId: string }, status: 'unverified' | 'verified', asOfDate: string): Promise<void> {
    const review = cardAccounts.value.find(card => card.ledgerAccountId === account.ledgerAccountId)?.balanceReview;
    await billflowApi.saveBalanceReview({
        ledgerAccountId: account.ledgerAccountId,
        status,
        asOfDate,
        expectedVersion: review?.version ?? 0,
        idempotencyKey: generateRandomUUID()
    });
    if (!answeredLedgerIds.value.includes(account.ledgerAccountId)) {
        answeredLedgerIds.value = [...answeredLedgerIds.value, account.ledgerAccountId];
    }
    if (task.value) {
        persistBalanceMemory(task.value.id);
        userStep.value = 'accounts';
    }
    cardAccounts.value = await billflowApi.listCardAccounts(todayCivilDate());
}

function balanceMemoryKey(taskId: string): string {
    return `ezbk.billflow.balance.${taskId}`;
}

function restoreBalanceMemory(taskId: string): void {
    createdLedgerIds.value = [];
    answeredLedgerIds.value = [];
    try {
        const raw = sessionStorage.getItem(balanceMemoryKey(taskId));
        if (!raw) {
            return;
        }
        const parsed = JSON.parse(raw) as { created?: unknown; answered?: unknown };
        if (Array.isArray(parsed.created)) {
            createdLedgerIds.value = parsed.created.filter((id): id is string => typeof id === 'string' && id.length > 0);
        }
        if (Array.isArray(parsed.answered)) {
            answeredLedgerIds.value = parsed.answered.filter((id): id is string => typeof id === 'string' && id.length > 0);
        }
    } catch {
        createdLedgerIds.value = [];
        answeredLedgerIds.value = [];
    }
}

function persistBalanceMemory(taskId: string): void {
    try {
        sessionStorage.setItem(balanceMemoryKey(taskId), JSON.stringify({
            created: createdLedgerIds.value,
            answered: answeredLedgerIds.value
        }));
    } catch {
        return;
    }
}

onMounted(reload);
</script>

<style scoped>
.task-workbench {
    --task-ink: #17352f;
    --task-mint: #dff3e9;
    --task-paper: rgb(var(--v-theme-surface));
    --task-rule: rgba(var(--v-theme-on-surface), 0.11);
    border: 1px solid var(--task-rule);
    border-radius: 18px 6px 18px 6px;
    box-shadow: none;
}

.task-toolbar,
.files-panel,
.work-section,
.next-bar {
    padding: 20px 22px;
}

.task-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    background: linear-gradient(115deg, rgba(var(--v-theme-primary), 0.08), transparent 58%);
}

.task-kicker {
    color: rgb(var(--v-theme-primary));
    font-size: 0.68rem;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
}

.task-lead {
    margin-top: 4px;
    color: rgba(var(--v-theme-on-surface), 0.64);
    font-size: 0.92rem;
}

.step-rail {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 1px;
    border-top: 1px solid var(--task-rule);
    background: var(--task-rule);
}

.step-rail button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 52px;
    padding: 10px 6px;
    border: 0;
    background: var(--task-paper);
    color: rgba(var(--v-theme-on-surface), 0.55);
    font-size: 0.76rem;
    cursor: pointer;
}

.step-rail button span {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 999px;
    background: rgba(var(--v-theme-on-surface), 0.08);
    font-size: 0.72rem;
    font-weight: 700;
}

.step-rail button.is-current {
    color: rgb(var(--v-theme-on-surface));
    font-weight: 700;
    box-shadow: inset 0 -3px rgb(var(--v-theme-primary));
}

.step-rail button.is-current span,
.step-rail button.is-done span {
    background: rgb(var(--v-theme-primary));
    color: rgb(var(--v-theme-on-primary));
}

.step-rail button.is-done {
    color: rgb(var(--v-theme-on-surface));
}

.step-rail button.is-locked,
.step-rail button:disabled {
    cursor: default;
    opacity: 0.55;
}

.files-panel,
.work-section {
    border-top: 1px solid var(--task-rule);
}

.section-copy {
    display: grid;
    gap: 4px;
    margin-bottom: 14px;
}

.section-copy span {
    color: rgba(var(--v-theme-on-surface), 0.6);
    font-size: 0.82rem;
    line-height: 1.5;
}

.empty-state {
    display: grid;
    justify-items: center;
    gap: 8px;
    padding: 56px 24px;
    text-align: center;
}

.empty-state p {
    max-width: 420px;
    margin: 0 0 8px;
    color: rgba(var(--v-theme-on-surface), 0.62);
}

.summary-grid {
    display: grid;
    grid-template-columns: 1.15fr 1fr 1fr;
    gap: 12px;
    padding: 0;
}

.confirm-hint {
    margin: 14px 0 0;
    color: rgba(var(--v-theme-on-surface), 0.62);
    font-size: 0.86rem;
    line-height: 1.5;
}

.summary-card {
    min-height: 112px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 18px 20px;
    border: 1px solid var(--task-rule);
    border-radius: 5px 16px 5px 16px;
    background: var(--task-paper);
}

.summary-card span {
    font-size: 0.74rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(var(--v-theme-on-surface), 0.58);
}

.summary-card strong {
    font-size: clamp(1.6rem, 2.4vw, 2.2rem);
    letter-spacing: -0.04em;
    font-variant-numeric: tabular-nums;
}

.summary-card--ink {
    background: var(--task-ink);
    color: #f5f1df;
    border-color: transparent;
}

.summary-card--ink span {
    color: rgba(245, 241, 223, 0.7);
}

.summary-card--todo {
    background: var(--task-mint);
    color: var(--task-ink);
}

.bucket-bar {
    display: grid;
    gap: 10px;
    margin-bottom: 16px;
}

.bucket-bar p,
.bucket-empty {
    margin: 0;
    color: rgba(var(--v-theme-on-surface), 0.6);
    font-size: 0.82rem;
    line-height: 1.5;
}

.bucket-empty {
    padding: 8px 0 4px;
}

.bucket-count {
    margin-left: 6px;
    font-variant-numeric: tabular-nums;
    opacity: 0.72;
}

.reused-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 8px;
}

.reused-item {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
    padding: 8px 12px;
    border: 1px solid var(--task-rule);
    border-radius: 8px 2px 8px 2px;
    background: rgba(var(--v-theme-primary), 0.04);
}

.reused-item strong {
    font-size: 0.86rem;
}

.reused-item span {
    color: rgba(var(--v-theme-on-surface), 0.55);
    font-size: 0.75rem;
}

.account-row-card {
    margin-bottom: 8px;
    border: 1px solid var(--task-rule);
    border-radius: 8px 2px 8px 2px;
    background: var(--task-paper);
}

.account-row-card--matched {
    border-color: rgba(var(--v-theme-primary), 0.35);
}

.account-row-card__main {
    display: grid;
    grid-template-columns: minmax(0, 1.3fr) minmax(180px, 0.8fr) auto;
    align-items: center;
    gap: 10px 12px;
    padding: 8px 12px;
}

.account-row-card__name {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 8px;
    min-width: 0;
}

.account-row-card__name strong {
    font-size: 0.92rem;
    line-height: 1.3;
}

.account-row-card__name span,
.account-row-card__name em {
    color: rgba(var(--v-theme-on-surface), 0.55);
    font-size: 0.75rem;
    font-style: normal;
    white-space: nowrap;
}

.account-row-card__select {
    min-width: 0;
}

.account-row-card__actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 4px;
}

.account-card {
    display: grid;
    gap: 8px;
    padding: 12px 14px;
    margin-bottom: 10px;
    border: 1px solid var(--task-rule);
    border-radius: 8px 2px 8px 2px;
    background: var(--task-paper);
}

.todo-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    margin: 0 0 8px;
}

.todo-toolbar__check {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.82rem;
}

.todo-toolbar__select,
.todo-row__select {
    min-width: 132px;
    max-width: 180px;
}

.todo-row {
    display: grid;
    grid-template-columns: 28px minmax(0, 1.4fr) auto minmax(132px, 180px) auto;
    align-items: center;
    gap: 6px 8px;
    padding: 6px 4px;
    border-bottom: 1px solid var(--task-rule);
}

.todo-row--done,
.todo-row--plain {
    grid-template-columns: minmax(0, 1.4fr) auto auto;
}

.todo-row__check {
    display: flex;
}

.todo-row__copy {
    min-width: 0;
}

.todo-row__copy strong,
.todo-row__facts b {
    overflow-wrap: anywhere;
    font-size: 0.88rem;
    line-height: 1.25;
}

.todo-row__copy small,
.todo-row__facts em,
.todo-row__facts span {
    display: block;
    color: rgba(var(--v-theme-on-surface), 0.55);
    font-size: 0.72rem;
    font-style: normal;
}

.todo-row__facts {
    display: grid;
    justify-items: end;
    gap: 1px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}

.todo-row__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
}

.account-card__head,
.account-card__actions,
.account-card__quiet,
.account-row,
.account-row__batch,
.next-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
}

.account-card__head,
.next-bar {
    justify-content: space-between;
}

.account-card__head strong {
    display: block;
}

.account-card__head span,
.account-card__hint {
    margin: 4px 0 0;
    color: rgba(var(--v-theme-on-surface), 0.6);
    font-size: 0.8rem;
    line-height: 1.45;
}

.account-card__actions {
    justify-content: flex-end;
}

.account-rows {
    display: grid;
    gap: 6px;
    padding-top: 8px;
    border-top: 1px solid var(--task-rule);
}

.account-row {
    align-items: flex-start;
    padding: 8px 4px;
    border-radius: 8px;
}

.account-row--skipped {
    opacity: 0.55;
}

.account-row__copy {
    flex: 1;
    min-width: 0;
}

.account-row__copy strong,
.account-row__facts b {
    display: block;
    overflow-wrap: anywhere;
}

.account-row__copy small {
    color: rgba(var(--v-theme-on-surface), 0.55);
}

.account-row__facts {
    display: grid;
    justify-items: end;
    gap: 4px;
    font-variant-numeric: tabular-nums;
}

.next-bar {
    position: sticky;
    bottom: 0;
    z-index: 2;
    border-top: 1px solid var(--task-rule);
    background: color-mix(in srgb, var(--task-paper) 92%, transparent);
    backdrop-filter: blur(10px);
}

.next-bar span {
    color: rgba(var(--v-theme-on-surface), 0.68);
    font-size: 0.9rem;
}

@media (max-width: 900px) {
    .summary-grid {
        grid-template-columns: 1fr;
    }

    .step-rail {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .account-row-card__main,
    .todo-row,
    .todo-row--done,
    .todo-row--plain {
        grid-template-columns: 1fr;
    }

    .account-card__head,
    .next-bar {
        align-items: flex-start;
        flex-direction: column;
    }
}
</style>
