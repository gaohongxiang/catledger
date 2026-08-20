package reconciliation

import (
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans"
)

type decisionSQLiteEnvironment struct {
	database *datastore.Database
	service  *DecisionService
	cases    *CaseService
	ledger   *decisionSQLiteLedger
}

type decisionCaseFixture struct {
	uid      int64
	caseId   int64
	rowIds   [2]int64
	batchIds [2]int64
}

type allowDecisionAuthorization struct{}

func (allowDecisionAuthorization) AuthorizeTransactionCreation(core.Context, int64, *time.Location, []*models.Transaction) error {
	return nil
}

type decisionSQLiteLedger struct {
	next       atomic.Int64
	failCreate atomic.Bool
}

func (l *decisionSQLiteLedger) CreateTransactionInSession(_ core.Context, _ *datastore.Database, sess *xorm.Session, draft *models.Transaction, _ []int64) (*models.Transaction, *models.Transaction, error) {
	transaction := *draft
	transaction.TransactionId = l.next.Add(1)
	transaction.CreatedUnixTime = 1_900_000_000
	transaction.UpdatedUnixTime = transaction.CreatedUnixTime
	var counterpart *models.Transaction
	if transaction.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT {
		transaction.RelatedId = l.next.Add(1)
		counterpart = &models.Transaction{
			TransactionId: transaction.RelatedId, Uid: transaction.Uid, Type: models.TRANSACTION_DB_TYPE_TRANSFER_IN,
			CategoryId: transaction.CategoryId, AccountId: transaction.RelatedAccountId, TransactionTime: transaction.TransactionTime + 1,
			TimezoneUtcOffset: transaction.TimezoneUtcOffset, Amount: transaction.RelatedAccountAmount,
			RelatedId: transaction.TransactionId, RelatedAccountId: transaction.AccountId, RelatedAccountAmount: transaction.Amount,
			CreatedUnixTime: transaction.CreatedUnixTime, UpdatedUnixTime: transaction.UpdatedUnixTime,
		}
	}
	beans := []any{&transaction}
	if counterpart != nil {
		beans = append(beans, counterpart)
	}
	for _, bean := range beans {
		if inserted, err := sess.Insert(bean); err != nil || inserted != 1 {
			return nil, nil, errors.New("insert decision test ledger event")
		}
	}
	if l.failCreate.Load() {
		return nil, nil, errors.New("synthetic decision ledger failure")
	}
	return &transaction, counterpart, nil
}

func (l *decisionSQLiteLedger) DeleteTransactionInSession(_ core.Context, _ *datastore.Database, sess *xorm.Session, uid int64, transactionId int64, expectedUpdatedUnixTime int64, relatedTransactionId int64, expectedRelatedUpdatedUnixTime int64, deletedUnixTime int64) (*models.Transaction, *models.Transaction, error) {
	primary := new(models.Transaction)
	found, err := sess.Where("uid=? AND transaction_id=? AND deleted=? AND updated_unix_time=?", uid, transactionId, false, expectedUpdatedUnixTime).Get(primary)
	if err != nil || !found {
		return nil, nil, errors.New("decision test deletion snapshot mismatch")
	}
	var related *models.Transaction
	if relatedTransactionId > 0 {
		related = new(models.Transaction)
		found, err = sess.Where("uid=? AND transaction_id=? AND deleted=? AND updated_unix_time=?", uid, relatedTransactionId, false, expectedRelatedUpdatedUnixTime).Get(related)
		if err != nil || !found || !completeDecisionTransferPair(primary, related) {
			return nil, nil, errors.New("decision test reciprocal deletion mismatch")
		}
	} else if primary.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT || primary.Type == models.TRANSACTION_DB_TYPE_TRANSFER_IN {
		return nil, nil, errors.New("decision test deletion omitted reciprocal")
	}
	update := &models.Transaction{Deleted: true, DeletedUnixTime: deletedUnixTime}
	ids := []int64{transactionId}
	if related != nil {
		ids = append(ids, related.TransactionId)
	}
	updated, err := sess.Where("uid=? AND deleted=?", uid, false).In("transaction_id", ids).Cols("deleted", "deleted_unix_time").Update(update)
	if err != nil || updated != int64(len(ids)) {
		return nil, nil, errors.New("decision test conditional deletion failed")
	}
	return primary, related, nil
}

