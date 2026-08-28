<template>
    <main-page-layout :no-navbar="true">
        <template #content>
            <v-window class="d-flex flex-grow-1 disable-tab-transition w-100-window-container" v-model="activeTab">
                <v-window-item value="transactionPage">
                    <v-card min-height="920">
                        <template #title>
                            <div class="transaction-toolbar d-flex align-center ga-3">
                                <div class="transaction-toolbar-leading d-flex align-center ga-3 text-no-wrap">
                                    <span>{{ tt('Transaction Details') }}</span>
                                </div>
                                <div class="transaction-period-summary d-flex align-center ga-2"
                                     v-if="showTotalAmountInTransactionListPage && currentMonthTotalAmount">
                                    <span>{{ queryAllFilterAccountIdsCount ? tt('Total Inflows') : tt('Total Income') }}</span>
                                    <span class="text-income" v-if="loading">
                                        <v-skeleton-loader type="text" width="60" :loading="true" />
                                    </span>
                                    <span class="text-income" v-else>
                                        {{ currentMonthTotalAmount.income }}
                                        <v-tooltip activator="parent" v-if="!currentMonthTotalAmount.incomeIsZero && currentMonthTotalAmount.incomeInDefaultCurrency !== currentMonthTotalAmount.income">
                                            {{ currentMonthTotalAmount.incomeInDefaultCurrency }}
                                        </v-tooltip>
                                    </span>
                                    <span class="ms-2">{{ queryAllFilterAccountIdsCount ? tt('Total Outflows') : tt('Total Expense') }}</span>
                                    <span class="text-expense" v-if="loading">
                                        <v-skeleton-loader type="text" width="60" :loading="true" />
                                    </span>
                                    <span class="text-expense" v-else>
                                        {{ currentMonthTotalAmount.expense }}
                                        <v-tooltip activator="parent" v-if="!currentMonthTotalAmount.expenseIsZero && currentMonthTotalAmount.expenseInDefaultCurrency !== currentMonthTotalAmount.expense">
                                            {{ currentMonthTotalAmount.expenseInDefaultCurrency }}
                                        </v-tooltip>
                                    </span>
                                </div>
                                <div class="transaction-toolbar-actions d-flex align-center ga-2 ms-auto">
                                    <v-select class="transaction-date-range-filter" density="compact" hide-details
                                              :aria-label="tt('Date Range')" :prepend-inner-icon="mdiCalendarMonthOutline"
                                              item-title="displayName" item-value="value"
                                              :disabled="loading" :items="recentDateRangeOptions"
                                              v-model="recentDateRangeIndex" />
                                    <v-select class="transaction-type-filter" density="compact" hide-details
                                              item-title="displayName" item-value="type" :disabled="loading"
                                              :items="[
                                                  { displayName: tt('All Types'), type: 0 },
                                                  { displayName: tt('Modify Balance'), type: 1 },
                                                  { displayName: tt('Income'), type: 2 },
                                                  { displayName: tt('Expense'), type: 3 },
                                                  { displayName: tt('Transfer'), type: 4 }
                                              ]" v-model="queryType" />
                                    <div class="transaction-keyword-filter">
                                    <v-text-field density="compact" :disabled="loading"
                                                  :prepend-inner-icon="mdiMagnify"
                                                  :append-inner-icon="searchKeyword !== query.keyword ? mdiCheck : undefined"
                                                  :placeholder="tt('Search transaction description')"
                                                  v-model="searchKeyword"
                                                  @click:append-inner="changeKeywordFilter(searchKeyword)"
                                                  @keyup.enter="changeKeywordFilter(searchKeyword)"
                                    />
                                    </div>
                                    <v-btn density="compact" color="default" variant="text"
                                           :icon="true" :loading="loading" @click="reload(true, false)">
                                        <template #loader>
                                            <v-progress-circular indeterminate size="20"/>
                                        </template>
                                        <v-icon :icon="mdiRefresh" size="24" />
                                        <v-tooltip activator="parent">{{ tt('Refresh') }}</v-tooltip>
                                    </v-btn>
                                    <v-btn density="compact" color="default" variant="text"
                                           :disabled="loading" :icon="true">
                                        <v-icon :icon="mdiDotsVertical" size="24" />
                                        <v-tooltip activator="parent">{{ tt('More') }}</v-tooltip>
                                        <v-menu activator="parent" location="bottom end" max-height="500">
                                            <v-list>
                                                <v-list-item key="AIClipboardTextRecognition"
                                                             :title="tt('AI Clipboard Text Recognition')"
                                                             :prepend-icon="mdiMagicStaff"
                                                             v-if="isTransactionFromAITextRecognitionEnabled()"
                                                             @click="addByRecognizingClipboardText" />
                                                <v-list-item key="AIImageRecognition"
                                                             :title="tt('AI Image Recognition')"
                                                             :prepend-icon="mdiMagicStaff"
                                                             v-if="isTransactionFromAIImageRecognitionEnabled()"
                                                             @click="addByRecognizingImage" />
                                                <v-divider class="my-2" v-if="isTransactionFromAITextRecognitionEnabled() || isTransactionFromAIImageRecognitionEnabled()" />
                                                <v-list-item :disabled="exportingData || !transactions.length"
                                                             :title="tt('Export to CSV (Comma-separated values) File')"
                                                             :prepend-icon="mdiFileDelimitedOutline"
                                                             v-if="isDataExportingEnabled()" @click="exportTransactions('csv')" />
                                                <v-list-item :disabled="exportingData || !transactions.length"
                                                             :title="tt('Export to TSV (Tab-separated values) File')"
                                                             :prepend-icon="mdiFileDelimitedOutline"
                                                             v-if="isDataExportingEnabled()" @click="exportTransactions('tsv')" />
                                            </v-list>
                                        </v-menu>
                                    </v-btn>
                                </div>
                            </div>
                        </template>

                        <v-table class="transaction-table" :hover="!loading">
                            <thead>
                            <tr>
                                <th class="transaction-table-column-time text-no-wrap">
                                    <v-menu ref="timeFilterMenu" class="transaction-time-menu"
                                            eager location="bottom" max-height="500"
                                            @update:model-value="scrollTimeMenuToSelectedItem">
                                        <template #activator="{ props }">
                                            <div class="d-flex align-center cursor-pointer"
                                                 :class="{ 'readonly': loading, 'text-primary': query.dateType !== DateRange.ThisMonth.type }" v-bind="props">
                                                <span>{{ tt('Time') }}</span>
                                                <v-icon :icon="mdiMenuDown" />
                                            </div>
                                        </template>
                                        <v-list :selected="[query.dateType]">
                                            <v-list-item class="text-body-medium" density="compact"
                                                         :key="dateRange.type" :value="dateRange.type"
                                                         :class="{ 'list-item-selected': query.dateType === dateRange.type }"
                                                         :append-icon="(query.dateType === dateRange.type ? mdiCheck : undefined)"
                                                         v-for="dateRange in allDateRanges">
                                                <v-list-item-title class="cursor-pointer"
                                                                   @click="changeDateFilter(dateRange.type)">
                                                    <div class="d-flex align-center">
                                                        <span class="text-body-medium ms-3">{{ dateRange.displayName }}</span>
                                                    </div>
                                                    <div class="transaction-list-custom-datetime-range ms-3 smaller" v-if="dateRange.isUserCustomRange && query.dateType === dateRange.type && query.minTime && query.maxTime">
                                                        <span>{{ queryMinTime }}</span>
                                                        <span>&nbsp;-&nbsp;</span>
                                                        <br/>
                                                        <span>{{ queryMaxTime }}</span>
                                                    </div>
                                                </v-list-item-title>
                                            </v-list-item>
                                        </v-list>
                                    </v-menu>
                                </th>
                                <th class="transaction-table-column-category text-no-wrap">
                                    <v-menu ref="categoryFilterMenu" class="transaction-category-menu"
                                            eager location="bottom" max-height="500"
                                            :disabled="query.type === 1"
                                            :close-on-content-click="false"
                                            v-model="categoryMenuState"
                                            @update:model-value="scrollCategoryMenuToSelectedItem">
                                        <template #activator="{ props }">
                                            <div class="d-flex align-center"
                                                :class="{ 'readonly': loading, 'cursor-pointer': query.type !== 1, 'text-primary': query.categoryIds }" v-bind="props">
                                                <span>{{ queryCategoryName }}</span>
                                                <v-icon :icon="mdiMenuDown" v-show="query.type !== 1" />
                                            </div>
                                        </template>
                                        <v-list :selected="[queryAllSelectedFilterCategoryIds]">
                                            <v-list-item key="" value="" class="text-body-medium" density="compact"
                                                         :class="{ 'list-item-selected': !query.categoryIds }"
                                                         :append-icon="(!query.categoryIds ? mdiCheck : undefined)">
                                                <v-list-item-title class="cursor-pointer"
                                                                   @click="changeCategoryFilter('')">
                                                    <div class="d-flex align-center">
                                                        <v-icon :icon="mdiViewGridOutline" />
                                                        <span class="text-body-medium ms-3">{{ tt('All') }}</span>
                                                    </div>
                                                </v-list-item-title>
                                            </v-list-item>
                                            <v-list-item key="multiple" value="multiple" class="text-body-medium" density="compact"
                                                         :class="{ 'list-item-selected': query.categoryIds && queryAllFilterCategoryIdsCount > 1 }"
                                                         :append-icon="(query.categoryIds && queryAllFilterCategoryIdsCount > 1 ? mdiCheck : undefined)"
                                                         v-if="allAvailableCategoriesCount > 0">
                                                <v-list-item-title class="cursor-pointer"
                                                                   @click="showFilterCategoryDialog = true">
                                                    <div class="d-flex align-center">
                                                        <v-icon :icon="mdiVectorArrangeBelow" />
                                                        <span class="text-body-medium ms-3">{{ tt('Multiple Categories') }}</span>
                                                    </div>
                                                </v-list-item-title>
                                            </v-list-item>

                                            <template :key="categoryType"
                                                      v-for="(categories, categoryType) in allPrimaryCategories">
                                                <v-divider />

                                                <v-list-item density="compact" v-show="categories && categories.length">
                                                    <v-list-item-title>
                                                        <span class="text-body-small">{{ getTransactionTypeName(categoryTypeToTransactionType(parseInt(categoryType)), 'Type') }}</span>
                                                    </v-list-item-title>
                                                </v-list-item>

                                                <v-list-group :key="category.id" v-for="(category, index) in categories">
                                                    <template #activator="{ props }" v-if="!category.hidden || queryAllFilterCategoryIds[category.id] || allCategories[query.categoryIds]?.parentId === category.id || hasSubCategoryInQuery(category)">
                                                        <v-divider v-if="index > 0" />
                                                        <v-list-item class="text-body-medium" density="compact"
                                                                     :class="getCategoryListItemCheckedClass(category, queryAllFilterCategoryIds)"
                                                                     v-bind="props">
                                                            <v-list-item-title>
                                                                <div class="d-flex align-center">
                                                                    <ItemIcon icon-type="category" size="24px" :icon-id="category.icon" :color="category.color"></ItemIcon>
                                                                    <span class="text-body-medium ms-2">{{ category.name }}</span>
                                                                </div>
                                                            </v-list-item-title>
                                                        </v-list-item>
                                                    </template>

                                                    <v-divider />
                                                    <v-list-item class="text-body-medium" density="compact"
                                                                 :class="{ 'item-in-multiple-selection': queryAllFilterCategoryIdsCount > 1 && queryAllFilterCategoryIds[category.id] }"
                                                                 :value="category.id"
                                                                 :append-icon="(query.categoryIds === category.id ? mdiCheck : undefined)">
                                                        <v-list-item-title class="cursor-pointer"
                                                                           @click="changeCategoryFilter(category.id)">
                                                            <div class="d-flex align-center">
                                                                <v-icon :icon="mdiViewGridOutline" />
                                                                <span class="text-body-medium ms-3">{{ tt('All') }}</span>
                                                            </div>
                                                        </v-list-item-title>
                                                    </v-list-item>

                                                    <template :key="subCategory.id"
                                                              v-for="subCategory in category.subCategories">
                                                        <v-divider v-if="!subCategory.hidden || queryAllFilterCategoryIds[subCategory.id]" />
                                                        <v-list-item class="text-body-medium" density="compact"
                                                                     :value="subCategory.id"
                                                                     :class="{ 'list-item-selected': query.categoryIds === subCategory.id, 'item-in-multiple-selection': queryAllFilterCategoryIdsCount > 1 && queryAllFilterCategoryIds[subCategory.id] }"
                                                                     :append-icon="(query.categoryIds === subCategory.id ? mdiCheck : undefined)"
                                                                     v-if="!subCategory.hidden || queryAllFilterCategoryIds[subCategory.id]">
                                                            <v-list-item-title class="cursor-pointer"
                                                                               @click="changeCategoryFilter(subCategory.id)">
                                                                <div class="d-flex align-center">
                                                                    <ItemIcon icon-type="category" size="24px" :icon-id="subCategory.icon" :color="subCategory.color"></ItemIcon>
                                                                    <span class="text-body-medium ms-2">{{ subCategory.name }}</span>
                                                                </div>
                                                            </v-list-item-title>
                                                        </v-list-item>
                                                    </template>
                                                </v-list-group>
                                            </template>
                                        </v-list>
                                    </v-menu>
                                </th>
                                <th class="transaction-table-column-amount text-no-wrap">
                                    <v-menu ref="amountFilterMenu" class="transaction-amount-menu"
                                            eager location="bottom" max-height="500"
                                            :close-on-content-click="false"
                                            v-model="amountMenuState"
                                            @update:model-value="scrollAmountMenuToSelectedItem">
                                        <template #activator="{ props }">
                                            <div class="d-flex align-center cursor-pointer"
                                                 :class="{ 'readonly': loading, 'text-primary': query.amountFilter }" v-bind="props">
                                                <span>{{ tt('Amount') }}</span>
                                                <v-icon :icon="mdiMenuDown" />
                                            </div>
                                        </template>
                                        <v-list :selected="[query.amountFilter.split(':')[0]]">
                                            <v-list-item key="" value="" class="text-body-medium" density="compact"
                                                         :class="{ 'list-item-selected': !query.amountFilter }"
                                                         :append-icon="(!query.amountFilter && !currentAmountFilterType ? mdiCheck : undefined)">
                                                <v-list-item-title class="cursor-pointer"
                                                                   @click="changeAmountFilter('')">
                                                    <div class="d-flex align-center">
                                                        <span class="text-body-medium ms-3">{{ tt('All') }}</span>
                                                    </div>
                                                </v-list-item-title>
                                            </v-list-item>
                                            <template :key="filterType.type"
                                                      v-for="filterType in AmountFilterType.values()">
                                                <v-list-item class="text-body-medium" density="compact"
                                                             :value="filterType.type"
                                                             :class="{ 'list-item-selected': query.amountFilter && query.amountFilter.startsWith(`${filterType.type}:`) }"
                                                             :append-icon="(query.amountFilter && query.amountFilter.startsWith(`${filterType.type}:`) && currentAmountFilterType !== filterType.type ? mdiCheck : undefined)">
                                                    <v-list-item-title class="cursor-pointer"
                                                                       @click="currentAmountFilterType = filterType.type">
                                                        <div class="d-flex align-center">
                                                            <span class="text-body-medium ms-3">{{ tt(filterType.name) }}</span>
                                                            <span class="text-body-medium ms-3" v-if="query.amountFilter && query.amountFilter.startsWith(`${filterType.type}:`) && currentAmountFilterType !== filterType.type">{{ queryAmount }}</span>
                                                            <amount-input class="transaction-amount-filter-value ms-4" density="compact"
                                                                          :currency="selectedAccountDefaultCurrency"
                                                                          v-model="currentAmountFilterValue1"
                                                                          v-if="currentAmountFilterType === filterType.type"/>
                                                            <span class="ms-2 me-2" v-if="currentAmountFilterType === filterType.type && filterType.paramCount === 2">~</span>
                                                            <amount-input class="transaction-amount-filter-value" density="compact"
                                                                          :currency="selectedAccountDefaultCurrency"
                                                                          v-model="currentAmountFilterValue2"
                                                                          v-if="currentAmountFilterType === filterType.type && filterType.paramCount === 2"/>
                                                            <v-btn class="ms-2" density="compact" color="primary" variant="tonal"
                                                                   @click="changeAmountFilter(filterType.type)"
                                                                   v-if="currentAmountFilterType === filterType.type">{{ tt('Apply') }}</v-btn>
                                                        </div>
                                                    </v-list-item-title>
                                                </v-list-item>
                                            </template>
                                        </v-list>
                                    </v-menu>
                                </th>
                                <th class="transaction-table-column-account text-no-wrap">
                                    <v-menu ref="accountFilterMenu" class="transaction-account-menu"
                                            eager location="bottom" max-height="500"
                                            @update:model-value="scrollAccountMenuToSelectedItem">
                                        <template #activator="{ props }">
                                            <div class="d-flex align-center cursor-pointer"
                                                 :class="{ 'readonly': loading, 'text-primary': query.accountIds }" v-bind="props">
                                                <span>{{ queryAccountName }}</span>
                                                <v-icon :icon="mdiMenuDown" />
                                            </div>
                                        </template>
                                        <v-list :selected="[queryAllSelectedFilterAccountIds]">
                                            <v-list-item key="" value="" class="text-body-medium" density="compact"
                                                         :class="{ 'list-item-selected': !query.accountIds }"
                                                         :append-icon="(!query.accountIds ? mdiCheck : undefined)">
                                                <v-list-item-title class="cursor-pointer"
                                                                   @click="changeAccountFilter('')">
                                                    <div class="d-flex align-center">
                                                        <v-icon :icon="mdiViewGridOutline" />
                                                        <span class="text-body-medium ms-3">{{ tt('All') }}</span>
                                                    </div>
                                                </v-list-item-title>
                                            </v-list-item>
                                            <v-list-item key="multiple" value="multiple" class="text-body-medium" density="compact"
                                                         :class="{ 'list-item-selected': query.accountIds && queryAllFilterAccountIdsCount > 1 }"
                                                         :append-icon="(query.accountIds && queryAllFilterAccountIdsCount > 1 ? mdiCheck : undefined)"
                                                         v-if="allAvailableAccountsCount > 0">
                                                <v-list-item-title class="cursor-pointer"
                                                                   @click="showFilterAccountDialog = true">
                                                    <div class="d-flex align-center">
                                                        <v-icon :icon="mdiVectorArrangeBelow" />
                                                        <span class="text-body-medium ms-3">{{ tt('Multiple Accounts') }}</span>
                                                    </div>
                                                </v-list-item-title>
                                            </v-list-item>
                                            <template :key="account.id"
                                                      v-for="account in allAccounts">
                                                <v-divider v-if="(!account.hidden && (!allAccountsMap[account.parentId] || !allAccountsMap[account.parentId]!.hidden)) || queryAllFilterAccountIds[account.id]" />
                                                <v-list-item class="text-body-medium" density="compact"
                                                             :value="account.id"
                                                             :class="{ 'list-item-selected': query.accountIds === account.id, 'item-in-multiple-selection': queryAllFilterAccountIdsCount > 1 && queryAllFilterAccountIds[account.id] }"
                                                             :append-icon="(query.accountIds === account.id ? mdiCheck : undefined)"
                                                             v-if="(!account.hidden && (!allAccountsMap[account.parentId] || !allAccountsMap[account.parentId]!.hidden)) || queryAllFilterAccountIds[account.id]">
                                                    <v-list-item-title class="cursor-pointer"
                                                                       @click="changeAccountFilter(account.id)">
                                                        <div class="d-flex align-center">
                                                            <ItemIcon icon-type="account" size="24px" :icon-id="account.icon" :color="account.color"></ItemIcon>
                                                            <span class="text-body-medium ms-2">{{ account.name }}</span>
                                                        </div>
                                                    </v-list-item-title>
                                                </v-list-item>
                                            </template>
                                        </v-list>
                                    </v-menu>
                                </th>
                                <th class="transaction-table-column-description text-no-wrap">{{ tt('Description') }}</th>
                            </tr>
                            </thead>

                            <tbody v-if="loading && (!transactions || !transactions.length || transactions.length < 1)">
                            <tr :key="itemIdx" v-for="itemIdx in skeletonData">
                                <td class="px-0" colspan="5">
                                    <v-skeleton-loader type="text" :loading="true"></v-skeleton-loader>
                                </td>
                            </tr>
                            </tbody>

                            <tbody v-if="!loading && (!transactions || !transactions.length || transactions.length < 1)">
                            <tr>
                                <td class="transaction-empty-cell text-center" colspan="5">
                                    <div class="transaction-empty-state d-flex align-center justify-center text-medium-emphasis">
                                        {{ tt('No transaction data') }}
                                    </div>
                                </td>
                            </tr>
                            </tbody>

                            <tbody :key="transaction.id"
                                   :class="{ 'disabled': loading, 'has-bottom-border': idx < transactions.length - 1 }"
                                   v-for="(transaction, idx) in transactions">
                                <tr class="transaction-list-row-date no-hover text-body-small"
                                    v-if="idx === 0 || (idx > 0 && (transaction.gregorianCalendarYearDashMonthDashDay !== transactions[idx - 1]!.gregorianCalendarYearDashMonthDashDay))">
                                    <td colspan="5" class="font-weight-bold">
                                        <div class="d-flex align-center">
                                            <span>{{ getDisplayLongDate(transaction) }}</span>
                                            <v-chip class="ms-1" color="default" size="x-small"
                                                    v-if="transaction.displayDayOfWeek">
                                                {{ getWeekdayLongName(transaction.displayDayOfWeek) }}
                                            </v-chip>
                                        </div>
                                    </td>
                                </tr>
                                <tr class="transaction-table-row-data cursor-pointer"
                                    @click="show(transaction)">
                                    <td class="transaction-table-column-time">
                                        <div class="d-flex flex-column">
                                            <span>{{ getDisplayTime(transaction) }}</span>
                                            <span class="text-body-small text-medium-emphasis" v-if="!isSameAsDefaultTimezoneOffsetMinutes(transaction)">{{ getDisplayTimezone(transaction) }}</span>
                                            <v-tooltip activator="parent" v-if="!isSameAsDefaultTimezoneOffsetMinutes(transaction)">{{ getDisplayTimeInDefaultTimezone(transaction) }}</v-tooltip>
                                        </div>
                                    </td>
                                    <td class="transaction-table-column-category">
                                        <div class="d-flex align-center">
                                            <ItemIcon size="24px" icon-type="category"
                                                      :icon-id="transaction.category.icon"
                                                      :color="transaction.category.color"
                                                      v-if="transaction.category && transaction.category.color"></ItemIcon>
                                            <v-icon size="24" :icon="mdiPencilBoxOutline" v-else-if="!transaction.category || !transaction.category.color" />
                                            <span class="ms-2" v-if="transaction.type === TransactionType.ModifyBalance">
                                                {{ tt('Modify Balance') }}
                                            </span>
                                            <span class="ms-2" v-else-if="transaction.type !== TransactionType.ModifyBalance && transaction.category">
                                                {{ transaction.category.name }}
                                            </span>
                                            <span class="ms-2" v-else-if="transaction.type !== TransactionType.ModifyBalance && !transaction.category">
                                                {{ getTransactionTypeName(transaction.type, 'Transaction') }}
                                            </span>
                                        </div>
                                    </td>
                                    <td class="transaction-table-column-amount" :class="{ 'text-expense': transaction.type === TransactionType.Expense, 'text-income': transaction.type === TransactionType.Income }">
                                        <div v-if="transaction.sourceAccount">
                                            <span>{{ getDisplayAmount(transaction) }}</span>
                                            <v-tooltip activator="parent" v-if="!transaction.hideAmount && getDisplayAmountCurrency(transaction) !== userDefaultCurrency">
                                                {{ getDisplayAmount(transaction, true) }}
                                            </v-tooltip>
                                        </div>
                                    </td>
                                    <td class="transaction-table-column-account">
                                        <div class="d-flex align-center">
                                            <span v-if="transaction.sourceAccount">{{ transaction.sourceAccount.name }}</span>
                                            <v-icon class="icon-with-direction mx-1" size="13" :icon="mdiArrowRight" v-if="transaction.sourceAccount && transaction.type === TransactionType.Transfer && transaction.destinationAccount && transaction.sourceAccount.id !== transaction.destinationAccount.id"></v-icon>
                                            <span v-if="transaction.sourceAccount && transaction.type === TransactionType.Transfer && transaction.destinationAccount && transaction.sourceAccount.id !== transaction.destinationAccount.id">{{ transaction.destinationAccount.name }}</span>
                                        </div>
                                    </td>
                                    <td class="transaction-table-column-description text-truncate">
                                        {{ transaction.comment }}
                                    </td>
                                </tr>
                            </tbody>
                        </v-table>

                        <div class="transaction-pagination mt-2 mb-4"
                             v-if="loading || transactions.length">
                            <pagination-buttons density="comfortable" :totalPageCount="totalPageCount"
                                                :disabled="loading" v-model="paginationCurrentPage" />
                            <div class="transaction-page-size-control d-flex align-center ga-2">
                                <span class="text-body-small text-medium-emphasis text-no-wrap">{{ tt('Transactions Per Page') }}</span>
                                <v-select class="transaction-page-size" density="compact" hide-details
                                          item-title="name" item-value="value" :disabled="loading"
                                          :items="allPageCounts" v-model="countPerPage" />
                            </div>
                        </div>
                    </v-card>
                </v-window-item>
            </v-window>
        </template>
    </main-page-layout>

    <date-range-selection-dialog :title="tt('Custom Date Range')"
                                 :min-time="customMinDatetime"
                                 :max-time="customMaxDatetime"
                                 v-model:show="showCustomDateRangeDialog"
                                 @dateRange:change="changeCustomDateFilter"
                                 @error="onShowDateRangeError" />

    <edit-dialog ref="editDialog" :type="TransactionEditPageType.Transaction" />
    <a-i-image-recognition-dialog ref="aiImageRecognitionDialog" />
    <account-filter-settings-dialog type="transactionListCurrent"
                                    v-model:show="showFilterAccountDialog"
                                    @settings:change="changeMultipleAccountsFilter" />

    <category-filter-settings-dialog type="transactionListCurrent"
                                     :category-types="allowCategoryTypes"
                                     v-model:show="showFilterCategoryDialog"
                                     @settings:change="changeMultipleCategoriesFilter" />

    <confirm-dialog ref="confirmDialog"/>
    <snack-bar ref="snackbar" />
