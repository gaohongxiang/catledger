<template>
    <div class="results-flow">
        <v-alert type="error" variant="tonal" closable v-model="showError">
            {{ tt('personalFinance.organizerV2.error') }}
        </v-alert>

        <section class="empty-stage" v-if="!update && !loading">
            <div>
                <span class="kicker">{{ tt('personalFinance.organizerV2.start.eyebrow') }}</span>
                <h2>{{ tt('personalFinance.organizerV2.start.title') }}</h2>
                <p>{{ tt('personalFinance.organizerV2.start.hint') }}</p>
            </div>
            <div class="source-picker">
                <article :key="batch.id" v-for="batch in selectedBatches">
                    <span>
                        <strong>{{ batch.file?.originalFileName || `${tt('personalFinance.organizerV2.start.batch')} #${batch.id}` }}</strong>
                        <small>{{ tt(getSourceTypeKey(batch.sourceType)) }} · {{ batch.validRowCount }} {{ tt('personalFinance.organizerV2.rows') }}</small>
                    </span>
                    <v-btn density="compact" variant="text" :icon="mdiClose" :aria-label="tt('personalFinance.organizerV2.start.remove')" @click="removeBatch(batch.id)" />
                </article>
                <div class="source-add">
                    <import-upload-button
                        variant="text"
                        :label="tt('personalFinance.organizerV2.start.add')"
                        @changed="onImportChanged"
                    />
                </div>
            </div>
            <div class="actions" v-if="selectedBatchIds.length">
                <v-btn class="round-primary-action" color="primary" size="large" :loading="busy || checkingPaymentAccounts" @click="startOrganizing">
                    {{ tt('personalFinance.organizerV2.start.action', { count: selectedBatchIds.length }) }}
                </v-btn>
            </div>
        </section>

        <template v-else-if="update">
            <section class="overview-card">
                <div class="steps">
                    <button @click="activeWorkflowStep = 1" :class="{ active: activeWorkflowStep === 1 }">
                        <b>1</b><span>{{ tt('personalFinance.organizerV2.workflow.upload') }}<strong>{{ update.sourceCount }}</strong></span>
                    </button>
                    <button class="attention" @click="showEventStep('needs_action')" :class="{ active: activeWorkflowStep === 2 }">
                        <b>2</b><span>{{ tt('personalFinance.organizerV2.workflow.review') }}<strong>{{ issueGroupCount }}</strong><small>{{ tt('personalFinance.organizerV2.workflow.eventCount', { count: update.needsActionEventCount }) }}</small></span>
                    </button>
                    <button @click="showPostingStep" :class="{ active: activeWorkflowStep === 3 }">
                        <b>3</b><span>{{ tt(postingStepLabelKey) }}<strong>{{ postingStepCount }}</strong></span>
                    </button>
                </div>
                <footer v-if="activeWorkflowStep === 2">
                    <div class="overview-controls">
                        <v-btn-toggle density="compact" divided mandatory variant="outlined" v-model="eventFilter">
                            <v-btn :value="filter" :key="filter" v-for="filter in visibleFilters">
                                {{ tt(`personalFinance.organizerV2.filter.${filter}`) }} <b>{{ eventFilterCount(filter) }}</b>
                            </v-btn>
                        </v-btn-toggle>
                        <small class="conservation-inline" :class="{ invalid: !conservationHolds }">
                            {{ tt('personalFinance.organizerV2.audit.compactSummary', { evidence: update.validEvidenceCount, duplicates: update.duplicateEvidenceCount, excluded: update.excludedEventCount, anomaly: excludedAnomalyCount, ready: update.readyEventCount, pending: update.needsActionEventCount, posted: update.postedEventCount }) }}
                        </small>
                    </div>
                </footer>
            </section>

            <section class="source-stage" v-if="activeWorkflowStep === 1">
                <header>
                    <div><h3>{{ tt('personalFinance.organizerV2.sources.title') }}</h3><p>{{ tt('personalFinance.organizerV2.sources.lockedHint') }}</p></div>
                    <v-btn variant="outlined" color="warning" v-if="canAbandonUpdate(update)" @click="showAbandon = true">
                        {{ tt('personalFinance.organizerV2.action.abandonAndReselect') }}
                    </v-btn>
                    <import-upload-button v-else-if="update.status === 'posted' || update.status === 'undone'" @changed="onImportChanged" />
                </header>
                <article :key="item.source.id" v-for="item in currentSources">
                    <div><strong>{{ item.batch?.file?.originalFileName || tt(getSourceTypeKey(item.source.sourceType)) }}</strong><small>{{ tt(getSourceTypeKey(item.source.sourceType)) }} · {{ item.batch?.validRowCount ?? 0 }} 条</small></div>
                    <span>{{ tt('personalFinance.organizerV2.sources.selected') }}</span>
                </article>
                <footer v-if="update.needsActionEventCount > 0">
                    <v-btn class="round-primary-action" color="primary" @click="showEventStep('needs_action')">
                        {{ tt('personalFinance.organizerV2.action.continueReview', { count: issueGroupCount }) }}
                    </v-btn>
                </footer>
            </section>

            <section class="posting-complete" v-if="activeWorkflowStep === 3 && postingStepShowsPosted">
                <span class="kicker">{{ tt('personalFinance.organizerV2.posted.eyebrow') }}</span>
                <strong>{{ tt('personalFinance.organizerV2.posted.title', { count: update.postedEventCount }) }}</strong>
                <p>{{ tt('personalFinance.organizerV2.posted.hint') }}</p>
                <v-btn variant="text" color="warning" v-if="canUndoUpdate(update)" @click="inspectUndo">
                    {{ tt('personalFinance.organizerV2.action.undo') }}
                </v-btn>
            </section>

            <section class="evidence-audit" v-else-if="activeWorkflowStep !== 1 && eventFilter === 'audit'">
                <header>
                    <div>
                        <h3>{{ tt('personalFinance.organizerV2.audit.title') }}</h3>
                        <p>{{ tt('personalFinance.organizerV2.audit.hint') }}</p>
                    </div>
                    <div class="audit-total">
                        <strong>{{ update.duplicateEvidenceCount }}</strong>
                        <span>{{ tt('personalFinance.organizerV2.audit.additionalEvidence') }}</span>
                        <small>{{ tt('personalFinance.organizerV2.audit.groupCount', { count: auditEvents.length }) }}</small>
                    </div>
                </header>
                <v-skeleton-loader type="list-item-two-line@4" v-if="loadingAudit" />
                <div class="audit-list" v-else-if="auditEvents.length">
                    <article :key="event.id" v-for="event in auditEvents">
                        <div class="audit-kind">
                            <span>{{ auditGroupLabel(event) }}</span>
                            <small>{{ auditGroupEquation(event) }}</small>
                        </div>
                        <time><b>{{ eventDay(event.eventUnixTime) }}</b><small>{{ eventMonth(event.eventUnixTime) }}</small></time>
                        <div class="audit-result">
                            <strong>{{ eventDisplayLabel(event) || tt('personalFinance.organizerV2.events.unnamed') }}</strong>
                            <small>{{ eventAccountName(event) }} · {{ tt(`personalFinance.organizerV2.nature.${event.economicNature}`) }} · {{ eventCategoryName(event) }}</small>
                        </div>
                        <p>{{ auditGroupRule(event) }}</p>
                        <b class="amount" :class="event.flowDirection">{{ formatEventAmount(event) }}</b>
                        <v-btn class="raw-record-action" size="small" variant="text" @click="openEvidence(event)">{{ tt('personalFinance.organizerV2.audit.reviewRecords', { count: event.evidenceCount }) }}</v-btn>
                    </article>
                </div>
                <p class="audit-empty" v-if="!loadingAudit && !auditEvents.length">{{ tt('personalFinance.organizerV2.audit.empty') }}</p>
            </section>

            <section class="workbench" v-else-if="activeWorkflowStep !== 1 && eventFilter !== 'audit'">
                <header>
                    <div><h3>{{ tt(`personalFinance.organizerV2.filter.${eventFilter}`) }}</h3><p>{{ tt(`personalFinance.organizerV2.events.tabHint.${eventFilter}`, { count: eventFilterCount(eventFilter) }) }}</p></div>
                    <v-btn class="post-all-action" color="primary" :loading="busy" :disabled="!canPostUpdate(update)" v-if="eventFilter === 'ready'" @click="postAllReady">
                        {{ update.needsActionEventCount > 0 ? tt('personalFinance.organizerV2.action.resolveBeforePost', { count: issueGroupCount }) : tt('personalFinance.organizerV2.action.confirmAndPost', { count: update.readyEventCount }) }}
                    </v-btn>
                </header>

                <div class="category-toolbar" v-if="eventFilter === 'ready' && uncategorizedEvents.length">
                    <div class="category-toolbar-copy">
                        <strong>{{ tt('personalFinance.organizerV2.category.pendingCount', { count: uncategorizedEvents.length }) }}</strong>
                        <span>{{ tt('personalFinance.organizerV2.category.optionalHint') }}</span>
                    </div>
                    <v-btn class="category-filter-action" size="small" density="comfortable" variant="outlined" color="primary" @click="showOnlyUncategorized = !showOnlyUncategorized">
                        {{ tt(showOnlyUncategorized ? 'personalFinance.organizerV2.category.showAll' : 'personalFinance.organizerV2.category.showOnlyPending') }}
                    </v-btn>
                </div>

                <v-skeleton-loader type="list-item-three-line@4" v-if="loadingEvents" />

                <div class="issue-list" v-else-if="eventFilter === 'needs_action' && reviewIssues.length">
                    <article class="issue-card" :key="issue.id" v-for="issue in sortedReviewIssues">
                        <header>
                            <div class="issue-heading"><span>{{ reviewIssueLabel(issue) }}</span><small>{{ reviewIssueHint(issue) }}</small></div>
                            <div class="issue-actions">
                                <em v-if="reviewIssueCount(issue) > 1">{{ tt('personalFinance.organizerV2.issue.count', { count: reviewIssueCount(issue) }) }}</em>
                                <v-btn size="small" density="compact" color="primary" :loading="busy" @click="openIssueResolve(issue)">{{ reviewIssueActionLabel(issue) }}</v-btn>
                            </div>
                        </header>
                        <div class="issue-events">
                            <div class="issue-event" :key="event.id" v-for="event in issueEvents(issue)">
                                <time><b>{{ eventDay(event.eventUnixTime) }}</b><small>{{ eventMonth(event.eventUnixTime) }}</small></time>
                                <div class="issue-event-copy">
                                    <strong>{{ issueEventTitle(event) }}</strong>
                                    <small v-if="issueEventDescription(event)">{{ issueEventDescription(event) }}</small>
                                    <div class="account-route" v-if="isAccountMovement(event)">
                                        <span :class="{ pending: !event.ledgerAccountId }">{{ movementSourceName(event) }}</span>
                                        <i aria-hidden="true">→</i>
                                        <span :class="{ pending: !event.counterpartyLedgerAccountId }">{{ movementDestinationName(event) }}</span>
                                    </div>
                                    <span v-else>{{ tt(`personalFinance.organizerV2.nature.${event.economicNature}`) }} · {{ eventAccountName(event) }} · {{ eventCategoryName(event) }}</span>
                                </div>
                                <b class="amount" :class="event.flowDirection">{{ formatEventAmount(event) }}</b>
                                <v-btn class="raw-record-action" size="small" variant="text" @click="openEvidence(event)">{{ tt('personalFinance.organizerV2.events.evidenceCount', { count: event.evidenceCount }) }}</v-btn>
                            </div>
                        </div>
                    </article>
                </div>

                <div class="event-list" v-else-if="visibleEvents.length">
                    <article class="event-row" :class="{ 'excluded-record': eventFilter === 'excluded' }" :key="event.id" v-for="event in visibleEvents">
                        <div class="event-kind" v-if="eventFilter === 'excluded'"><span>{{ eventExcludedLabel(event) }}</span></div>
                        <time><b>{{ eventDay(event.eventUnixTime) }}</b><small>{{ eventMonth(event.eventUnixTime) }}</small></time>
                        <div class="event-copy"><span :class="event.economicNature" v-if="eventFilter !== 'excluded'">{{ tt(`personalFinance.organizerV2.nature.${event.economicNature}`) }}</span><strong>{{ eventDisplayLabel(event) || tt('personalFinance.organizerV2.events.unnamed') }}</strong><small v-if="eventDescription(event)">{{ eventDescription(event) }}</small></div>
                        <div class="context" v-if="eventFilter === 'excluded'">{{ eventExcludedContext(event) }}</div>
                        <div class="context event-account" v-else>{{ eventAccountName(event) }}</div>
                        <div class="category-field" v-if="eventFilter !== 'excluded'">
                            <span :class="{ pending: isCategorisable(event) && !event.categoryId }">{{ eventCategoryName(event) }}</span>
                            <button class="category-edit-action" type="button" v-if="eventFilter === 'ready' && isCategorisable(event) && update.status === 'review'" @click="openCategoryCorrection(event)">
                                {{ tt(event.categoryId ? 'personalFinance.organizerV2.category.modify' : 'personalFinance.organizerV2.category.action') }}
                            </button>
                        </div>
                        <b class="amount" :class="event.flowDirection">{{ formatEventAmount(event) }}</b>
                        <div class="row-actions">
                            <v-btn class="raw-record-action" size="small" variant="text" @click="openEvidence(event)">{{ tt('personalFinance.organizerV2.events.evidenceCount', { count: event.evidenceCount }) }}</v-btn>
                        </div>
                    </article>
                </div>
                <div class="empty" v-else>{{ tt(eventFilter === 'needs_action' && update.needsActionEventCount === 0 ? 'personalFinance.organizerV2.events.reviewComplete' : 'personalFinance.organizerV2.events.empty') }}</div>
            </section>
        </template>

        <v-skeleton-loader type="heading, image, list-item-three-line@3" v-else />

        <payment-account-setup-dialog ref="paymentAccountSetupDialog" @saved="createAndOrganize" />

        <v-dialog max-width="980" v-model="showEvidence">
            <v-card class="evidence-dialog">
                <v-card-title class="evidence-dialog-title">
                    <span>{{ tt('personalFinance.organizerV2.evidence.title') }}</span>
                    <small v-if="evidence">{{ tt('personalFinance.organizerV2.events.evidenceCount', { count: evidence.evidence.length }) }}</small>
                </v-card-title>
                <v-card-text class="evidence-dialog-body">
                    <v-skeleton-loader type="list-item-three-line@3" v-if="loadingEvidence" />
                    <div class="evidence-list" v-else>
                        <aside class="audit-explanation" v-if="selectedEvidenceEvent && selectedEvidenceEvent.evidenceCount > 1">
                            <div><span>{{ auditGroupLabel(selectedEvidenceEvent) }}</span><strong>{{ auditGroupEquation(selectedEvidenceEvent) }}</strong></div>
                            <p>{{ auditGroupRule(selectedEvidenceEvent) }}</p>
                            <small>{{ tt('personalFinance.organizerV2.audit.amountWarning') }}</small>
                        </aside>
                        <article class="evidence-record" :class="item.evidenceRole" :key="item.id" v-for="item in evidence?.evidence">
                            <header>
                                <div><strong>{{ evidenceFileName(item) }}</strong><small>{{ evidenceSourceMeta(item) }}</small></div>
                                <span>{{ evidenceRoleLabel(item) }} · {{ tt('personalFinance.organizerV2.evidence.originalFields', { count: item.row.rawFields.length }) }}</span>
                            </header>
                            <dl class="raw-fields" v-if="item.row.rawFields.length">
                                <div :key="`${index}-${field.name}`" v-for="(field, index) in item.row.rawFields">
                                    <dt>{{ field.name || tt('personalFinance.organizerV2.evidence.unnamedField') }}</dt>
                                    <dd>{{ field.value || '—' }}</dd>
                                </div>
                            </dl>
                            <p class="empty-fields" v-else>{{ tt('personalFinance.organizerV2.evidence.emptyFields') }}</p>
                        </article>
                        <p v-if="!evidence?.evidence.length">{{ tt('personalFinance.organizerV2.evidence.empty') }}</p>
                    </div>
                </v-card-text>
                <v-card-actions><v-spacer /><v-btn @click="showEvidence = false">{{ tt('Close') }}</v-btn></v-card-actions>
            </v-card>
        </v-dialog>

        <v-dialog max-width="780" v-model="showResolve">
            <v-card>
                <v-card-title>{{ tt(resolveDialogTitleKey) }}</v-card-title>
                <v-card-text>
                    <div class="resolve-preview" v-if="selectedEvent">
                        <div><strong>{{ eventDisplayLabel(selectedEvent) || tt('personalFinance.organizerV2.events.unnamed') }}</strong><small>{{ reviewIssueLabel(selectedIssue) }} · {{ reviewIssueScope(selectedIssue) }}</small></div>
                        <b :class="selectedEvent.flowDirection">{{ formatEventAmount(selectedEvent) }}</b>
                    </div>
                    <template v-if="selectedIssue?.type === 'same_event'">
                        <p class="hint">{{ tt('personalFinance.organizerV2.resolve.relationship.hint') }}</p>
                        <v-radio-group class="relationship-options" hide-details v-model="selectedSameEventDecision">
                            <v-radio value="confirm_same">
                                <template #label><div class="relationship-option-copy"><strong>{{ tt('personalFinance.organizerV2.resolve.relationship.same') }}</strong><small>{{ tt('personalFinance.organizerV2.resolve.relationship.sameHint') }}</small></div></template>
                            </v-radio>
                            <v-radio value="confirm_distinct">
                                <template #label><div class="relationship-option-copy"><strong>{{ tt('personalFinance.organizerV2.resolve.relationship.distinct') }}</strong><small>{{ tt('personalFinance.organizerV2.resolve.relationship.distinctHint') }}</small></div></template>
                            </v-radio>
                        </v-radio-group>
                    </template>
                    <template v-else-if="selectedIssue?.type === 'refund_relation'">
                        <p class="hint">请选择原消费。系统会校验币种、金额、时间和累计退款金额；退款只冲减消费，不计为收入。</p>
                        <v-select :loading="loadingRefundCandidates" :items="refundCandidateOptions" item-title="title" item-value="value" variant="outlined" label="原消费" v-model="selectedRefundTargetEventId" />
                    </template>
                    <template v-else-if="selectedIssue?.type === 'installment_origin'">
                        <p class="hint">{{ tt('personalFinance.organizerV2.resolve.installment.hint') }}</p>
                        <div class="installment-candidate-facts" v-if="installmentCandidate">
                            <span v-if="installmentCandidate.termCount">{{ tt('personalFinance.organizerV2.resolve.installment.termCount', { count: installmentCandidate.termCount }) }}</span>
                            <span v-if="installmentCandidate.currentPeriod">{{ tt('personalFinance.organizerV2.resolve.installment.currentPeriod', { count: installmentCandidate.currentPeriod }) }}</span>
                            <span>{{ installmentCandidate.liabilityAccountId ? accountName(installmentCandidate.liabilityAccountId) : tt('personalFinance.organizerV2.resolve.installment.liabilityPending') }}</span>
                        </div>
                        <v-radio-group class="relationship-options" hide-details v-model="selectedInstallmentDecision">
                            <v-radio value="existing" :disabled="loadingExistingInstallmentContracts || compatibleInstallmentContracts.length < 1">
                                <template #label><div class="relationship-option-copy"><strong>{{ tt('personalFinance.organizerV2.resolve.installment.existing', { count: compatibleInstallmentContracts.length }) }}</strong><small>{{ tt('personalFinance.organizerV2.resolve.installment.existingHint') }}</small></div></template>
                            </v-radio>
                            <v-radio value="create" :disabled="loadingInstallmentCandidate || !installmentCandidate">
                                <template #label><div class="relationship-option-copy"><strong>{{ tt('personalFinance.organizerV2.resolve.installment.create') }}</strong><small>{{ tt('personalFinance.organizerV2.resolve.installment.createHint') }}</small></div></template>
                            </v-radio>
                            <v-radio value="placeholder" :disabled="loadingInstallmentCandidate || installmentCandidate?.status !== 'pending'">
                                <template #label><div class="relationship-option-copy"><strong>{{ tt('personalFinance.organizerV2.resolve.installment.placeholder') }}</strong><small>{{ tt('personalFinance.organizerV2.resolve.installment.placeholderHint') }}</small></div></template>
                            </v-radio>
                            <v-radio value="expense">
                                <template #label><div class="relationship-option-copy"><strong>{{ tt('personalFinance.organizerV2.resolve.installment.notInstallment') }}</strong><small>{{ tt('personalFinance.organizerV2.resolve.installment.notInstallmentHint') }}</small></div></template>
                            </v-radio>
                        </v-radio-group>
                        <v-expansion-panels class="existing-installment-picker" variant="accordion" v-if="selectedInstallmentDecision === 'existing'">
                            <v-expansion-panel>
                                <v-expansion-panel-title>
                                    <div class="existing-installment-selection">
                                        <strong>{{ selectedExistingInstallmentContract?.contract.name }}</strong>
                                        <small>{{ tt('personalFinance.organizerV2.resolve.installment.existingListHint', { count: compatibleInstallmentContracts.length }) }}</small>
                                    </div>
                                </v-expansion-panel-title>
                                <v-expansion-panel-text>
                                    <v-radio-group class="existing-installment-list" hide-details v-model="selectedExistingInstallmentContractId">
                                        <v-radio :key="summary.contract.id" :value="summary.contract.id" v-for="summary in compatibleInstallmentContracts">
                                            <template #label>
                                                <div class="existing-installment-option">
                                                    <div><strong>{{ summary.contract.name }}</strong><span v-if="summary.contract.id === recommendedExistingInstallmentContractId">{{ tt('personalFinance.organizerV2.resolve.installment.recommended') }}</span></div>
                                                    <small>{{ accountName(summary.contract.liabilityAccountId) }} · {{ tt('personalFinance.organizerV2.resolve.installment.contractProgress', { paid: summary.paidInstallmentCount, total: summary.totalInstallmentCount }) }}</small>
                                                </div>
                                            </template>
                                        </v-radio>
                                    </v-radio-group>
                                </v-expansion-panel-text>
                            </v-expansion-panel>
                        </v-expansion-panels>
                        <div class="installment-contract-form" v-if="selectedInstallmentDecision === 'create'">
                            <header class="installment-editor-heading">
                                <div>
                                    <div>{{ tt('personalFinance.loans.installmentRecord.eyebrow') }}</div>
                                    <h3>{{ tt('personalFinance.loans.installmentRecord.editorTitle') }}</h3>
                                    <p>{{ tt('personalFinance.loans.installmentRecord.editorSubtitle') }}</p>
                                </div>
                            </header>
                            <v-alert class="mx-5 mt-5 mb-0" type="info" variant="tonal">
                                {{ tt('personalFinance.loans.installmentRecord.boundary') }}
                            </v-alert>
                            <loan-contract-form
                                compact-installment
                                embedded
                                :liability-accounts="installmentLiabilityAccounts"
                                :payment-accounts="installmentPaymentAccounts"
                                :model-value="installmentContractIdentity"
                                @update:model-value="updateInstallmentIdentity"
                            />
                            <loan-calculator-panel
                                compact-installment
                                embedded
                                :currency="installmentContractIdentity.currency"
                                :loading="calculatingInstallment"
                                :model-value="installmentCalculation"
                                :opening-completed-installment-count="installmentOpeningCompletedCount"
                                purpose="installment-record"
                                :result="installmentCalculationResult"
                                @calculate="calculateInstallmentDraft"
                                @update:model-value="updateInstallmentCalculation"
                                @update:opening-completed-installment-count="value => installmentOpeningCompletedCount = value"
                            >
                                <template #compact-liability-account>
                                    <v-select
                                        item-title="name"
                                        item-value="id"
                                        :items="installmentLiabilityAccounts"
                                        :label="tt('personalFinance.loans.field.liabilityAccount')"
                                        :model-value="installmentContractIdentity.liabilityAccountId"
                                        @update:model-value="value => updateInstallmentIdentity({ ...installmentContractIdentity, liabilityAccountId: value })"
                                    />
                                </template>
                            </loan-calculator-panel>
                        </div>
                        <v-alert class="mt-4" type="info" variant="tonal" v-else-if="selectedInstallmentDecision === 'placeholder'">
                            {{ tt('personalFinance.organizerV2.resolve.installment.placeholderBoundary') }}
                        </v-alert>
                        <v-row dense v-else-if="selectedInstallmentDecision === 'expense'">
                            <v-col cols="12" md="6"><v-select :items="availableLedgerAccounts" item-title="name" item-value="id" variant="outlined" :label="tt(ledgerAccountFieldLabelKey)" v-model="selectedLedgerAccountId" /></v-col>
                            <v-col cols="12" md="6"><v-select clearable :items="categoryOptions" item-title="title" item-value="value" variant="outlined" :label="tt('personalFinance.organizerV2.resolve.category')" v-model="selectedCategoryId" /></v-col>
                        </v-row>
                    </template>
                    <template v-else>
                        <p class="hint">{{ reviewIssueScopeHint(selectedIssue) }}</p>
                        <v-row dense>
                            <v-col cols="12" md="6"><v-select :items="natureOptions" item-title="title" item-value="value" variant="outlined" :label="tt('personalFinance.organizerV2.resolve.nature')" v-model="selectedNature" /></v-col>
                            <v-col cols="12" md="6"><v-select :items="availableLedgerAccounts" item-title="name" item-value="id" variant="outlined" :label="tt(ledgerAccountFieldLabelKey)" v-model="selectedLedgerAccountId" /></v-col>
                            <v-col cols="12" md="6" v-if="needsCounterpartyAccount"><v-select :items="availableCounterpartyAccounts" item-title="name" item-value="id" variant="outlined" :label="tt(counterpartyAccountFieldLabelKey)" v-model="selectedCounterpartyLedgerAccountId" /></v-col>
                            <v-col cols="12" :md="needsCounterpartyAccount ? 6 : 12"><v-select clearable :items="categoryOptions" item-title="title" item-value="value" variant="outlined" :label="tt('personalFinance.organizerV2.resolve.category')" :hint="tt('personalFinance.organizerV2.resolve.categoryHint')" persistent-hint v-model="selectedCategoryId" /></v-col>
                        </v-row>
                    </template>
                </v-card-text>
                <v-card-actions><v-spacer /><v-btn variant="text" @click="showResolve = false">{{ tt('Cancel') }}</v-btn><v-btn color="primary" :disabled="!canResolveSelected" :loading="busy || loadingInstallmentCandidate || loadingExistingInstallmentContracts" @click="resolveSelected">{{ tt(resolveActionLabelKey) }}</v-btn></v-card-actions>
            </v-card>
        </v-dialog>

        <v-dialog max-width="620" v-model="showCategoryCorrection">
            <v-card>
                <v-card-title>{{ tt('personalFinance.organizerV2.category.title') }}</v-card-title>
                <v-card-text>
                    <div class="resolve-preview" v-if="selectedEvent">
                        <div><strong>{{ eventDisplayLabel(selectedEvent) || tt('personalFinance.organizerV2.events.unnamed') }}</strong><small>{{ eventAccountName(selectedEvent) }} · {{ tt(`personalFinance.organizerV2.nature.${selectedEvent.economicNature}`) }}</small></div>
                        <b :class="selectedEvent.flowDirection">{{ formatEventAmount(selectedEvent) }}</b>
                    </div>
                    <p class="hint">{{ tt(update?.status === 'posted' ? 'personalFinance.organizerV2.category.postedHint' : 'personalFinance.organizerV2.category.hint') }}</p>
                    <v-select autofocus :items="categoryOptions" item-title="title" item-value="value" variant="outlined" :label="tt('personalFinance.organizerV2.resolve.category')" v-model="selectedCategoryId" />
					<div class="category-scope-loading" v-if="loadingCategoryScope"><v-progress-circular indeterminate size="16" width="2" />{{ tt('personalFinance.organizerV2.category.scopeChecking') }}</div>
                    <div class="category-scope" v-if="canBatchCategoryCorrection">
                        <strong>{{ tt('personalFinance.organizerV2.category.scopeTitle') }}</strong>
                        <v-radio-group hide-details v-model="selectedCategoryScope">
                            <v-radio value="matching_uncategorized">
								<template #label><span><b>{{ tt('personalFinance.organizerV2.category.scopeMatching', { count: matchingCategoryEventCount }) }}</b><small>{{ tt('personalFinance.organizerV2.category.scopeMatchingHint') }}</small></span></template>
                            </v-radio>
                            <v-radio value="single">
                                <template #label><span><b>{{ tt('personalFinance.organizerV2.category.scopeSingle') }}</b><small>{{ tt('personalFinance.organizerV2.category.scopeSingleHint') }}</small></span></template>
                            </v-radio>
                        </v-radio-group>
                    </div>
                    <v-alert type="info" variant="tonal">{{ tt('personalFinance.organizerV2.category.learningHint') }}</v-alert>
                </v-card-text>
                <v-card-actions><v-spacer /><v-btn variant="text" @click="showCategoryCorrection = false">{{ tt('Cancel') }}</v-btn><v-btn color="primary" :disabled="!selectedCategoryId || loadingCategoryScope" :loading="busy" @click="saveCategoryCorrection">{{ tt('personalFinance.organizerV2.category.save') }}</v-btn></v-card-actions>
            </v-card>
        </v-dialog>

        <v-dialog max-width="560" v-model="showAbandon">
            <v-card>
                <v-card-title>{{ tt('personalFinance.organizerV2.abandon.title') }}</v-card-title>
                <v-card-text>
                    <p>{{ tt('personalFinance.organizerV2.abandon.hint') }}</p>
                    <v-alert type="info" variant="tonal">{{ tt('personalFinance.organizerV2.abandon.kept') }}</v-alert>
                </v-card-text>
                <v-card-actions><v-spacer /><v-btn @click="showAbandon = false">{{ tt('Cancel') }}</v-btn><v-btn color="warning" :loading="busy" @click="abandonAndReselect">{{ tt('personalFinance.organizerV2.abandon.confirm') }}</v-btn></v-card-actions>
            </v-card>
        </v-dialog>

        <v-dialog max-width="560" v-model="showUndo">
            <v-card><v-card-title>{{ tt('personalFinance.organizerV2.undo.title') }}</v-card-title><v-card-text><p>{{ tt('personalFinance.organizerV2.undo.impact', { transactions: undoImpact?.transactionCount ?? 0 }) }}</p><v-alert type="warning" variant="tonal" v-if="undoImpact && !undoImpact.safeToApply">{{ tt('personalFinance.organizerV2.undo.unsafe') }}</v-alert></v-card-text><v-card-actions><v-spacer /><v-btn @click="showUndo = false">{{ tt('Cancel') }}</v-btn><v-btn color="warning" :disabled="!undoImpact?.safeToApply" :loading="busy" @click="undoCurrent">{{ tt('personalFinance.organizerV2.action.undo') }}</v-btn></v-card-actions></v-card>
        </v-dialog>
    </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue';
