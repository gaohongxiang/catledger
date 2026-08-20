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
                accept=".csv,.xlsx,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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
                <span v-if="canEditFiles">{{ task ? tt('personalFinance.billflow.files.inTask') : tt('personalFinance.billflow.files.selected', { count: selectedFileIds.length }) }}</span>
                <span v-else>{{ tt('personalFinance.billflow.files.inTaskLocked') }}</span>
            </div>
            <v-chip-group column multiple v-model="selectedFileIds" v-if="canEditFiles">
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
                        <dl class="card-header-facts" v-if="accountGroupHasCardHeader(group)">
                            <div v-if="group.statementDate">
                                <dt>{{ tt('personalFinance.billflow.accounts.statementDate') }}</dt>
                                <dd>{{ group.statementDate }}</dd>
                            </div>
                            <div v-if="group.dueDate">
                                <dt>{{ tt('personalFinance.billflow.accounts.dueDate') }}</dt>
                                <dd>{{ group.dueDate }}</dd>
                            </div>
                            <div v-if="formatAccountCardLimit(group)">
                                <dt>{{ tt('personalFinance.billflow.accounts.creditLimit') }}</dt>
                                <dd>{{ formatAccountCardLimit(group) }}</dd>
                            </div>
                        </dl>
                        <p class="card-header-copy" v-if="accountGroupHasCardHeader(group)">{{ tt('personalFinance.billflow.accounts.cardHeaderReusedHint') }}</p>
                        <div class="account-balance" v-if="balanceAccountFor(group)">
                            <amount-input
                                density="compact"
                                show-currency
                                :currency="balanceAccountFor(group)?.currency ?? group.currency"
                                :disabled="busy"
                                :label="tt('personalFinance.billflow.balance.amount')"
                                :model-value="balanceDrafts[group.ledgerAccountId ?? ''] ?? 0"
                                @update:model-value="value => setBalanceDraft(group.ledgerAccountId ?? '', value)"
                            />
                            <div class="account-card__actions">
                                <v-btn size="small" variant="text" :loading="busy" @click="skipBalance({ ledgerAccountId: group.ledgerAccountId ?? '' })">{{ tt('personalFinance.billflow.balance.skip') }}</v-btn>
                                <v-btn size="small" color="primary" variant="tonal" :loading="busy" :disabled="!group.ledgerAccountId || !canSaveBalance(group.ledgerAccountId)" @click="verifyBalance({ ledgerAccountId: group.ledgerAccountId ?? '' })">
                                    {{ tt('personalFinance.billflow.balance.save') }}
                                </v-btn>
                            </div>
                        </div>
                    </div>
                </div>
                <p class="bucket-empty" v-else>{{ tt('personalFinance.billflow.accounts.reusedEmpty') }}</p>
            </template>

            <template v-else-if="accountBucket === 'excluded'">
                <div class="reused-list" v-if="accounts?.excluded.length">
                    <div class="reused-item" :key="group.sampleRowId" v-for="group in accounts.excluded">
                        <strong>{{ group.displayName }}</strong>
                        <span>{{ tt('personalFinance.billflow.accounts.rows', { count: group.rowCount }) }}</span>
                        <dl class="card-header-facts" v-if="accountGroupHasCardHeader(group)">
                            <div v-if="group.statementDate">
                                <dt>{{ tt('personalFinance.billflow.accounts.statementDate') }}</dt>
                                <dd>{{ group.statementDate }}</dd>
                            </div>
                            <div v-if="group.dueDate">
                                <dt>{{ tt('personalFinance.billflow.accounts.dueDate') }}</dt>
                                <dd>{{ group.dueDate }}</dd>
                            </div>
                            <div v-if="formatAccountCardLimit(group)">
                                <dt>{{ tt('personalFinance.billflow.accounts.creditLimit') }}</dt>
                                <dd>{{ formatAccountCardLimit(group) }}</dd>
                            </div>
                        </dl>
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
                    :class="{ 'account-row-card--matched': !!matchedAccount(group) }"
                    :key="group.sampleRowId"
                    v-for="group in accounts?.needsCreate"
                >
                    <div class="account-row-card__main">
                        <div class="account-row-card__name">
                            <strong>{{ group.displayName }}</strong>
                            <span>{{ tt('personalFinance.billflow.accounts.rows', { count: group.rowCount }) }}</span>
                            <em v-if="matchedAccount(group)">{{ tt('personalFinance.billflow.accounts.matchedHint', { name: matchedAccount(group)?.name ?? '' }) }}</em>
                            <dl class="card-header-facts" v-if="accountGroupHasCardHeader(group)">
                                <div v-if="group.statementDate">
                                    <dt>{{ tt('personalFinance.billflow.accounts.statementDate') }}</dt>
                                    <dd>{{ group.statementDate }}</dd>
                                </div>
                                <div v-if="group.dueDate">
                                    <dt>{{ tt('personalFinance.billflow.accounts.dueDate') }}</dt>
                                    <dd>{{ group.dueDate }}</dd>
                                </div>
                                <div v-if="formatAccountCardLimit(group)">
                                    <dt>{{ tt('personalFinance.billflow.accounts.creditLimit') }}</dt>
                                    <dd>{{ formatAccountCardLimit(group) }}</dd>
                                </div>
                            </dl>
                            <p class="card-header-copy" v-if="accountGroupHasCardHeader(group) && group.suggestedType === 'credit_card'">{{ tt('personalFinance.billflow.accounts.cardHeaderCreateHint') }}</p>
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
                            <v-btn size="small" variant="text" :loading="busy" @click="excludeAccount(group)">
                                {{ tt('personalFinance.billflow.accounts.exclude') }}
                            </v-btn>
                        </div>
                    </div>
                </article>
            </template>
        </section>

        <section class="work-section" v-if="currentStep === 'review' && task">
            <div class="transaction-plan-summary" v-if="transactionPlan">
                <button
                    type="button"
                    class="transaction-plan-card"
                    :class="{ 'transaction-plan-card--active': reviewPane === 'evidence' }"
                    :aria-pressed="reviewPane === 'evidence'"
                    @click="setReviewPane('evidence')"
                >
                    <strong>{{ transactionPlan.evidenceRowCount }}</strong>
                    <span>{{ tt('personalFinance.billflow.plan.evidence') }}</span>
                </button>
                <span class="transaction-plan-summary__operator">−</span>
                <button
                    type="button"
                    class="transaction-plan-card"
                    :class="{ 'transaction-plan-card--active': reviewPane === 'merge' }"
                    :aria-pressed="reviewPane === 'merge'"
                    @click="setReviewPane('merge')"
                >
                    <strong>{{ transactionPlan.consolidatedRowCount }}</strong>
                    <span>{{ tt('personalFinance.billflow.plan.consolidated') }}</span>
                </button>
                <span class="transaction-plan-summary__operator">=</span>
                <button
                    type="button"
                    class="transaction-plan-card transaction-plan-summary__primary"
                    :class="{ 'transaction-plan-card--active': reviewPane === 'transactions' }"
                    :aria-pressed="reviewPane === 'transactions'"
                    @click="setReviewPane('transactions')"
                >
                    <strong>{{ transactionPlan.plannedTransactionCount }}</strong>
                    <span>{{ tt('personalFinance.billflow.plan.transactions') }}</span>
                </button>
                <button
                    type="button"
                    class="transaction-plan-card"
                    :class="{ 'transaction-plan-card--active': reviewPane === 'relations' }"
                    :aria-pressed="reviewPane === 'relations'"
                    @click="setReviewPane('relations')"
                >
                    <strong>{{ transactionPlan.mergeReviewCount + transactionPlan.otherReviewCount }}</strong>
                    <span>{{ tt('personalFinance.billflow.plan.blocking') }}</span>
                </button>
                <button
                    type="button"
                    class="transaction-plan-card"
                    :class="{ 'transaction-plan-card--active': reviewPane === 'category' }"
                    :aria-pressed="reviewPane === 'category'"
                    @click="setReviewPane('category')"
                >
                    <strong>{{ transactionPlan.categoryReviewCount }}</strong>
                    <span>{{ tt('personalFinance.billflow.plan.uncategorized') }}</span>
                </button>
            </div>
            <p class="transaction-plan-summary__explanation" v-if="transactionPlan">
                {{ tt('personalFinance.billflow.plan.explanation', {
                    transactions: transactionPlan.plannedTransactionCount,
                    duplicates: transactionPlan.consolidatedRowCount,
                    categories: transactionPlan.categoryReviewCount
                }) }}
            </p>
            <div class="bucket-bar pane-bar">
                <div>
                    <strong>{{ tt(`personalFinance.billflow.pane.${reviewPane}`) }}</strong>
                    <p>{{ tt(reviewPaneHintKey(reviewPane)) }}</p>
                </div>
                <v-btn
                    size="small"
                    variant="tonal"
                    :loading="busy"
                    v-if="task && canReapplyOrganize(task.status, accounts?.needsCreate.length ?? 0)"
                    @click="runTask"
                >
                    {{ tt('personalFinance.billflow.merge.reanalyze') }}
                </v-btn>
            </div>
            <template v-if="reviewPane === 'merge'">
            <p class="bucket-empty" v-if="canAutoRunAfterAccounts(task.status, accounts?.needsCreate.length ?? 0)">
                {{ tt('personalFinance.billflow.merge.pending') }}
            </p>
            <template v-else>
                <div class="bucket-bar">
                    <strong>{{ tt(`personalFinance.billflow.merge.bucket.${mergeBucket}`) }} · {{ mergeBucketCounts[mergeBucket] }}</strong>
                    <p>{{ tt(mergeBucketHintKey(mergeBucket)) }}</p>
                </div>
                <template v-if="mergeBucket === 'merged'">
                    <p class="bucket-empty" v-if="!processedMergeGroups.length">{{ tt('personalFinance.billflow.merge.mergedEmpty') }}</p>
                </template>
                <template v-else>
                    <p class="bucket-empty" v-if="!pendingMergeGroups.length">{{ tt('personalFinance.billflow.merge.empty') }}</p>
                </template>
                <div class="merge-table-wrap" v-if="activeMergeGroups.length">
                        <table class="merge-table">
                            <thead>
                                <tr>
                                    <th>{{ tt('personalFinance.billflow.merge.column.source') }}</th>
                                    <th>{{ tt('Account') }}</th>
                                    <th>{{ tt('personalFinance.billflow.merge.column.counterparty') }}</th>
                                    <th v-if="mergeHasItemColumn">{{ tt('personalFinance.billflow.merge.column.item') }}</th>
                                    <th>{{ tt('Category') }}</th>
                                    <th>{{ tt('Amount') }}</th>
                                    <th>{{ tt('Time') }}</th>
                                    <th>{{ tt('Type') }}</th>
                                    <th>{{ tt('personalFinance.billflow.merge.column.orderId') }}</th>
                                    <th>{{ tt('personalFinance.billflow.skip.title') }}</th>
                                </tr>
                            </thead>
                            <tbody class="merge-group" :key="group.id" v-for="(group, groupIndex) in activeMergeGroups">
                                <tr class="merge-group__gap" v-if="groupIndex > 0">
                                    <td :colspan="mergeColumnCount"></td>
                                </tr>
                                <tr class="merge-group__bar">
                                    <td :colspan="mergeColumnCount">
                                        <div class="merge-group__bar-inner">
                                            <span>
                                                {{ tt('personalFinance.billflow.merge.groupRows', { count: mergeGroupRows(group).length }) }}
                                                · {{ tt(`personalFinance.billflow.merge.status.${group.status}`) }}
                                            </span>
                                            <div class="merge-group__actions">
                                                <div class="todo-row__actions" v-if="group.caseIds.length">
                                                    <v-btn
                                                        density="compact"
                                                        size="x-small"
                                                        color="primary"
                                                        variant="text"
                                                        :key="caseId"
                                                        :loading="busy"
                                                        v-for="(caseId, caseIndex) in group.caseIds"
                                                        @click="openReconciliation(caseId)"
                                                    >
                                                        {{ group.caseIds.length === 1 ? tt('personalFinance.organizer.tab.reconciliation') : tt('personalFinance.billflow.merge.openCase', { index: caseIndex + 1 }) }}
                                                    </v-btn>
                                                </div>
                                            </div>
                                        </div>
                                    </td>
                                </tr>
                                <tr class="merge-group__row" :key="group.id + '-' + index" v-for="(row, index) in mergeGroupRows(group)">
                                    <td>{{ formatMergeSource(row) }}</td>
                                    <td>{{ row.account }}</td>
                                    <td>{{ row.label }}</td>
                                    <td v-if="mergeHasItemColumn">{{ row.item }}</td>
                                    <td>{{ row.billType }}</td>
                                    <td class="is-num">{{ formatMergeAmount(row) }}</td>
                                    <td>{{ formatMergeTime(row) }}</td>
                                    <td>{{ row.direction ? tt(billflowDirectionKey(row.direction)) : '' }}</td>
                                    <td class="is-id">{{ mergeOrderId(row) }}</td>
                                    <td>
                                        <v-checkbox-btn
                                            hide-details
                                            density="compact"
                                            :disabled="busy"
                                            :model-value="isRowSkipped(row.rowId)"
                                            v-if="row.inTask && canSkipRow(row.rowId)"
                                            @click.prevent="toggleSkipRow(row.rowId)"
                                        />
                                    </td>
                                </tr>
                                <tr class="merge-group__note" v-if="mergeBucket !== 'merged' && group.rows.length > 2">
                                    <td :colspan="mergeColumnCount">{{ tt('personalFinance.billflow.merge.matchesMany') }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
            </template>
            </template>

            <template v-else-if="reviewPane === 'category'">
            <div class="bucket-bar">
                <strong>{{ tt(`personalFinance.billflow.todos.bucket.${categoryBucket}`) }} · {{ categoryBucketCounts[categoryBucket] }}</strong>
                <p>{{ tt(categoryBucketHintKey(categoryBucket)) }}</p>
            </div>

            <template v-if="categoryBucket === 'classified'">
                <p class="bucket-empty" v-if="!classifiedReviewRows.length">{{ tt('personalFinance.billflow.todos.classifiedEmpty') }}</p>
                <article class="todo-row todo-row--done" :key="row.id" v-for="row in classifiedReviewRows">
                    <div class="todo-row__copy">
                        <strong>{{ classifiedTitle(row) }}</strong>
                        <small v-if="classifiedSubtitle(row)">{{ classifiedSubtitle(row) }}</small>
                    </div>
                    <div class="todo-row__facts">
                        <b v-if="formatClassifiedAmount(row)">{{ formatClassifiedAmount(row) }}</b>
                        <span>{{ classifiedCategoryLabel(row) }}</span>
                    </div>
                    <label class="todo-skip" v-if="canSkipRow(row.id)">
                        <v-checkbox-btn hide-details :model-value="isRowSkipped(row.id)" @click.prevent="toggleSkipRow(row.id)" />
                        {{ tt('personalFinance.billflow.accounts.skipped') }}
                    </label>
                    <v-btn v-if="row.todoId && row.version" density="compact" size="x-small" variant="text" :loading="busy" @click="restoreClassifiedRow(row)">
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
                <p class="bucket-empty" v-if="!reviewTodos.length && !skippedOrphanRows.length">{{ tt('personalFinance.billflow.todos.pendingEmpty') }}</p>
                <article class="todo-row" :key="todo.id" v-for="todo in reviewTodos">
                    <label class="todo-row__check" v-if="todo.status === 'open' && !isRowSkipped(todo.subjectId)">
                        <v-checkbox-btn v-model="selectedTodoIds" :value="todo.id" hide-details />
                    </label>
                    <span v-else />
                    <div class="todo-row__copy">
                        <strong>{{ todoTitle(todo) }}</strong>
                        <small v-if="todoSubtitle(todo)">{{ todoSubtitle(todo) }}</small>
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
                        v-if="canAssignBillflowCategory(todo.todoKind) && !isRowSkipped(todo.subjectId)"
                        @update:model-value="value => setTodoCategory(todo.id, value)"
                    />
                    <div class="todo-row__actions">
                        <label class="todo-skip" v-if="canSkipTodo(todo)">
                            <v-checkbox-btn hide-details :model-value="isRowSkipped(todo.subjectId)" @click.prevent="toggleSkipTodo(todo)" />
                            {{ tt('personalFinance.billflow.accounts.skipped') }}
                        </label>
                        <template v-if="!isRowSkipped(todo.subjectId)">
                            <v-btn
                                density="compact"
                                size="x-small"
                                color="primary"
                                variant="text"
                                :loading="busy"
                                :disabled="!categoryDrafts[todo.id]"
                                v-if="canAssignBillflowCategory(todo.todoKind)"
                                @click="assignOneTodo(todo)"
                            >
                                {{ tt('personalFinance.billflow.todos.saveCategory') }}
                            </v-btn>
                            <v-btn density="compact" size="x-small" color="primary" variant="text" :loading="busy" v-else @click="resolveTodo(todo, 'resolved')">
                                {{ tt('personalFinance.billflow.todos.resolve') }}
                            </v-btn>
                            <v-btn density="compact" size="x-small" variant="text" :loading="busy" @click="resolveTodo(todo, 'dismissed')">
                                {{ tt('personalFinance.billflow.todos.dismiss') }}
                            </v-btn>
                        </template>
                    </div>
                </article>
                <article class="todo-row todo-row--done" :key="'skipped-' + row.id" v-for="row in skippedOrphanRows">
                    <div class="todo-row__copy">
                        <strong>{{ row.label }}</strong>
                        <small v-if="formatAccountTime(row)">{{ formatAccountTime(row) }}</small>
                    </div>
                    <div class="todo-row__facts">
                        <b v-if="formatAccountAmount(row)">{{ formatAccountAmount(row) }}</b>
                        <em v-if="row.direction">{{ tt(billflowDirectionKey(row.direction)) }}</em>
                    </div>
                    <label class="todo-skip">
                        <v-checkbox-btn hide-details :model-value="true" @click.prevent="toggleSkipRow(row.id)" />
                        {{ tt('personalFinance.billflow.accounts.skipped') }}
                    </label>
                </article>
            </template>
            </template>

            <template v-else-if="reviewPane === 'relations'">
                <div class="section-copy">
                    <strong>{{ tt('personalFinance.billflow.todos.othersTitle') }}</strong>
                    <span v-if="!otherReviewTodos.length">{{ tt('personalFinance.billflow.todos.othersEmpty') }}</span>
                </div>
                <article class="todo-row todo-row--plain" :key="todo.id" v-for="todo in otherReviewTodos">
                    <div class="todo-row__copy">
                        <strong>{{ todoTitle(todo) }}</strong>
                        <small v-if="todoMeta(todo)">{{ todoMeta(todo) }}</small>
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
                        :items="counterpartAccountOptions(todo)"
                        :placeholder="tt('personalFinance.billflow.todos.pickPaymentAccount')"
                        :disabled="busy"
                        :model-value="counterpartAccountDrafts[todo.id]"
                        v-if="todo.todoKind === 'repayment_unclear'"
                        @update:model-value="value => setCounterpartAccount(todo.id, value)"
                    />
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
                        v-if="canAssignBillflowCategory(todo.todoKind) && !isRowSkipped(todo.subjectId)"
                        @update:model-value="value => setTodoCategory(todo.id, value)"
                    />
                    <div class="todo-row__actions">
                        <v-btn density="compact" size="x-small" variant="text" :loading="busy" v-if="isInstallmentTodo(todo.todoKind)" @click="confirmInstallment(todo)">
                            {{ tt('personalFinance.billflow.todos.installment') }}
                        </v-btn>
                        <v-btn
                            density="compact"
                            size="x-small"
                            color="primary"
                            variant="text"
                            :loading="busy"
                            :disabled="!counterpartAccountDrafts[todo.id]"
                            v-if="todo.todoKind === 'repayment_unclear'"
                            @click="assignCounterpartAccount(todo)"
                        >
                            {{ tt('personalFinance.billflow.todos.savePaymentAccount') }}
                        </v-btn>
                        <v-btn
                            density="compact"
                            size="x-small"
                            color="primary"
                            variant="text"
                            :loading="busy"
                            :disabled="!categoryDrafts[todo.id]"
                            v-else-if="canAssignBillflowCategory(todo.todoKind)"
                            @click="assignOneTodo(todo)"
                        >
                            {{ tt('personalFinance.billflow.todos.saveCategory') }}
                        </v-btn>
                        <v-btn v-else density="compact" size="x-small" color="primary" variant="text" :loading="busy" @click="resolveTodo(todo, 'resolved')">
                            {{ tt('personalFinance.billflow.todos.resolve') }}
                        </v-btn>
                        <v-btn density="compact" size="x-small" variant="text" :loading="busy" @click="resolveTodo(todo, 'dismissed')">
                            {{ tt('personalFinance.billflow.todos.dismiss') }}
                        </v-btn>
                    </div>
                </article>
            </template>

            <template v-else-if="reviewPane === 'evidence'">
                <div class="section-copy">
                    <strong>{{ tt('personalFinance.billflow.plan.evidenceTitle') }}</strong>
                    <span>{{ tt('personalFinance.billflow.plan.rowsShown', { count: transactionPlan?.evidenceRows.length ?? 0 }) }}</span>
                </div>
                <article class="todo-row todo-row--plain" :key="row.rowId" v-for="row in transactionPlan?.evidenceRows ?? []">
                    <div class="todo-row__copy">
                        <strong>{{ planRowTitle(row) }}</strong>
                        <small>{{ planRowSubtitle(row) }}</small>
                    </div>
                    <div class="todo-row__facts">
                        <b>{{ formatMergeAmount(row) }}</b>
                        <em v-if="row.direction">{{ tt(billflowDirectionKey(row.direction)) }}</em>
                    </div>
                    <span class="plan-row-badge">{{ formatMergeSource(row) }}</span>
                </article>
            </template>

            <template v-else>
                <div class="section-copy">
                    <strong>{{ tt('personalFinance.billflow.plan.transactionsTitle') }}</strong>
                    <span>{{ tt('personalFinance.billflow.plan.rowsShown', { count: transactionPlan?.transactions.length ?? 0 }) }}</span>
                </div>
                <article class="todo-row todo-row--plain" :key="transaction.id" v-for="transaction in transactionPlan?.transactions ?? []">
                    <div class="todo-row__copy">
                        <strong>{{ planTransactionTitle(transaction) }}</strong>
                        <small>{{ planTransactionSubtitle(transaction) }}</small>
                    </div>
                    <div class="todo-row__facts">
                        <b>{{ formatPlanTransactionAmount(transaction) }}</b>
                        <em v-if="transaction.direction">{{ tt(billflowDirectionKey(transaction.direction)) }}</em>
                    </div>
                    <div class="plan-transaction-status">
                        <span>{{ tt('personalFinance.billflow.plan.evidenceCount', { count: transaction.evidenceCount }) }}</span>
                        <span class="needs-relation" v-if="transaction.needsRelation">{{ tt('personalFinance.billflow.plan.needsRelation') }}</span>
                        <span class="needs-category" v-else-if="transaction.needsCategory">{{ tt('personalFinance.billflow.plan.needsCategory') }}</span>
                        <span class="is-ready" v-else>{{ tt('personalFinance.billflow.plan.ready') }}</span>
                    </div>
                </article>
            </template>
        </section>

        <section class="work-section" v-if="currentStep === 'others' && task">
            <p class="confirm-hint">{{ tt('personalFinance.billflow.othersHint') }}</p>
            <div class="section-copy">
                <strong>{{ tt('personalFinance.billflow.todos.othersTitle') }}</strong>
                <span v-if="!otherReviewTodos.length">{{ tt('personalFinance.billflow.todos.othersEmpty') }}</span>
            </div>
            <article class="todo-row todo-row--plain" :key="todo.id" v-for="todo in otherReviewTodos">
                <div class="todo-row__copy">
                    <strong>{{ todoTitle(todo) }}</strong>
                    <small v-if="todoMeta(todo)">{{ todoMeta(todo) }}</small>
                </div>
                <div class="todo-row__facts">
                    <b v-if="formatTodoAmount(todo)">{{ formatTodoAmount(todo) }}</b>
                    <em v-if="todo.direction">{{ tt(billflowDirectionKey(todo.direction)) }}</em>
                </div>
                <div class="todo-row__actions">
                    <v-btn density="compact" size="x-small" variant="text" :loading="busy" v-if="isInstallmentTodo(todo.todoKind)" @click="confirmInstallment(todo)">
                        {{ tt('personalFinance.billflow.todos.installment') }}
                    </v-btn>
                    <v-btn density="compact" size="x-small" color="primary" variant="text" :loading="busy" @click="resolveTodo(todo, 'resolved')">
                        {{ tt('personalFinance.billflow.todos.resolve') }}
                    </v-btn>
                    <v-btn density="compact" size="x-small" variant="text" :loading="busy" @click="resolveTodo(todo, 'dismissed')">
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
    <ceb-credit-import-dialog ref="cebCreditImportDialog" @parsed="onParsedBatch" />
    <source-account-dialog ref="sourceAccountDialog" @parsed="onParsedBatch" />
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, useTemplateRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { mdiRefresh, mdiTrayArrowUp } from '@mdi/js';

import AmountInput from '@/components/desktop/AmountInput.vue';
import { useI18n } from '@/locales/helpers.ts';
import { getBrowserTimezoneOffsetMinutes, getCurrentUnixTime, getTimezoneOffsetMinutes, parseDateTimeFromUnixTimeWithBrowserTimezone } from '@/lib/datetime.ts';
import { generateRandomUUID } from '@/lib/misc.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';
import { useAccountsStore } from '@/stores/account.ts';
import { useTransactionCategoriesStore } from '@/stores/transactionCategory.ts';
import { useUserStore } from '@/stores/user.ts';

import { CategoryType } from '@/core/category.ts';
import type { TransactionCategory } from '@/models/transaction_category.ts';

import type { BillflowAccountGroup, BillflowAccountRow, BillflowAccounts, BillflowClassifiedRow, BillflowMergeGroup, BillflowMergeRow, BillflowPlannedTransaction, BillflowTask, BillflowTodo, BillflowTodoStatus, BillflowTransactionPlan, CardCycleAccount } from '../models.ts';
import { todoKindKey } from '../presentation.ts';
import { getSourceTypeKey } from '../../presentation.ts';
import { billflowApi } from '../service.ts';
import {
    BILLFLOW_ACCOUNT_BUCKETS,
    BILLFLOW_OPENING_BALANCE_UNIX_TIME,
    BILLFLOW_WORKBENCH_STEPS,
    accountBucketHintKey,
    accountGroupHasCardHeader,
    billflowDirectionKey,
    billflowWorkbenchStepIndex,
    canAutoRunAfterAccounts,
    canReapplyOrganize,
    canAssignBillflowCategory,
    canOpenBillflowWorkbenchStep,
    chunkBillflowItems,
    createdAccountsNeedingBalance,
    eligibleOrganizeFileIds,
    canEditOrganizeFiles,
    categoryBucketHintKey,
    categoryTodos,
    isInstallmentTodo,
    matchedLedgerAccount,
    mergeBucketHintKey,
    mergeSelectedOrganizeFileIds,
    nextBillflowWorkbenchStep,
    otherTodos,
    previousBillflowWorkbenchStep,
    rememberCreatedLedgerIds,
    resolveAccountBucket,
    resolveBillflowWorkbenchStep,
    resolveCategoryBucket,
    resolveMergeBucket,
    resolveReviewPane,
    reviewPaneHintKey,
    sameOrganizeFileIds,
    suggestedAccountCategory,
    taskAwaitsConfirm,
    taskNeedsAccounts,
    taskShowsTodos,
    type BillflowAccountBucket,
    type BillflowCategoryBucket,
    type BillflowMergeBucket,
    type BillflowReviewPane,
    type BillflowWorkbenchStep
} from '../state.ts';
import { canConfigureCebCreditPdf } from '../../state.ts';
import { usePersonalFinanceStore } from '../../store.ts';
import { todayCivilDate } from '../../dashboard/state.ts';
import CebCreditImportDialog from '../../components/CebCreditImportDialog.vue';
import SourceAccountDialog from '../../components/SourceAccountDialog.vue';

const { tt, formatAmountToLocalizedNumeralsWithCurrency, formatDateTimeToShortDate, formatDateTimeToShortDateTime } = useI18n();
const router = useRouter();
const userStore = useUserStore();
const personalFinanceStore = usePersonalFinanceStore();
const accountsStore = useAccountsStore();
const categoriesStore = useTransactionCategoriesStore();
const fileInput = ref<HTMLInputElement>();
const cebCreditImportDialog = useTemplateRef<InstanceType<typeof CebCreditImportDialog>>('cebCreditImportDialog');
const sourceAccountDialog = useTemplateRef<InstanceType<typeof SourceAccountDialog>>('sourceAccountDialog');
const loading = ref(false);
const busy = ref(false);
const error = ref(false);

function openReconciliation(caseId?: string): void {
    router.push({ path: '/personal-finance/bills', query: { view: 'reconciliation', ...(caseId ? { caseId } : {}) } });
}
const selectedFileIds = ref<string[]>([]);
const previousEligibleIds = ref<string[]>([]);
const task = ref<BillflowTask>();
const accounts = ref<BillflowAccounts>();
const pickedAccountIds = reactive<Record<string, string>>({});
const openTodos = ref<readonly BillflowTodo[]>([]);
const resolvedTodos = ref<readonly BillflowTodo[]>([]);
const dismissedTodos = ref<readonly BillflowTodo[]>([]);
const classifiedRows = ref<readonly BillflowClassifiedRow[]>([]);
const transactionPlan = ref<BillflowTransactionPlan>();
const mergeGroups = computed<readonly BillflowMergeGroup[]>(() => transactionPlan.value?.items ?? []);
const accountRowIndex = ref<Record<string, { sampleRowId: string, skipped: boolean, row: BillflowAccountRow }>>({});
const selectedTodoIds = ref<string[]>([]);
const categoryDrafts = reactive<Record<string, string>>({});
const counterpartAccountDrafts = reactive<Record<string, string>>({});
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
const mergeBucket = ref<BillflowMergeBucket>('pending');
const userPickedMergeBucket = ref(false);
const reviewPane = ref<BillflowReviewPane>('transactions');
const userPickedReviewPane = ref(false);

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
const canEditFiles = computed(() => !task.value || canEditOrganizeFiles(task.value.status));
const taskMemberFileIds = computed(() => taskFiles.value.map(file => file.fileId));
const stepInput = computed(() => ({
    hasTask: !!task.value,
    status: task.value?.status,
    needsCreateCount: accounts.value?.needsCreate.length ?? 0,
    needsBalanceCount: newBalanceAccounts.value.length
}));
const currentStep = computed(() => resolveBillflowWorkbenchStep(userStep.value, stepInput.value));
const currentStepIndex = computed(() => billflowWorkbenchStepIndex(currentStep.value));
const reviewTodos = computed(() => categoryTodos(openTodos.value));
const classifiedReviewRows = computed(() => classifiedRows.value.filter(row => !isRowSkipped(row.id)));
const pendingMergeGroups = computed(() => mergeGroups.value.filter(group => group.status === 'pending' || group.status === 'action_required'));
const processedMergeGroups = computed(() => mergeGroups.value.filter(group => group.status !== 'pending' && group.status !== 'action_required'));
const activeMergeGroups = computed(() => mergeBucket.value === 'merged' ? processedMergeGroups.value : pendingMergeGroups.value);
const mergeHasItemColumn = computed(() => activeMergeGroups.value.some(group => mergeGroupRows(group).some(row => !!row.item)));
const mergeColumnCount = computed(() => mergeHasItemColumn.value ? 10 : 9);
const otherReviewTodos = computed(() => otherTodos(openTodos.value));
const blockingTodos = computed(() => openTodos.value.filter(todo => todo.todoKind !== 'uncategorized'));
const skippedOrphanRows = computed(() => {
    const known = new Set([
        ...openTodos.value,
        ...resolvedTodos.value,
        ...dismissedTodos.value
    ].filter(todo => todo.subjectKind === 'raw_row').map(todo => todo.subjectId));
    return Object.values(accountRowIndex.value)
        .filter(item => item.skipped && !known.has(item.row.id))
        .map(item => item.row);
});
const assignableReviewTodos = computed(() => reviewTodos.value.filter(todo => todo.status === 'open' && canAssignBillflowCategory(todo.todoKind) && !isRowSkipped(todo.subjectId)));
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
    pending: transactionPlan.value?.categoryReviewCount ?? reviewTodos.value.length,
    classified: classifiedReviewRows.value.length
}));
const mergeBucketCounts = computed(() => ({
    pending: pendingMergeGroups.value.length,
    merged: processedMergeGroups.value.length
}));
const reviewPaneInput = computed(() => ({
    awaitingRun: !!task.value && canAutoRunAfterAccounts(task.value.status, accounts.value?.needsCreate.length ?? 0),
    mergePending: pendingMergeGroups.value.length,
    categoryPending: reviewTodos.value.length + skippedOrphanRows.value.length
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
        if (taskNeedsAccounts(task.value.status, pendingCount) && pendingCount > 0) {
            return {
                hint: tt('personalFinance.billflow.next.accounts', { count: pendingCount }),
                label: tt('personalFinance.billflow.step.next'),
                run: async (): Promise<void> => {},
                disabled: true
            };
        }
    }
    if (currentStep.value === 'review' && task.value && canAutoRunAfterAccounts(task.value.status, pendingCount)) {
        return {
            hint: tt('personalFinance.billflow.next.merge'),
            label: tt('personalFinance.billflow.run'),
            run: runTask
        };
    }
    if (currentStep.value === 'review' && task.value && pendingMergeGroups.value.length > 0) {
        return {
            hint: tt('personalFinance.billflow.next.mergeBlocked', { count: pendingMergeGroups.value.length }),
            label: tt('personalFinance.billflow.step.next'),
            run: async (): Promise<void> => {},
            disabled: true
        };
    }
    if (currentStep.value === 'others' && task.value && otherReviewTodos.value.length > 0) {
        return {
            hint: tt('personalFinance.billflow.next.othersBlocked', { count: otherReviewTodos.value.length }),
            label: tt('personalFinance.billflow.step.next'),
            run: async (): Promise<void> => {},
            disabled: true
        };
    }
    if (currentStep.value === 'confirm' && task.value && taskAwaitsConfirm(task.value.status)) {
        return {
            hint: blockingTodos.value.length
                ? tt('personalFinance.billflow.next.reviewBlocked', { count: blockingTodos.value.length })
                : tt('personalFinance.billflow.next.confirm'),
            label: tt('personalFinance.billflow.confirmPost'),
            run: confirmPost,
            disabled: blockingTodos.value.length > 0
        };
    }
    return undefined;
});
const canAdvanceWithoutAction = computed(() => {
    if (currentStep.value === 'files') {
        return !!task.value && (!canEditFiles.value || selectedFileIds.value.length > 0);
    }
    if (currentStep.value === 'accounts') {
        return !!task.value && (accounts.value?.needsCreate.length ?? 0) < 1;
    }
    if (currentStep.value === 'review') {
        return !!task.value
            && !canAutoRunAfterAccounts(task.value.status, accounts.value?.needsCreate.length ?? 0)
            && pendingMergeGroups.value.length < 1
            && canOpenStep('others');
    }
    if (currentStep.value === 'others') {
        return otherReviewTodos.value.length < 1 && canOpenStep('confirm');
    }
    return false;
});
const canGoForward = computed(() => (!!stepAction.value && !stepAction.value.disabled) || canAdvanceWithoutAction.value);
const forwardLabel = computed(() => stepAction.value?.label ?? tt('personalFinance.billflow.step.next'));
const forwardHint = computed(() => {
    if (stepAction.value?.hint) {
        return stepAction.value.hint;
    }
    if (currentStep.value === 'accounts') {
        return tt('personalFinance.billflow.next.accountsReady');
    }
    if (currentStep.value === 'review' && pendingMergeGroups.value.length > 0) {
        return tt('personalFinance.billflow.next.mergeBlocked', { count: pendingMergeGroups.value.length });
    }
    if (currentStep.value === 'review') {
        return tt('personalFinance.billflow.next.review');
    }
    if (currentStep.value === 'others' && otherReviewTodos.value.length > 0) {
        return tt('personalFinance.billflow.next.othersBlocked', { count: otherReviewTodos.value.length });
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

watch([currentStep, mergeBucketCounts], () => {
    if (currentStep.value !== 'review') {
        userPickedMergeBucket.value = false;
        return;
    }
    mergeBucket.value = resolveMergeBucket(mergeBucket.value, mergeBucketCounts.value, userPickedMergeBucket.value);
}, { immediate: true });

watch([currentStep, reviewPaneInput], () => {
    if (currentStep.value !== 'review') {
        userPickedReviewPane.value = false;
        return;
    }
    reviewPane.value = resolveReviewPane(reviewPane.value, reviewPaneInput.value, userPickedReviewPane.value);
}, { immediate: true });

function canOpenStep(step: BillflowWorkbenchStep): boolean {
    if (!canOpenBillflowWorkbenchStep(step, stepInput.value)) {
        return false;
    }
    if (!task.value || !(taskAwaitsConfirm(task.value.status) || task.value.status === 'ready' || task.value.status === 'failed')) {
        return true;
    }
    if (step === 'others' && pendingMergeGroups.value.length > 0) {
        return false;
    }
    if (step === 'confirm' && blockingTodos.value.length > 0) {
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

function setReviewPane(value: unknown): void {
    if (value !== 'evidence' && value !== 'transactions' && value !== 'merge' && value !== 'relations' && value !== 'category') {
        return;
    }
    userPickedReviewPane.value = true;
    reviewPane.value = value;
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
    if (currentStep.value === 'files') {
        if (!task.value) {
            if (!stepAction.value || stepAction.value.disabled) {
                return;
            }
            if (!await createTask()) {
                return;
            }
            userStep.value = 'accounts';
            return;
        }
        if (canEditFiles.value) {
            if (selectedFileIds.value.length < 1) {
                return;
            }
            if (!sameOrganizeFileIds(selectedFileIds.value, taskMemberFileIds.value)) {
                if (!await replaceTaskFiles()) {
                    return;
                }
            }
        }
        userStep.value = 'accounts';
        return;
    }
    if (currentStep.value === 'accounts') {
        if (stepAction.value) {
            if (stepAction.value.disabled) {
                return;
            }
            await stepAction.value.run();
            userStep.value = 'accounts';
            return;
        }
        if ((accounts.value?.needsCreate.length ?? 0) > 0) {
            return;
        }
        userStep.value = 'review';
        return;
    }
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

function formatAccountCardLimit(group: BillflowAccountGroup): string {
    return group.creditLimitAmount
        ? formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(group.creditLimitAmount), group.creditLimitCurrency || group.currency || 'CNY')
        : '';
}

function balanceAccountFor(group: BillflowAccountGroup) {
    if (!group.ledgerAccountId) {
        return undefined;
    }
    return newBalanceAccounts.value.find(account => account.ledgerAccountId === group.ledgerAccountId);
}

function isRowSkipped(rowId?: string): boolean {
    return !!rowId && !!accountRowIndex.value[rowId]?.skipped;
}

function canSkipRow(rowId?: string): boolean {
    return !!rowId && !!accountRowIndex.value[rowId];
}

function canSkipTodo(todo: BillflowTodo): boolean {
    return todo.subjectKind === 'raw_row' && canSkipRow(todo.subjectId);
}

async function loadAccountRowIndex(taskId: string): Promise<void> {
    const groups = accounts.value?.reused ?? [];
    const entries = await Promise.all(groups.map(async group => {
        const rows = await billflowApi.listAccountRows(taskId, group.sampleRowId);
        return rows.map(row => [row.id, { sampleRowId: group.sampleRowId, skipped: row.skipped, row }] as const);
    }));
    const index: Record<string, { sampleRowId: string, skipped: boolean, row: BillflowAccountRow }> = {};
    for (const pair of entries.flat()) {
        index[pair[0]] = pair[1];
    }
    accountRowIndex.value = index;
}

async function mutateAccountRow(rowId: string, skip: boolean): Promise<void> {
    if (!task.value) {
        return;
    }
    const sampleRowId = accountRowIndex.value[rowId]?.sampleRowId;
    if (!sampleRowId) {
        return;
    }
    const request = {
        taskId: task.value.id,
        expectedVersion: task.value.version,
        sampleRowId,
        rowIds: [rowId],
        idempotencyKey: generateRandomUUID()
    };
    accounts.value = skip
        ? await billflowApi.skipAccountRows(request)
        : await billflowApi.restoreAccountRows(request);
}

async function toggleSkipRow(rowId: string): Promise<void> {
    if (!task.value || !canSkipRow(rowId)) {
        return;
    }
    busy.value = true;
    try {
        await mutateAccountRow(rowId, !isRowSkipped(rowId));
        await openTask(task.value.id);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function toggleSkipTodo(todo: BillflowTodo): Promise<void> {
    if (!task.value || !canSkipTodo(todo)) {
        return;
    }
    const skip = !isRowSkipped(todo.subjectId);
    busy.value = true;
    try {
        await mutateAccountRow(todo.subjectId, skip);
        if (skip && todo.status === 'open') {
            await billflowApi.resolveTodo(todo.id, todo.version, 'dismissed', generateRandomUUID());
        } else if (!skip && todo.status !== 'open') {
            await billflowApi.resolveTodo(todo.id, todo.version, 'open', generateRandomUUID());
        }
        await openTask(task.value.id);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

function formatTodoAmount(todo: BillflowTodo): string {
    return formatMergeAmount(todo);
}

function formatTodoTime(todo: BillflowTodo): string {
    return todo.unixTime ? formatDateTimeToShortDateTime(parseDateTimeFromUnixTimeWithBrowserTimezone(todo.unixTime)) : '';
}

type MergeLineSource = {
    sourceType?: string;
    account?: string;
    label?: string;
    item?: string;
    billType?: string;
    amount?: string;
    currency?: string;
    unixTime?: number;
    orderId?: string;
    merchantOrderId?: string;
    direction?: string;
};

function formatMergeAmount(row: MergeLineSource): string {
    return row.amount ? formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(row.amount), row.currency || 'CNY') : '';
}

function formatMergeSource(row: MergeLineSource): string {
    if (row.sourceType === 'alipay' || row.sourceType === 'wechat' || row.sourceType === 'bank') {
        return tt(getSourceTypeKey(row.sourceType));
    }
    return '';
}

function formatMergeTime(row: MergeLineSource): string {
    if (!row.unixTime) {
        return '';
    }
    const dateTime = parseDateTimeFromUnixTimeWithBrowserTimezone(row.unixTime);
    if (row.sourceType === 'bank' || (dateTime.getHour() === 0 && dateTime.getMinute() === 0 && dateTime.getSecond() === 0)) {
        return formatDateTimeToShortDate(dateTime);
    }
    return formatDateTimeToShortDateTime(dateTime);
}

function mergeOrderId(row: MergeLineSource): string {
    return row.merchantOrderId || row.orderId || '';
}

function mergeGroupRows(group: BillflowMergeGroup): readonly BillflowMergeRow[] {
    return group.rows;
}

function planRowTitle(row: BillflowMergeRow): string {
    return row.label || row.item || row.account || tt('personalFinance.billflow.plan.evidence');
}

function planRowSubtitle(row: BillflowMergeRow): string {
    return [formatMergeSource(row), row.account, row.item, row.billType, formatMergeTime(row)]
        .filter((part): part is string => !!part && part !== planRowTitle(row))
        .filter((part, index, parts) => parts.indexOf(part) === index)
        .join(' · ');
}

function planTransactionTitle(transaction: BillflowPlannedTransaction): string {
    return transaction.label || transaction.item || transaction.account || tt('personalFinance.billflow.plan.transactions');
}

function planTransactionSubtitle(transaction: BillflowPlannedTransaction): string {
    return [formatMergeSource(transaction), transaction.account, transaction.item, transaction.billType, formatMergeTime(transaction)]
        .filter((part): part is string => !!part && part !== planTransactionTitle(transaction))
        .filter((part, index, parts) => parts.indexOf(part) === index)
        .join(' · ');
}

function formatPlanTransactionAmount(transaction: BillflowPlannedTransaction): string {
    return formatMergeAmount(transaction);
}

function formatBillChannel(sourceType: string | undefined, account: string | undefined): string {
    if (sourceType === 'bank' && account) {
        return account;
    }
    if (sourceType === 'alipay' || sourceType === 'wechat' || sourceType === 'bank') {
        return tt(getSourceTypeKey(sourceType));
    }
    return account || '';
}

function todoTitle(todo: BillflowTodo): string {
    const label = todo.label || todo.item || tt(todoKindKey(todo.todoKind));
    const channel = formatBillChannel(todo.sourceType, todo.account);
    if (todo.todoKind === 'cross_source_ambiguous' && channel) {
        return channel + ' - ' + label;
    }
    return label;
}

function todoSubtitle(todo: BillflowTodo): string {
    const title = todoTitle(todo);
    return [todo.item, todo.billType, formatTodoTime(todo)]
        .filter((part): part is string => !!part && part !== title)
        .filter((part, index, parts) => parts.indexOf(part) === index)
        .join(' · ');
}

function todoMeta(todo: BillflowTodo): string {
    return [todoSubtitle(todo), tt(todoKindKey(todo.todoKind))]
        .filter((part): part is string => !!part)
        .filter((part, index, parts) => parts.indexOf(part) === index)
        .join(' · ');
}

function classifiedTitle(row: BillflowClassifiedRow): string {
    return row.label || row.item || row.billType;
}

function classifiedSubtitle(row: BillflowClassifiedRow): string {
    const title = classifiedTitle(row);
    return [row.item, row.billType, row.unixTime ? formatDateTimeToShortDateTime(parseDateTimeFromUnixTimeWithBrowserTimezone(row.unixTime)) : '']
        .filter((part): part is string => !!part && part !== title)
        .filter((part, index, parts) => parts.indexOf(part) === index)
        .join(' · ');
}

function formatClassifiedAmount(row: BillflowClassifiedRow): string {
    return row.amount ? formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(row.amount), row.currency || 'CNY') : '';
}

function classifiedCategoryLabel(row: BillflowClassifiedRow): string {
    return categoryName(row.categoryId);
}

function categoryName(categoryId?: string): string {
    if (!categoryId) {
        return '';
    }
    for (const type of [CategoryType.Expense, CategoryType.Income, CategoryType.Transfer]) {
        const match = flattenCategoryOptions(type).find(option => option.value === categoryId);
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

function counterpartAccountOptions(todo: BillflowTodo): { title: string, value: string }[] {
    return accountsStore.allVisiblePlainAccounts
        .filter(account => account.id !== todo.ledgerAccountId && (!todo.currency || account.currency === todo.currency))
        .map(account => ({ title: account.name, value: account.id }));
}

function setCounterpartAccount(todoId: string, value: unknown): void {
    if (typeof value !== 'string') {
        return;
    }
    counterpartAccountDrafts[todoId] = value;
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

async function reload(): Promise<void> {
    loading.value = true;
    error.value = false;
    try {
        await Promise.all([
            personalFinanceStore.loadBatches(0, 50),
            accountsStore.loadAllAccounts({ force: true }),
            categoriesStore.loadAllCategories({ force: false })
        ]);
        const [pending, receiving, awaiting, ready, failed] = await Promise.all([
            billflowApi.listTasks('accounts_pending'),
            billflowApi.listTasks('receiving'),
            billflowApi.listTasks('awaiting_confirm'),
            billflowApi.listTasks('ready'),
            billflowApi.listTasks('failed')
        ]);
        const current = pending.items[0] ?? receiving.items[0] ?? awaiting.items[0] ?? ready.items[0] ?? failed.items[0] ?? task.value;
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
    await applyUniqueMatchedAccounts(taskId);
    if (taskShowsTodos(task.value.status)) {
        const [open, resolved, dismissed, classified, groups] = await Promise.all([
            billflowApi.listAllTodos(taskId, 'open'),
            billflowApi.listAllTodos(taskId, 'resolved'),
            billflowApi.listAllTodos(taskId, 'dismissed'),
            billflowApi.listClassifiedRows(taskId),
            billflowApi.listMergeGroups(taskId)
        ]);
        openTodos.value = open;
        resolvedTodos.value = resolved;
        dismissedTodos.value = dismissed;
        classifiedRows.value = classified;
        transactionPlan.value = groups;
        selectedTodoIds.value = selectedTodoIds.value.filter(id => openTodos.value.some(todo => todo.id === id));
        await loadAccountRowIndex(taskId);
    } else {
        openTodos.value = [];
        resolvedTodos.value = [];
        dismissedTodos.value = [];
        classifiedRows.value = [];
        transactionPlan.value = undefined;
        accountRowIndex.value = {};
    }
    syncTaskFileSelection();
}

function syncTaskFileSelection(): void {
    if (!task.value || !canEditOrganizeFiles(task.value.status)) {
        return;
    }
    selectedFileIds.value = [...new Set(task.value.members.map(member => member.fileId))];
    previousEligibleIds.value = eligibleFiles.value.map(file => file.fileId);
}

async function upload(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length < 1) return;
    busy.value = true;
    error.value = false;
    try {
        for (const file of files) {
            const result = await personalFinanceStore.uploadFile(file);
            if (canConfigureCebCreditPdf(result.file)) {
                cebCreditImportDialog.value?.open({
                    fileId: result.file.id,
                    currency: userStore.currentUserDefaultCurrency,
                    timezoneUtcOffset: getTimezoneOffsetMinutes(getCurrentUnixTime()),
                    reasonCode: 'initial_upload_ceb_fallback'
                });
                continue;
            }
            await parseUploadedFile(result.file.id);
        }
        await personalFinanceStore.loadBatches(0, 50);
    } catch {
        error.value = true;
        await personalFinanceStore.loadBatches(0, 50).catch(() => undefined);
    } finally {
        busy.value = false;
    }
}

async function parseUploadedFile(fileId: string): Promise<void> {
    const timezoneUtcOffset = getTimezoneOffsetMinutes(getCurrentUnixTime());
    const result = await personalFinanceStore.reparseFile({
        fileId,
        currency: userStore.currentUserDefaultCurrency,
        timezoneUtcOffset,
        reasonCode: 'initial_upload'
    });
    if (result.requiresSourceAccount && result.discovery) {
        sourceAccountDialog.value?.open({
            fileId,
            discovery: result.discovery,
            currency: userStore.currentUserDefaultCurrency,
            timezoneUtcOffset
        });
        return;
    }
    if (result.batch?.id) {
        await selectParsedFile(result.batch.id);
    }
}

async function onParsedBatch(batchId: string): Promise<void> {
    busy.value = true;
    error.value = false;
    try {
        await selectParsedFile(batchId);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function selectParsedFile(batchId: string): Promise<void> {
    await personalFinanceStore.loadBatches(0, 50);
    const fileId = personalFinanceStore.batches.find(batch => batch.id === batchId)?.fileId;
    if (fileId && !selectedFileIds.value.includes(fileId)) {
        selectedFileIds.value = [...selectedFileIds.value, fileId];
    }
    userStep.value = 'files';
}

async function replaceTaskFiles(): Promise<boolean> {
    if (!task.value || selectedFileIds.value.length < 1) {
        return false;
    }
    busy.value = true;
    error.value = false;
    try {
        const updated = await billflowApi.replaceTaskFiles(task.value.id, task.value.version, selectedFileIds.value, generateRandomUUID());
        task.value = updated;
        restoreBalanceMemory(updated.id);
        await openTask(updated.id);
        accountBucket.value = 'pending';
        userPickedBucket.value = false;
        return true;
    } catch {
        error.value = true;
        return false;
    } finally {
        busy.value = false;
    }
}

async function createTask(): Promise<boolean> {
    busy.value = true;
    try {
        const created = await billflowApi.createTask(selectedFileIds.value, generateRandomUUID());
        task.value = created;
        restoreBalanceMemory(created.id);
        await openTask(created.id);
        userStep.value = 'files';
        return true;
    } catch {
        error.value = true;
        return false;
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

async function applyUniqueMatchedAccounts(taskId: string): Promise<void> {
    const groups = (accounts.value?.needsCreate ?? []).filter(group => !!matchedAccount(group));
    if (groups.length < 1) {
        return;
    }
    for (const group of groups) {
        const accountId = matchedAccount(group)?.id;
        if (!accountId) {
            continue;
        }
        const current = await billflowApi.getTask(taskId);
        accounts.value = await billflowApi.overrideAccount({
            taskId: current.id,
            expectedVersion: current.version,
            sampleRowId: group.sampleRowId,
            ledgerAccountId: accountId,
            idempotencyKey: generateRandomUUID()
        });
        delete pickedAccountIds[group.sampleRowId];
    }
    task.value = await billflowApi.getTask(taskId);
    accounts.value = await billflowApi.getAccounts(taskId);
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
    if (!task.value || blockingTodos.value.length > 0) return;
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

async function restoreClassifiedRow(row: BillflowClassifiedRow): Promise<void> {
    if (!row.todoId || row.version === undefined) {
        return;
    }
    busy.value = true;
    try {
        await billflowApi.resolveTodo(row.todoId, row.version, 'open', generateRandomUUID());
        if (task.value) await openTask(task.value.id);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function assignTodos(todos: readonly BillflowTodo[], categoryId: string): Promise<void> {
    if (!categoryId || todos.length < 1) {
        return;
    }
    busy.value = true;
    try {
        for (const chunk of chunkBillflowItems(todos.map(todo => ({ todoId: todo.id, expectedVersion: todo.version })))) {
            await billflowApi.assignTodoCategories(chunk, categoryId, generateRandomUUID());
        }
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

async function assignCounterpartAccount(todo: BillflowTodo): Promise<void> {
    const accountId = counterpartAccountDrafts[todo.id];
    if (!accountId) {
        return;
    }
    busy.value = true;
    try {
        await billflowApi.assignTodoCounterpartAccount(todo.id, todo.version, accountId, generateRandomUUID());
        delete counterpartAccountDrafts[todo.id];
        if (task.value) await openTask(task.value.id);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
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
    padding: 10px 16px;
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
    gap: 5px;
    min-height: 34px;
    padding: 4px 4px;
    border: 0;
    background: var(--task-paper);
    color: rgba(var(--v-theme-on-surface), 0.55);
    font-size: 0.72rem;
    cursor: pointer;
}

.step-rail button span {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 999px;
    background: rgba(var(--v-theme-on-surface), 0.08);
    font-size: 0.68rem;
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
    margin: 0 0 8px;
    color: rgba(var(--v-theme-on-surface), 0.62);
    font-size: 0.78rem;
    line-height: 1.4;
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

.transaction-plan-summary {
    display: grid;
    grid-template-columns: minmax(112px, 1fr) auto minmax(112px, 1fr) auto minmax(140px, 1.2fr) minmax(112px, 1fr) minmax(112px, 1fr);
    align-items: stretch;
    gap: 8px;
    margin-bottom: 16px;
}

.transaction-plan-summary article,
.transaction-plan-card {
    display: grid;
    gap: 2px;
    padding: 12px 14px;
    border: 1px solid var(--task-rule);
    border-radius: 12px;
    background: color-mix(in srgb, var(--task-paper) 92%, var(--task-mint));
    text-align: left;
}

.transaction-plan-card {
    width: 100%;
    color: inherit;
    font: inherit;
    cursor: pointer;
    transition: border-color 160ms ease, background-color 160ms ease, transform 160ms ease;
}

.transaction-plan-card:hover {
    border-color: color-mix(in srgb, var(--v-theme-primary) 48%, var(--task-rule));
    transform: translateY(-1px);
}

.transaction-plan-card:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--v-theme-primary) 30%, transparent);
    outline-offset: 2px;
}

.transaction-plan-card--active {
    border-color: var(--task-ink);
    background: var(--task-mint);
    box-shadow: inset 0 -3px 0 color-mix(in srgb, var(--v-theme-primary) 72%, var(--task-ink));
}

.transaction-plan-summary strong,
.transaction-plan-card strong {
    color: var(--task-ink);
    font-size: 1.55rem;
    line-height: 1;
    font-variant-numeric: tabular-nums;
}

.transaction-plan-summary span,
.transaction-plan-card span {
    color: rgba(var(--v-theme-on-surface), 0.58);
    font-size: 0.74rem;
}

.transaction-plan-summary__primary {
    border-color: color-mix(in srgb, var(--v-theme-primary) 42%, var(--task-rule)) !important;
    background: var(--task-mint) !important;
}

.transaction-plan-summary__operator {
    align-self: center;
    font-size: 1.4rem !important;
}

.transaction-plan-summary__explanation {
    margin: -6px 0 16px;
    padding: 10px 14px;
    border-left: 3px solid var(--v-theme-primary);
    background: color-mix(in srgb, var(--task-mint) 58%, transparent);
    color: rgba(var(--v-theme-on-surface), 0.72);
    font-size: 0.84rem;
    line-height: 1.55;
}

.bucket-bar {
    display: grid;
    gap: 6px;
    margin-bottom: 8px;
}

.pane-bar {
    margin-bottom: 14px;
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

.reused-item .card-header-facts,
.account-row-card__name .card-header-facts {
    flex-basis: 100%;
    margin-top: 4px;
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
    align-items: start;
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
    min-width: 120px;
    max-width: 168px;
}

.todo-row {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto minmax(120px, 168px) auto;
    align-items: center;
    gap: 4px 8px;
    min-height: 32px;
    padding: 3px 0;
    border-bottom: 1px solid var(--task-rule);
}

.todo-row--done,
.todo-row--plain {
    grid-template-columns: minmax(0, 1fr) auto auto auto;
}

.merge-table-wrap {
    overflow-x: auto;
    margin: 0 -4px;
}

.merge-table {
    width: 100%;
    min-width: 920px;
    border-collapse: collapse;
    font-size: 0.75rem;
    line-height: 1.35;
}

.merge-table th,
.merge-table td {
    padding: 6px 8px;
    text-align: left;
    vertical-align: top;
    overflow-wrap: anywhere;
}

.merge-table th {
    position: sticky;
    top: 0;
    z-index: 1;
    color: rgba(var(--v-theme-on-surface), 0.55);
    font-size: 0.7rem;
    font-weight: 600;
    white-space: nowrap;
    background: var(--task-paper);
    border-bottom: 1px solid var(--task-rule);
}

.merge-table td.is-num {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    font-weight: 650;
}

.merge-table td.is-id {
    max-width: 168px;
    color: rgba(var(--v-theme-on-surface), 0.62);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.68rem;
}

.merge-group__gap td {
    height: 10px;
    padding: 0;
    border: 0;
    background: transparent;
}

.merge-group__bar td {
    padding: 4px 8px;
    background: var(--task-mint);
    border: 1px solid color-mix(in srgb, var(--task-ink) 16%, var(--task-rule));
    border-bottom: 0;
    border-radius: 8px 8px 0 0;
}

.merge-group__bar-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--task-ink);
    font-size: 0.72rem;
    font-weight: 650;
}

.merge-group__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
}

.merge-group__row td,
.merge-group__note td {
    background: color-mix(in srgb, var(--task-mint) 28%, var(--task-paper));
    border-top: 1px dashed var(--task-rule);
    border-bottom: 0;
    border-left: 1px solid color-mix(in srgb, var(--task-ink) 16%, var(--task-rule));
    border-right: 1px solid color-mix(in srgb, var(--task-ink) 16%, var(--task-rule));
}

.merge-group__row td:first-child,
.merge-group__note td:first-child,
.merge-group__bar td {
    border-left-width: 3px;
    border-left-color: var(--task-ink);
}

.merge-group__bar + .merge-group__row td {
    border-top: 0;
}

.merge-group tr:last-child td {
    border-bottom: 1px solid color-mix(in srgb, var(--task-ink) 16%, var(--task-rule));
}

.merge-group tr:last-child td:first-child {
    border-bottom-left-radius: 8px;
}

.merge-group tr:last-child td:last-child {
    border-bottom-right-radius: 8px;
}

.merge-group__note td {
    color: rgba(var(--v-theme-on-surface), 0.58);
    font-size: 0.72rem;
}

.todo-skip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    color: rgba(var(--v-theme-on-surface), 0.58);
    font-size: 0.72rem;
    white-space: nowrap;
}

.todo-row__check {
    display: flex;
}

.todo-row__copy {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 8px;
    min-width: 0;
}

.todo-row__copy strong,
.todo-row__facts b {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8rem;
    line-height: 1.25;
    font-weight: 600;
}

.todo-row__copy small,
.todo-row__facts em,
.todo-row__facts span {
    color: rgba(var(--v-theme-on-surface), 0.52);
    font-size: 0.7rem;
    font-style: normal;
    white-space: nowrap;
}

.todo-row__facts {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}

.todo-row__actions {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    justify-content: flex-end;
    gap: 0;
}

.todo-row__actions :deep(.v-btn) {
    min-width: 0;
    min-height: 22px;
    height: 22px;
    padding: 0 6px;
    margin: 0;
    font-size: 0.72rem;
}

.plan-row-badge,
.plan-transaction-status {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
    color: rgba(var(--v-theme-on-surface), 0.58);
    font-size: 0.72rem;
}

.plan-transaction-status span {
    padding: 2px 7px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--task-rule) 42%, transparent);
}

.plan-transaction-status .needs-relation {
    color: rgb(var(--v-theme-error));
    background: color-mix(in srgb, rgb(var(--v-theme-error)) 10%, transparent);
}

.plan-transaction-status .needs-category {
    color: rgb(var(--v-theme-warning));
    background: color-mix(in srgb, rgb(var(--v-theme-warning)) 12%, transparent);
}

.plan-transaction-status .is-ready {
    color: var(--task-ink);
    background: var(--task-mint);
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
    color: rgba(var(--v-theme-on-surface), 0.55);
    font-size: 0.78rem;
}

.card-header-facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 8px 16px;
    margin: 8px 0 0;
}

.card-header-facts dt {
    color: rgba(var(--v-theme-on-surface), 0.55);
    font-size: 0.72rem;
}

.card-header-facts dd {
    margin: 0;
    font-size: 0.92rem;
    font-variant-numeric: tabular-nums;
}

.card-header-copy {
    margin: 6px 0 0;
    color: rgba(var(--v-theme-on-surface), 0.58);
    font-size: 0.75rem;
    line-height: 1.4;
}

.account-balance {
    display: grid;
    gap: 8px;
    margin-top: 8px;
    max-width: 280px;
}

.account-row-card__main--skip {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
}

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
        grid-template-columns: repeat(4, minmax(0, 1fr));
    }

    .account-row-card__main {
        grid-template-columns: 1fr;
    }

    .transaction-plan-summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .transaction-plan-summary__operator {
        display: none;
    }

    .account-card__head,
    .next-bar {
        align-items: flex-start;
        flex-direction: column;
    }
}

@media (max-width: 640px) {
    .todo-row,
    .todo-row--done,
    .todo-row--plain {
        grid-template-columns: minmax(0, 1fr) auto;
    }

    .todo-row__actions,
    .todo-row__select {
        grid-column: 1 / -1;
        justify-content: flex-end;
    }
}
</style>
