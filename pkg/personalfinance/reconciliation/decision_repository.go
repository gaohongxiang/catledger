package reconciliation

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"xorm.io/xorm"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/models"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
)

var (
	errDecisionCaseNotFound        = errors.New("reconciliation decision case not found")
	errDecisionCaseVersionConflict = errors.New("reconciliation decision case version conflict")
	errDecisionNotAvailable        = errors.New("reconciliation decision not available")
	errDecisionLedgerRejected      = errors.New("reconciliation decision ledger rejected")
)

type decisionRepository struct {
	store *datastore.DataStore
}

type preparedDecisionCase struct {
	caseRecord      *Case
	currentDecision *Decision
}

func newDecisionRepository(store *datastore.DataStore) (*decisionRepository, error) {
	if store == nil || store.Count() < 1 {
		return nil, fmt.Errorf("reconciliation decision repository requires a user data store")
	}
	return &decisionRepository{store: store}, nil
}

func (r *decisionRepository) database(uid int64) (*datastore.Database, error) {
	if r == nil || r.store == nil || uid < 1 {
		return nil, fmt.Errorf("reconciliation decision repository requires a positive uid")
	}
	return r.store.Choose(uid), nil
}

func (r *decisionRepository) prepareCase(c core.Context, uid int64, caseId int64) (*preparedDecisionCase, error) {
	database, _ := r.database(uid)
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	caseRecord := new(Case)
	found, err := sess.Where("uid=? AND case_id=?", uid, caseId).Get(caseRecord)
	if err != nil {
		return nil, fmt.Errorf("prepare reconciliation decision case: %w", err)
	}
	if !found {
		return nil, errDecisionCaseNotFound
	}
	prepared := &preparedDecisionCase{caseRecord: caseRecord}
	if caseRecord.CurrentDecisionId != nil {
		prepared.currentDecision = new(Decision)
		found, err = sess.Where("uid=? AND decision_id=? AND case_id=?", uid, *caseRecord.CurrentDecisionId, caseId).Get(prepared.currentDecision)
		if err != nil || !found {
			return nil, fmt.Errorf("reconciliation current decision invariant mismatch")
		}
	}
	return prepared, nil
}

// createOrFindDecision 先持久化 ready 命令，uid+摘要唯一约束负责并发裁决。
func (r *decisionRepository) createOrFindDecision(c core.Context, candidate *Decision) (*Decision, bool, error) {
	if err := validateNewDecision(candidate); err != nil {
		return nil, false, err
	}
	database, _ := r.database(candidate.Uid)
	for attempt := 0; attempt < maximumCandidatePersistenceAttempts; attempt++ {
		sess := database.NewPrivacySession(c)
		inserted, insertErr := sess.Insert(candidate)
		sess.Close()
		if insertErr == nil && inserted == 1 {
			copy := *candidate
			copy.PreviousDecisionId = cloneInt64(candidate.PreviousDecisionId)
			return &copy, true, nil
		}
		persisted, findErr := r.findDecisionByKey(c, candidate.Uid, candidate.IdempotencyKeyDigest)
		if findErr == nil && persisted != nil {
			return persisted, false, nil
		}
		cause := insertErr
		if cause == nil {
			cause = fmt.Errorf("unexpected inserted row count %d", inserted)
		}
		if findErr != nil {
			cause = findErr
		}
		if attempt+1 == maximumCandidatePersistenceAttempts || !isRetryableCandidatePersistenceError(database.DatabaseType(), cause) {
			return nil, false, fmt.Errorf("create reconciliation decision: %w", cause)
		}
		if err := waitCandidatePersistenceRetry(c, initialCandidatePersistenceRetryDelay<<attempt); err != nil {
			return nil, false, err
		}
	}
	return nil, false, fmt.Errorf("reconciliation decision retry limit reached")
}