import { mdiClose } from '@mdi/js';
import { useI18n } from '@/locales/helpers.ts';
import { generateRandomUUID } from '@/lib/misc.ts';
import { parseBigDecimal } from '@/lib/numeral.ts';
import { useAccountsStore } from '@/stores/account.ts';
import { useTransactionCategoriesStore } from '@/stores/transactionCategory.ts';
import { CategoryType } from '@/core/category.ts';
import { AccountCategory } from '@/core/account.ts';
import type { TransactionCategory } from '@/models/transaction_category.ts';

import ImportUploadButton from '../../components/ImportUploadButton.vue';
import PaymentAccountSetupDialog from '../../components/PaymentAccountSetupDialog.vue';
import { usePersonalFinanceStore } from '../../store.ts';
import { getSourceTypeKey } from '../../presentation.ts';
import type { InstallmentCandidate, InstallmentCandidateStatus } from '../../installments/models.ts';
import { installmentApi } from '../../installments/service.ts';
import type { LoanCalculationInput, LoanCalculationResult, LoanContractIdentityInput, LoanContractSummary } from '../../loans/models.ts';
import { loanApi } from '../../loans/service.ts';
import { createDefaultLoanCalculationInput, validateLoanCalculationInput } from '../../loans/state.ts';
import LoanCalculatorPanel from '../../loans/desktop/components/LoanCalculatorPanel.vue';
import LoanContractForm from '../../loans/desktop/components/LoanContractForm.vue';
import type { EconomicEvent, EconomicEventStatus, EconomicNature, FinanceUpdate, OrganizerEventEvidence, OrganizerEvidenceItem, OrganizerImpact, ReviewIssue, ReviewIssueMember } from '../models.ts';
import { organizerApi } from '../service.ts';
import { RESULT_UPDATE_STATUSES, canAbandonUpdate, canPostUpdate, canUndoUpdate, eventCivilDate, eventDisplayLabel, eventReasonCodes, inferInstallmentFirstDueDate, inferOpeningCompletedInstallmentCount, installmentNameWithFirstDueDate, installmentProductName, reviewIssuePresentation, selectCurrentUpdate, sortEconomicEventsOldestFirst, updateConservationHolds } from '../state.ts';