</template>

<script setup lang="ts">
import { VMenu } from 'vuetify/components/VMenu';
import PaginationButtons from '@/components/desktop/PaginationButtons.vue';
import ConfirmDialog from '@/components/desktop/ConfirmDialog.vue';
import SnackBar from '@/components/desktop/SnackBar.vue';
import EditDialog from './list/dialogs/EditDialog.vue';
import AIImageRecognitionDialog from './list/dialogs/AIImageRecognitionDialog.vue';
import AccountFilterSettingsDialog from '@/views/desktop/common/dialogs/AccountFilterSettingsDialog.vue';
import CategoryFilterSettingsDialog from '@/views/desktop/common/dialogs/CategoryFilterSettingsDialog.vue';
import { TransactionEditPageType } from '@/views/base/transactions/TransactionEditPageBase.ts';

import { ref, computed, useTemplateRef, watch, nextTick } from 'vue';
import { useRouter, onBeforeRouteUpdate } from 'vue-router';

import { useI18n } from '@/locales/helpers.ts';
import { TransactionListPageType, useTransactionListPageBase } from '@/views/base/transactions/TransactionListPageBase.ts';

import { useSettingsStore } from '@/stores/setting.ts';
import { useUserStore } from '@/stores/user.ts';
import { useAccountsStore } from '@/stores/account.ts';
import { useTransactionCategoriesStore } from '@/stores/transactionCategory.ts';
import { useTransactionsStore } from '@/stores/transaction.ts';
import { useDesktopPageStore } from '@/stores/desktopPage.ts';