func (r *decisionRepository) executeDecision(c core.Context, execution *decisionExecution, ledger DecisionLedger, generateId func() int64, now int64) (*Decision, error) {
	if execution == nil || execution.uid < 1 || execution.caseId < 1 || execution.expectedCaseVersion < 1 || execution.decisionId < 1 || ledger == nil || generateId == nil || now < 1 {
		return nil, ErrDecisionRequestInvalid
	}
	database, _ := r.database(execution.uid)
	for attempt := 0; attempt < maximumCandidatePersistenceAttempts; attempt++ {
		var completed *Decision
		err := database.DoPrivacyTransaction(c, func(sess *xorm.Session) error {
			var applyErr error
			completed, applyErr = r.executeDecisionTransaction(c, database, sess, execution, ledger, generateId, now)
			return applyErr
		})
		if err == nil {
			return completed, nil
		}
		if attempt+1 == maximumCandidatePersistenceAttempts || !isRetryableCandidatePersistenceError(database.DatabaseType(), err) {
			return nil, err
		}
		if waitErr := waitCandidatePersistenceRetry(c, initialCandidatePersistenceRetryDelay<<attempt); waitErr != nil {
			return nil, waitErr
		}
	}
	return nil, fmt.Errorf("reconciliation decision execution retry limit reached")
}