const { tt, formatAmountToLocalizedNumeralsWithCurrency } = useI18n();
const emit = defineEmits<{ (event: 'sync-label', value: string): void }>();
const accountsStore = useAccountsStore();
const categoriesStore = useTransactionCategoriesStore();
const personalFinanceStore = usePersonalFinanceStore();
type PaymentAccountSetupDialogType = InstanceType<typeof PaymentAccountSetupDialog>;
const paymentAccountSetupDialog = useTemplateRef<PaymentAccountSetupDialogType>('paymentAccountSetupDialog');
const loading = ref(true);
const syncing = ref(false);
const lastSyncedAt = ref(0);
const loadingEvents = ref(false);
const loadingAudit = ref(false);
const loadingEvidence = ref(false);
const loadingRefundCandidates = ref(false);
const loadingCategoryScope = ref(false);
const loadingInstallmentCandidate = ref(false);
const loadingExistingInstallmentContracts = ref(false);
const busy = ref(false);
const checkingPaymentAccounts = ref(false);
const showError = ref(false);
const update = ref<FinanceUpdate>();
const events = ref<readonly EconomicEvent[]>([]);
const auditEvents = ref<readonly EconomicEvent[]>([]);
const excludedAnomalyEvents = ref<readonly EconomicEvent[]>([]);
const uncategorizedEvents = ref<readonly EconomicEvent[]>([]);
const reviewIssues = ref<readonly ReviewIssue[]>([]);
const reviewMembers = ref<readonly ReviewIssueMember[]>([]);
type ResultsFilter = EconomicEventStatus | 'audit';

const eventFilter = ref<ResultsFilter>('needs_action');
const showOnlyUncategorized = ref(false);
const selectedBatchIds = ref<string[]>([]);
const sourceSelectionInitialized = ref(false);
const activeWorkflowStep = ref<1 | 2 | 3>(2);
const showEvidence = ref(false);
const evidence = ref<OrganizerEventEvidence>();
const selectedEvidenceEvent = ref<EconomicEvent>();
const showResolve = ref(false);
const showCategoryCorrection = ref(false);
const selectedIssue = ref<ReviewIssue>();
const selectedEvent = ref<EconomicEvent>();
const selectedNature = ref<EconomicNature>('expense');
const selectedLedgerAccountId = ref('');
const selectedCounterpartyLedgerAccountId = ref('');
const selectedCategoryId = ref('');
const selectedCategoryScope = ref<'single' | 'matching_uncategorized'>('single');
const matchingCategoryEventCount = ref(1);
const selectedRefundTargetEventId = ref('');
const selectedSameEventDecision = ref<'' | 'confirm_same' | 'confirm_distinct'>('');
const selectedInstallmentDecision = ref<'' | 'existing' | 'create' | 'placeholder' | 'expense'>('');
const installmentCandidate = ref<InstallmentCandidate>();
const existingInstallmentContracts = ref<readonly LoanContractSummary[]>([]);
const selectedExistingInstallmentContractId = ref('');
const calculatingInstallment = ref(false);
const installmentCalculationResult = ref<LoanCalculationResult>();
const installmentContractIdentity = ref<LoanContractIdentityInput>(emptyInstallmentIdentity());
const installmentCalculation = ref<LoanCalculationInput>(emptyInstallmentCalculation());
const installmentOpeningCompletedCount = ref(0);
const installmentAutoNameBase = ref('');
const installmentAutoName = ref('');
const refundCandidates = ref<readonly EconomicEvent[]>([]);
const showAbandon = ref(false);
const showUndo = ref(false);
const undoImpact = ref<OrganizerImpact>();
const auditEventStatuses: readonly EconomicEventStatus[] = ['needs_action', 'ready', 'posted', 'excluded'];
const visibleFilters: readonly ResultsFilter[] = ['needs_action', 'excluded', 'audit'];
const natures: readonly EconomicNature[] = ['expense', 'income', 'refund', 'fee', 'repayment', 'borrow', 'internal_transfer', 'balance_adjustment'];
const readyBatches = computed(() => personalFinanceStore.batches.filter(batch => batch.status === 'ready'));
const selectedBatches = computed(() => {
    const selected = new Set(selectedBatchIds.value);
    return readyBatches.value.filter(batch => selected.has(batch.id));
});
const canInspectCategoryCorrectionScope = computed(() => update.value?.status === 'review' && !!selectedEvent.value && !selectedEvent.value.categoryId);
const canBatchCategoryCorrection = computed(() => canInspectCategoryCorrectionScope.value && !loadingCategoryScope.value && matchingCategoryEventCount.value > 1);
const conservationHolds = computed(() => !!update.value && updateConservationHolds(update.value));
const excludedAnomalyCount = computed(() => excludedAnomalyEvents.value.length);
const syncLabel = computed(() => {
    if (syncing.value) return tt('personalFinance.organizerV2.sync.syncing');
    if (!lastSyncedAt.value) return tt('personalFinance.organizerV2.sync.pending');
    const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(lastSyncedAt.value);
    return tt('personalFinance.organizerV2.sync.syncedAt', { time });
});
watch(syncLabel, value => emit('sync-label', value), { immediate: true });
const natureOptions = computed(() => natures.map(value => ({ value, title: tt(`personalFinance.organizerV2.nature.${value}`) })));
const availableLedgerAccounts = computed(() => accountsStore.allVisiblePlainAccounts.filter(account => !selectedEvent.value?.currency || account.currency === selectedEvent.value.currency));
const needsCounterpartyAccount = computed(() => ['internal_transfer', 'repayment', 'borrow'].includes(selectedNature.value));
const availableCounterpartyAccounts = computed(() => accountsStore.allVisiblePlainAccounts.filter(account => account.id !== selectedLedgerAccountId.value && (!selectedEvent.value?.currency || account.currency === selectedEvent.value.currency)));
const installmentLiabilityAccounts = computed(() => accountsStore.allVisiblePlainAccounts
    .filter(account => account.category === AccountCategory.CreditCard.type || account.category === AccountCategory.DebtAccount.type)
    .map(account => ({ id: account.id, name: account.name, currency: account.currency })));
const installmentPaymentAccounts = computed(() => accountsStore.allVisiblePlainAccounts
    .filter(account => account.isAsset && account.currency === installmentContractIdentity.value.currency)
    .map(account => ({ id: account.id, name: account.name, currency: account.currency })));