import { type NameNumeralValue, keys } from '@/core/base.ts';
import {
    type LocalizedRecentMonthDateRange,
    type TimeRangeAndDateType,
    DateRangeScene,
    DateRange
} from '@/core/datetime.ts';
import { AmountFilterType } from '@/core/numeral.ts';
import { TransactionType } from '@/core/transaction.ts';

import type { TransactionCategory } from '@/models/transaction_category.ts';
import { type Transaction } from '@/models/transaction.ts';

import {
    isFunction,
    isObject,
    isString,
    isNumber
} from '@/lib/common.ts';
import {
    getCurrentUnixTime,
    parseDateTimeFromUnixTime,
    getDayFirstDateTimeBySpecifiedUnixTime,
    getDateTypeByDateRange,
    getDateTypeByBillingCycleDateRange,
    getDateRangeByDateType,
    getDateRangeByBillingCycleDateType,
    getDateRangeByLastReconciledTimeRangeDateType,
    getRecentDateRangeIndex
} from '@/lib/datetime.ts';
import {
    categoryTypeToTransactionType,
    transactionTypeToCategoryType
} from '@/lib/category.ts';
import {
    isDataExportingEnabled,
    isTransactionFromAITextRecognitionEnabled,
    isTransactionFromAIImageRecognitionEnabled
} from '@/lib/server_settings.ts';
import { scrollToSelectedItem, startDownloadFile } from '@/lib/ui/common.ts';
import logger from '@/lib/logger.ts';