func (r *decisionRepository) executeDecisionTransaction(c core.Context, database *datastore.Database, sess *xorm.Session, execution *decisionExecution, ledger DecisionLedger, generateId func() int64, now int64) (*Decision, error) {
	started := now
	updated, err := sess.Where("uid=? AND decision_id=? AND case_id=? AND status=?", execution.uid, execution.decisionId, execution.caseId, DECISION_STATUS_READY).
		Cols("status", "started_unix_time", "updated_unix_time").
		Update(&Decision{Status: DECISION_STATUS_APPLYING, StartedUnixTime: &started, UpdatedUnixTime: now})
	if err != nil {
		return nil, fmt.Errorf("claim reconciliation decision: %w", err)
	}
	if updated != 1 {
		persisted, findErr := findDecisionById(sess, execution.uid, execution.decisionId)
		if findErr != nil {
			return nil, findErr
		}
		if persisted != nil && isTerminalDecisionStatus(persisted.Status) {
			return persisted, nil
		}
		return nil, errDecisionNotAvailable
	}

	caseRecord := new(Case)
	found, err := sess.Where("uid=? AND case_id=?", execution.uid, execution.caseId).Get(caseRecord)
	if err != nil {
		return nil, fmt.Errorf("load reconciliation decision case: %w", err)
	}
	if !found {
		return nil, errDecisionCaseNotFound
	}
	if caseRecord.Version != execution.expectedCaseVersion {
		return nil, errDecisionCaseVersionConflict
	}
	if err := validateDecisionCaseAvailability(sess, execution, caseRecord); err != nil {
		return nil, err
	}

	members, err := loadCaseMemberRows(sess, execution.uid, caseRecord, maximumDecisionMemberRows)
	if err != nil {
		return nil, err
	}
	reasonCodes := make([]string, 0)
	for _, member := range members {
		if member.limitReached {
			reasonCodes = append(reasonCodes, string(UNDO_REASON_EVIDENCE_LIMIT_REACHED))
			break
		}
	}

	decisionStatus := DECISION_STATUS_ACTION_REQUIRED
	caseStatus := CASE_STATUS_ACTION_REQUIRED
	keepCurrentDecision := false
	if len(reasonCodes) == 0 {
		switch execution.decisionType {
		case DECISION_TYPE_SAME_EVENT, DECISION_TYPE_INTERNAL_TRANSFER, DECISION_TYPE_REFUND_REVERSAL:
			matchingReasons, applyErr := applyMatchingDecision(c, database, sess, execution, ledger, generateId, now, members)
			if applyErr != nil {
				return nil, applyErr
			}
			if len(matchingReasons) > 0 {
				reasonCodes = append(reasonCodes, matchingReasons...)
			} else {
				decisionStatus = DECISION_STATUS_APPLIED
				caseStatus = CASE_STATUS_RESOLVED
			}
		case DECISION_TYPE_INDEPENDENT:
			if err := updateIndependentRows(sess, execution.uid, members, now); err != nil {
				return nil, err
			}
			decisionStatus = DECISION_STATUS_APPLIED
			caseStatus = CASE_STATUS_RESOLVED
		case DECISION_TYPE_DEFER:
			decisionStatus = DECISION_STATUS_DEFERRED
			caseStatus = CASE_STATUS_DEFERRED
		case DECISION_TYPE_REOPEN:
			outcome, reopenErr := applyReopenDecision(c, database, sess, execution, ledger, generateId, now, caseRecord, members)
			if reopenErr != nil {
				return nil, reopenErr
			}
			keepCurrentDecision = outcome.keepCurrentDecision
			if len(outcome.reasonCodes) == 0 {
				decisionStatus = DECISION_STATUS_APPLIED
				caseStatus = CASE_STATUS_OPEN
			} else {
				reasonCodes = append(reasonCodes, outcome.reasonCodes...)
			}
		default:
			return nil, fmt.Errorf("invalid reconciliation decision type")
		}
	}

	nextVersion := caseRecord.Version + 1
	currentDecisionId := execution.decisionId
	if keepCurrentDecision && execution.previousDecisionId != nil {
		currentDecisionId = *execution.previousDecisionId
	}
	caseUpdate := &Case{Status: caseStatus, Version: nextVersion, CurrentDecisionId: &currentDecisionId, UpdatedUnixTime: now}
	query := sess.Where("uid=? AND case_id=? AND version=?", execution.uid, execution.caseId, execution.expectedCaseVersion)
	if execution.previousDecisionId == nil {
		query = query.And("current_decision_id IS NULL")
	} else {
		query = query.And("current_decision_id=?", *execution.previousDecisionId)
	}
	updated, err = query.Cols("status", "version", "current_decision_id", "updated_unix_time").Update(caseUpdate)
	if err != nil {
		return nil, fmt.Errorf("apply reconciliation case CAS: %w", err)
	}
	if updated != 1 {
		return nil, errDecisionCaseVersionConflict
	}

	reasonJSON, err := encodeDecisionReasons(reasonCodes)
	if err != nil {
		return nil, err
	}
	completed := now
	errorCode := ""
	if decisionStatus == DECISION_STATUS_ACTION_REQUIRED && len(reasonCodes) > 0 {
		errorCode = reasonCodes[0]
	}
	decisionUpdate := &Decision{AppliedCaseVersion: nextVersion, Status: decisionStatus, ReasonCodesJson: reasonJSON, ErrorCode: errorCode, CompletedUnixTime: &completed, UpdatedUnixTime: now}
	updated, err = sess.Where("uid=? AND decision_id=? AND status=?", execution.uid, execution.decisionId, DECISION_STATUS_APPLYING).
		Cols("applied_case_version", "status", "reason_codes_json", "error_code", "completed_unix_time", "updated_unix_time").Update(decisionUpdate)
	if err != nil {
		return nil, fmt.Errorf("complete reconciliation decision: %w", err)
	}
	if updated != 1 {
		return nil, errDecisionNotAvailable
	}
	return findDecisionById(sess, execution.uid, execution.decisionId)
}

func (r *decisionRepository) markDecisionFailed(c core.Context, uid int64, decisionId int64, errorCode string, now int64) error {
	if uid < 1 || decisionId < 1 || validateSafeReasonCode(errorCode) != nil || now < 1 {
		return ErrDecisionRequestInvalid
	}
	database, _ := r.database(uid)
	for attempt := 0; attempt < maximumCandidatePersistenceAttempts; attempt++ {
		retry, err := r.markDecisionFailedAttempt(c, database, uid, decisionId, errorCode, now)
		if err == nil {
			return nil
		}
		if !retry || attempt+1 == maximumCandidatePersistenceAttempts {
			return err
		}
		if waitErr := waitCandidatePersistenceRetry(c, initialCandidatePersistenceRetryDelay<<attempt); waitErr != nil {
			return waitErr
		}
	}
	return fmt.Errorf("reconciliation decision failure transition retry limit reached")
}