const compatibleInstallmentContracts = computed(() => rankCompatibleInstallmentContracts(installmentCandidate.value, selectedEvent.value, existingInstallmentContracts.value));
const recommendedExistingInstallmentContractId = computed(() => compatibleInstallmentContracts.value[0]?.contract.id ?? '');
const selectedExistingInstallmentContract = computed(() => compatibleInstallmentContracts.value.find(summary => summary.contract.id === selectedExistingInstallmentContractId.value));
const ledgerAccountFieldLabelKey = computed(() => {
    if (selectedNature.value === 'income') return 'personalFinance.organizerV2.resolve.incomeAccount';
    if (selectedNature.value === 'refund') return 'personalFinance.organizerV2.resolve.refundAccount';
    if (selectedNature.value === 'expense' || selectedNature.value === 'fee') return 'personalFinance.organizerV2.resolve.expenseAccount';
    if (selectedNature.value === 'repayment') return 'personalFinance.organizerV2.resolve.repaymentSourceAccount';
    if (selectedNature.value === 'internal_transfer') return 'personalFinance.organizerV2.resolve.transferSourceAccount';
    return 'personalFinance.organizerV2.resolve.ledgerAccount';
});
const counterpartyAccountFieldLabelKey = computed(() => {
    if (selectedNature.value === 'repayment') return 'personalFinance.organizerV2.resolve.repaymentTargetAccount';
    if (selectedNature.value === 'internal_transfer') return 'personalFinance.organizerV2.resolve.transferDestinationAccount';
    return 'personalFinance.organizerV2.resolve.counterpartyAccount';
});
const categoryType = computed(() => {
    if (selectedNature.value === 'income' || selectedNature.value === 'refund') return CategoryType.Income;
    if (needsCounterpartyAccount.value) return CategoryType.Transfer;
    return CategoryType.Expense;
});
const categoryOptions = computed(() => flattenCategories(categoriesStore.allTransactionCategories[categoryType.value] ?? []));
const canResolveSelected = computed(() => {
    if (!selectedIssue.value || !selectedEvent.value) return false;
    if (selectedIssue.value.type === 'same_event') return !!selectedSameEventDecision.value;
    if (selectedIssue.value.type === 'refund_relation') return !!selectedRefundTargetEventId.value;
    if (selectedIssue.value.type === 'installment_origin') {
        if (selectedInstallmentDecision.value === 'existing') return !!selectedExistingInstallmentContract.value;
        if (selectedInstallmentDecision.value === 'create') return !!installmentCandidate.value && installmentDraftValid.value;
        if (selectedInstallmentDecision.value === 'placeholder') return installmentCandidate.value?.status === 'pending';
        if (selectedInstallmentDecision.value === 'expense') return !!selectedLedgerAccountId.value;
        return false;
    }
    return !!selectedLedgerAccountId.value && selectedNature.value !== 'unknown' && (!needsCounterpartyAccount.value || (!!selectedCounterpartyLedgerAccountId.value && selectedCounterpartyLedgerAccountId.value !== selectedLedgerAccountId.value));
});
const resolveDialogTitleKey = computed(() => {
    if (selectedIssue.value?.type === 'same_event') return 'personalFinance.organizerV2.issue.action.confirmRelationship';
    if (selectedIssue.value?.type === 'refund_relation') return 'personalFinance.organizerV2.issue.action.selectRefundOriginal';
    if (selectedIssue.value?.type === 'installment_origin') {
        if (selectedInstallmentDecision.value === 'existing') return 'personalFinance.organizerV2.resolve.installment.existingTitle';
        if (selectedInstallmentDecision.value === 'placeholder') return 'personalFinance.organizerV2.resolve.installment.placeholderTitle';
        return selectedInstallmentDecision.value === 'create'
            ? 'personalFinance.organizerV2.resolve.installment.createTitle'
            : 'personalFinance.organizerV2.resolve.installment.title';
    }
    return 'personalFinance.organizerV2.resolve.title';
});
const resolveActionLabelKey = computed(() => {
    if (selectedIssue.value?.type === 'same_event') return 'personalFinance.organizerV2.resolve.relationship.confirm';
    if (selectedIssue.value?.type === 'installment_origin' && selectedInstallmentDecision.value) {
        return `personalFinance.organizerV2.resolve.installment.${selectedInstallmentDecision.value}Confirm`;
    }
    return 'personalFinance.organizerV2.resolve.save';
});
const issueGroupCount = computed(() => reviewIssues.value.length || update.value?.needsActionEventCount || 0);
const postingStepShowsPosted = computed(() => !!update.value?.postedEventCount && !update.value.readyEventCount);
const postingStepLabelKey = computed(() => postingStepShowsPosted.value ? 'personalFinance.organizerV2.filter.posted' : 'personalFinance.organizerV2.workflow.ready');
const postingStepCount = computed(() => postingStepShowsPosted.value ? update.value?.postedEventCount ?? 0 : update.value?.readyEventCount ?? 0);
const visibleEvents = computed(() => eventFilter.value === 'ready' && showOnlyUncategorized.value
    ? events.value.filter(event => isCategorisable(event) && !event.categoryId)
    : events.value);
const eventMap = computed(() => new Map(events.value.map(event => [event.id, event])));
const memberMap = computed(() => {
    const result = new Map<string, ReviewIssueMember[]>();
    for (const member of reviewMembers.value) {
        const values = result.get(member.issueId) ?? [];
        values.push(member); result.set(member.issueId, values);
    }
    return result;
});
const sortedReviewIssues = computed(() => [...reviewIssues.value].sort((left, right) => {
    const leftEvent = issueEvents(left)[0];
    const rightEvent = issueEvents(right)[0];
    return (leftEvent?.eventUnixTime ?? Number.MAX_SAFE_INTEGER) - (rightEvent?.eventUnixTime ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id);
}));
const refundCandidateOptions = computed(() => refundCandidates.value.map(event => ({ value: event.id, title: `${eventDay(event.eventUnixTime)} ${eventMonth(event.eventUnixTime)} · ${eventDisplayLabel(event) || '未命名消费'} · ${formatEventAmount(event)}` })));
const currentSources = computed(() => {
    const batches = new Map(personalFinanceStore.batches.map(batch => [batch.id, batch]));
    return (update.value?.sources ?? []).map(source => ({ source, batch: batches.get(source.batchId) }));
});

watch(eventFilter, () => {
    if (activeWorkflowStep.value !== 1) activeWorkflowStep.value = workflowStepForFilter(eventFilter.value);
    if (eventFilter.value !== 'ready') showOnlyUncategorized.value = false;
    if (eventFilter.value !== 'audit') void loadEvents();
});
watch(selectedNature, () => { if (!needsCounterpartyAccount.value) selectedCounterpartyLedgerAccountId.value = ''; if (selectedCategoryId.value && !categoryOptions.value.some(option => option.value === selectedCategoryId.value)) selectedCategoryId.value = ''; });
watch(selectedInstallmentDecision, value => {
    if (value === 'expense') selectedNature.value = 'expense';
});

function idempotencyKey(action: string): string { return `pf-review-ui-v1:${action}:${generateRandomUUID()}`; }
function removeBatch(id: string): void { selectedBatchIds.value = selectedBatchIds.value.filter(value => value !== id); }
function workflowStepForFilter(filter: ResultsFilter): 2 | 3 { return filter === 'ready' || filter === 'posted' ? 3 : 2; }
function showEventStep(filter: ResultsFilter): void { activeWorkflowStep.value = workflowStepForFilter(filter); eventFilter.value = filter; }
function showPostingStep(): void {
    activeWorkflowStep.value = 3;
    if (!postingStepShowsPosted.value) eventFilter.value = 'ready';
}
function eventFilterCount(filter: ResultsFilter): number {
    if (!update.value) return 0;
    if (filter === 'audit') return update.value.duplicateEvidenceCount;
    if (filter === 'needs_action') return update.value.needsActionEventCount;
    if (filter === 'ready') return update.value.readyEventCount;
    if (filter === 'posted') return update.value.postedEventCount;
    if (filter === 'excluded') return update.value.excludedEventCount;
    return 0;
}
function eventDay(unixTime?: number): string { return unixTime ? String(new Date(unixTime * 1000).getDate()).padStart(2, '0') : '—'; }
function eventMonth(unixTime?: number): string { return unixTime ? new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(unixTime * 1000)) : ''; }
function formatEventAmount(event: EconomicEvent): string { return event.amount ? formatAmountToLocalizedNumeralsWithCurrency(parseBigDecimal(event.amount), event.currency) : '—'; }
function eventDescription(event: EconomicEvent): string { const title = eventDisplayLabel(event); return [...new Set([event.item, event.note].filter((value): value is string => !!value && value !== title && !isDisplayDate(value)))].join(' · '); }
function eventAccountName(event: EconomicEvent): string { return event.ledgerAccountId ? accountsStore.allAccountsMap[event.ledgerAccountId]?.name || '账户待确认' : '账户待确认'; }
function isCategorisable(event: EconomicEvent): boolean { return ['expense', 'income', 'fee'].includes(event.economicNature); }
function eventCategoryName(event: EconomicEvent): string {
    if (!isCategorisable(event)) return tt('personalFinance.organizerV2.category.notRequired');
    return event.categoryId ? categoriesStore.allTransactionCategoriesMap[event.categoryId]?.name || tt('personalFinance.organizerV2.events.uncategorized') : tt('personalFinance.organizerV2.events.uncategorized');
}
function isAccountMovement(event: EconomicEvent): boolean { return ['internal_transfer', 'repayment', 'borrow'].includes(event.economicNature); }
function accountName(accountId?: string): string { return accountId ? accountsStore.allAccountsMap[accountId]?.name || tt('personalFinance.organizerV2.events.accountPending') : ''; }
function movementSourceName(event: EconomicEvent): string { return accountName(event.ledgerAccountId) || tt('personalFinance.organizerV2.events.sourceAccountPending'); }
function movementDestinationName(event: EconomicEvent): string { return accountName(event.counterpartyLedgerAccountId) || tt('personalFinance.organizerV2.events.destinationAccountPending'); }
function isDisplayDate(value: string): boolean { return /^\s*\d{4}[年/.\-]\d{1,2}[月/.\-]\d{1,2}日?\s*$/.test(value); }
function isGenericIssueDescription(value: string): boolean { return /(?:需要|请选择).*(?:账户|交易|还款)/.test(value); }
function conciseRepaymentLabel(event: EconomicEvent): string {
    const values = [event.item, event.counterparty, event.note].filter((value): value is string => !!value && !isGenericIssueDescription(value) && !isDisplayDate(value));
    for (const value of values) {
        const segment = value.split(/[|/／]/).map(item => item.trim()).find(item => item.includes('还款'));
        if (segment) return segment;
    }
    return tt('personalFinance.organizerV2.nature.repayment');
}
function issueEventTitle(event: EconomicEvent): string {
    if (event.economicNature === 'repayment') return conciseRepaymentLabel(event);
    if (event.economicNature === 'internal_transfer' && event.item && !isGenericIssueDescription(event.item) && !isDisplayDate(event.item)) return event.item;
    return eventDisplayLabel(event) || tt('personalFinance.organizerV2.events.unnamed');
}
function issueEventDescription(event: EconomicEvent): string {
    const title = issueEventTitle(event);
    return [...new Set([event.item, event.note].filter((value): value is string => !!value && value !== title && !isDisplayDate(value) && !isGenericIssueDescription(value)))].join(' · ');
}
function evidenceBatch(item: OrganizerEvidenceItem) { return personalFinanceStore.batches.find(batch => batch.id === item.row.batchId); }
function evidenceFileName(item: OrganizerEvidenceItem): string { const batch = evidenceBatch(item); return batch?.file?.originalFileName || tt('personalFinance.organizerV2.evidence.source'); }
function evidenceSourceMeta(item: OrganizerEvidenceItem): string { const batch = evidenceBatch(item); const source = batch ? tt(getSourceTypeKey(batch.sourceType)) : tt('personalFinance.organizerV2.evidence.source'); return `${source} · ${tt('personalFinance.organizerV2.evidence.rowNumber', { number: item.row.rowNumber })}`; }
function evidenceRoleLabel(item: OrganizerEvidenceItem): string { return tt(`personalFinance.organizerV2.audit.role.${item.evidenceRole}`); }
function isAnomalyEvent(event: EconomicEvent): boolean { return eventReasonCodes(event).some(reason => ['transaction_closed', 'transaction_failed', 'core_fields_conflict', 'postability_direction_conflict'].includes(reason)); }
function eventExcludedLabel(event: EconomicEvent): string {
    const reasons = eventReasonCodes(event);
    if (reasons.includes('transaction_closed')) return tt('personalFinance.organizerV2.anomaly.closed');
    if (reasons.includes('transaction_failed')) return tt('personalFinance.organizerV2.anomaly.failed');
    if (reasons.includes('already_posted')) return tt('personalFinance.organizerV2.excluded.alreadyPosted');
    return tt('personalFinance.organizerV2.excluded.accountIgnored');
}
function eventExcludedContext(event: EconomicEvent): string {
    const reasons = eventReasonCodes(event);
    const paymentMethod = event.paymentMethod || tt('personalFinance.organizerV2.excluded.paymentMethodMissing');
    if (reasons.includes('transaction_closed')) return [tt('personalFinance.organizerV2.excluded.closedHint'), paymentMethod].join(' · ');
    if (reasons.includes('transaction_failed')) return [tt('personalFinance.organizerV2.excluded.failedHint'), paymentMethod].join(' · ');
    if (reasons.includes('already_posted')) return tt('personalFinance.organizerV2.reason.alreadyPosted');
    return [tt('personalFinance.organizerV2.excluded.accountIgnoredHint'), event.paymentMethod].filter(Boolean).join(' · ');
}
function auditGroupType(event: EconomicEvent): 'sameEvent' | 'transfer' | 'repayment' | 'sourceIdentity' {
    const reasons = eventReasonCodes(event);
    if (reasons.includes('auto_same_event')) return 'sameEvent';
    if (reasons.includes('auto_repayment_pair')) return 'repayment';
    if (reasons.includes('auto_transfer_pair')) return 'transfer';
    return 'sourceIdentity';
}
function auditGroupLabel(event: EconomicEvent): string { return tt(`personalFinance.organizerV2.audit.kind.${auditGroupType(event)}`); }
function auditGroupRule(event: EconomicEvent): string { return tt(`personalFinance.organizerV2.audit.rule.${auditGroupType(event)}`); }
function auditGroupEquation(event: EconomicEvent): string { return tt('personalFinance.organizerV2.audit.equation', { records: event.evidenceCount }); }
function issueEvents(issue: ReviewIssue): EconomicEvent[] { return sortEconomicEventsOldestFirst((memberMap.value.get(issue.id) ?? []).filter(member => member.role === 'subject' && member.objectType === 'event').map(member => eventMap.value.get(member.objectId)).filter((event): event is EconomicEvent => !!event)); }
function reviewIssuePresentationFor(issue?: ReviewIssue) { return reviewIssuePresentation(issue, issue ? issueEvents(issue) : []); }
function reviewIssueLabel(issue?: ReviewIssue): string {
    return tt(reviewIssuePresentationFor(issue).labelKey);
}
function reviewIssueHint(issue: ReviewIssue): string {
    const presentation = reviewIssuePresentationFor(issue);
    return tt(presentation.hintKey, { count: presentation.count });
}
function reviewIssueCount(issue: ReviewIssue): number { return reviewIssuePresentationFor(issue).count; }
function reviewIssueActionLabel(issue: ReviewIssue): string {
    if (issue.type === 'same_event') return tt('personalFinance.organizerV2.issue.action.confirmRelationship');
    if (issue.type === 'refund_relation') return tt('personalFinance.organizerV2.issue.action.selectRefundOriginal');
    if (issue.type === 'installment_origin') return tt('personalFinance.organizerV2.issue.action.confirmInstallment');
    if (reviewIssueCount(issue) > 1) return tt('personalFinance.organizerV2.issue.batchResolve');
    const labelKey = reviewIssuePresentationFor(issue).labelKey;
    const actionByLabel: Readonly<Record<string, string>> = {
        'personalFinance.organizerV2.issue.label.incomeAccount': 'personalFinance.organizerV2.issue.action.selectIncomeAccount',
        'personalFinance.organizerV2.issue.label.expenseAccount': 'personalFinance.organizerV2.issue.action.selectExpenseAccount',
        'personalFinance.organizerV2.issue.label.refundAccount': 'personalFinance.organizerV2.issue.action.selectRefundAccount',
        'personalFinance.organizerV2.issue.label.transferSource': 'personalFinance.organizerV2.issue.action.selectTransferSource',
        'personalFinance.organizerV2.issue.label.transferDestination': 'personalFinance.organizerV2.issue.action.selectTransferDestination',
        'personalFinance.organizerV2.issue.label.repaymentSource': 'personalFinance.organizerV2.issue.action.selectRepaymentSource',
        'personalFinance.organizerV2.issue.label.repaymentTarget': 'personalFinance.organizerV2.issue.action.selectRepaymentTarget',
        'personalFinance.organizerV2.issue.label.compositeRepaymentTarget': 'personalFinance.organizerV2.issue.action.selectRepaymentTarget'
    };
    return tt(actionByLabel[labelKey] || 'personalFinance.organizerV2.issue.action.resolve');
}
function reviewIssueScope(issue?: ReviewIssue): string { const count = reviewIssuePresentationFor(issue).count; return tt(count > 1 ? 'personalFinance.organizerV2.issue.scopeMany' : 'personalFinance.organizerV2.issue.scopeOne', { count }); }
function reviewIssueScopeHint(issue?: ReviewIssue): string { const count = reviewIssuePresentationFor(issue).count; return tt(count > 1 ? 'personalFinance.organizerV2.issue.scopeHintMany' : 'personalFinance.organizerV2.issue.scopeHintOne', { count }); }
function directionForNature(nature: EconomicNature): EconomicEvent['flowDirection'] { if (nature === 'income' || nature === 'refund') return 'inflow'; if (['internal_transfer', 'repayment', 'borrow', 'balance_adjustment'].includes(nature)) return 'neutral'; return 'outflow'; }
function flattenCategories(categories: TransactionCategory[]): { title: string; value: string }[] { const result: { title: string; value: string }[] = []; for (const category of categories) for (const child of category.subCategories ?? []) if (!category.hidden && !child.hidden) result.push({ title: `${category.name} / ${child.name}`, value: child.id }); return result; }
function amountAtLeast(left?: string, right?: string): boolean { try { return !!left && !!right && BigInt(left) >= BigInt(right); } catch { return false; } }

