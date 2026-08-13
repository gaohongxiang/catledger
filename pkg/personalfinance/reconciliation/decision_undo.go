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

type undoInspection struct {
	impact       *UndoImpact
	decision     *Decision
	links        []*TransactionLink
	methods      map[int64]TransactionCreationMethod
	snapshots    map[int64]int64
	transactions map[int64]*models.Transaction
}

type reopenOutcome struct {
	reasonCodes         []string
	keepCurrentDecision bool
}

func inspectUndoInSession(sess *xorm.Session, uid int64, caseRecord *Case) (*undoInspection, error) {
	if sess == nil || uid < 1 || caseRecord == nil || caseRecord.Uid != uid || caseRecord.CaseId < 1 {
		return nil, ErrDecisionRequestInvalid
	}
	inspection := &undoInspection{
		impact:       &UndoImpact{CaseId: caseRecord.CaseId},
		methods:      make(map[int64]TransactionCreationMethod),
		snapshots:    make(map[int64]int64),
		transactions: make(map[int64]*models.Transaction),
	}
	if caseRecord.CurrentDecisionId == nil {
		inspection.impact.ReasonCodes = []UndoImpactReason{UNDO_REASON_NO_CURRENT_DECISION}
		return inspection, nil
	}

	inspection.impact.DecisionId = *caseRecord.CurrentDecisionId
	decision := new(Decision)
	found, err := sess.Where("uid=? AND decision_id=? AND case_id=?", uid, inspection.impact.DecisionId, caseRecord.CaseId).Get(decision)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("reconciliation current decision invariant mismatch")
	}
	inspection.decision = decision
	if decision.DecisionType == DECISION_TYPE_REOPEN {
		inspection.impact.ReasonCodes = []UndoImpactReason{UNDO_REASON_NO_CURRENT_DECISION}
		return inspection, nil
	}

	links := make([]*TransactionLink, 0)
	if err := sess.Where("uid=? AND decision_id=?", uid, decision.DecisionId).Asc("link_id").Limit(maximumDecisionEvidenceLinks + 1).Find(&links); err != nil {
		return nil, err
	}
	if len(links) > maximumDecisionEvidenceLinks {
		inspection.impact.ReasonCodes = []UndoImpactReason{UNDO_REASON_EVIDENCE_LIMIT_REACHED}
		return inspection, nil
	}
	inspection.links = links
	for _, link := range links {
		if link == nil || link.Uid != uid || link.DecisionId != decision.DecisionId || link.RowId < 1 || link.TransactionId < 1 || link.TransactionUpdatedUnixTime < 1 {
			return nil, fmt.Errorf("reconciliation undo link invariant mismatch")
		}
		if link.CreationMethod != TRANSACTION_CREATION_METHOD_ATTACHED_EXISTING && link.CreationMethod != TRANSACTION_CREATION_METHOD_RECONCILIATION_CREATED {
			return nil, fmt.Errorf("invalid reconciliation creation method")
		}
		if previous, exists := inspection.methods[link.TransactionId]; exists && previous != link.CreationMethod {
			return nil, fmt.Errorf("reconciliation creation method invariant mismatch")
		}
		if previous, exists := inspection.snapshots[link.TransactionId]; exists && previous != link.TransactionUpdatedUnixTime {
			return nil, fmt.Errorf("reconciliation transaction snapshot invariant mismatch")
		}
		inspection.methods[link.TransactionId] = link.CreationMethod
		inspection.snapshots[link.TransactionId] = link.TransactionUpdatedUnixTime
	}

	inspection.impact.TransactionCount = int64(len(inspection.methods))
	for _, method := range inspection.methods {
		if method == TRANSACTION_CREATION_METHOD_ATTACHED_EXISTING {
			inspection.impact.AttachedExistingCount++
		} else {
			inspection.impact.ReconciliationCreatedCount++
		}
	}
	transactions, err := loadDecisionTransactions(sess, uid, decisionMapKeys(inspection.methods))
	if err != nil {
		return nil, err
	}
	inspection.transactions = transactions

	createdEffects := make(map[int64]*LedgerEffect)
	effects := make([]*LedgerEffect, 0)
	if err := sess.Where("uid=? AND decision_id=? AND effect_type=?", uid, decision.DecisionId, LEDGER_EFFECT_TYPE_CREATED).
		Asc("effect_id").Limit(maximumDecisionEvidenceLinks + 1).Find(&effects); err != nil {
		return nil, err
	}
	if len(effects) > maximumDecisionEvidenceLinks {
		inspection.impact.ReasonCodes = []UndoImpactReason{UNDO_REASON_EVIDENCE_LIMIT_REACHED}
		return inspection, nil
	}
	for _, effect := range effects {
		if effect == nil || effect.Uid != uid || effect.DecisionId != decision.DecisionId || effect.TransactionId < 1 || effect.TransactionUpdatedUnixTime < 1 {
			return nil, fmt.Errorf("reconciliation undo effect invariant mismatch")
		}
		if _, exists := createdEffects[effect.TransactionId]; exists {
			return nil, fmt.Errorf("reconciliation undo effect duplicated")
		}
		createdEffects[effect.TransactionId] = effect
	}

	reasons := make(map[UndoImpactReason]struct{})
	incompleteTransferEvents := make(map[string]struct{})
	for transactionId, method := range inspection.methods {
		if method != TRANSACTION_CREATION_METHOD_RECONCILIATION_CREATED {
			continue
		}
		transaction := transactions[transactionId]
		if transaction == nil || transaction.Deleted {
			inspection.impact.MissingTransactionCount++
			reasons[UNDO_REASON_TRANSACTION_MISSING] = struct{}{}
			continue
		}
		effect := createdEffects[transactionId]
		if transaction.UpdatedUnixTime != inspection.snapshots[transactionId] || effect == nil || effect.TransactionUpdatedUnixTime != inspection.snapshots[transactionId] {
			inspection.impact.ModifiedTransactionCount++
			reasons[UNDO_REASON_TRANSACTION_MODIFIED] = struct{}{}
		}
		legacyCount, countErr := sess.Where("uid=? AND transaction_id=?", uid, transactionId).Count(new(importing.RawRowTransactionLink))
		if countErr != nil {
			return nil, countErr
		}
		if legacyCount > 0 {
			inspection.impact.BatchRelationCount++
			reasons[UNDO_REASON_BATCH_RELATION_PRESENT] = struct{}{}
		}
		sharedCount, countErr := sess.Table(new(TransactionLink)).Alias("l").
			Join("INNER", "pf_reconciliation_case", "pf_reconciliation_case.uid=l.uid AND pf_reconciliation_case.current_decision_id=l.decision_id").
			Where("l.uid=? AND pf_reconciliation_case.uid=? AND l.transaction_id=? AND l.decision_id<>?", uid, uid, transactionId, decision.DecisionId).Count(new(TransactionLink))
		if countErr != nil {
			return nil, countErr
		}
		if sharedCount > 0 {
			inspection.impact.SharedTransactionCount++
			reasons[UNDO_REASON_TRANSACTION_SHARED] = struct{}{}
		}
		if isTransferTransaction(transaction) {
			counterpart := transactions[transaction.RelatedId]
			pairKey := transferPairKey(transaction.TransactionId, transaction.RelatedId)
			if inspection.methods[transaction.RelatedId] != TRANSACTION_CREATION_METHOD_RECONCILIATION_CREATED || counterpart == nil || counterpart.Deleted ||
				inspection.snapshots[transaction.RelatedId] != counterpart.UpdatedUnixTime || createdEffects[transaction.RelatedId] == nil ||
				!completeDecisionTransferPair(transaction, counterpart) {
				if _, exists := incompleteTransferEvents[pairKey]; !exists {
					incompleteTransferEvents[pairKey] = struct{}{}
					inspection.impact.IncompleteTransferPairCount++
				}
				reasons[UNDO_REASON_TRANSFER_PAIR_INCOMPLETE] = struct{}{}
			}
		}
	}
	inspection.impact.ReasonCodes = sortedUndoImpactReasons(reasons)
	inspection.impact.CanAutomaticallyDelete = inspection.impact.ReconciliationCreatedCount > 0 && len(inspection.impact.ReasonCodes) == 0
	inspection.impact.CanReopen = inspection.impact.ReconciliationCreatedCount == 0 || inspection.impact.CanAutomaticallyDelete
	return inspection, nil
}