func (r *decisionRepository) markDecisionFailedAttempt(c core.Context, database *datastore.Database, uid int64, decisionId int64, errorCode string, now int64) (bool, error) {
	failed := now
	sess := database.NewPrivacySession(c)
	updated, err := sess.Where("uid=? AND decision_id=? AND status=?", uid, decisionId, DECISION_STATUS_READY).
		Cols("status", "error_code", "failed_unix_time", "updated_unix_time").
		Update(&Decision{Status: DECISION_STATUS_FAILED, ErrorCode: errorCode, FailedUnixTime: &failed, UpdatedUnixTime: now})
	sess.Close()
	if err != nil {
		wrapped := fmt.Errorf("mark reconciliation decision failed: %w", err)
		return isRetryableCandidatePersistenceError(database.DatabaseType(), wrapped), wrapped
	}
	if updated == 1 {
		return false, nil
	}

	persisted, findErr := r.findDecisionById(c, uid, decisionId)
	if findErr != nil {
		wrapped := fmt.Errorf("read reconciliation decision failure transition: %w", findErr)
		return isRetryableCandidatePersistenceError(database.DatabaseType(), wrapped), wrapped
	}
	if persisted != nil && isTerminalDecisionStatus(persisted.Status) {
		return false, nil
	}
	if persisted != nil && (persisted.Status == DECISION_STATUS_READY || persisted.Status == DECISION_STATUS_APPLYING) {
		return true, errDecisionNotAvailable
	}
	return false, errDecisionNotAvailable
}

func (r *decisionRepository) getUndoImpact(c core.Context, uid int64, caseId int64) (*UndoImpact, error) {
	database, _ := r.database(uid)
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	caseRecord := new(Case)
	found, err := sess.Where("uid=? AND case_id=?", uid, caseId).Get(caseRecord)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, errDecisionCaseNotFound
	}
	return getUndoImpactInSession(sess, uid, caseRecord)
}

func getUndoImpactInSession(sess *xorm.Session, uid int64, caseRecord *Case) (*UndoImpact, error) {
	inspection, err := inspectUndoInSession(sess, uid, caseRecord)
	if err != nil {
		return nil, err
	}
	return inspection.impact, nil
}

func validateDecisionCaseAvailability(sess *xorm.Session, execution *decisionExecution, caseRecord *Case) error {
	if execution.undo {
		if caseRecord.CurrentDecisionId == nil || execution.previousDecisionId == nil || *caseRecord.CurrentDecisionId != *execution.previousDecisionId ||
			(caseRecord.Status != CASE_STATUS_RESOLVED && caseRecord.Status != CASE_STATUS_DEFERRED && caseRecord.Status != CASE_STATUS_ACTION_REQUIRED) {
			return errDecisionNotAvailable
		}
		current := new(Decision)
		found, err := sess.Where("uid=? AND decision_id=? AND case_id=?", execution.uid, *caseRecord.CurrentDecisionId, execution.caseId).Get(current)
		if err != nil {
			return err
		}
		if !found || current.DecisionType == DECISION_TYPE_REOPEN {
			return errDecisionNotAvailable
		}
		return nil
	}
	if caseRecord.Status != CASE_STATUS_OPEN {
		return errDecisionNotAvailable
	}
	if caseRecord.CurrentDecisionId == nil {
		return nil
	}
	if execution.previousDecisionId == nil || *caseRecord.CurrentDecisionId != *execution.previousDecisionId {
		return errDecisionNotAvailable
	}
	current := new(Decision)
	found, err := sess.Where("uid=? AND decision_id=? AND case_id=?", execution.uid, *caseRecord.CurrentDecisionId, execution.caseId).Get(current)
	if err != nil {
		return err
	}
	if !found || current.DecisionType != DECISION_TYPE_REOPEN || current.Status != DECISION_STATUS_APPLIED {
		return errDecisionNotAvailable
	}
	return nil
}

