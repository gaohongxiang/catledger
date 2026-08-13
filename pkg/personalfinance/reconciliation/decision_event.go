package reconciliation

import (
	"fmt"
	"sort"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

const (
	decisionReasonEvidenceLimit           = "evidence_limit_reached"
	decisionReasonEventMissing            = "ledger_event_missing"
	decisionReasonEventModified           = "ledger_event_modified"
	decisionReasonEventTypeMismatch       = "ledger_event_type_mismatch"
	decisionReasonTransferIncomplete      = "transfer_pair_incomplete"
	decisionReasonMultipleEvents          = "multiple_existing_events"
	decisionReasonDraftRequired           = "ledger_draft_required"
	decisionReasonDraftMismatch           = "ledger_draft_mismatch"
	decisionReasonRefundRoleAmbiguous     = "refund_roles_ambiguous"
	decisionReasonRefundEventsNotDistinct = "refund_events_not_distinct"
	decisionReasonRefundSemanticsInvalid  = "refund_semantics_invalid"
)

type decisionLedgerEvent struct {
	key         string
	primary     *models.Transaction
	counterpart *models.Transaction
	method      TransactionCreationMethod
}

type decisionEvidenceResolution struct {
	memberEvents []map[string]*decisionLedgerEvent
	rowsByMember [][]*importing.RawImportRow
}

type transferEvidenceRoleState struct {
	primary     bool
	counterpart bool
}

func applyMatchingDecision(c core.Context, database *datastore.Database, sess *xorm.Session, execution *decisionExecution, ledger DecisionLedger, generateId func() int64, now int64, members []*caseMemberRows) ([]string, error) {
	resolution, actionReason, err := resolveDecisionEvidence(sess, execution.uid, members)
	if err != nil {
		return nil, err
	}
	if actionReason != "" {
		return []string{actionReason}, nil
	}

	switch execution.decisionType {
	case DECISION_TYPE_SAME_EVENT, DECISION_TYPE_INTERNAL_TRANSFER:
		return applySingleEventDecision(c, database, sess, execution, ledger, generateId, now, members, resolution)
	case DECISION_TYPE_REFUND_REVERSAL:
		return applyRefundDecision(c, database, sess, execution, ledger, generateId, now, members, resolution)
	default:
		return nil, fmt.Errorf("invalid matching decision type")
	}
}

func resolveDecisionEvidence(sess *xorm.Session, uid int64, members []*caseMemberRows) (*decisionEvidenceResolution, string, error) {
	rowIds := memberRowIds(members)
	links, limitReached, err := loadEvidenceLinkReferences(sess, uid, rowIds, maximumDecisionEvidenceLinks)
	if err != nil {
		return nil, "", err
	}
	if limitReached {
		return nil, decisionReasonEvidenceLimit, nil
	}
	rowMember := make(map[int64]int)
	rowsByMember := make([][]*importing.RawImportRow, len(members))
	for memberIndex, member := range members {
		for _, row := range member.rows {
			if previous, exists := rowMember[row.RowId]; exists && previous != memberIndex {
				return nil, "", fmt.Errorf("reconciliation row belongs to multiple members")
			}
			rowMember[row.RowId] = memberIndex
			if isDecisionEvidenceRow(row) {
				rowsByMember[memberIndex] = append(rowsByMember[memberIndex], row)
			}
		}
		if len(rowsByMember[memberIndex]) == 0 {
			return nil, decisionReasonEventMissing, nil
		}
	}

	transactionIds := make([]int64, 0, len(links))
	for _, link := range links {
		if link == nil || link.rowId < 1 || link.transactionId < 1 || link.transactionUpdatedUnixTime < 1 || link.groupId < 1 ||
			(link.origin != "v002" && link.origin != "v003") {
			return nil, "", fmt.Errorf("reconciliation evidence link invariant mismatch")
		}
		if _, exists := rowMember[link.rowId]; !exists {
			return nil, "", fmt.Errorf("reconciliation evidence link row invariant mismatch")
		}
		transactionIds = append(transactionIds, link.transactionId)
	}
	transactions, err := loadDecisionTransactions(sess, uid, uniquePositiveInt64(transactionIds))
	if err != nil {
		return nil, "", err
	}
	for _, link := range links {
		transaction := transactions[link.transactionId]
		if transaction != nil && isTransferTransaction(transaction) && transaction.RelatedId > 0 {
			transactionIds = append(transactionIds, transaction.RelatedId)
		}
	}
	transactions, err = loadDecisionTransactions(sess, uid, uniquePositiveInt64(transactionIds))
	if err != nil {
		return nil, "", err
	}

	memberEvents := make([]map[string]*decisionLedgerEvent, len(members))
	for index := range memberEvents {
		memberEvents[index] = make(map[string]*decisionLedgerEvent)
	}
	transferRoles := make(map[string]*transferEvidenceRoleState)
	allEvents := make(map[string]struct{})

	for _, link := range links {
		transaction := transactions[link.transactionId]
		if transaction == nil || transaction.Deleted {
			return nil, decisionReasonEventMissing, nil
		}
		if transaction.Uid != uid || transaction.UpdatedUnixTime != link.transactionUpdatedUnixTime {
			return nil, decisionReasonEventModified, nil
		}
		event, reason := decisionEventForTransaction(transaction, transactions)
		if reason != "" {
			return nil, reason, nil
		}
		if !evidenceRoleMatchesEvent(link.relationRole, event) {
			return nil, decisionReasonEventTypeMismatch, nil
		}
		memberIndex := rowMember[link.rowId]
		memberEvents[memberIndex][event.key] = event
		allEvents[event.key] = struct{}{}
		if event.counterpart != nil {
			roleKey := fmt.Sprintf("%s:%d:%d:%d", link.origin, link.groupId, link.rowId, event.primary.TransactionId)
			state := transferRoles[roleKey]
			if state == nil {
				state = new(transferEvidenceRoleState)
				transferRoles[roleKey] = state
			}
			switch link.relationRole {
			case string(TRANSACTION_RELATION_ROLE_PRIMARY):
				state.primary = true
			case string(TRANSACTION_RELATION_ROLE_TRANSFER_COUNTERPART):
				state.counterpart = true
			}
		}
	}
	if len(allEvents) > maximumDecisionLedgerEvents {
		return nil, decisionReasonEvidenceLimit, nil
	}
	for _, state := range transferRoles {
		if !state.primary || !state.counterpart {
			return nil, decisionReasonTransferIncomplete, nil
		}
	}
	return &decisionEvidenceResolution{memberEvents: memberEvents, rowsByMember: rowsByMember}, "", nil
}

func applySingleEventDecision(c core.Context, database *datastore.Database, sess *xorm.Session, execution *decisionExecution, ledger DecisionLedger, generateId func() int64, now int64, members []*caseMemberRows, resolution *decisionEvidenceResolution) ([]string, error) {
	events := unionDecisionEvents(resolution.memberEvents)
	if len(events) > 1 {
		return []string{decisionReasonMultipleEvents}, nil
	}
	var event *decisionLedgerEvent
	created := false
	for _, existing := range events {
		event = existing
	}
	if event == nil {
		if execution.primaryDraft == nil {
			return []string{decisionReasonDraftRequired}, nil
		}
		if !decisionDraftMatchesRows(execution.primaryDraft.transaction, flattenDecisionRows(resolution.rowsByMember), execution.decisionType) {
			return []string{decisionReasonDraftMismatch}, nil
		}
		var err error
		event, err = createDecisionLedgerEvent(c, database, sess, execution.uid, execution.primaryDraft, ledger)
		if err != nil {
			return nil, err
		}
		created = true
	}
	if execution.decisionType == DECISION_TYPE_INTERNAL_TRANSFER && event.counterpart == nil {
		return []string{decisionReasonEventTypeMismatch}, nil
	}

	method := TRANSACTION_CREATION_METHOD_ATTACHED_EXISTING
	if created {
		method = TRANSACTION_CREATION_METHOD_RECONCILIATION_CREATED
		if err := insertCreatedEventEffects(sess, execution, event, generateId, now); err != nil {
			return nil, err
		}
	}
	for _, rows := range resolution.rowsByMember {
		for _, row := range rows {
			if err := insertDecisionEventLinks(sess, execution, row.RowId, event, method, TRANSACTION_RELATION_ROLE_PRIMARY, generateId, now); err != nil {
				return nil, err
			}
		}
	}
	if err := markDecisionRowsLinked(sess, execution.uid, members, now); err != nil {
		return nil, err
	}
	return nil, nil
}

func applyRefundDecision(c core.Context, database *datastore.Database, sess *xorm.Session, execution *decisionExecution, ledger DecisionLedger, generateId func() int64, now int64, members []*caseMemberRows, resolution *decisionEvidenceResolution) ([]string, error) {
	originalIndex, ok := refundOriginalMemberIndex(execution.fieldSelection, resolution.rowsByMember)
	if !ok {
		return []string{decisionReasonRefundRoleAmbiguous}, nil
	}
	refundIndex := 1 - originalIndex
	if len(resolution.memberEvents[originalIndex]) > 1 || len(resolution.memberEvents[refundIndex]) > 1 {
		return []string{decisionReasonMultipleEvents}, nil
	}
	original := onlyDecisionEvent(resolution.memberEvents[originalIndex])
	refund := onlyDecisionEvent(resolution.memberEvents[refundIndex])
	if original != nil && refund != nil && original.key == refund.key {
		return []string{decisionReasonRefundEventsNotDistinct}, nil
	}
	if original == nil && execution.refundOriginalDraft == nil || refund == nil && execution.refundTransactionDraft == nil {
		return []string{decisionReasonDraftRequired}, nil
	}
	if original == nil && !decisionDraftMatchesRows(execution.refundOriginalDraft.transaction, resolution.rowsByMember[originalIndex], DECISION_TYPE_REFUND_REVERSAL) ||
		refund == nil && !decisionDraftMatchesRows(execution.refundTransactionDraft.transaction, resolution.rowsByMember[refundIndex], DECISION_TYPE_REFUND_REVERSAL) {
		return []string{decisionReasonDraftMismatch}, nil
	}
	originalPrimary := execution.refundOriginalDraft
	if original != nil {
		originalPrimary = &decisionDraft{transaction: original.primary}
	}
	refundPrimary := execution.refundTransactionDraft
	if refund != nil {
		refundPrimary = &decisionDraft{transaction: refund.primary}
	}
	if originalPrimary == nil || refundPrimary == nil || !isOrdinaryTransaction(originalPrimary.transaction) || !isOrdinaryTransaction(refundPrimary.transaction) ||
		(original != nil && original.counterpart != nil) || (refund != nil && refund.counterpart != nil) ||
		originalPrimary.transaction.Amount != refundPrimary.transaction.Amount || !ordinaryDirectionsOpposite(originalPrimary.transaction, refundPrimary.transaction) {
		return []string{decisionReasonRefundSemanticsInvalid}, nil
	}
	originalCreated := false
	refundCreated := false
	if original == nil {
		var err error
		original, err = createDecisionLedgerEvent(c, database, sess, execution.uid, execution.refundOriginalDraft, ledger)
		if err != nil {
			return nil, err
		}
		originalCreated = true
	}
	if refund == nil {
		var err error
		refund, err = createDecisionLedgerEvent(c, database, sess, execution.uid, execution.refundTransactionDraft, ledger)
		if err != nil {
			return nil, err
		}
		refundCreated = true
	}
	if original.counterpart != nil || refund.counterpart != nil || original.primary.TransactionId == refund.primary.TransactionId ||
		original.primary.Amount != refund.primary.Amount || !ordinaryDirectionsOpposite(original.primary, refund.primary) {
		return nil, fmt.Errorf("created refund ledger event invariant mismatch")
	}
	if originalCreated {
		if err := insertCreatedEventEffects(sess, execution, original, generateId, now); err != nil {
			return nil, err
		}
	}
	if refundCreated {
		if err := insertCreatedEventEffects(sess, execution, refund, generateId, now); err != nil {
			return nil, err
		}
	}
	for memberIndex, event := range []*decisionLedgerEvent{original, refund} {
		actualMemberIndex := originalIndex
		role := TRANSACTION_RELATION_ROLE_REFUND_ORIGINAL
		created := originalCreated
		if memberIndex == 1 {
			actualMemberIndex = refundIndex
			role = TRANSACTION_RELATION_ROLE_REFUND_TRANSACTION
			created = refundCreated
		}
		method := TRANSACTION_CREATION_METHOD_ATTACHED_EXISTING
		if created {
			method = TRANSACTION_CREATION_METHOD_RECONCILIATION_CREATED
		}
		for _, row := range resolution.rowsByMember[actualMemberIndex] {
			if err := insertDecisionEventLinks(sess, execution, row.RowId, event, method, role, generateId, now); err != nil {
				return nil, err
			}
		}
	}
	if err := markDecisionRowsLinked(sess, execution.uid, members, now); err != nil {
		return nil, err
	}
	return nil, nil
}

func createDecisionLedgerEvent(c core.Context, database *datastore.Database, sess *xorm.Session, uid int64, draft *decisionDraft, ledger DecisionLedger) (*decisionLedgerEvent, error) {
	transaction := *draft.transaction
	tagIds := append([]int64(nil), draft.tagIds...)
	primary, counterpart, err := ledger.CreateTransactionInSession(c, database, sess, &transaction, tagIds)
	if err != nil {
		return nil, errDecisionLedgerRejected
	}
	if primary == nil || primary.Uid != uid || primary.TransactionId < 1 || primary.Deleted || primary.UpdatedUnixTime < 1 {
		return nil, fmt.Errorf("created reconciliation ledger event invariant mismatch")
	}
	event := &decisionLedgerEvent{primary: primary, method: TRANSACTION_CREATION_METHOD_RECONCILIATION_CREATED}
	if isTransferTransaction(primary) {
		if counterpart == nil || !completeDecisionTransferPair(primary, counterpart) {
			return nil, fmt.Errorf("created reconciliation transfer invariant mismatch")
		}
		if primary.Type == models.TRANSACTION_DB_TYPE_TRANSFER_IN {
			event.primary, event.counterpart = counterpart, primary
		} else {
			event.counterpart = counterpart
		}
	} else if !isOrdinaryTransaction(primary) || counterpart != nil {
		return nil, fmt.Errorf("created reconciliation event type invariant mismatch")
	}
	event.key = decisionEventKey(event.primary, event.counterpart)
	return event, nil
}

func insertDecisionEventLinks(sess *xorm.Session, execution *decisionExecution, rowId int64, event *decisionLedgerEvent, method TransactionCreationMethod, primaryRole TransactionRelationRole, generateId func() int64, now int64) error {
	if err := insertDecisionLink(sess, execution, rowId, event.primary, primaryRole, method, generateId, now); err != nil {
		return err
	}
	if event.counterpart != nil {
		if primaryRole != TRANSACTION_RELATION_ROLE_PRIMARY {
			return fmt.Errorf("refund relationship cannot target a transfer event")
		}
		return insertDecisionLink(sess, execution, rowId, event.counterpart, TRANSACTION_RELATION_ROLE_TRANSFER_COUNTERPART, method, generateId, now)
	}
	return nil
}

func insertDecisionLink(sess *xorm.Session, execution *decisionExecution, rowId int64, transaction *models.Transaction, role TransactionRelationRole, method TransactionCreationMethod, generateId func() int64, now int64) error {
	linkId := generateId()
	if linkId < 1 {
		return fmt.Errorf("reconciliation link identifier unavailable")
	}
	link := &TransactionLink{Uid: execution.uid, DecisionId: execution.decisionId, RowId: rowId, TransactionId: transaction.TransactionId,
		RelationRole: role, CreationMethod: method, RuleVersion: TRANSACTION_LINK_VERSION_V1,
		TransactionUpdatedUnixTime: transaction.UpdatedUnixTime, CreatedUnixTime: now, LinkId: linkId}
	inserted, err := sess.Insert(link)
	if err != nil {
		return fmt.Errorf("insert reconciliation transaction link: %w", err)
	}
	if inserted != 1 {
		return fmt.Errorf("reconciliation transaction link was not inserted")
	}
	return nil
}

func insertCreatedEventEffects(sess *xorm.Session, execution *decisionExecution, event *decisionLedgerEvent, generateId func() int64, now int64) error {
	transactions := []*models.Transaction{event.primary}
	if event.counterpart != nil {
		transactions = append(transactions, event.counterpart)
	}
	for _, transaction := range transactions {
		effectId := generateId()
		if effectId < 1 {
			return fmt.Errorf("reconciliation effect identifier unavailable")
		}
		effect := &LedgerEffect{Uid: execution.uid, DecisionId: execution.decisionId, TransactionId: transaction.TransactionId,
			EffectType: LEDGER_EFFECT_TYPE_CREATED, TransactionUpdatedUnixTime: transaction.UpdatedUnixTime,
			CreatedUnixTime: now, EffectId: effectId}
		inserted, err := sess.Insert(effect)
		if err != nil {
			return fmt.Errorf("insert reconciliation ledger effect: %w", err)
		}
		if inserted != 1 {
			return fmt.Errorf("reconciliation ledger effect was not inserted")
		}
	}
	return nil
}

func markDecisionRowsLinked(sess *xorm.Session, uid int64, members []*caseMemberRows, now int64) error {
	rowIds := targetMemberRowIds(members, importing.PROCESSING_STATE_PENDING)
	if len(rowIds) > 0 {
		updated, err := sess.Where("uid=? AND processing_state=?", uid, importing.PROCESSING_STATE_PENDING).In("row_id", rowIds).
			Cols("processing_state", "disposition").Update(&importing.RawImportRow{ProcessingState: importing.PROCESSING_STATE_LINKED, Disposition: importing.IMPORT_DISPOSITION_NON_POSTABLE})
		if err != nil {
			return err
		}
		if updated != int64(len(rowIds)) {
			return errDecisionCaseVersionConflict
		}
	}
	return recomputeDecisionBatches(sess, uid, members, now)
}

func decisionEventForTransaction(transaction *models.Transaction, transactions map[int64]*models.Transaction) (*decisionLedgerEvent, string) {
	if isOrdinaryTransaction(transaction) {
		return &decisionLedgerEvent{key: decisionEventKey(transaction, nil), primary: transaction, method: TRANSACTION_CREATION_METHOD_ATTACHED_EXISTING}, ""
	}
	if !isTransferTransaction(transaction) {
		return nil, decisionReasonEventTypeMismatch
	}
	counterpart := transactions[transaction.RelatedId]
	if counterpart == nil || counterpart.Deleted || !completeDecisionTransferPair(transaction, counterpart) {
		return nil, decisionReasonTransferIncomplete
	}
	primary := transaction
	if transaction.Type == models.TRANSACTION_DB_TYPE_TRANSFER_IN {
		primary, counterpart = counterpart, transaction
	}
	return &decisionLedgerEvent{key: decisionEventKey(primary, counterpart), primary: primary, counterpart: counterpart, method: TRANSACTION_CREATION_METHOD_ATTACHED_EXISTING}, ""
}

func evidenceRoleMatchesEvent(role string, event *decisionLedgerEvent) bool {
	if event == nil {
		return false
	}
	switch role {
	case string(TRANSACTION_RELATION_ROLE_PRIMARY):
		return true
	case string(TRANSACTION_RELATION_ROLE_TRANSFER_COUNTERPART):
		return event.counterpart != nil
	case string(TRANSACTION_RELATION_ROLE_REFUND_ORIGINAL), string(TRANSACTION_RELATION_ROLE_REFUND_TRANSACTION):
		return event.counterpart == nil
	default:
		return false
	}
}

func completeDecisionTransferPair(first *models.Transaction, second *models.Transaction) bool {
	if first == nil || second == nil || first.Uid != second.Uid || first.Deleted || second.Deleted ||
		first.TransactionId < 1 || second.TransactionId < 1 || first.TransactionId == second.TransactionId ||
		first.RelatedId != second.TransactionId || second.RelatedId != first.TransactionId ||
		first.AccountId != second.RelatedAccountId || first.RelatedAccountId != second.AccountId ||
		first.Amount != second.RelatedAccountAmount || first.RelatedAccountAmount != second.Amount ||
		first.CategoryId != second.CategoryId || first.TimezoneUtcOffset != second.TimezoneUtcOffset {
		return false
	}
	return (first.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT && second.Type == models.TRANSACTION_DB_TYPE_TRANSFER_IN && second.TransactionTime == first.TransactionTime+1) ||
		(first.Type == models.TRANSACTION_DB_TYPE_TRANSFER_IN && second.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT && second.TransactionTime == first.TransactionTime-1)
}

func decisionDraftMatchesRows(transaction *models.Transaction, rows []*importing.RawImportRow, decisionType DecisionType) bool {
	if transaction == nil || len(rows) == 0 {
		return false
	}
	for _, row := range rows {
		if row.NormalizedAmount == nil || *row.NormalizedAmount < 0 {
			return false
		}
		if isTransferTransaction(transaction) {
			if transaction.Amount != *row.NormalizedAmount || transaction.RelatedAccountAmount != *row.NormalizedAmount {
				return false
			}
			continue
		}
		if transaction.Amount != *row.NormalizedAmount {
			return false
		}
		if decisionType != DECISION_TYPE_REFUND_REVERSAL {
			if row.NormalizedDirection == importing.NORMALIZED_DIRECTION_INCOME && transaction.Type != models.TRANSACTION_DB_TYPE_INCOME {
				return false
			}
			if row.NormalizedDirection == importing.NORMALIZED_DIRECTION_EXPENSE && transaction.Type != models.TRANSACTION_DB_TYPE_EXPENSE {
				return false
			}
		}
	}
	return true
}

func refundOriginalMemberIndex(selection DecisionFieldSelection, rows [][]*importing.RawImportRow) (int, bool) {
	if selection.RefundOriginalMemberOrder == 1 || selection.RefundOriginalMemberOrder == 2 {
		return int(selection.RefundOriginalMemberOrder - 1), true
	}
	refundMember := -1
	for memberIndex, memberRows := range rows {
		hasRefund := false
		for _, row := range memberRows {
			if row.EconomicEffect == importing.ECONOMIC_EFFECT_REFUND {
				hasRefund = true
			}
		}
		if hasRefund {
			if refundMember != -1 {
				return 0, false
			}
			refundMember = memberIndex
		}
	}
	if refundMember == -1 {
		return 0, false
	}
	return 1 - refundMember, true
}

func isDecisionEvidenceRow(row *importing.RawImportRow) bool {
	return row != nil && row.ParseState == importing.PARSE_STATE_VALID &&
		(row.IdentityState == importing.IDENTITY_STATE_NEW || row.IdentityState == importing.IDENTITY_STATE_EXACT_DUPLICATE || row.IdentityState == importing.IDENTITY_STATE_BATCH_LOCAL) &&
		(row.SemanticEligibility == importing.SEMANTIC_ELIGIBILITY_POSTABLE || row.SemanticEligibility == importing.SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED) &&
		(row.ProcessingState == importing.PROCESSING_STATE_PENDING || row.ProcessingState == importing.PROCESSING_STATE_LINKED)
}

func unionDecisionEvents(members []map[string]*decisionLedgerEvent) map[string]*decisionLedgerEvent {
	result := make(map[string]*decisionLedgerEvent)
	for _, events := range members {
		for key, event := range events {
			result[key] = event
		}
	}
	return result
}

func onlyDecisionEvent(events map[string]*decisionLedgerEvent) *decisionLedgerEvent {
	for _, event := range events {
		return event
	}
	return nil
}

func flattenDecisionRows(values [][]*importing.RawImportRow) []*importing.RawImportRow {
	result := make([]*importing.RawImportRow, 0)
	for _, rows := range values {
		result = append(result, rows...)
	}
	return result
}

func decisionEventKey(primary *models.Transaction, counterpart *models.Transaction) string {
	if counterpart == nil {
		return fmt.Sprintf("ordinary:%d", primary.TransactionId)
	}
	return fmt.Sprintf("transfer:%d:%d", primary.TransactionId, counterpart.TransactionId)
}

func isTransferTransaction(transaction *models.Transaction) bool {
	return transaction != nil && (transaction.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT || transaction.Type == models.TRANSACTION_DB_TYPE_TRANSFER_IN)
}

func ordinaryDirectionsOpposite(first *models.Transaction, second *models.Transaction) bool {
	return first != nil && second != nil && ((first.Type == models.TRANSACTION_DB_TYPE_INCOME && second.Type == models.TRANSACTION_DB_TYPE_EXPENSE) ||
		(first.Type == models.TRANSACTION_DB_TYPE_EXPENSE && second.Type == models.TRANSACTION_DB_TYPE_INCOME))
}

func uniquePositiveInt64(values []int64) []int64 {
	seen := make(map[int64]struct{})
	result := make([]int64, 0, len(values))
	for _, value := range values {
		if value > 0 {
			if _, exists := seen[value]; !exists {
				seen[value] = struct{}{}
				result = append(result, value)
			}
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}