func applyReopenDecision(c core.Context, database *datastore.Database, sess *xorm.Session, execution *decisionExecution, ledger DecisionLedger, generateId func() int64, now int64, caseRecord *Case, members []*caseMemberRows) (*reopenOutcome, error) {
	if execution == nil || execution.previousDecisionId == nil {
		return nil, errDecisionNotAvailable
	}
	inspection, err := inspectUndoInSession(sess, execution.uid, caseRecord)
	if err != nil {
		return nil, err
	}
	if inspection.decision == nil || inspection.decision.DecisionId != *execution.previousDecisionId {
		return nil, errDecisionNotAvailable
	}
	if !inspection.impact.CanReopen {
		return &reopenOutcome{reasonCodes: undoReasonsAsStrings(inspection.impact.ReasonCodes), keepCurrentDecision: true}, nil
	}

	createdIds := make([]int64, 0)
	for transactionId, method := range inspection.methods {
		if method == TRANSACTION_CREATION_METHOD_RECONCILIATION_CREATED {
			createdIds = append(createdIds, transactionId)
		}
	}
	sort.Slice(createdIds, func(i, j int) bool { return createdIds[i] < createdIds[j] })
	deleted := make(map[int64]struct{})
	for _, transactionId := range createdIds {
		if _, exists := deleted[transactionId]; exists {
			continue
		}
		transaction := inspection.transactions[transactionId]
		if transaction == nil {
			return nil, errDecisionLedgerRejected
		}
		relatedId := int64(0)
		relatedSnapshot := int64(0)
		if transaction.Type == models.TRANSACTION_DB_TYPE_TRANSFER_IN {
			continue
		}
		if transaction.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT {
			relatedId = transaction.RelatedId
			relatedSnapshot = inspection.snapshots[relatedId]
		}
		primary, related, deleteErr := ledger.DeleteTransactionInSession(c, database, sess, execution.uid, transactionId, inspection.snapshots[transactionId], relatedId, relatedSnapshot, now)
		if deleteErr != nil || primary == nil || primary.TransactionId != transactionId || (relatedId == 0 && related != nil) || (relatedId > 0 && (related == nil || related.TransactionId != relatedId)) {
			return nil, errDecisionLedgerRejected
		}
		if err := insertSoftDeletedEffect(sess, execution, primary, generateId, now); err != nil {
			return nil, err
		}
		deleted[transactionId] = struct{}{}
		if related != nil {
			if err := insertSoftDeletedEffect(sess, execution, related, generateId, now); err != nil {
				return nil, err
			}
			deleted[related.TransactionId] = struct{}{}
		}
	}

	if inspection.decision.DecisionType == DECISION_TYPE_INDEPENDENT {
		if err := restoreIndependentRows(sess, execution.uid, members, now); err != nil {
			return nil, err
		}
	} else {
		if err := restoreLinkedDecisionRows(sess, execution.uid, inspection.decision.DecisionId, inspection.links, members, now); err != nil {
			return nil, err
		}
	}
	return &reopenOutcome{}, nil
}