import {
    mdiMagnify,
    mdiCheck,
    mdiCalendarMonthOutline,
    mdiDotsVertical,
    mdiFileDelimitedOutline,
    mdiViewGridOutline,
    mdiVectorArrangeBelow,
    mdiRefresh,
    mdiMenuDown,
    mdiPencilBoxOutline,
    mdiArrowRight,
    mdiMagicStaff
} from '@mdi/js';

interface TransactionListProps {
    initPageType?: string;
    initDateType?: string,
    initMaxTime?: string,
    initMinTime?: string,
    initType?: string,
    initCategoryIds?: string,
    initAccountIds?: string,
    initAmountFilter?: string,
    initKeyword?: string,
    initMatchMode?: string
}

const props = defineProps<TransactionListProps>();

type ConfirmDialogType = InstanceType<typeof ConfirmDialog>;
type SnackBarType = InstanceType<typeof SnackBar>;
type EditDialogType = InstanceType<typeof EditDialog>;
type AIImageRecognitionDialogType = InstanceType<typeof AIImageRecognitionDialog>;

interface TransactionListDisplayTotalAmount {
    incomeIsZero: boolean;
    expenseIsZero: boolean;
    income: string;
    expense: string;
    incomeInDefaultCurrency: string;
    expenseInDefaultCurrency: string;
}