async function load(silent = false): Promise<void> {
    if (syncing.value) return;
    if (!silent) loading.value = true;
    syncing.value = true;
    showError.value = false;
    try {
        const pages = await Promise.all(RESULT_UPDATE_STATUSES.map(status => organizerApi.listUpdates(status)));
        const selected = selectCurrentUpdate(pages.map(page => [...page.items]));
        update.value = selected ? await organizerApi.getUpdate(selected.id) : undefined;
        await Promise.all([personalFinanceStore.loadBatches(0, 100), Promise.allSettled([accountsStore.loadAllAccounts({ force: false }), categoriesStore.loadAllCategories({ force: false })])]);
        if (!update.value && !sourceSelectionInitialized.value) {
            selectedBatchIds.value = readyBatches.value.map(batch => batch.id);
            sourceSelectionInitialized.value = true;
        }
        if (update.value) await Promise.all([loadEvents(silent), loadEvidenceAudit(silent), loadExcludedAnomalies(), loadUncategorizedEvents()]);
        lastSyncedAt.value = Date.now();
    } catch { showError.value = true; }
    finally { loading.value = false; syncing.value = false; }
}

async function listAllEvents(updateId: string, status: EconomicEventStatus): Promise<EconomicEvent[]> {
    const result: EconomicEvent[] = [];
    let cursor: { updatedUnixTime: number; eventId: string } | undefined;
    do {
        const page = await organizerApi.listEvents(updateId, status, 100, cursor);
        result.push(...page.items);
        cursor = page.nextCursor;
    } while (cursor);
    return sortEconomicEventsOldestFirst(result);
}

async function loadEvidenceAudit(silent = false): Promise<void> {
    if (!update.value || update.value.duplicateEvidenceCount < 1) { auditEvents.value = []; return; }
    if (!silent) loadingAudit.value = true;
    try {
        const pages = await Promise.all(auditEventStatuses.map(status => listAllEvents((update.value as FinanceUpdate).id, status)));
        auditEvents.value = sortEconomicEventsOldestFirst(pages.flat().filter(event => event.evidenceCount > 1));
    } catch { showError.value = true; }
    finally { if (!silent) loadingAudit.value = false; }
}

async function loadExcludedAnomalies(): Promise<void> {
    if (!update.value) { excludedAnomalyEvents.value = []; return; }
    try {
        const excluded = await listAllEvents((update.value as FinanceUpdate).id, 'excluded');
        excludedAnomalyEvents.value = sortEconomicEventsOldestFirst(excluded.filter(isAnomalyEvent));
    } catch { showError.value = true; }
}

async function loadUncategorizedEvents(): Promise<void> {
    if (!update.value) { uncategorizedEvents.value = []; return; }
    const status: EconomicEventStatus | undefined = update.value.status === 'review' ? 'ready' : update.value.status === 'posted' ? 'posted' : undefined;
    if (!status) { uncategorizedEvents.value = []; return; }
    try {
        const items = await listAllEvents(update.value.id, status);
        uncategorizedEvents.value = items.filter(event => isCategorisable(event) && !event.categoryId);
    } catch { showError.value = true; }
}

async function loadEvents(silent = false): Promise<void> {
    if (!update.value || eventFilter.value === 'audit') return;
    if (!silent) loadingEvents.value = true;
    try {
        if (eventFilter.value === 'needs_action') {
            const [eventItems, issuePage] = await Promise.all([listAllEvents(update.value.id, 'needs_action'), organizerApi.listReviewIssues(update.value.id)]);
            events.value = eventItems; reviewIssues.value = issuePage.items; reviewMembers.value = issuePage.members;
        } else {
            events.value = await listAllEvents(update.value.id, eventFilter.value); reviewIssues.value = []; reviewMembers.value = [];
        }
    } catch { showError.value = true; }
    finally { if (!silent) loadingEvents.value = false; }
}

function resetToSourceSelection(batchIds: readonly string[] = []): void {
    update.value = undefined;
    events.value = [];
    auditEvents.value = [];
    excludedAnomalyEvents.value = [];
    uncategorizedEvents.value = [];
    reviewIssues.value = [];
    reviewMembers.value = [];
    selectedBatchIds.value = [...batchIds];
    sourceSelectionInitialized.value = true;
    activeWorkflowStep.value = 1;
}
async function onImportChanged(batchId: string): Promise<void> {
    await personalFinanceStore.loadBatches(0, 100);
    if (!readyBatches.value.some(batch => batch.id === batchId)) return;
    if (update.value?.status === 'posted' || update.value?.status === 'undone') {
        resetToSourceSelection([batchId]);
    } else if (!update.value && !selectedBatchIds.value.includes(batchId)) {
        selectedBatchIds.value = [...selectedBatchIds.value, batchId];
    }
}
async function runMutation(operation: () => Promise<{ update: FinanceUpdate }>): Promise<boolean> { busy.value = true; try { update.value = (await operation()).update; await Promise.all([loadEvents(), loadEvidenceAudit(), loadExcludedAnomalies(), loadUncategorizedEvents()]); lastSyncedAt.value = Date.now(); return true; } catch { showError.value = true; return false; } finally { busy.value = false; } }
async function startOrganizing(): Promise<void> {
    if (selectedBatchIds.value.length < 1 || checkingPaymentAccounts.value || busy.value) return;
    checkingPaymentAccounts.value = true;
    try {
        const hasPaymentAccounts = await paymentAccountSetupDialog.value?.open(selectedBatchIds.value);
        if (!hasPaymentAccounts) await createAndOrganize();
    } catch {
        showError.value = true;
    } finally {
        checkingPaymentAccounts.value = false;
    }
}
async function createAndOrganize(): Promise<void> { busy.value = true; try { const created = await organizerApi.createUpdate(selectedBatchIds.value, idempotencyKey('create')); update.value = (await organizerApi.organize(created, idempotencyKey('organize'))).update; activeWorkflowStep.value = 2; eventFilter.value = 'needs_action'; await Promise.all([loadEvents(), loadEvidenceAudit(), loadExcludedAnomalies(), loadUncategorizedEvents()]); lastSyncedAt.value = Date.now(); } catch { showError.value = true; } finally { busy.value = false; } }
async function postAllReady(): Promise<void> {
    if (!update.value) return;
    await runMutation(() => organizerApi.postAllReady(update.value as FinanceUpdate, idempotencyKey('post-all')));
    activeWorkflowStep.value = 3;
}

async function abandonAndReselect(): Promise<void> {
    const current = update.value;
    if (!current || !canAbandonUpdate(current)) return;
    const previousBatchIds = (current.sources ?? []).map(source => source.batchId);
    busy.value = true;
    try {
        await organizerApi.abandon(current, idempotencyKey('abandon'));
        await personalFinanceStore.loadBatches(0, 100);
        const selectable = new Set(readyBatches.value.map(batch => batch.id));
        resetToSourceSelection(previousBatchIds.filter(batchId => selectable.has(batchId)));
        showAbandon.value = false;
        lastSyncedAt.value = Date.now();
    } catch { showError.value = true; }
    finally { busy.value = false; }
}
async function openEvidence(event: EconomicEvent): Promise<void> { selectedEvidenceEvent.value = event; showEvidence.value = true; loadingEvidence.value = true; evidence.value = undefined; try { evidence.value = await organizerApi.getEvidence(event.id); } catch { showError.value = true; showEvidence.value = false; } finally { loadingEvidence.value = false; } }