func TestCaseAndDecisionServiceSQLiteIdempotencyCASIsolationAndRowOnlyDecisions(t *testing.T) {
	environment := newDecisionSQLiteEnvironment(t)
	first := insertDecisionCaseFixture(t, environment.database, 1101, 10_000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.ECONOMIC_EFFECT_NORMAL)
	second := insertDecisionCaseFixture(t, environment.database, 1101, 20_000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.ECONOMIC_EFFECT_NORMAL)
	third := insertDecisionCaseFixture(t, environment.database, 1101, 30_000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.ECONOMIC_EFFECT_NORMAL)

	page, err := environment.cases.ListCases(nil, ListCasesRequest{Uid: first.uid, Status: CASE_STATUS_OPEN, Limit: 2})
	if err != nil || len(page.Items) != 2 || page.NextCursor == nil || page.Items[0].CaseId != third.caseId || page.Items[1].CaseId != second.caseId {
		t.Fatalf("stable case pagination mismatch: %+v %v", page, err)
	}
	detail, err := environment.cases.GetCase(nil, first.uid, first.caseId)
	if err != nil || len(detail.Members) != 2 || detail.Members[0].MaskedSourceAccount != "synthetic account" || len(detail.Members[0].Evidence) != 1 {
		t.Fatalf("masked case detail mismatch: %+v %v", detail, err)
	}
	if _, err = environment.cases.GetCase(nil, first.uid+1, first.caseId); !errors.Is(err, ErrCaseNotFound) {
		t.Fatalf("cross-user case was visible: %v", err)
	}

	request := DecideCaseRequest{Uid: first.uid, CaseId: first.caseId, ExpectedCaseVersion: 1, DecisionType: DECISION_TYPE_INDEPENDENT, IdempotencyKey: "independent-case-1", CreatedIp: "192.0.2.10"}
	result, err := environment.service.DecideCase(nil, request, time.UTC)
	if err != nil || result.Status != DECISION_STATUS_APPLIED || result.AppliedCaseVersion != 2 {
		t.Fatalf("apply independent decision: %+v %v", result, err)
	}
	replayed, err := environment.service.DecideCase(nil, request, time.UTC)
	if err != nil || !replayed.Replayed || replayed.DecisionId != result.DecisionId {
		t.Fatalf("replay independent decision: %+v %v", replayed, err)
	}
	conflicting := request
	conflicting.DecisionType = DECISION_TYPE_DEFER
	if _, err = environment.service.DecideCase(nil, conflicting, time.UTC); !errors.Is(err, ErrDecisionIdempotencyConflict) {
		t.Fatalf("same idempotency key with another digest was accepted: %v", err)
	}
	assertDecisionRows(t, environment.database, first, importing.PROCESSING_STATE_IGNORED)

	deferred, err := environment.service.DecideCase(nil, DecideCaseRequest{Uid: second.uid, CaseId: second.caseId, ExpectedCaseVersion: 1, DecisionType: DECISION_TYPE_DEFER, IdempotencyKey: "defer-case-2", CreatedIp: "192.0.2.10"}, time.UTC)
	if err != nil || deferred.Status != DECISION_STATUS_DEFERRED {
		t.Fatalf("defer decision failed: %+v %v", deferred, err)
	}
	assertDecisionRows(t, environment.database, second, importing.PROCESSING_STATE_PENDING)
	if _, err = environment.service.DecideCase(nil, DecideCaseRequest{Uid: second.uid, CaseId: second.caseId, ExpectedCaseVersion: 1, DecisionType: DECISION_TYPE_DEFER, IdempotencyKey: "stale-case-2", CreatedIp: "192.0.2.10"}, time.UTC); !errors.Is(err, ErrDecisionCaseVersionConflict) {
		t.Fatalf("stale case version was not rejected: %v", err)
	}
	if _, err = environment.service.DecideCase(nil, DecideCaseRequest{Uid: first.uid + 1, CaseId: first.caseId, ExpectedCaseVersion: 1, DecisionType: DECISION_TYPE_DEFER, IdempotencyKey: "foreign-case-1", CreatedIp: "192.0.2.10"}, time.UTC); !errors.Is(err, ErrDecisionCaseNotFound) {
		t.Fatalf("cross-user decision did not look absent: %v", err)
	}

	requests := []DecideCaseRequest{
		{Uid: third.uid, CaseId: third.caseId, ExpectedCaseVersion: 1, DecisionType: DECISION_TYPE_INDEPENDENT, IdempotencyKey: "cas-case-3-a", CreatedIp: "192.0.2.10"},
		{Uid: third.uid, CaseId: third.caseId, ExpectedCaseVersion: 1, DecisionType: DECISION_TYPE_DEFER, IdempotencyKey: "cas-case-3-b", CreatedIp: "192.0.2.10"},
	}
	start := make(chan struct{})
	errorsByRequest := make([]error, len(requests))
	var waitGroup sync.WaitGroup
	for index := range requests {
		waitGroup.Add(1)
		go func(index int) {
			defer waitGroup.Done()
			<-start
			_, errorsByRequest[index] = environment.service.DecideCase(nil, requests[index], time.UTC)
		}(index)
	}
	close(start)
	waitGroup.Wait()
	succeeded := 0
	conflicted := 0
	for _, requestErr := range errorsByRequest {
		if requestErr == nil {
			succeeded++
		} else if errors.Is(requestErr, ErrDecisionCaseVersionConflict) {
			conflicted++
		}
	}
	if succeeded != 1 || conflicted != 1 {
		t.Fatalf("case CAS did not select exactly one decision: %+v", errorsByRequest)
	}
}