const router = useRouter();

const {
    tt,
    getAllRecentMonthDateRanges,
    getWeekdayLongName,
    formatNumberToLocalizedNumerals
} = useI18n();

const {
    pageType,
    loading,
    customMinDatetime,
    customMaxDatetime,
    firstDayOfWeek,
    fiscalYearStart,
    userDefaultCurrency,
    selectedAccountDefaultCurrency,
    showTotalAmountInTransactionListPage,
    allDateRanges,
    allAccounts,
    allAccountsMap,
    allAvailableAccountsCount,
    allCategories,
    allPrimaryCategories,
    allAvailableCategoriesCount,
    query,
    queryMinTime,
    queryMaxTime,
    queryMonthlyData,
    queryAllFilterCategoryIds,
    queryAllFilterAccountIds,
    queryAllFilterCategoryIdsCount,
    queryAllFilterAccountIdsCount,
    queryAccountName,
    queryCategoryName,
    queryAmount,
    currentMonthTransactionData,
    hasSubCategoryInQuery,
    isSameAsDefaultTimezoneOffsetMinutes,
    getDisplayTime,
    getDisplayLongDate,
    getDisplayTimezone,
    getDisplayTimeInDefaultTimezone,
    getDisplayAmount,
    getDisplayAmountCurrency,
    getDisplayMonthTotalAmount,
    getTransactionTypeName
} = useTransactionListPageBase();

const settingsStore = useSettingsStore();
const userStore = useUserStore();
const accountsStore = useAccountsStore();
const transactionCategoriesStore = useTransactionCategoriesStore();
const transactionsStore = useTransactionsStore();
const desktopPageStore = useDesktopPageStore();

const timeFilterMenu = useTemplateRef<VMenu>('timeFilterMenu');
const categoryFilterMenu = useTemplateRef<VMenu>('categoryFilterMenu');
const amountFilterMenu = useTemplateRef<VMenu>('amountFilterMenu');
const accountFilterMenu = useTemplateRef<VMenu>('accountFilterMenu');

const confirmDialog = useTemplateRef<ConfirmDialogType>('confirmDialog');
const snackbar = useTemplateRef<SnackBarType>('snackbar');
const editDialog = useTemplateRef<EditDialogType>('editDialog');
const aiImageRecognitionDialog = useTemplateRef<AIImageRecognitionDialogType>('aiImageRecognitionDialog');

const activeTab = ref<string>('transactionPage');
const currentPage = ref<number>(1);
const temporaryCountPerPage = ref<number | null>(null);
const totalCount = ref<number>(1);
const searchKeyword = ref<string>('');
const currentAmountFilterType = ref<string>('');
const currentAmountFilterValue1 = ref<number>(0);
const currentAmountFilterValue2 = ref<number>(0);
const currentPageTransactions = ref<Transaction[]>([]);
const categoryMenuState = ref<boolean>(false);
const amountMenuState = ref<boolean>(false);
const exportingData = ref<boolean>(false);
const showCustomDateRangeDialog = ref<boolean>(false);
const showFilterAccountDialog = ref<boolean>(false);
const showFilterCategoryDialog = ref<boolean>(false);

const allPageCounts = computed<NameNumeralValue[]>(() => {
    const pageCounts: NameNumeralValue[] = [];
    const availableCountPerPage: number[] = [ 5, 10, 15, 20, 25, 30, 50 ];

    for (const count of availableCountPerPage) {
        pageCounts.push({ value: count, name: formatNumberToLocalizedNumerals(count) });
    }

    return pageCounts;
});
const recentMonthDateRanges = computed<LocalizedRecentMonthDateRange[]>(() => getAllRecentMonthDateRanges(true, true));
const recentDateRangeOptions = computed(() => recentMonthDateRanges.value.map((dateRange, index) => ({
    displayName: dateRange.displayName,
    value: index
})));

const allowCategoryTypes = computed<string>(() => {
    if (TransactionType.Income <= query.value.type && query.value.type <= TransactionType.Transfer) {
        return transactionTypeToCategoryType(query.value.type)?.toString() ?? '';
    }

    return '';
});

const transactions = computed<Transaction[]>(() => {
    if (queryMonthlyData.value) {
        const transactionData = currentMonthTransactionData.value;

        if (!transactionData || !transactionData.items) {
            return [];
        }

        const firstIndex = (currentPage.value - 1) * countPerPage.value;
        const lastIndex = currentPage.value * countPerPage.value;

        return transactionData.items.slice(firstIndex, lastIndex);
    }

    return currentPageTransactions.value;
});

const recentDateRangeIndex = computed<number>({
    get: () => getRecentDateRangeIndex(recentMonthDateRanges.value, query.value.dateType, query.value.minTime, query.value.maxTime, firstDayOfWeek.value, fiscalYearStart.value),
    set: (value) => {
        if (value < 0 || value >= recentMonthDateRanges.value.length) {
            value = 0;
        }

        changeDateFilter(recentMonthDateRanges.value[value] as LocalizedRecentMonthDateRange);
    }
});

const queryType = computed<number>({
    get: () => query.value.type,
    set: (value) => changeTypeFilter(value)
});

const queryAllSelectedFilterCategoryIds = computed<string>(() => {
    if (queryAllFilterCategoryIdsCount.value === 0) {
        return '';
    } else if (queryAllFilterCategoryIdsCount.value === 1) {
        return query.value.categoryIds;
    } else { // queryAllFilterCategoryIdsCount.value > 1
        return 'multiple';
    }
});

const queryAllSelectedFilterAccountIds = computed<string>(() => {
    if (queryAllFilterAccountIdsCount.value === 0) {
        return '';
    } else if (queryAllFilterAccountIdsCount.value === 1) {
        return query.value.accountIds;
    } else { // queryAllFilterAccountIdsCount.value > 1
        return 'multiple';
    }
});

const countPerPage = computed<number>({
    get: () => {
        if (temporaryCountPerPage.value) {
            return temporaryCountPerPage.value;
        }

        return settingsStore.appSettings.itemsCountInTransactionListPage;
    },
    set: (value) => {
        const newTotalPageCount = Math.ceil(totalCount.value / value);

        if (currentPage.value > newTotalPageCount) {
            currentPage.value = newTotalPageCount;
        }

        temporaryCountPerPage.value = value;

        if (!queryMonthlyData.value) {
            reload(false, false);
        }
    }
});