func updateIndependentRows(sess *xorm.Session, uid int64, members []*caseMemberRows, now int64) error {
	rowIds := targetMemberRowIds(members, importing.PROCESSING_STATE_PENDING)
	if len(rowIds) == 0 {
		return nil
	}
	updated, err := sess.Where("uid=? AND processing_state=?", uid, importing.PROCESSING_STATE_PENDING).In("row_id", rowIds).
		Cols("processing_state", "disposition").Update(&importing.RawImportRow{ProcessingState: importing.PROCESSING_STATE_IGNORED, Disposition: importing.IMPORT_DISPOSITION_NON_POSTABLE})
	if err != nil {
		return err
	}
	if updated != int64(len(rowIds)) {
		return errDecisionCaseVersionConflict
	}
	return recomputeDecisionBatches(sess, uid, members, now)
}

func restoreIndependentRows(sess *xorm.Session, uid int64, members []*caseMemberRows, now int64) error {
	for _, member := range members {
		for _, row := range member.rows {
			if row.ProcessingState != importing.PROCESSING_STATE_IGNORED || row.ParseState != importing.PARSE_STATE_VALID ||
				(row.SemanticEligibility != importing.SEMANTIC_ELIGIBILITY_POSTABLE && row.SemanticEligibility != importing.SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED) {
				continue
			}
			disposition := pendingDisposition(row)
			updated, err := sess.Where("uid=? AND row_id=? AND processing_state=?", uid, row.RowId, importing.PROCESSING_STATE_IGNORED).
				Cols("processing_state", "disposition").Update(&importing.RawImportRow{ProcessingState: importing.PROCESSING_STATE_PENDING, Disposition: disposition})
			if err != nil {
				return err
			}
			if updated != 1 {
				return errDecisionCaseVersionConflict
			}
		}
	}
	return recomputeDecisionBatches(sess, uid, members, now)
}

func targetMemberRowIds(members []*caseMemberRows, state importing.ProcessingState) []int64 {
	seen := make(map[int64]struct{})
	result := make([]int64, 0)
	for _, member := range members {
		for _, row := range member.rows {
			if row.ProcessingState == state && row.ParseState == importing.PARSE_STATE_VALID &&
				(row.SemanticEligibility == importing.SEMANTIC_ELIGIBILITY_POSTABLE || row.SemanticEligibility == importing.SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED) {
				if _, exists := seen[row.RowId]; !exists {
					seen[row.RowId] = struct{}{}
					result = append(result, row.RowId)
				}
			}
		}
	}
	return result
}

func recomputeDecisionBatches(sess *xorm.Session, uid int64, members []*caseMemberRows, now int64) error {
	batchSet := make(map[int64]struct{})
	for _, member := range members {
		for _, row := range member.rows {
			batchSet[row.BatchId] = struct{}{}
		}
	}
	for batchId := range batchSet {
		pending, err := sess.Where("uid=? AND batch_id=? AND processing_state=?", uid, batchId, importing.PROCESSING_STATE_PENDING).Count(new(importing.RawImportRow))
		if err != nil {
			return err
		}
		linked, err := sess.Where("uid=? AND batch_id=? AND processing_state=?", uid, batchId, importing.PROCESSING_STATE_LINKED).Count(new(importing.RawImportRow))
		if err != nil {
			return err
		}
		status := importing.IMPORT_BATCH_STATUS_READY
		if pending == 0 {
			status = importing.IMPORT_BATCH_STATUS_COMPLETED
		} else if linked > 0 {
			status = importing.IMPORT_BATCH_STATUS_PARTIALLY_POSTED
		}
		updated, err := sess.Where("uid=? AND batch_id=?", uid, batchId).
			In("status", []string{string(importing.IMPORT_BATCH_STATUS_READY), string(importing.IMPORT_BATCH_STATUS_PARTIALLY_POSTED), string(importing.IMPORT_BATCH_STATUS_COMPLETED)}).
			Cols("status", "pending_row_count", "posted_row_count", "updated_unix_time").
			Update(&importing.ImportBatch{Status: status, PendingRowCount: pending, PostedRowCount: linked, UpdatedUnixTime: now})
		if err != nil {
			return err
		}
		if updated != 1 {
			return errDecisionNotAvailable
		}
	}
	return nil
}