func TestDecisionServiceSQLiteZeroOneMultipleTransferRefundAndRollback(t *testing.T) {
	environment := newDecisionSQLiteEnvironment(t)
	uid := int64(2202)
	insertDecisionLedgerAccounts(t, environment.database, uid, "CNY")

	zero := insertDecisionCaseFixture(t, environment.database, uid, 40_000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.ECONOMIC_EFFECT_NORMAL)
	zeroResult, err := environment.service.DecideCase(nil, sameEventRequest(zero, "same-zero", expenseDraft(zero, 500)), time.UTC)
	if err != nil || zeroResult.Status != DECISION_STATUS_APPLIED || countDecisionRows(t, environment.database, new(models.Transaction), "uid=?", uid) != 1 || countDecisionRows(t, environment.database, new(LedgerEffect), "uid=? AND decision_id=?", uid, zeroResult.DecisionId) != 1 {
		t.Fatalf("zero-event same_event failed: %+v %v", zeroResult, err)
	}
	assertDecisionRows(t, environment.database, zero, importing.PROCESSING_STATE_LINKED)
	uncategorized := insertDecisionCaseFixture(t, environment.database, uid, 45_000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.ECONOMIC_EFFECT_NORMAL)
	uncategorizedDraft := expenseDraft(uncategorized, 500)
	uncategorizedDraft.CategoryId = 0
	uncategorizedDraft.AllowUncategorized = true
	uncategorizedResult, err := environment.service.DecideCase(nil, sameEventRequest(uncategorized, "same-zero-uncategorized", uncategorizedDraft), time.UTC)
	if err != nil || uncategorizedResult.Status != DECISION_STATUS_APPLIED {
		t.Fatalf("uncategorized zero-event same_event failed: %+v %v", uncategorizedResult, err)
	}
	assertDecisionRows(t, environment.database, uncategorized, importing.PROCESSING_STATE_LINKED)

	one := insertDecisionCaseFixture(t, environment.database, uid, 50_000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.ECONOMIC_EFFECT_NORMAL)
	existing := insertDecisionExistingEvent(t, environment.database, one, 1, 500, models.TRANSACTION_DB_TYPE_EXPENSE, 70_001)
	oneResult, err := environment.service.DecideCase(nil, sameEventRequest(one, "same-one", nil), time.UTC)
	if err != nil || oneResult.Status != DECISION_STATUS_APPLIED || countDecisionRows(t, environment.database, new(models.Transaction), "uid=? AND transaction_id=?", uid, existing.TransactionId) != 1 || countDecisionRows(t, environment.database, new(LedgerEffect), "uid=? AND decision_id=?", uid, oneResult.DecisionId) != 0 {
		t.Fatalf("one-event attachment failed: %+v %v", oneResult, err)
	}

	incompatible := insertDecisionCaseFixture(t, environment.database, uid, 55_000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.ECONOMIC_EFFECT_NORMAL)
	insertDecisionExistingEvent(t, environment.database, incompatible, 1, 700, models.TRANSACTION_DB_TYPE_EXPENSE, 70_051)
	incompatibleResult, err := environment.service.DecideCase(nil, sameEventRequest(incompatible, "same-incompatible", nil), time.UTC)
	if err != nil || incompatibleResult.Status != DECISION_STATUS_ACTION_REQUIRED || len(incompatibleResult.ReasonCodes) != 1 || incompatibleResult.ReasonCodes[0] != decisionReasonEventTypeMismatch {
		t.Fatalf("incompatible existing event was attached: %+v %v", incompatibleResult, err)
	}

	multiple := insertDecisionCaseFixture(t, environment.database, uid, 60_000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.ECONOMIC_EFFECT_NORMAL)
	insertDecisionExistingEvent(t, environment.database, multiple, 1, 500, models.TRANSACTION_DB_TYPE_EXPENSE, 70_101)
	insertDecisionExistingEvent(t, environment.database, multiple, 2, 500, models.TRANSACTION_DB_TYPE_EXPENSE, 70_102)
	multipleResult, err := environment.service.DecideCase(nil, sameEventRequest(multiple, "same-multiple", nil), time.UTC)
	if err != nil || multipleResult.Status != DECISION_STATUS_ACTION_REQUIRED || len(multipleResult.ReasonCodes) != 1 || multipleResult.ReasonCodes[0] != decisionReasonMultipleEvents {
		t.Fatalf("multiple existing events were not escalated: %+v %v", multipleResult, err)
	}

	transfer := insertDecisionCaseFixture(t, environment.database, uid, 70_000, importing.NORMALIZED_DIRECTION_INCOME, importing.ECONOMIC_EFFECT_NORMAL)
	transferDraft := expenseDraft(transfer, 500)
	transferDraft.Type = models.TRANSACTION_TYPE_TRANSFER
	transferDraft.DestinationAccountId = 99
	transferDraft.DestinationAmount = 500
	transferResult, err := environment.service.DecideCase(nil, DecideCaseRequest{Uid: uid, CaseId: transfer.caseId, ExpectedCaseVersion: 1, DecisionType: DECISION_TYPE_INTERNAL_TRANSFER, IdempotencyKey: "transfer-zero", CreatedIp: "192.0.2.10", PrimaryDraft: transferDraft}, time.UTC)
	if err != nil || transferResult.Status != DECISION_STATUS_APPLIED || countDecisionRows(t, environment.database, new(LedgerEffect), "uid=? AND decision_id=?", uid, transferResult.DecisionId) != 2 || countDecisionRows(t, environment.database, new(TransactionLink), "uid=? AND decision_id=?", uid, transferResult.DecisionId) != 4 {
		t.Fatalf("complete transfer decision failed: %+v %v", transferResult, err)
	}

	refund := insertDecisionCaseFixture(t, environment.database, uid, 80_000, importing.NORMALIZED_DIRECTION_INCOME, importing.ECONOMIC_EFFECT_REFUND)
	originalDraft := expenseDraft(refund, 500)
	refundDraft := expenseDraft(refund, 500)
	refundDraft.Type = models.TRANSACTION_TYPE_INCOME
	refundDraft.UnixTime++
	refundResult, err := environment.service.DecideCase(nil, DecideCaseRequest{
		Uid: uid, CaseId: refund.caseId, ExpectedCaseVersion: 1, DecisionType: DECISION_TYPE_REFUND_REVERSAL,
		IdempotencyKey: "refund-zero", CreatedIp: "192.0.2.10", FieldSelection: DecisionFieldSelection{RefundOriginalMemberOrder: 1},
		RefundOriginalDraft: originalDraft, RefundTransactionDraft: refundDraft,
	}, time.UTC)
	if err != nil || refundResult.Status != DECISION_STATUS_APPLIED || countDecisionRows(t, environment.database, new(LedgerEffect), "uid=? AND decision_id=?", uid, refundResult.DecisionId) != 2 {
		t.Fatalf("refund pair decision failed: %+v %v", refundResult, err)
	}
	assertDecisionTransactionsNotDeleted(t, environment.database, uid, refundResult.DecisionId)

	wrongCurrency := insertDecisionCaseFixture(t, environment.database, uid, 85_000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.ECONOMIC_EFFECT_NORMAL)
	setDecisionLedgerAccountCurrency(t, environment.database, uid, 1, "USD")
	wrongCurrencyResult, err := environment.service.DecideCase(nil, sameEventRequest(wrongCurrency, "same-wrong-currency", expenseDraft(wrongCurrency, 500)), time.UTC)
	if err != nil || wrongCurrencyResult.Status != DECISION_STATUS_ACTION_REQUIRED || len(wrongCurrencyResult.ReasonCodes) != 1 || wrongCurrencyResult.ReasonCodes[0] != decisionReasonDraftMismatch {
		t.Fatalf("wrong account currency was not rejected: %+v %v", wrongCurrencyResult, err)
	}
	setDecisionLedgerAccountCurrency(t, environment.database, uid, 1, "CNY")

	rollback := insertDecisionCaseFixture(t, environment.database, uid, 90_000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.ECONOMIC_EFFECT_NORMAL)
	environment.ledger.failCreate.Store(true)
	_, err = environment.service.DecideCase(nil, sameEventRequest(rollback, "same-rollback", expenseDraft(rollback, 500)), time.UTC)
	environment.ledger.failCreate.Store(false)
	if !errors.Is(err, ErrDecisionLedgerRejected) {
		t.Fatalf("ledger failure was not stable: %v", err)
	}
	if countDecisionRows(t, environment.database, new(models.Transaction), "uid=? AND transaction_time=?", uid, expenseDraft(rollback, 500).UnixTime*1000) != 0 {
		t.Fatal("failed decision left a ledger transaction")
	}
	assertDecisionRows(t, environment.database, rollback, importing.PROCESSING_STATE_PENDING)
}