const totalPageCount = computed<number>(() => Math.ceil(totalCount.value / countPerPage.value));

const paginationCurrentPage = computed<number>({
    get: () => currentPage.value,
    set: (value) => {
        currentPage.value = value;

        if (!queryMonthlyData.value) {
            reload(false, false);
        }
    }
});

const skeletonData = computed<number[]>(() => {
    const data: number[] = [];
    const totalCount = countPerPage.value;

    for (let i = 0; i < totalCount; i++) {
        data.push(i);
    }

    return data;
});

const currentMonthTotalAmount = computed<TransactionListDisplayTotalAmount | null>(() => {
    if (queryMonthlyData.value) {
        const transactionData = currentMonthTransactionData.value;

        if (!transactionData) {
            return null;
        }

        const displayMonthlyTotalAmount: TransactionListDisplayTotalAmount = {
            incomeIsZero: transactionData.totalAmount.income.isZero(),
            expenseIsZero: transactionData.totalAmount.expense.isZero(),
            income: getDisplayMonthTotalAmount(transactionData.totalAmount.income, selectedAccountDefaultCurrency.value, '', transactionData.totalAmount.incompleteIncome),
            expense: getDisplayMonthTotalAmount(transactionData.totalAmount.expense, selectedAccountDefaultCurrency.value, '', transactionData.totalAmount.incompleteExpense),
            incomeInDefaultCurrency: getDisplayMonthTotalAmount(transactionData.totalAmount.income, selectedAccountDefaultCurrency.value, '', transactionData.totalAmount.incompleteIncome, true),
            expenseInDefaultCurrency: getDisplayMonthTotalAmount(transactionData.totalAmount.expense, selectedAccountDefaultCurrency.value, '', transactionData.totalAmount.incompleteExpense, true)
        };

        return displayMonthlyTotalAmount;
    } else {
        return null;
    }
});

function getCategoryListItemCheckedClass(category: TransactionCategory, queryCategoryIds: Record<string, boolean>): Record<string, boolean> {
    if (queryCategoryIds && queryCategoryIds[category.id]) {
        return {
            'list-item-selected': true,
            'has-children-item-selected': true
        };
    }

    if (category.subCategories) {
        for (const subCategory of category.subCategories) {
            if (queryCategoryIds && queryCategoryIds[subCategory.id]) {
                return {
                    'list-item-selected': true,
                    'has-children-item-selected': true
                };
            }
        }
    }

    return {};
}

function getAmountFilterParameterCount(filterType: string): number {
    const amountFilterType = AmountFilterType.valueOf(filterType);
    return amountFilterType ? amountFilterType.paramCount : 0;
}

function updateUrlWhenChanged(changed: boolean): void {
    if (changed) {
        loading.value = true;
        currentPageTransactions.value = [];
        transactionsStore.clearTransactions();
        router.push(`/transaction/list?${transactionsStore.getTransactionListPageParams(pageType.value)}`);
    }
}

function init(initProps: TransactionListProps): void {
    pageType.value = TransactionListPageType.List.type;
    let dateRange: TimeRangeAndDateType | null = getDateRangeByDateType(initProps.initDateType ? parseInt(initProps.initDateType) : undefined, firstDayOfWeek.value, fiscalYearStart.value);

    if (!dateRange && initProps.initDateType && initProps.initMaxTime && initProps.initMinTime &&
        (DateRange.isBillingCycle(parseInt(initProps.initDateType)) || DateRange.isLastReconciledTimeRange(parseInt(initProps.initDateType)) || initProps.initDateType === DateRange.Custom.type.toString()) &&
        parseInt(initProps.initMaxTime) > 0 && parseInt(initProps.initMinTime) > 0) {
        dateRange = {
            dateType: parseInt(initProps.initDateType),
            maxTime: parseInt(initProps.initMaxTime),
            minTime: parseInt(initProps.initMinTime)
        };
    }

    transactionsStore.initTransactionListFilter({
        dateType: dateRange ? dateRange.dateType : undefined,
        maxTime: dateRange ? dateRange.maxTime : undefined,
        minTime: dateRange ? dateRange.minTime : undefined,
        type: initProps.initType && parseInt(initProps.initType) > 0 ? parseInt(initProps.initType) : undefined,
        categoryIds: initProps.initCategoryIds,
        accountIds: initProps.initAccountIds,
        amountFilter: initProps.initAmountFilter || '',
        keyword: initProps.initKeyword || '',
        matchMode: initProps.initMatchMode && parseInt(initProps.initMatchMode) >= 0 ? parseInt(initProps.initMatchMode) : undefined
    });

    searchKeyword.value = initProps.initKeyword || '';
    currentAmountFilterType.value = '';

    currentPage.value = 1;
    reload(false, true);

}

function reload(force: boolean, init: boolean): void {
    loading.value = true;

    const page = currentPage.value;

    Promise.all([
        accountsStore.loadAllAccounts({ force: false }),
        transactionCategoriesStore.loadAllCategories({ force: false })
    ]).then(() => {
        if (init) {
            if (desktopPageStore.showAddTransactionDialogInTransactionList) {
                desktopPageStore.resetShowAddTransactionDialogInTransactionList();
                add();
            }
        }

        if (queryMonthlyData.value) {
            const currentMonthMinDate = parseDateTimeFromUnixTime(query.value.minTime);
            const currentYear = currentMonthMinDate.getGregorianCalendarYear();
            const currentMonth = currentMonthMinDate.getGregorianCalendarMonth();

            return transactionsStore.loadMonthlyAllTransactions({
                year: currentYear,
                month: currentMonth,
                mustHavePictures: false,
                withPictures: false,
                autoExpand: true,
                defaultCurrency: selectedAccountDefaultCurrency.value
            });
        } else {
            return transactionsStore.loadTransactions({
                reload: true,
                count: countPerPage.value,
                page: page,
                mustHavePictures: false,
                withCount: page <= 1,
                withPictures: false,
                autoExpand: true,
                defaultCurrency: selectedAccountDefaultCurrency.value
            });
        }
    }).then(data => {
        loading.value = false;
        currentPageTransactions.value = data && data.items && data.items.length ? data.items : [];

        if (page <= 1) {
            totalCount.value = data && data.totalCount ? data.totalCount : 1;
        }

        if (force) {
            snackbar.value?.showMessage('Data has been updated');
        }
    }).catch(error => {
        loading.value = false;
        currentPageTransactions.value = [];
        totalCount.value = 1;

        if (!error.processed) {
            snackbar.value?.showError(error);
        }
    });
}

function changeDateFilter(dateRange: TimeRangeAndDateType | number | null): void {
    if (dateRange === DateRange.Custom.type || (isObject(dateRange) && dateRange.dateType === DateRange.Custom.type && !dateRange.minTime && !dateRange.maxTime)) { // Custom
        if (!query.value.minTime || !query.value.maxTime) {
            customMaxDatetime.value = getCurrentUnixTime();
            customMinDatetime.value = getDayFirstDateTimeBySpecifiedUnixTime(customMaxDatetime.value).getUnixTime();
        } else {
            customMaxDatetime.value = query.value.maxTime;
            customMinDatetime.value = query.value.minTime;
        }

        showCustomDateRangeDialog.value = true;

        return;
    }

    if (isNumber(dateRange)) {
        if (DateRange.isBillingCycle(dateRange)) {
            dateRange = getDateRangeByBillingCycleDateType(dateRange, firstDayOfWeek.value, fiscalYearStart.value, accountsStore.getAccountStatementDate(query.value.accountIds));
        } else if (DateRange.isLastReconciledTimeRange(dateRange)) {
            dateRange = getDateRangeByLastReconciledTimeRangeDateType(dateRange, allAccountsMap.value[query.value.accountIds]?.lastReconciledTime);
        } else {
            dateRange = getDateRangeByDateType(dateRange, firstDayOfWeek.value, fiscalYearStart.value);
        }
    }

    if (!dateRange) {
        return;
    }

    if (query.value.dateType === dateRange.dateType && query.value.maxTime === dateRange.maxTime && query.value.minTime === dateRange.minTime) {
        return;
    }

    const changed = transactionsStore.updateTransactionListFilter({
        dateType: dateRange.dateType,
        maxTime: dateRange.maxTime,
        minTime: dateRange.minTime
    });

    updateUrlWhenChanged(changed);
}