async function openCategoryCorrection(event: EconomicEvent): Promise<void> {
    if (!isCategorisable(event) || (update.value?.status !== 'review' && update.value?.status !== 'posted')) return;
	const currentUpdate = update.value;
    selectedEvent.value = event;
    selectedNature.value = event.economicNature;
    selectedCategoryId.value = event.categoryId ?? '';
	selectedCategoryScope.value = 'single';
	matchingCategoryEventCount.value = 1;
    showCategoryCorrection.value = true;
	if (currentUpdate.status !== 'review' || event.categoryId) return;
	loadingCategoryScope.value = true;
	try {
		const preview = await organizerApi.getCategoryCorrectionScope(currentUpdate.id, event.id);
		if (!showCategoryCorrection.value || selectedEvent.value?.id !== event.id) return;
		matchingCategoryEventCount.value = Math.max(1, preview.matchingEventCount);
		selectedCategoryScope.value = matchingCategoryEventCount.value > 1 ? 'matching_uncategorized' : 'single';
	} catch {
		if (selectedEvent.value?.id === event.id) showError.value = true;
	} finally {
		if (selectedEvent.value?.id === event.id) loadingCategoryScope.value = false;
	}
}

async function saveCategoryCorrection(): Promise<void> {
    const currentUpdate = update.value;
    const event = selectedEvent.value;
    if (!currentUpdate || (currentUpdate.status !== 'review' && currentUpdate.status !== 'posted') || !event || !selectedCategoryId.value) return;
    await runMutation(() => organizerApi.correctEvent({
        updateId: currentUpdate.id,
        eventId: event.id,
        expectedUpdateVersion: currentUpdate.version,
        expectedEventVersion: event.version,
        idempotencyKey: idempotencyKey('category'),
        categoryScope: canBatchCategoryCorrection.value ? selectedCategoryScope.value : 'single',
        fieldMask: 128,
        categoryId: selectedCategoryId.value
    }));
    showCategoryCorrection.value = false;
}

async function openIssueResolve(issue: ReviewIssue): Promise<void> {
    const representative = issueEvents(issue)[0]; if (!representative) return;
    selectedIssue.value = issue; selectedEvent.value = representative;
    selectedNature.value = representative.economicNature === 'unknown' ? 'expense' : representative.economicNature;
    selectedLedgerAccountId.value = representative.ledgerAccountId ?? '';
    selectedCounterpartyLedgerAccountId.value = representative.counterpartyLedgerAccountId ?? '';
    selectedCategoryId.value = representative.categoryId ?? '';
    selectedSameEventDecision.value = '';
    selectedInstallmentDecision.value = '';
    installmentCandidate.value = undefined;
    existingInstallmentContracts.value = [];
    selectedExistingInstallmentContractId.value = '';
    installmentCalculationResult.value = undefined;
    selectedRefundTargetEventId.value = ''; refundCandidates.value = [];
    showResolve.value = true;
    if (issue.type === 'refund_relation') await loadRefundCandidates(representative);
    if (issue.type === 'installment_origin') {
        await loadInstallmentCandidate(representative);
        initializeInstallmentDraft(representative);
        await loadExistingInstallmentContracts(representative);
    }
}

async function listInstallmentCandidates(status: InstallmentCandidateStatus): Promise<InstallmentCandidate[]> {
    const result: InstallmentCandidate[] = [];
    let cursor: { readonly updatedUnixTime: number; readonly candidateId: string } | undefined;
    do {
        const page = await installmentApi.listCandidates(status, cursor);
        result.push(...page.items);
        cursor = page.nextCursor;
    } while (cursor);
    return result;
}

async function loadInstallmentCandidate(event: EconomicEvent): Promise<void> {
    loadingInstallmentCandidate.value = true;
    installmentCandidate.value = undefined;
    try {
        const eventEvidence = await organizerApi.getEvidence(event.id);
        const rowIds = new Set(eventEvidence.evidence.map(item => item.rowId));
        const statuses: readonly InstallmentCandidateStatus[] = ['pending', 'needs_details', 'action_required'];
        for (const status of statuses) {
            const candidates = await listInstallmentCandidates(status);
            const matched = candidates.find(candidate => candidate.members.some(member => member.kind === 'raw_row' && rowIds.has(member.refId)));
            if (matched) {
                installmentCandidate.value = matched;
                return;
            }
        }
    } catch {
        showError.value = true;
    } finally {
        loadingInstallmentCandidate.value = false;
    }
}

function rankCompatibleInstallmentContracts(candidate: InstallmentCandidate | undefined, event: EconomicEvent | undefined,
    contracts: readonly LoanContractSummary[]): LoanContractSummary[] {
    if (!event) return [];
    const liabilityAccountId = candidate?.liabilityAccountId || event.ledgerAccountId || '';
    return contracts
        .filter(summary => summary.contract.status === 'active' && summary.contract.currency === event.currency &&
            (!liabilityAccountId || summary.contract.liabilityAccountId === liabilityAccountId))
        .map(summary => ({
            summary,
            score: (summary.contract.liabilityAccountId === liabilityAccountId ? 100 : 0) +
                (candidate?.termCount && summary.totalInstallmentCount === candidate.termCount ? 30 : 0) +
                (summary.contract.contractType === 'credit_card_installment' ? 10 : 0)
        }))
        .sort((left, right) => right.score - left.score || right.summary.contract.updatedUnixTime - left.summary.contract.updatedUnixTime ||
            left.summary.contract.name.localeCompare(right.summary.contract.name))
        .map(item => item.summary);
}

async function loadExistingInstallmentContracts(event: EconomicEvent): Promise<void> {
    loadingExistingInstallmentContracts.value = true;
    try {
        const contracts: LoanContractSummary[] = [];
        let cursor: { updatedUnixTime: number; contractId: string } | undefined;
        do {
            const page = await loanApi.listContracts({ status: 'active', limit: 100, ...(cursor ? { cursor } : {}) });
            contracts.push(...page.items);
            cursor = page.nextCursor ? { updatedUnixTime: page.nextCursor.updatedUnixTime, contractId: page.nextCursor.contractId } : undefined;
        } while (cursor);
        existingInstallmentContracts.value = contracts;
        const recommended = rankCompatibleInstallmentContracts(installmentCandidate.value, event, contracts)[0];
        if (recommended) {
            selectedExistingInstallmentContractId.value = recommended.contract.id;
            selectedInstallmentDecision.value = 'existing';
        }
    } catch {
        showError.value = true;
    } finally {
        loadingExistingInstallmentContracts.value = false;
    }
}

async function loadRefundCandidates(refund: EconomicEvent): Promise<void> {
    if (!update.value) return;
    loadingRefundCandidates.value = true;
    try {
        const [ready, posted] = await Promise.all([listAllEvents(update.value.id, 'ready'), listAllEvents(update.value.id, 'posted')]);
        refundCandidates.value = sortEconomicEventsOldestFirst([...ready, ...posted].filter(event => event.id !== refund.id && event.economicNature === 'expense' && event.currency === refund.currency && amountAtLeast(event.amount, refund.amount) && (event.eventUnixTime || 0) <= (refund.eventUnixTime || Number.MAX_SAFE_INTEGER)));
        if (refundCandidates.value.length === 1) selectedRefundTargetEventId.value = (refundCandidates.value[0] as EconomicEvent).id;
    } catch { showError.value = true; }
    finally { loadingRefundCandidates.value = false; }
}

async function resolveSelected(): Promise<void> {
    if (!update.value || !selectedIssue.value || !selectedEvent.value || !canResolveSelected.value) return;
    const issue = selectedIssue.value; const currentUpdate = update.value;
    if (issue.type === 'same_event') {
        const decision = selectedSameEventDecision.value;
        const primary = issueEvents(issue)[0];
        if (!decision || (decision === 'confirm_same' && !primary)) return;
        await runMutation(() => organizerApi.resolveReviewIssue({ updateId: currentUpdate.id, issueId: issue.id, expectedUpdateVersion: currentUpdate.version, expectedIssueVersion: issue.version, idempotencyKey: idempotencyKey(decision === 'confirm_same' ? 'same' : 'distinct'), decision, primaryEventId: decision === 'confirm_same' ? primary?.id : undefined }));
    } else if (issue.type === 'refund_relation') {
        await runMutation(() => organizerApi.resolveReviewIssue({ updateId: currentUpdate.id, issueId: issue.id, expectedUpdateVersion: currentUpdate.version, expectedIssueVersion: issue.version, idempotencyKey: idempotencyKey('refund'), decision: 'link_refund', targetEventId: selectedRefundTargetEventId.value }));
    } else if (issue.type === 'installment_origin' && selectedInstallmentDecision.value === 'existing') {
        const candidate = installmentCandidate.value;
        const contract = selectedExistingInstallmentContract.value;
        if (!candidate || !contract) return;
        busy.value = true;
        try {
            await installmentApi.confirmCandidate({
                candidateId: candidate.id, expectedVersion: candidate.version, treatAsInstallment: true,
                linkedContractId: contract.contract.id
            });
        } catch {
            showError.value = true;
            return;
        } finally {
            busy.value = false;
        }
        await runMutation(() => organizerApi.resolveReviewIssue({
            updateId: currentUpdate.id, issueId: issue.id, expectedUpdateVersion: currentUpdate.version,
            expectedIssueVersion: issue.version, idempotencyKey: idempotencyKey('installment-existing'),
            decision: 'confirm_installment_principal', installmentCandidateId: candidate.id
        }));
    } else if (issue.type === 'installment_origin' && selectedInstallmentDecision.value === 'create') {
        const candidate = installmentCandidate.value;
        if (!candidate) return;
        busy.value = true;
        try {
            await installmentApi.confirmCandidate({
                candidateId: candidate.id, expectedVersion: candidate.version, treatAsInstallment: true,
                liabilityAccountId: installmentContractIdentity.value.liabilityAccountId,
                termCount: installmentCalculation.value.termCount,
                openingCompletedInstallmentCount: installmentOpeningCompletedCount.value,
                contract: installmentContractIdentity.value,
                calculation: validateLoanCalculationInput(installmentCalculation.value)
            });
        } catch {
            showError.value = true;
            return;
        } finally {
            busy.value = false;
        }
        await runMutation(() => organizerApi.resolveReviewIssue({
            updateId: currentUpdate.id, issueId: issue.id, expectedUpdateVersion: currentUpdate.version,
            expectedIssueVersion: issue.version, idempotencyKey: idempotencyKey('installment-principal'),
            decision: 'confirm_installment_principal', installmentCandidateId: candidate.id
        }));
    } else if (issue.type === 'installment_origin' && selectedInstallmentDecision.value === 'placeholder') {
        const candidate = installmentCandidate.value;
        if (!candidate || candidate.status !== 'pending') return;
        await runMutation(() => organizerApi.resolveReviewIssue({
            updateId: currentUpdate.id, issueId: issue.id, expectedUpdateVersion: currentUpdate.version,
            expectedIssueVersion: issue.version, idempotencyKey: idempotencyKey('installment-placeholder'),
            decision: 'confirm_installment_principal', installmentCandidateId: candidate.id
        }));
    } else {
        let fieldMask = 1 | 4 | 8;
        if (needsCounterpartyAccount.value) fieldMask |= 2;
        if (selectedCategoryId.value) fieldMask |= 128;
        await runMutation(() => organizerApi.resolveReviewIssue({ updateId: currentUpdate.id, issueId: issue.id, expectedUpdateVersion: currentUpdate.version, expectedIssueVersion: issue.version, idempotencyKey: idempotencyKey('apply-fields'), decision: 'apply_fields', fieldMask, economicNature: selectedNature.value, flowDirection: directionForNature(selectedNature.value), ledgerAccountId: selectedLedgerAccountId.value, counterpartyLedgerAccountId: needsCounterpartyAccount.value ? selectedCounterpartyLedgerAccountId.value : undefined, categoryId: selectedCategoryId.value || undefined }));
    }
    showResolve.value = false;
}

function emptyInstallmentIdentity(): LoanContractIdentityInput {
    return { name: '', lenderName: '', contractType: 'credit_card_installment', liabilityAccountId: '', currency: 'CNY', note: '' };
}

function emptyInstallmentCalculation(): LoanCalculationInput {
    return { ...createDefaultLoanCalculationInput(), fundingType: 'purchase_installment' };
}

const installmentDraftValid = computed(() => {
    const identity = installmentContractIdentity.value;
    try {
        validateLoanCalculationInput(installmentCalculation.value);
    } catch {
        return false;
    }
    return !!identity.name.trim() && !!identity.lenderName.trim() && !!identity.liabilityAccountId &&
        installmentOpeningCompletedCount.value >= 0 && installmentOpeningCompletedCount.value < installmentCalculation.value.termCount &&
        /^[A-Z]{3}$/.test(identity.currency) && installmentLiabilityAccounts.value.some(account => account.id === identity.liabilityAccountId && account.currency === identity.currency) &&
        (!identity.defaultPaymentAccountId || installmentPaymentAccounts.value.some(account => account.id === identity.defaultPaymentAccountId));
});