func TestDecisionServiceSQLiteUndoAttachedCreatedModifiedSharedAndIncompletePair(t *testing.T) {
	environment := newDecisionSQLiteEnvironment(t)
	uid := int64(3303)
	insertDecisionLedgerAccounts(t, environment.database, uid, "CNY")

	attached := insertDecisionCaseFixture(t, environment.database, uid, 100_000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.ECONOMIC_EFFECT_NORMAL)
	existing := insertDecisionExistingEvent(t, environment.database, attached, 1, 500, models.TRANSACTION_DB_TYPE_EXPENSE, 170_001)
	attachedDecision, err := environment.service.DecideCase(nil, sameEventRequest(attached, "undo-attached-decide", nil), time.UTC)
	if err != nil {
		t.Fatalf("create attached decision: %v", err)
	}
	impact, err := environment.service.GetUndoImpact(nil, uid, attached.caseId)
	if err != nil || !impact.CanReopen || impact.CanAutomaticallyDelete || impact.AttachedExistingCount != 1 {
		t.Fatalf("attached undo impact mismatch: %+v %v", impact, err)
	}
	undo, err := environment.service.UndoCase(nil, UndoCaseRequest{Uid: uid, CaseId: attached.caseId, ExpectedCaseVersion: attachedDecision.AppliedCaseVersion, IdempotencyKey: "undo-attached"}, time.UTC)
	if err != nil || undo.Status != DECISION_STATUS_APPLIED || loadDecisionTransaction(t, environment.database, uid, existing.TransactionId).Deleted {
		t.Fatalf("attached undo changed the ledger: %+v %v", undo, err)
	}

	created := insertDecisionCaseFixture(t, environment.database, uid, 110_000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.ECONOMIC_EFFECT_NORMAL)
	createdDecision, err := environment.service.DecideCase(nil, sameEventRequest(created, "undo-created-decide", expenseDraft(created, 500)), time.UTC)
	if err != nil {
		t.Fatalf("create reconciliation ledger decision: %v", err)
	}
	createdTransactionId := decisionEffectTransactionIds(t, environment.database, uid, createdDecision.DecisionId)[0]
	impact, err = environment.service.GetUndoImpact(nil, uid, created.caseId)
	if err != nil || !impact.CanAutomaticallyDelete {
		t.Fatalf("created undo impact mismatch: %+v %v", impact, err)
	}
	undo, err = environment.service.UndoCase(nil, UndoCaseRequest{Uid: uid, CaseId: created.caseId, ExpectedCaseVersion: 2, IdempotencyKey: "undo-created"}, time.UTC)
	if err != nil || undo.Status != DECISION_STATUS_APPLIED || !loadDecisionTransaction(t, environment.database, uid, createdTransactionId).Deleted {
		t.Fatalf("created event was not safely deleted: %+v %v", undo, err)
	}
	assertDecisionRows(t, environment.database, created, importing.PROCESSING_STATE_PENDING)

	modified := insertDecisionCaseFixture(t, environment.database, uid, 120_000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.ECONOMIC_EFFECT_NORMAL)
	modifiedDecision, err := environment.service.DecideCase(nil, sameEventRequest(modified, "undo-modified-decide", expenseDraft(modified, 500)), time.UTC)
	if err != nil {
		t.Fatalf("create modified undo fixture: %v", err)
	}
	modifiedTransactionId := decisionEffectTransactionIds(t, environment.database, uid, modifiedDecision.DecisionId)[0]
	updateDecisionTransactionSnapshot(t, environment.database, uid, modifiedTransactionId)
	undo, err = environment.service.UndoCase(nil, UndoCaseRequest{Uid: uid, CaseId: modified.caseId, ExpectedCaseVersion: 2, IdempotencyKey: "undo-modified"}, time.UTC)
	if err != nil || undo.Status != DECISION_STATUS_ACTION_REQUIRED || loadDecisionTransaction(t, environment.database, uid, modifiedTransactionId).Deleted {
		t.Fatalf("modified event was not escalated without deletion: %+v %v", undo, err)
	}
	assertCurrentDecision(t, environment.database, uid, modified.caseId, modifiedDecision.DecisionId)

	shared := insertDecisionCaseFixture(t, environment.database, uid, 130_000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.ECONOMIC_EFFECT_NORMAL)
	sharedDecision, err := environment.service.DecideCase(nil, sameEventRequest(shared, "undo-shared-decide", expenseDraft(shared, 500)), time.UTC)
	if err != nil {
		t.Fatalf("create shared undo fixture: %v", err)
	}
	sharedTransactionId := decisionEffectTransactionIds(t, environment.database, uid, sharedDecision.DecisionId)[0]
	insertActiveSharedDecision(t, environment.database, uid, sharedTransactionId, 140_000)
	impact, err = environment.service.GetUndoImpact(nil, uid, shared.caseId)
	if err != nil || impact.SharedTransactionCount != 1 || impact.CanReopen {
		t.Fatalf("shared undo impact mismatch: %+v %v", impact, err)
	}

	incomplete := insertDecisionCaseFixture(t, environment.database, uid, 150_000, importing.NORMALIZED_DIRECTION_INCOME, importing.ECONOMIC_EFFECT_NORMAL)
	incompleteDraft := expenseDraft(incomplete, 500)
	incompleteDraft.Type = models.TRANSACTION_TYPE_TRANSFER
	incompleteDraft.DestinationAccountId = 99
	incompleteDraft.DestinationAmount = 500
	incompleteDecision, err := environment.service.DecideCase(nil, DecideCaseRequest{Uid: uid, CaseId: incomplete.caseId, ExpectedCaseVersion: 1, DecisionType: DECISION_TYPE_INTERNAL_TRANSFER, IdempotencyKey: "undo-transfer-decide", CreatedIp: "192.0.2.10", PrimaryDraft: incompleteDraft}, time.UTC)
	if err != nil {
		t.Fatalf("create incomplete transfer undo fixture: %v", err)
	}
	transferIds := decisionEffectTransactionIds(t, environment.database, uid, incompleteDecision.DecisionId)
	softDeleteDecisionTransaction(t, environment.database, uid, transferIds[1])
	impact, err = environment.service.GetUndoImpact(nil, uid, incomplete.caseId)
	if err != nil || impact.IncompleteTransferPairCount != 1 || impact.CanReopen {
		t.Fatalf("incomplete transfer impact mismatch: %+v %v", impact, err)
	}
}