func restoreLinkedDecisionRows(sess *xorm.Session, uid int64, previousDecisionId int64, links []*TransactionLink, members []*caseMemberRows, now int64) error {
	rowIds := make(map[int64]struct{})
	for _, link := range links {
		rowIds[link.RowId] = struct{}{}
	}
	for rowId := range rowIds {
		legacyCount, err := sess.Where("uid=? AND row_id=?", uid, rowId).Count(new(importing.RawRowTransactionLink))
		if err != nil {
			return err
		}
		activeOtherCount, err := sess.Table(new(TransactionLink)).Alias("l").
			Join("INNER", "pf_reconciliation_case", "pf_reconciliation_case.uid=l.uid AND pf_reconciliation_case.current_decision_id=l.decision_id").
			Where("l.uid=? AND pf_reconciliation_case.uid=? AND l.row_id=? AND l.decision_id<>?", uid, uid, rowId, previousDecisionId).Count(new(TransactionLink))
		if err != nil {
			return err
		}
		if legacyCount > 0 || activeOtherCount > 0 {
			continue
		}
		row := new(importing.RawImportRow)
		found, err := sess.Where("uid=? AND row_id=?", uid, rowId).Get(row)
		if err != nil {
			return err
		}
		if !found {
			return fmt.Errorf("reconciliation undo row invariant mismatch")
		}
		if row.ProcessingState != importing.PROCESSING_STATE_LINKED {
			continue
		}
		disposition := pendingDisposition(row)
		updated, err := sess.Where("uid=? AND row_id=? AND processing_state=?", uid, rowId, importing.PROCESSING_STATE_LINKED).
			Cols("processing_state", "disposition").Update(&importing.RawImportRow{ProcessingState: importing.PROCESSING_STATE_PENDING, Disposition: disposition})
		if err != nil {
			return err
		}
		if updated != 1 {
			return errDecisionCaseVersionConflict
		}
	}
	return recomputeDecisionBatches(sess, uid, members, now)
}

func insertSoftDeletedEffect(sess *xorm.Session, execution *decisionExecution, transaction *models.Transaction, generateId func() int64, now int64) error {
	effectId := generateId()
	if transaction == nil || effectId < 1 {
		return fmt.Errorf("reconciliation soft deletion effect invariant mismatch")
	}
	deleted := now
	effect := &LedgerEffect{Uid: execution.uid, DecisionId: execution.decisionId, TransactionId: transaction.TransactionId,
		EffectType: LEDGER_EFFECT_TYPE_SOFT_DELETED, TransactionUpdatedUnixTime: transaction.UpdatedUnixTime,
		TransactionDeletedUnixTime: &deleted, CreatedUnixTime: now, EffectId: effectId}
	inserted, err := sess.Insert(effect)
	if err != nil {
		return fmt.Errorf("insert reconciliation soft deletion effect: %w", err)
	}
	if inserted != 1 {
		return fmt.Errorf("reconciliation soft deletion effect was not inserted")
	}
	return nil
}

func pendingDisposition(row *importing.RawImportRow) importing.ImportDisposition {
	if row != nil && row.SemanticEligibility == importing.SEMANTIC_ELIGIBILITY_POSTABLE && row.IdentityState == importing.IDENTITY_STATE_NEW {
		return importing.IMPORT_DISPOSITION_POSTABLE
	}
	return importing.IMPORT_DISPOSITION_REVIEW_REQUIRED
}

func transferPairKey(first int64, second int64) string {
	if first > second {
		first, second = second, first
	}
	return fmt.Sprintf("%d:%d", first, second)
}

func undoReasonsAsStrings(reasons []UndoImpactReason) []string {
	result := make([]string, len(reasons))
	for index, reason := range reasons {
		result[index] = string(reason)
	}
	return result
}