function initializeInstallmentDraft(event: EconomicEvent): void {
    const liabilityId = installmentCandidate.value?.liabilityAccountId ?? event.ledgerAccountId ?? '';
    const liability = installmentLiabilityAccounts.value.find(account => account.id === liabilityId);
    const eventDate = eventCivilDate(event);
    const currentPeriod = installmentCandidate.value?.currentPeriod ?? 1;
    const firstDueDate = inferInstallmentFirstDueDate(eventDate, currentPeriod);
    const statementLabel = eventDisplayLabel(event);
    const baseName = installmentProductName(statementLabel) || statementLabel || tt('personalFinance.loans.candidates.unknownTermName');
    installmentAutoNameBase.value = baseName;
    installmentAutoName.value = installmentNameWithFirstDueDate(baseName, firstDueDate);
    installmentContractIdentity.value = {
        name: installmentAutoName.value,
        lenderName: liability?.name ?? tt('personalFinance.loans.candidates.unknownLender'),
        contractType: 'credit_card_installment', liabilityAccountId: liability?.id ?? '',
        currency: liability?.currency ?? event.currency ?? 'CNY', note: tt('personalFinance.loans.candidates.note')
    };
    installmentCalculation.value = {
        ...emptyInstallmentCalculation(), effectiveDate: eventDate, contractDate: eventDate,
        firstDueDate, termCount: installmentCandidate.value?.termCount ?? 12
    };
    installmentOpeningCompletedCount.value = inferOpeningCompletedInstallmentCount(
        eventDate, firstDueDate, installmentCalculation.value.termCount
    );
}

function updateInstallmentIdentity(value: LoanContractIdentityInput): void {
    const liability = installmentLiabilityAccounts.value.find(account => account.id === value.liabilityAccountId);
    const currency = liability?.currency ?? value.currency;
    installmentContractIdentity.value = {
        ...value,
        lenderName: liability?.name ?? value.lenderName,
        contractType: 'credit_card_installment',
        currency,
        defaultPaymentAccountId: undefined,
        note: tt('personalFinance.loans.candidates.note')
    };
}

function updateInstallmentCalculation(value: LoanCalculationInput): void {
    const nameWasAutomatic = installmentContractIdentity.value.name === installmentAutoName.value;
    const nextAutomaticName = installmentNameWithFirstDueDate(installmentAutoNameBase.value, value.firstDueDate);
    if (nameWasAutomatic) {
        installmentContractIdentity.value = { ...installmentContractIdentity.value, name: nextAutomaticName };
    }
    installmentAutoName.value = nextAutomaticName;
    const firstDueDateChanged = value.firstDueDate !== installmentCalculation.value.firstDueDate;
    const termCountChanged = value.termCount !== installmentCalculation.value.termCount;
    installmentCalculation.value = value;
    if ((firstDueDateChanged || termCountChanged) && selectedEvent.value) {
        installmentOpeningCompletedCount.value = inferOpeningCompletedInstallmentCount(
            eventCivilDate(selectedEvent.value), value.firstDueDate, value.termCount
        );
    }
    installmentCalculationResult.value = undefined;
}

async function calculateInstallmentDraft(): Promise<void> {
    calculatingInstallment.value = true;
    try {
        installmentCalculationResult.value = await loanApi.calculate(validateLoanCalculationInput(installmentCalculation.value));
    } catch {
        showError.value = true;
    } finally {
        calculatingInstallment.value = false;
    }
}
async function inspectUndo(): Promise<void> { if (!update.value) return; busy.value = true; try { undoImpact.value = await organizerApi.getUndoImpact(update.value.id); showUndo.value = true; } catch { showError.value = true; } finally { busy.value = false; } }
async function undoCurrent(): Promise<void> { if (!update.value) return; await runMutation(() => organizerApi.undo(update.value as FinanceUpdate, idempotencyKey('undo'))); showUndo.value = false; }

function autoSync(): void {
    if (document.visibilityState === 'visible' && !busy.value) void load(true);
}

onMounted(() => {
    window.addEventListener('focus', autoSync);
    document.addEventListener('visibilitychange', autoSync);
    void load();
});
onBeforeUnmount(() => {
    window.removeEventListener('focus', autoSync);
    document.removeEventListener('visibilitychange', autoSync);
});
</script>