func TestDecisionServiceSQLiteUndoLoanRelationGuardsPreviewAndTransactionalRecheck(t *testing.T) {
	environment := newDecisionSQLiteEnvironment(t)
	uid := int64(4404)
	insertDecisionLedgerAccounts(t, environment.database, uid, "CNY")
	fixture := insertDecisionCaseFixture(t, environment.database, uid, 210_000, importing.NORMALIZED_DIRECTION_INCOME, importing.ECONOMIC_EFFECT_NORMAL)
	draft := expenseDraft(fixture, 500)
	draft.Type = models.TRANSACTION_TYPE_TRANSFER
	draft.DestinationAccountId = 99
	draft.DestinationAmount = 500
	decision, err := environment.service.DecideCase(nil, DecideCaseRequest{Uid: uid, CaseId: fixture.caseId,
		ExpectedCaseVersion: 1, DecisionType: DECISION_TYPE_INTERNAL_TRANSFER, IdempotencyKey: "undo-loan-relation-decide",
		CreatedIp: "192.0.2.10", PrimaryDraft: draft}, time.UTC)
	if err != nil {
		t.Fatalf("create loan-relation guard fixture: %v", err)
	}
	transactionIds := decisionEffectTransactionIds(t, environment.database, uid, decision.DecisionId)
	if len(transactionIds) != 2 {
		t.Fatalf("transfer fixture does not have two rows: %v", transactionIds)
	}

	insertDecisionLoanBinding(t, environment.database, uid+1, transactionIds[1], 8_800_001, 8_900_001)
	impact, err := environment.service.GetUndoImpact(nil, uid, fixture.caseId)
	if err != nil || !impact.CanAutomaticallyDelete || impact.LoanRelationCount != 0 {
		t.Fatalf("cross-user loan relation blocked undo: %+v %v", impact, err)
	}

	// Preview 与提交之间新增本用户活动关系；UndoCase 内部必须再次检查并拒绝删除完整逻辑事件。
	insertDecisionLoanBinding(t, environment.database, uid, transactionIds[1], 8_800_002, 8_900_002)
	undo, err := environment.service.UndoCase(nil, UndoCaseRequest{Uid: uid, CaseId: fixture.caseId,
		ExpectedCaseVersion: decision.AppliedCaseVersion, IdempotencyKey: "undo-loan-relation-guard"}, time.UTC)
	if err != nil || undo.Status != DECISION_STATUS_ACTION_REQUIRED ||
		!containsDecisionReason(undo.ReasonCodes, string(UNDO_REASON_LOAN_RELATION_PRESENT)) {
		t.Fatalf("transactional loan guard did not return stable action_required: %+v %v", undo, err)
	}
	for _, transactionId := range transactionIds {
		if loadDecisionTransaction(t, environment.database, uid, transactionId).Deleted {
			t.Fatal("loan-related transfer row was automatically deleted")
		}
	}
	impact, err = environment.service.GetUndoImpact(nil, uid, fixture.caseId)
	if err != nil || impact.LoanRelationCount != 1 || impact.CanReopen || impact.CanAutomaticallyDelete ||
		!containsUndoReason(impact.ReasonCodes, UNDO_REASON_LOAN_RELATION_PRESENT) {
		t.Fatalf("loan relation impact aggregate mismatch: %+v %v", impact, err)
	}
}