func encodeDecisionReasons(reasons []string) (string, error) {
	sort.Strings(reasons)
	for _, reason := range reasons {
		if err := validateSafeReasonCode(reason); err != nil {
			return "", err
		}
	}
	encoded, err := jsonMarshalStrings(reasons)
	if err != nil {
		return "", err
	}
	return encoded, nil
}

func jsonMarshalStrings(values []string) (string, error) {
	// 独立小函数让持久化入口不接受调用方提供的 JSON。
	data, err := json.Marshal(values)
	return string(data), err
}

func validateNewDecision(value *Decision) error {
	if value == nil || value.Uid < 1 || value.CaseId < 1 || value.ExpectedCaseVersion < 1 || value.AppliedCaseVersion != 0 || value.DecisionId < 1 ||
		!isDecisionType(value.DecisionType, true) || len(value.IdempotencyKeyDigest) != 64 || len(value.RequestDigest) != 64 ||
		value.IdempotencyKeyVersion != IDEMPOTENCY_KEY_VERSION_V1 || value.RequestDigestVersion != DECISION_REQUEST_VERSION_V1 || value.Status != DECISION_STATUS_READY ||
		len(value.FieldSelectionJson) > 1024 || value.ReasonCodesJson != "[]" || value.ErrorCode != "" || value.CreatedUnixTime < 1 || value.UpdatedUnixTime != value.CreatedUnixTime ||
		value.StartedUnixTime != nil || value.CompletedUnixTime != nil || value.FailedUnixTime != nil {
		return ErrDecisionRequestInvalid
	}
	return nil
}

func (r *decisionRepository) findDecisionByKey(c core.Context, uid int64, digest string) (*Decision, error) {
	database, _ := r.database(uid)
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	value := new(Decision)
	found, err := sess.Where("uid=? AND idempotency_key_digest=?", uid, digest).Get(value)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	return value, nil
}

func (r *decisionRepository) findDecisionById(c core.Context, uid int64, decisionId int64) (*Decision, error) {
	database, _ := r.database(uid)
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findDecisionById(sess, uid, decisionId)
}

func findDecisionById(sess *xorm.Session, uid int64, decisionId int64) (*Decision, error) {
	value := new(Decision)
	found, err := sess.Where("uid=? AND decision_id=?", uid, decisionId).Get(value)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	return value, nil
}

func loadDecisionTransactions(sess *xorm.Session, uid int64, ids []int64) (map[int64]*models.Transaction, error) {
	result := make(map[int64]*models.Transaction)
	if len(ids) == 0 {
		return result, nil
	}
	values := make([]*models.Transaction, 0, len(ids))
	if err := sess.Where("uid=?", uid).In("transaction_id", ids).Find(&values); err != nil {
		return nil, err
	}
	for _, value := range values {
		result[value.TransactionId] = value
	}
	return result, nil
}

func decisionMapKeys(values map[int64]TransactionCreationMethod) []int64 {
	result := make([]int64, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	return result
}

func sortedUndoImpactReasons(values map[UndoImpactReason]struct{}) []UndoImpactReason {
	result := make([]UndoImpactReason, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}