function changeCustomDateFilter(minTime: number, maxTime: number): void {
    if (!minTime || !maxTime) {
        return;
    }

    let dateType: number | null = getDateTypeByBillingCycleDateRange(minTime, maxTime, firstDayOfWeek.value, fiscalYearStart.value, DateRangeScene.Normal, accountsStore.getAccountStatementDate(query.value.accountIds));

    if (!dateType) {
        dateType = getDateTypeByDateRange(minTime, maxTime, firstDayOfWeek.value, fiscalYearStart.value, DateRangeScene.Normal);
    }

    if (query.value.dateType === dateType && query.value.maxTime === maxTime && query.value.minTime === minTime) {
        showCustomDateRangeDialog.value = false;
        return;
    }

    const changed = transactionsStore.updateTransactionListFilter({
        dateType: dateType,
        maxTime: maxTime,
        minTime: minTime
    });

    showCustomDateRangeDialog.value = false;
    updateUrlWhenChanged(changed);
}

function changeTypeFilter(type: number): void {
    let newCategoryFilter: string | undefined = undefined;

    if (type && query.value.categoryIds) {
        newCategoryFilter = '';

        for (const categoryId of keys(queryAllFilterCategoryIds.value)) {
            const category = allCategories.value[categoryId];

            if (category && category.type === transactionTypeToCategoryType(type)) {
                if (newCategoryFilter.length > 0) {
                    newCategoryFilter += ',';
                }

                newCategoryFilter += categoryId;
            }
        }
    }

    const changed = transactionsStore.updateTransactionListFilter({
        type: type,
        categoryIds: newCategoryFilter
    });

    updateUrlWhenChanged(changed);
}

function changeCategoryFilter(categoryIds: string): void {
    categoryMenuState.value = false;

    if (query.value.categoryIds === categoryIds) {
        return;
    }

    const changed = transactionsStore.updateTransactionListFilter({
        categoryIds: categoryIds
    });

    updateUrlWhenChanged(changed);
}

function changeMultipleCategoriesFilter(changed: boolean): void {
    categoryMenuState.value = false;
    showFilterCategoryDialog.value = false;
    updateUrlWhenChanged(changed);
}

function changeAccountFilter(accountIds: string): void {
    if (query.value.accountIds === accountIds) {
        return;
    }

    const changed = transactionsStore.updateTransactionListFilter({
        accountIds: accountIds
    });

    updateUrlWhenChanged(changed);
}

function changeMultipleAccountsFilter(changed: boolean): void {
    showFilterAccountDialog.value = false;
    updateUrlWhenChanged(changed);
}

function changeKeywordFilter(keyword: string): void {
    if (query.value.keyword === keyword) {
        return;
    }

    const changed = transactionsStore.updateTransactionListFilter({
        keyword: keyword
    });

    updateUrlWhenChanged(changed);
}

function changeAmountFilter(filterType: string): void {
    currentAmountFilterType.value = '';
    amountMenuState.value = false;

    if (query.value.amountFilter === filterType) {
        return;
    }

    let amountFilter = filterType;

    if (filterType) {
        const amountCount = getAmountFilterParameterCount(filterType);

        if (!amountCount) {
            return;
        }

        if (amountCount === 1) {
            amountFilter += ':' + currentAmountFilterValue1.value;
        } else if (amountCount === 2) {
            if (currentAmountFilterValue2.value < currentAmountFilterValue1.value) {
                snackbar.value?.showMessage('Incorrect amount range');
                return;
            }

            amountFilter += ':' + currentAmountFilterValue1.value + ':' + currentAmountFilterValue2.value;
        } else {
            return;
        }
    }

    if (query.value.amountFilter === amountFilter) {
        return;
    }

    const changed = transactionsStore.updateTransactionListFilter({
        amountFilter: amountFilter
    });

    updateUrlWhenChanged(changed);
}

function add(autoRecognizeClipboardText?: string): void {
    const currentUnixTime = getCurrentUnixTime();

    let newTransactionTime: number | undefined = undefined;

    if (query.value.maxTime && query.value.minTime) {
        if (query.value.maxTime < currentUnixTime) {
            newTransactionTime = query.value.maxTime;
        } else if (currentUnixTime < query.value.minTime) {
            newTransactionTime = query.value.minTime;
        }
    }

    editDialog.value?.open({
        time: newTransactionTime,
        type: query.value.type,
        categoryId: queryAllFilterCategoryIdsCount.value === 1 ? query.value.categoryIds : '',
        accountId: queryAllFilterAccountIdsCount.value === 1 ? query.value.accountIds : '',
        autoRecognizeClipboardText: autoRecognizeClipboardText
    }).then(result => {
        if (result && result.message) {
            snackbar.value?.showMessage(result.message);
        }

        reload(false, false);
    }).catch(error => {
        if (error) {
            snackbar.value?.showError(error);
        }
    });
}

function addByRecognizingClipboardText(): void {
    if (navigator.clipboard && isFunction(navigator.clipboard.readText)) {
        navigator.clipboard.readText().then(text => {
            const clipboardText = text && text.trim() ? text.trim() : '';
            add(clipboardText);
        }).catch(error => {
            logger.error('failed to read clipboard', error);
            add('');
        });
    } else {
        add('');
    }
}

function addByRecognizingImage(): void {
    aiImageRecognitionDialog.value?.open().then(result => {
        const recognizedResponse = result.response;
        const autoUploadRecognizedImage = settingsStore.appSettings.autoUploadTransactionPictureForAIRecognition;

        editDialog.value?.open({
            time: recognizedResponse.time,
            type: recognizedResponse.type,
            categoryId: recognizedResponse.categoryId,
            accountId: recognizedResponse.sourceAccountId,
            destinationAccountId: recognizedResponse.destinationAccountId,
            amount: recognizedResponse.sourceAmount,
            destinationAmount: recognizedResponse.destinationAmount,
            comment: recognizedResponse.comment,
            autoUploadPicture: autoUploadRecognizedImage ? result.imageFile : undefined,
            noTransactionDraft: true
        }).then(result => {
            if (result && result.message) {
                snackbar.value?.showMessage(result.message);
            }

            reload(false, false);
        }).catch(error => {
            if (error) {
                snackbar.value?.showError(error);
            }
        });
    });
}

function exportTransactions(fileExtension: string): void {
    if (exportingData.value) {
        return;
    }

    const nickname = userStore.currentUserNickname;
    let exportFileName = '';

    if (nickname) {
        exportFileName = tt('dataExport.exportFilename', {
            nickname: nickname
        }) + '.' + fileExtension;
    } else {
        exportFileName = tt('dataExport.defaultExportFilename') + '.' + fileExtension;
    }

    const exportTransactionReq = transactionsStore.getExportTransactionDataRequestByTransactionFilter();

    exportingData.value = true;

    userStore.getExportedUserData(fileExtension, exportTransactionReq).then(data => {
        startDownloadFile(exportFileName, data);
        exportingData.value = false;
    }).catch(error => {
        exportingData.value = false;

        if (!error.processed) {
            snackbar.value?.showError(error);
        }
    });
}