func insertDecisionLoanBinding(t *testing.T, database *datastore.Database, uid int64, transactionId int64, bindingId int64, allocationId int64) {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	binding := &loans.TransactionBinding{Uid: uid, TransactionId: transactionId, CurrentAllocationId: &allocationId,
		Version: 2, CreatedUnixTime: 1_900_000_001, UpdatedUnixTime: 1_900_000_002, BindingId: bindingId}
	if inserted, err := sess.Insert(binding); err != nil || inserted != 1 {
		t.Fatalf("insert active loan binding: inserted=%d err=%v", inserted, err)
	}
}

func containsDecisionReason(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func containsUndoReason(values []UndoImpactReason, expected UndoImpactReason) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func newDecisionSQLiteEnvironment(t *testing.T) *decisionSQLiteEnvironment {
	t.Helper()
	_, database := newCandidateSQLiteService(t, &sequentialCandidateIds{})
	if err := database.SyncStructs(new(models.Account), new(models.Transaction)); err != nil {
		t.Fatalf("create decision ledger schema: %v", err)
	}
	store, err := datastore.NewDataStore(database)
	if err != nil {
		t.Fatalf("create decision store: %v", err)
	}
	var identifiers atomic.Int64
	identifiers.Store(9_000_000)
	ledger := new(decisionSQLiteLedger)
	ledger.next.Store(8_000_000)
	service, err := NewDecisionService(store, allowDecisionAuthorization{}, ledger, func() int64 { return identifiers.Add(1) })
	if err != nil {
		t.Fatalf("create decision service: %v", err)
	}
	service.now = func() time.Time { return time.Unix(1_900_000_000, 0) }
	caseService, err := NewCaseService(store)
	if err != nil {
		t.Fatalf("create case service: %v", err)
	}
	return &decisionSQLiteEnvironment{database: database, service: service, cases: caseService, ledger: ledger}
}

func insertDecisionCaseFixture(t *testing.T, database *datastore.Database, uid int64, base int64, secondDirection importing.NormalizedDirection, secondEffect importing.EconomicEffect) decisionCaseFixture {
	t.Helper()
	fixture := decisionCaseFixture{uid: uid, caseId: base + 51, rowIds: [2]int64{base + 41, base + 42}, batchIds: [2]int64{base + 11, base + 12}}
	accounts := [2]int64{base + 1, base + 2}
	identities := [2]int64{base + 31, base + 32}
	beans := make([]any, 0, 12)
	for index := 0; index < 2; index++ {
		account := candidateTestAccount(uid, accounts[index], []importing.SourceType{importing.SOURCE_TYPE_ALIPAY, importing.SOURCE_TYPE_BANK}[index])
		batch := candidateTestBatch(uid, fixture.batchIds[index], accounts[index])
		file := &importing.ImportFile{Uid: uid, ContentState: importing.IMPORT_FILE_CONTENT_STATE_AVAILABLE, OriginalFileName: "fixture.csv", FileSize: 1,
			FileSha256: candidateDigest(batch.FileId), MimeType: "text/csv", FileExtension: "csv", StorageObjectKey: "opaque", CreatedIp: "192.0.2.1",
			CreatedUnixTime: 1, UpdatedUnixTime: 1, FileId: batch.FileId}
		identity := candidateTestIdentity(uid, identities[index], accounts[index])
		row := candidateTestRow(uid, fixture.rowIds[index], fixture.batchIds[index], int64Pointer(identities[index]), importing.IDENTITY_STATE_NEW, 500, "CNY", 1_720_000_000+base+int64(index))
		if index == 1 {
			row.NormalizedDirection = secondDirection
			row.EconomicEffect = secondEffect
		}
		beans = append(beans, file, account, batch, identity, row)
	}
	caseRecord := &Case{Uid: uid, CaseKey: candidateDigest(fixture.caseId), CaseKeyVersion: CASE_KEY_VERSION_V1, Status: CASE_STATUS_OPEN, Version: 1, MemberCount: 2,
		SuggestedRelationType: DECISION_TYPE_SAME_EVENT, CandidateScore: 100, CandidateRuleVersion: CANDIDATE_RULE_VERSION_V2,
		ExplanationVersion: EXPLANATION_VERSION_V2, ReasonCodesJson: "[]", CreatedUnixTime: base, LastEvaluatedUnixTime: base, UpdatedUnixTime: base, CaseId: fixture.caseId}
	beans = append(beans, caseRecord,
		&CaseMember{Uid: uid, CaseId: fixture.caseId, MemberOrder: 1, MemberKind: MEMBER_KIND_SOURCE_IDENTITY, MemberRefId: identities[0], MemberRole: candidateMemberRoleEvidence, CreatedUnixTime: base, MemberId: base + 61},
		&CaseMember{Uid: uid, CaseId: fixture.caseId, MemberOrder: 2, MemberKind: MEMBER_KIND_SOURCE_IDENTITY, MemberRefId: identities[1], MemberRole: candidateMemberRoleEvidence, CreatedUnixTime: base, MemberId: base + 62},
	)
	insertCandidateFixtures(t, database, beans...)
	return fixture
}

func sameEventRequest(fixture decisionCaseFixture, key string, draft *importing.LedgerTransactionDraft) DecideCaseRequest {
	return DecideCaseRequest{Uid: fixture.uid, CaseId: fixture.caseId, ExpectedCaseVersion: 1, DecisionType: DECISION_TYPE_SAME_EVENT, IdempotencyKey: key, CreatedIp: "192.0.2.10", PrimaryDraft: draft}
}

func expenseDraft(fixture decisionCaseFixture, amount int64) *importing.LedgerTransactionDraft {
	return &importing.LedgerTransactionDraft{Type: models.TRANSACTION_TYPE_EXPENSE, CategoryId: 1, UnixTime: 1_720_000_000 + fixture.caseId, SourceAccountId: 1, SourceAmount: amount}
}

func insertDecisionLedgerAccounts(t *testing.T, database *datastore.Database, uid int64, currency string) {
	t.Helper()
	insertCandidateFixtures(t, database,
		&models.Account{AccountId: 1, Uid: uid, Category: models.ACCOUNT_CATEGORY_CASH, Type: models.ACCOUNT_TYPE_SINGLE_ACCOUNT, Name: "source", Currency: currency, CreatedUnixTime: 1, UpdatedUnixTime: 1},
		&models.Account{AccountId: 99, Uid: uid, Category: models.ACCOUNT_CATEGORY_CASH, Type: models.ACCOUNT_TYPE_SINGLE_ACCOUNT, Name: "destination", Currency: currency, CreatedUnixTime: 1, UpdatedUnixTime: 1},
	)
}

func setDecisionLedgerAccountCurrency(t *testing.T, database *datastore.Database, uid int64, accountId int64, currency string) {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	updated, err := sess.Where("uid=? AND account_id=?", uid, accountId).Cols("currency").Update(&models.Account{Currency: currency})
	if err != nil || updated != 1 {
		t.Fatalf("update decision ledger account currency: updated=%d err=%v", updated, err)
	}
}

func insertDecisionExistingEvent(t *testing.T, database *datastore.Database, fixture decisionCaseFixture, member int, amount int64, transactionType models.TransactionDbType, transactionId int64) *models.Transaction {
	t.Helper()
	transaction := &models.Transaction{TransactionId: transactionId, Uid: fixture.uid, Type: transactionType, CategoryId: 1, AccountId: 1,
		TransactionTime: transactionId * 1000, Amount: amount, CreatedUnixTime: 1_800_000_000, UpdatedUnixTime: 1_800_000_000}
	link := &importing.RawRowTransactionLink{Uid: fixture.uid, RowId: fixture.rowIds[member-1], TransactionId: transactionId,
		RelationRole: importing.RAW_ROW_TRANSACTION_RELATION_PRIMARY, CreationMethod: importing.RAW_ROW_TRANSACTION_CREATION_POSTING_CREATED,
		PostingId: transactionId + 1, RuleVersion: importing.POSTING_LINK_VERSION_V1, TransactionUpdatedUnixTime: transaction.UpdatedUnixTime,
		CreatedUnixTime: transaction.UpdatedUnixTime, LinkId: transactionId + 2}
	insertCandidateFixtures(t, database, transaction, link)
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	if updated, err := sess.Where("uid=? AND row_id=?", fixture.uid, fixture.rowIds[member-1]).Cols("processing_state", "disposition").
		Update(&importing.RawImportRow{ProcessingState: importing.PROCESSING_STATE_LINKED, Disposition: importing.IMPORT_DISPOSITION_NON_POSTABLE}); err != nil || updated != 1 {
		t.Fatalf("mark existing evidence row linked: %v", err)
	}
	if updated, err := sess.Where("uid=? AND batch_id=?", fixture.uid, fixture.batchIds[member-1]).Cols("status", "pending_row_count", "posted_row_count").
		Update(&importing.ImportBatch{Status: importing.IMPORT_BATCH_STATUS_COMPLETED, PendingRowCount: 0, PostedRowCount: 1}); err != nil || updated != 1 {
		t.Fatalf("mark existing evidence batch linked: %v", err)
	}
	return transaction
}

func assertDecisionRows(t *testing.T, database *datastore.Database, fixture decisionCaseFixture, state importing.ProcessingState) {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	rows := make([]*importing.RawImportRow, 0, 2)
	if err := sess.Where("uid=?", fixture.uid).In("row_id", fixture.rowIds[:]).Find(&rows); err != nil || len(rows) != 2 {
		t.Fatalf("load decision rows: %+v %v", rows, err)
	}
	for _, row := range rows {
		if row.ProcessingState != state {
			t.Fatalf("unexpected decision row state: %+v", row)
		}
	}
	batches := make([]*importing.ImportBatch, 0, 2)
	if err := sess.Where("uid=?", fixture.uid).In("batch_id", fixture.batchIds[:]).Find(&batches); err != nil || len(batches) != 2 {
		t.Fatalf("load decision batches: %+v %v", batches, err)
	}
	for _, batch := range batches {
		expectedStatus := importing.IMPORT_BATCH_STATUS_COMPLETED
		expectedPending := int64(0)
		expectedPosted := int64(0)
		if state == importing.PROCESSING_STATE_PENDING {
			expectedStatus = importing.IMPORT_BATCH_STATUS_READY
			expectedPending = 1
		} else if state == importing.PROCESSING_STATE_LINKED {
			expectedPosted = 1
		}
		if batch.Status != expectedStatus || batch.PendingRowCount != expectedPending || batch.PostedRowCount != expectedPosted {
			t.Fatalf("unexpected decision batch state: %+v", batch)
		}
	}
}

func countDecisionRows(t *testing.T, database *datastore.Database, bean any, condition string, args ...any) int64 {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	count, err := sess.Where(condition, args...).Count(bean)
	if err != nil {
		t.Fatalf("count decision rows %T: %v", bean, err)
	}
	return count
}

func decisionEffectTransactionIds(t *testing.T, database *datastore.Database, uid int64, decisionId int64) []int64 {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	effects := make([]*LedgerEffect, 0)
	if err := sess.Where("uid=? AND decision_id=? AND effect_type=?", uid, decisionId, LEDGER_EFFECT_TYPE_CREATED).Asc("transaction_id").Find(&effects); err != nil {
		t.Fatalf("list decision effects: %v", err)
	}
	ids := make([]int64, len(effects))
	for index, effect := range effects {
		ids[index] = effect.TransactionId
	}
	return ids
}

func assertDecisionTransactionsNotDeleted(t *testing.T, database *datastore.Database, uid int64, decisionId int64) {
	t.Helper()
	for _, transactionId := range decisionEffectTransactionIds(t, database, uid, decisionId) {
		if loadDecisionTransaction(t, database, uid, transactionId).Deleted {
			t.Fatalf("refund transaction was deleted: %d", transactionId)
		}
	}
}

func loadDecisionTransaction(t *testing.T, database *datastore.Database, uid int64, transactionId int64) *models.Transaction {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	transaction := new(models.Transaction)
	found, err := sess.Where("uid=? AND transaction_id=?", uid, transactionId).Get(transaction)
	if err != nil || !found {
		t.Fatalf("load decision transaction %d: %v", transactionId, err)
	}
	return transaction
}

func updateDecisionTransactionSnapshot(t *testing.T, database *datastore.Database, uid int64, transactionId int64) {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	if updated, err := sess.Where("uid=? AND transaction_id=?", uid, transactionId).Cols("updated_unix_time").Update(&models.Transaction{UpdatedUnixTime: 1_900_000_001}); err != nil || updated != 1 {
		t.Fatalf("modify decision transaction snapshot: %v", err)
	}
}

func softDeleteDecisionTransaction(t *testing.T, database *datastore.Database, uid int64, transactionId int64) {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	if updated, err := sess.Where("uid=? AND transaction_id=?", uid, transactionId).Cols("deleted", "deleted_unix_time").Update(&models.Transaction{Deleted: true, DeletedUnixTime: 1_900_000_001}); err != nil || updated != 1 {
		t.Fatalf("soft delete decision transaction fixture: %v", err)
	}
}

func assertCurrentDecision(t *testing.T, database *datastore.Database, uid int64, caseId int64, decisionId int64) {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	caseRecord := new(Case)
	found, err := sess.Where("uid=? AND case_id=?", uid, caseId).Get(caseRecord)
	if err != nil || !found || caseRecord.CurrentDecisionId == nil || *caseRecord.CurrentDecisionId != decisionId || caseRecord.Status != CASE_STATUS_ACTION_REQUIRED {
		t.Fatalf("unsafe reopen replaced the active decision: %+v %v", caseRecord, err)
	}
}

func insertActiveSharedDecision(t *testing.T, database *datastore.Database, uid int64, transactionId int64, base int64) {
	t.Helper()
	decisionId := base + 1
	current := decisionId
	completed := base
	insertCandidateFixtures(t, database,
		&Case{Uid: uid, CaseKey: candidateDigest(base), CaseKeyVersion: CASE_KEY_VERSION_V1, Status: CASE_STATUS_RESOLVED, Version: 2, MemberCount: 2,
			SuggestedRelationType: DECISION_TYPE_SAME_EVENT, CandidateScore: 1, CandidateRuleVersion: CANDIDATE_RULE_VERSION_V1,
			ExplanationVersion: EXPLANATION_VERSION_V1, ReasonCodesJson: "[]", CurrentDecisionId: &current, CreatedUnixTime: base, LastEvaluatedUnixTime: base, UpdatedUnixTime: base, CaseId: base + 2},
		&Decision{Uid: uid, CaseId: base + 2, ExpectedCaseVersion: 1, AppliedCaseVersion: 2, DecisionType: DECISION_TYPE_SAME_EVENT,
			IdempotencyKeyDigest: strings.Repeat("a", 63) + "b", IdempotencyKeyVersion: IDEMPOTENCY_KEY_VERSION_V1,
			RequestDigest: strings.Repeat("b", 64), RequestDigestVersion: DECISION_REQUEST_VERSION_V1, Status: DECISION_STATUS_APPLIED,
			FieldSelectionJson: "{}", ReasonCodesJson: "[]", CreatedUnixTime: base, CompletedUnixTime: &completed, UpdatedUnixTime: base, DecisionId: decisionId},
		&TransactionLink{Uid: uid, DecisionId: decisionId, RowId: base + 3, TransactionId: transactionId, RelationRole: TRANSACTION_RELATION_ROLE_PRIMARY,
			CreationMethod: TRANSACTION_CREATION_METHOD_ATTACHED_EXISTING, RuleVersion: TRANSACTION_LINK_VERSION_V1,
			TransactionUpdatedUnixTime: 1_900_000_000, CreatedUnixTime: base, LinkId: base + 4},
	)
}