<style scoped>
.results-flow {
    --rule: rgba(var(--v-theme-on-surface), .12);
    --record-row-min-height: 58px;
    --record-date-size: .9rem;
    --record-month-size: .62rem;
    --record-title-size: .8rem;
    --record-meta-size: .68rem;
    --record-detail-size: .7rem;
    --record-action-size: .72rem;
    display: grid;
    gap: 10px;
}
.kicker { color: rgb(var(--v-theme-primary)); font-size: .68rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.empty-stage, .overview-card, .source-stage, .posting-complete, .evidence-audit, .workbench { border: 1px solid var(--rule); border-radius: 12px; background: rgb(var(--v-theme-surface)); overflow: hidden; }
.empty-stage { display: flex; flex-direction: column; min-height: 420px; padding: clamp(28px, 5vw, 62px); background: linear-gradient(125deg, rgba(var(--v-theme-primary), .09), transparent 48%), rgb(var(--v-theme-surface)); }
.empty-stage h2 { margin: 8px 0; font-size: clamp(1.8rem, 4vw, 3rem); }
.empty-stage p, .overview-card p, .workbench p, .source-stage p { color: rgba(var(--v-theme-on-surface), .6); }
.source-picker { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 9px; margin: 28px 0 20px; }
.source-picker article { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 11px 11px 13px; border: 1px solid var(--rule); border-radius: 8px; background: rgb(var(--v-theme-surface)); }
.source-picker article span { display: grid; min-width: 0; }
.source-picker strong, .source-picker small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-picker small { color: rgba(var(--v-theme-on-surface), .55); }
.source-picker article :deep(.v-btn) { color: rgba(var(--v-theme-on-surface), .48); }
.source-picker article :deep(.v-btn:hover) { color: rgb(var(--v-theme-error)); }
.source-add { display: grid; place-items: center; min-height: 58px; border: 1px dashed rgba(var(--v-theme-primary), .42); border-radius: 8px; background: rgba(var(--v-theme-primary), .025); }
.actions { display: flex; flex-wrap: wrap; gap: 6px; }
.empty-stage > .actions { justify-content: flex-end; margin-top: auto; }
.workbench > header, .source-stage > header { display: flex; align-items: start; justify-content: space-between; gap: 16px; padding: 12px 14px; background: rgba(var(--v-theme-primary), .035); }
.overview-card h3, .workbench h3, .source-stage h3 { margin: 0; }
.workbench header p, .source-stage header p { margin: 2px 0 0; font-size: .78rem; }
.post-all-action { flex: none; }
.category-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 42px; padding: 6px 14px; border-top: 1px solid var(--rule); background: rgba(var(--v-theme-primary), .018); }
.category-toolbar-copy { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.category-toolbar-copy::before { align-self: stretch; width: 3px; min-height: 20px; border-radius: 999px; background: rgba(var(--v-theme-primary), .68); content: ''; }
.category-toolbar-copy strong { color: rgb(var(--v-theme-primary)); font-size: .74rem; white-space: nowrap; }
.category-toolbar-copy span { overflow: hidden; color: rgba(var(--v-theme-on-surface), .52); font-size: .68rem; text-overflow: ellipsis; white-space: nowrap; }
.category-filter-action { flex: none; min-width: 0; }
.steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--rule); border-block: 1px solid var(--rule); }
.steps button { display: flex; align-items: center; gap: 9px; min-height: 56px; padding: 8px 14px; border: 0; background: rgb(var(--v-theme-surface)); color: inherit; cursor: pointer; text-align: start; }
.steps button.active { box-shadow: inset 0 3px rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .05); }
.steps button.attention.active { box-shadow: inset 0 3px rgb(var(--v-theme-warning)); }
.steps button > b { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: rgba(var(--v-theme-primary), .1); color: rgb(var(--v-theme-primary)); font-size: .78rem; }
.steps button span { display: grid; color: rgba(var(--v-theme-on-surface), .58); font-size: .72rem; }
.steps button strong { color: rgb(var(--v-theme-on-surface)); font-size: 1rem; line-height: 1.15; }
.steps button small { color: rgb(var(--v-theme-warning)); }
.overview-card > footer { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 48px; padding: 8px 14px; }
.overview-controls { display: flex; align-items: center; gap: 12px; min-width: 0; }
.overview-controls .v-btn b { margin-inline-start: 5px; color: rgb(var(--v-theme-primary)); font-size: .72rem; font-variant-numeric: tabular-nums; }
.conservation-inline { overflow: hidden; color: rgba(var(--v-theme-on-surface), .48); font-size: .68rem; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
.conservation-inline.invalid { color: rgb(var(--v-theme-error)); }
.posting-complete { display: grid; grid-template-columns: auto auto minmax(0,1fr) auto; align-items: baseline; gap: 10px; padding: 12px 14px; border-inline-start: 4px solid rgb(var(--v-theme-success)); background: rgba(var(--v-theme-success), .045); }
.posting-complete strong { font-size: .92rem; }
.posting-complete p { margin: 0; color: rgba(var(--v-theme-on-surface), .58); font-size: .74rem; }
.source-stage > header { align-items: center; padding-block: 10px; }
.source-stage > header > div { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.source-stage > header p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-stage article { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 12px; min-height: 54px; padding: 7px 14px; border-top: 1px solid var(--rule); }
.source-stage article > div { display: grid; min-width: 0; line-height: 1.25; }
.source-stage article strong, .source-stage article small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-stage article small { margin-top: 2px; color: rgba(var(--v-theme-on-surface), .55); font-size: .7rem; }
.source-stage article > span { padding: 3px 7px; border-radius: 999px; background: rgba(var(--v-theme-success), .08); color: rgb(var(--v-theme-success)); font-size: .68rem; white-space: nowrap; }
.source-stage > footer { display: flex; justify-content: flex-end; padding: 9px 14px; border-top: 1px solid var(--rule); }
.evidence-audit > header { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 10px 14px; border-bottom: 1px solid var(--rule); background: rgba(var(--v-theme-primary), .035); }
.evidence-audit > header > div:first-child { display: grid; grid-template-columns: auto minmax(0,1fr); align-items: baseline; gap: 10px; min-width: 0; }
.evidence-audit h3 { margin: 0; font-size: 1rem; }
.evidence-audit > header p { margin: 0; overflow: hidden; color: rgba(var(--v-theme-on-surface), .58); font-size: .74rem; text-overflow: ellipsis; white-space: nowrap; }
.audit-total { display: grid; grid-template-columns: auto auto; align-items: baseline; gap: 0 5px; flex: none; text-align: end; }
.audit-total strong { color: rgb(var(--v-theme-primary)); font-size: 1.1rem; font-variant-numeric: tabular-nums; }
.audit-total span { font-size: .7rem; font-weight: 700; }
.audit-total small { grid-column: 1 / -1; color: rgba(var(--v-theme-on-surface), .52); font-size: .65rem; }
.audit-list { display: grid; }
.audit-list article { display: grid; grid-template-columns: minmax(150px,.55fr) 44px minmax(180px,.8fr) minmax(280px,1.4fr) minmax(110px,auto) auto; align-items: center; gap: 10px; min-height: var(--record-row-min-height); padding: 7px 12px; border-top: 1px solid var(--rule); }
.audit-list article:first-child { border-top: 0; }
.audit-kind, .audit-result { display: grid; min-width: 0; }
.audit-kind span { color: rgb(var(--v-theme-primary)); font-size: .7rem; font-weight: 800; }
.audit-kind small, .audit-result small { overflow: hidden; color: rgba(var(--v-theme-on-surface), .54); font-size: var(--record-meta-size); text-overflow: ellipsis; white-space: nowrap; }
.audit-list time { display: grid; border-inline-start: 1px solid var(--rule); text-align: center; }
.audit-list time b { font-size: var(--record-date-size); }
.audit-list time small { color: rgba(var(--v-theme-on-surface), .5); font-size: var(--record-month-size); }
.audit-result strong { overflow: hidden; font-size: var(--record-title-size); text-overflow: ellipsis; white-space: nowrap; }
.audit-list article > p { margin: 0; overflow: hidden; color: rgba(var(--v-theme-on-surface), .62); font-size: var(--record-detail-size); line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.evidence-audit > footer { display: flex; justify-content: center; padding: 5px 12px; border-top: 1px solid var(--rule); }
.audit-empty { margin: 0; padding: 28px; color: rgba(var(--v-theme-on-surface), .55); text-align: center; }
.issue-list { display: grid; gap: 7px; padding: 10px; background: rgba(var(--v-theme-on-surface), .025); }
.issue-card { border: 1px solid var(--rule); border-radius: 10px; background: rgb(var(--v-theme-surface)); overflow: hidden; }
.issue-card > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 10px; background: rgba(var(--v-theme-warning), .055); }
.issue-heading { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.issue-card > header span { color: rgb(var(--v-theme-warning)); font-size: .68rem; font-weight: 800; }
.issue-card > header small { overflow: hidden; color: rgba(var(--v-theme-on-surface), .56); font-size: .72rem; text-overflow: ellipsis; white-space: nowrap; }
.issue-card > header em { padding: 4px 8px; border-radius: 999px; background: rgba(var(--v-theme-warning), .12); color: rgb(var(--v-theme-warning)); font-size: .7rem; font-style: normal; white-space: nowrap; }
.issue-actions { display: flex; align-items: center; justify-content: flex-end; gap: 4px; flex: none; }
.issue-events { display: grid; }
.issue-event, .event-row { display: grid; grid-template-columns: 52px minmax(0,1fr) minmax(130px,auto) auto; align-items: center; gap: 10px; min-height: var(--record-row-min-height); padding: 7px 12px; border-top: 1px solid var(--rule); }
.issue-event time, .event-row time { display: grid; text-align: center; border-inline-end: 1px solid var(--rule); }
.issue-event time b, .event-row time b { font-size: var(--record-date-size); }
.issue-event time small, .event-row time small { color: rgba(var(--v-theme-on-surface), .58); font-size: var(--record-month-size); }
.issue-event > div, .event-row > div { display: grid; min-width: 0; }
.issue-event > div > small, .issue-event > div > span, .event-row > div > small { color: rgba(var(--v-theme-on-surface), .64); font-size: var(--record-meta-size); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.event-row .context { color: rgba(var(--v-theme-on-surface), .64); font-size: var(--record-detail-size); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.category-field { display: flex !important; align-items: center; gap: 6px; min-width: 0; color: rgba(var(--v-theme-on-surface), .64); font-size: var(--record-detail-size); }
.category-field > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.category-field > span.pending { color: rgb(var(--v-theme-warning)); }
.category-edit-action { flex: none; padding: 0; border: 0; background: none; color: rgb(var(--v-theme-primary)); cursor: pointer; font: inherit; font-size: .66rem; font-weight: 700; white-space: nowrap; }
.category-edit-action:hover { text-decoration: underline; text-underline-offset: 2px; }
.issue-event-copy { gap: 1px; }
.issue-event-copy > strong, .event-row > div > strong { overflow: hidden; font-size: var(--record-title-size); text-overflow: ellipsis; white-space: nowrap; }
.account-route { display: flex; align-items: center; gap: 7px; min-width: 0; color: rgba(var(--v-theme-on-surface), .72); font-size: var(--record-detail-size); }
.account-route span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-route span.pending { color: rgb(var(--v-theme-warning)); font-weight: 700; }
.account-route i { color: rgba(var(--v-theme-on-surface), .38); font-style: normal; }
.event-list { display: grid; }
.event-row { grid-template-columns: 52px minmax(220px,.8fr) minmax(170px,.72fr) minmax(120px,.46fr) minmax(130px,auto) auto; }
.event-row.excluded-record { grid-template-columns: 5rem 44px minmax(220px,.8fr) minmax(260px,1.2fr) minmax(130px,auto) auto; }
.event-row.excluded-record time { border-inline-start: 1px solid var(--rule); border-inline-end: 0; }
.event-row .event-copy > span { color: rgb(var(--v-theme-primary)); font-size: .68rem; }
.event-row .event-copy > span.income { color: rgb(var(--v-theme-success)); }
.event-kind span { overflow: hidden; color: rgb(var(--v-theme-warning)); font-size: .7rem; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
.event-row.excluded-record .context { color: rgba(var(--v-theme-on-surface), .56); }
.amount { text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; }
.amount.inflow, .resolve-preview b.inflow { color: rgb(var(--v-theme-success)); }
.amount.outflow, .resolve-preview b.outflow { color: rgb(var(--v-theme-error)); }
.raw-record-action { font-size: var(--record-action-size); font-weight: 700; white-space: nowrap; }
.row-actions { display: flex !important; align-items: center; justify-content: flex-end; gap: 3px; white-space: nowrap; }
.empty { padding: 56px; color: rgba(var(--v-theme-on-surface), .55); text-align: center; }
.evidence-dialog-title { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding: 18px 20px 12px; }
.evidence-dialog-title small { color: rgba(var(--v-theme-on-surface), .52); font-size: .76rem; font-weight: 600; }
.evidence-dialog-body { max-height: min(72vh, 720px); padding: 0 20px 16px; overflow-y: auto; }
.evidence-list { display: grid; gap: 12px; }
.audit-explanation { display: grid; gap: 5px; padding: 10px 12px; border-inline-start: 3px solid rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .055); }
.audit-explanation > div { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.audit-explanation span { color: rgb(var(--v-theme-primary)); font-size: .7rem; font-weight: 800; }
.audit-explanation strong { font-size: .78rem; }
.audit-explanation p { margin: 0; color: rgba(var(--v-theme-on-surface), .72); font-size: .76rem; }
.audit-explanation small { color: rgba(var(--v-theme-on-surface), .52); font-size: .68rem; }
.evidence-record { overflow: hidden; border: 1px solid var(--rule); border-radius: 10px; background: rgb(var(--v-theme-surface)); }
.evidence-record > header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 9px 12px; border-bottom: 1px solid var(--rule); background: rgba(var(--v-theme-primary), .045); }
.evidence-record > header > div { display: grid; min-width: 0; }
.evidence-record > header strong, .evidence-record > header small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.evidence-record > header small { color: rgba(var(--v-theme-on-surface), .55); font-size: .7rem; }
.evidence-record > header > span { color: rgb(var(--v-theme-primary)); font-size: .7rem; font-weight: 700; white-space: nowrap; }
.evidence-record.discarded { opacity: .62; }
.raw-fields { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); margin: 0; }
.raw-fields > div { display: grid; grid-template-columns: minmax(92px,.38fr) minmax(0,1fr); align-items: baseline; gap: 10px; min-height: 34px; padding: 7px 11px; border-bottom: 1px solid rgba(var(--v-theme-on-surface), .07); }
.raw-fields > div:nth-child(odd) { border-inline-end: 1px solid rgba(var(--v-theme-on-surface), .07); }
.raw-fields dt { overflow: hidden; color: rgba(var(--v-theme-on-surface), .52); font-size: .68rem; text-overflow: ellipsis; white-space: nowrap; }
.raw-fields dd { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: .76rem; line-height: 1.35; }
.empty-fields { margin: 0; padding: 24px; color: rgba(var(--v-theme-on-surface), .55); text-align: center; }
.resolve-preview { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px; border-inline-start: 3px solid rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .05); }
.resolve-preview > div { display: grid; min-width: 0; }
.resolve-preview small { color: rgba(var(--v-theme-on-surface), .58); }
.resolve-preview b { white-space: nowrap; }
.hint { margin: 14px 0 10px; font-size: .82rem; }
.category-scope { margin: 2px 0 14px; padding: 10px 12px; border: 1px solid var(--rule); border-radius: 10px; background: rgba(var(--v-theme-primary), .025); }
.category-scope-loading { display: flex; align-items: center; gap: 8px; min-height: 42px; margin: 2px 0 14px; color: rgba(var(--v-theme-on-surface), .58); font-size: .78rem; }
.category-scope > strong { color: rgba(var(--v-theme-on-surface), .72); font-size: .76rem; }
.category-scope :deep(.v-selection-control) { min-height: 40px; }
.category-scope :deep(.v-label) { opacity: 1; }
.category-scope span { display: grid; gap: 1px; }
.category-scope b { color: rgba(var(--v-theme-on-surface), .84); font-size: .82rem; font-weight: 600; }
.category-scope small { color: rgba(var(--v-theme-on-surface), .54); font-size: .7rem; }
.relationship-options { display: grid; gap: 8px; }
.relationship-options :deep(.v-selection-control) { align-items: flex-start; min-height: 64px; padding: 10px 12px; border: 1px solid var(--rule); border-radius: 9px; }
.relationship-options :deep(.v-selection-control--dirty) { border-color: rgba(var(--v-theme-primary), .45); background: rgba(var(--v-theme-primary), .045); }
.relationship-option-copy { display: grid; gap: 2px; padding-top: 1px; }
.relationship-option-copy small { color: rgba(var(--v-theme-on-surface), .58); font-size: .74rem; }
.installment-candidate-facts { display: flex; flex-wrap: wrap; gap: 7px; margin: -2px 0 12px; }
.installment-candidate-facts span { padding: 5px 9px; border-radius: 999px; background: rgba(var(--v-theme-primary), .08); color: rgba(var(--v-theme-on-surface), .72); font-size: .72rem; font-weight: 650; }
.existing-installment-picker { margin: 10px 0 14px; }
.existing-installment-picker :deep(.v-expansion-panel) { border: 1px solid var(--rule); border-radius: 9px; box-shadow: none; }
.existing-installment-selection { display: grid; gap: 2px; }
.existing-installment-selection small { color: rgba(var(--v-theme-on-surface), .56); font-size: .72rem; }
.existing-installment-list { display: grid; gap: 6px; }
.existing-installment-list :deep(.v-selection-control) { align-items: flex-start; min-height: 54px; padding: 8px 10px; border: 1px solid var(--rule); border-radius: 8px; }
.existing-installment-list :deep(.v-selection-control--dirty) { border-color: rgba(var(--v-theme-primary), .42); background: rgba(var(--v-theme-primary), .04); }
.existing-installment-option { display: grid; gap: 2px; width: 100%; }
.existing-installment-option > div { display: flex; align-items: center; gap: 7px; }
.existing-installment-option span { padding: 2px 6px; border-radius: 999px; background: rgba(var(--v-theme-primary), .1); color: rgb(var(--v-theme-primary)); font-size: .65rem; font-weight: 650; }
.existing-installment-option small { color: rgba(var(--v-theme-on-surface), .58); font-size: .72rem; }
.installment-contract-form { margin-top: 12px; overflow: hidden; border: 1px solid var(--rule); border-radius: 12px; background: rgb(var(--v-theme-surface)); }
.installment-editor-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 20px; border-bottom: 1px solid var(--rule); background: linear-gradient(145deg, rgba(var(--v-theme-primary), .045), transparent 58%); }
.installment-editor-heading > div > div { color: rgb(var(--v-theme-primary)); font-size: .72rem; font-weight: 700; letter-spacing: .08em; }
.installment-editor-heading h3 { margin: 4px 0 0; color: rgba(var(--v-theme-on-surface), .88); font-size: 1.18rem; line-height: 1.3; }
.installment-editor-heading p { margin: 7px 0 0; color: rgba(var(--v-theme-on-surface), .58); font-size: .8rem; line-height: 1.45; }
.installment-editor-heading > span { flex: none; padding: 7px 10px; border-radius: 8px; background: rgba(var(--v-theme-primary), .08); color: rgb(var(--v-theme-primary)); font-size: .8rem; }
.installment-outcome { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 5px 12px; margin-top: 12px; padding: 10px 12px; border-inline-start: 3px solid rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .045); }
.installment-outcome strong { color: rgb(var(--v-theme-primary)); font-size: .72rem; white-space: nowrap; }
.installment-outcome span { color: rgba(var(--v-theme-on-surface), .72); font-size: .76rem; line-height: 1.45; }
@media (max-width: 900px) {
    .steps { grid-template-columns: 1fr; }
    .overview-card > footer, .workbench > header, .source-stage > header { align-items: start; flex-direction: column; }
    .post-all-action { align-self: stretch; }
    .category-toolbar { align-items: stretch; flex-direction: column; gap: 6px; }
    .category-toolbar-copy span { white-space: normal; }
    .category-filter-action { align-self: flex-start; }
    .source-stage > header > div { display: grid; gap: 2px; }
    .overview-controls { align-items: stretch; flex-direction: column; width: 100%; }
    .overview-controls .v-btn-toggle { align-self: stretch; overflow-x: auto; }
    .conservation-inline { white-space: normal; }
    .posting-complete { grid-template-columns: auto 1fr; }
    .posting-complete p { grid-column: 1 / -1; }
    .issue-card > header { align-items: stretch; flex-direction: column; }
    .evidence-audit > header { align-items: start; }
    .evidence-audit > header > div:first-child { grid-template-columns: auto 1fr; }
    .evidence-audit > header p { grid-column: 1 / -1; white-space: normal; }
    .audit-list article { grid-template-columns: 44px minmax(0,1fr) auto; }
    .audit-kind { grid-column: 1 / -1; grid-row: 1; }
    .audit-list article > p { grid-column: 2 / -1; white-space: normal; }
    .audit-list article > .amount { grid-column: 2; text-align: start; }
    .audit-list article > .v-btn { grid-column: 3; }
    .issue-actions { justify-content: flex-start; flex-wrap: wrap; }
    .issue-event, .event-row { grid-template-columns: 48px minmax(0,1fr) auto; }
    .issue-event > .amount, .event-row .context, .event-row .category-field { grid-column: 2; text-align: start; }
    .issue-event > .v-btn, .event-row > .v-btn, .event-row > .row-actions { grid-column: 3; }
    .event-row.excluded-record { grid-template-columns: 48px minmax(0,1fr) auto; }
    .event-row.excluded-record .event-kind { grid-column: 1 / -1; grid-row: 1; }
    .event-row.excluded-record time { grid-column: 1; grid-row: 2; border-inline-start: 0; border-inline-end: 1px solid var(--rule); }
    .event-row.excluded-record .event-copy { grid-column: 2 / -1; grid-row: 2; }
    .event-row.excluded-record .context { grid-column: 2 / -1; grid-row: 3; }
    .event-row.excluded-record > .amount { grid-column: 2; grid-row: 4; text-align: start; }
    .event-row.excluded-record > .v-btn, .event-row.excluded-record > .row-actions { grid-column: 3; grid-row: 4; }
    .raw-fields { grid-template-columns: 1fr; }
    .raw-fields > div:nth-child(odd) { border-inline-end: 0; }
}
</style>