function show(transaction: Transaction): void {
    editDialog.value?.open({
        id: transaction.id,
        currentTransaction: transaction
    }).then(result => {
        if (result && result.message) {
            snackbar.value?.showMessage(result.message);
        }

        reload(false, false);
    }).catch(error => {
        if (error) {
            snackbar.value?.showError(error);
        }
    });
}

function scrollTimeMenuToSelectedItem(opened: boolean): void {
    if (opened) {
        scrollMenuToSelectedItem(timeFilterMenu.value);
    }
}

function scrollCategoryMenuToSelectedItem(opened: boolean): void {
    if (opened) {
        scrollMenuToSelectedItem(categoryFilterMenu.value);
    }
}

function scrollAmountMenuToSelectedItem(opened: boolean): void {
    if (opened) {
        currentAmountFilterType.value = '';

        let amount1 = 0, amount2 = 0;

        if (isString(query.value.amountFilter)) {
            try {
                const filterItems = query.value.amountFilter.split(':');
                const amountCount = getAmountFilterParameterCount(filterItems[0] as string);

                if (filterItems.length === 2 && amountCount === 1) {
                    amount1 = parseInt(filterItems[1] as string);
                } else if (filterItems.length === 3 && amountCount === 2) {
                    amount1 = parseInt(filterItems[1] as string);
                    amount2 = parseInt(filterItems[2] as string);
                }
            } catch (ex) {
                logger.warn('cannot parse amount from filter value, original value is ' + query.value.amountFilter, ex);
            }
        }

        currentAmountFilterValue1.value = amount1;
        currentAmountFilterValue2.value = amount2;

        scrollMenuToSelectedItem(amountFilterMenu.value);
    }
}

function scrollAccountMenuToSelectedItem(opened: boolean): void {
    if (opened) {
        scrollMenuToSelectedItem(accountFilterMenu.value);
    }
}

function scrollMenuToSelectedItem(menu: VMenu | null): void {
    nextTick(() => {
        scrollToSelectedItem(menu?.contentEl, 'div.v-list', 'div.v-list', 'div.v-list-item.list-item-selected');
    });
}

function onShowDateRangeError(message: string): void {
    snackbar.value?.showError(message);
}

onBeforeRouteUpdate((to) => {
    if (to.query) {
        init({
            initDateType: (to.query['dateType'] as string | null) || undefined,
            initMinTime: (to.query['minTime'] as string | null) || undefined,
            initMaxTime: (to.query['maxTime'] as string | null) || undefined,
            initType: (to.query['type'] as string | null) || undefined,
            initCategoryIds: (to.query['categoryIds'] as string | null) || undefined,
            initAccountIds: (to.query['accountIds'] as string | null) || undefined,
            initAmountFilter: (to.query['amountFilter'] as string | null) || undefined,
            initKeyword: (to.query['keyword'] as string | null) || undefined,
            initMatchMode: (to.query['matchMode'] as string | null) || undefined
        });
    } else {
        init({});
    }
});

watch(() => desktopPageStore.showAddTransactionDialogInTransactionList, (newValue) => {
    if (newValue) {
        desktopPageStore.resetShowAddTransactionDialogInTransactionList();
        add();
    }
});

init(props);
</script>

<style>
.transaction-keyword-filter {
    flex: 0 1 19rem;
    min-width: 15rem;
}

.transaction-keyword-filter .v-input--density-compact {
    --v-input-control-height: 38px !important;
    --v-input-padding-top: 5px !important;
    --v-input-padding-bottom: 5px !important;
    --v-input-chips-margin-top: 0px !important;
    --v-input-chips-margin-bottom: 0px !important;
    inline-size: 100%;

    .v-field__input {
        min-block-size: 38px !important;
    }
}

.transaction-date-range-filter {
    flex: 0 0 155px;
    width: 155px;
}

.transaction-list-custom-datetime-range {
    line-height: 1rem;
}

.v-table.transaction-table > .v-table__wrapper > table {
    width: 100%;
    min-width: 840px;
    table-layout: fixed;

    th,
    td {
        width: auto !important;
        min-width: 0 !important;
        white-space: nowrap;
    }

    td:not([colspan]) {
        overflow: hidden;
        text-overflow: ellipsis;
    }
}

.v-table.transaction-table {
    .transaction-list-row-date > td {
        font-size: 0.8rem;
        height: 42px !important;
    }

    .transaction-table-column-category .v-btn,
    .transaction-table-column-account .v-btn {
        font-size: 0.75rem;

        .v-btn__append {
            margin-inline-start: 0in;
        }
    }

}

.transaction-time-menu .item-icon,
.transaction-category-menu .item-icon,
.transaction-amount-menu .item-icon,
.transaction-account-menu .item-icon,
.transaction-table .item-icon {
    padding-bottom: 3px;
}

.transaction-amount-filter-value {
    width: 100px;
}

.transaction-amount-filter-value input.v-field__input {
    min-height: 32px !important;
    padding: 0 8px 0 8px;
}

.transaction-category-menu .has-children-item-selected span,
.transaction-category-menu .item-in-multiple-selection span,
.transaction-account-menu .item-in-multiple-selection span {
    font-weight: bold;
}

.transaction-toolbar {
    flex-wrap: wrap;
    width: 100%;
}

.transaction-period-summary {
    flex: 0 0 auto;
    padding-inline-start: 12px;
    border-inline-start: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    font-size: 0.875rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}

.transaction-toolbar-actions {
    flex: 0 1 auto;
    flex-wrap: nowrap;
    min-width: 0;
}

.transaction-type-filter {
    flex: 0 0 150px;
    width: 150px;
}

.transaction-pagination {
    display: grid;
    grid-template-columns: minmax(190px, 1fr) auto minmax(190px, 1fr);
    align-items: center;
    gap: 16px;
    padding-inline: 24px;
}

.transaction-pagination > :first-child {
    grid-column: 2;
}

.transaction-page-size-control {
    grid-column: 3;
    justify-self: end;
}

.transaction-page-size {
    flex: 0 0 84px;
    width: 84px;
}

.transaction-empty-cell {
    padding: 0 !important;
}

.transaction-empty-state {
    min-height: clamp(260px, 45vh, 520px);
}

@media (max-width: 1279px) {
    .transaction-toolbar-actions {
        flex-basis: 100%;
        justify-content: flex-end;
        margin-inline-start: 0 !important;
    }
}

@media (max-width: 959px) {
    .transaction-keyword-filter {
        flex: 1 1 auto;
        min-width: 12rem;
    }

    .transaction-pagination {
        grid-template-columns: 1fr auto 1fr;
        padding-inline: 16px;
    }
}

@media (max-width: 700px) {
    .transaction-toolbar-leading,
    .transaction-toolbar-actions {
        flex-basis: 100%;
        flex-wrap: wrap;
    }

    .transaction-toolbar-actions {
        justify-content: stretch;
    }

    .transaction-keyword-filter {
        order: 3;
        flex-basis: 100%;
    }

    .transaction-pagination {
        display: flex;
        flex-direction: column;
        justify-content: center;
    }

    .transaction-page-size-control {
        align-self: center;
    }
}
</style>
