package organizer_test

import (
	"errors"
	"fmt"
	"sync"
	"testing"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/organizer"
)

func TestPostingEngineSQLitePostsAtomicallyAndReplays(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	if err := database.SyncStructs(new(models.Transaction)); err != nil {
		t.Fatalf("create ledger test table: %v", err)
	}
	const uid = int64(9101)
	const updateId = int64(9201)
	expense := postingEvent(uid, updateId, 9301, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_EXPENSE)
	refund := postingEvent(uid, updateId, 9302, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_REFUND)
	seedPostingUpdateWithRelations(t, repository, uid, updateId, []*organizer.EconomicEvent{expense, refund},
		[]*organizer.EconomicEventRelation{postingRefundRelation(uid, updateId, refund, expense, 9350)})
	ledger := &postingLedgerStub{next: 9400}
	engine, err := organizer.NewPostingEngine(repository, ledger, &engineIdGenerator{next: 9500})
	if err != nil {
		t.Fatalf("create posting engine: %v", err)
	}
	request := organizer.PostRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 2, IdempotencyKey: "post-all-9201-v2", Mode: organizer.POST_MODE_ALL_READY}
	result, err := engine.Post(nil, request)
	if err != nil || result == nil || result.Replayed || result.Update.Status != organizer.UPDATE_STATUS_POSTED || result.Update.Version != 4 ||
		result.Update.PostedEventCount != 2 || result.Update.ReadyEventCount != 0 || len(result.Links) != 2 {
		t.Fatalf("post all result mismatch: result=%+v err=%v", result, err)
	}
	replayed, err := engine.Post(nil, request)
	if err != nil || replayed == nil || !replayed.Replayed || replayed.Action.ActionId != result.Action.ActionId || len(replayed.Links) != 2 {
		t.Fatalf("post all replay mismatch: result=%+v err=%v", replayed, err)
	}
	assertPostingCounts(t, database, uid, 2, 2, 1)
}

func TestPostingEngineSQLitePostsExplicitUnlinkedRefund(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	if err := database.SyncStructs(new(models.Transaction)); err != nil {
		t.Fatalf("create refund guard ledger table: %v", err)
	}
	const uid = int64(9104)
	const updateId = int64(9204)
	refund := postingEvent(uid, updateId, 9331, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_REFUND)
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{refund})
	engine, _ := organizer.NewPostingEngine(repository, &postingLedgerStub{next: 9430}, &engineIdGenerator{next: 9530})
	result, err := engine.Post(nil, organizer.PostRequest{
		Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 2, IdempotencyKey: "forged-refund-ready", Mode: organizer.POST_MODE_ALL_READY,
	})
	if err != nil || result == nil || result.Update.Status != organizer.UPDATE_STATUS_POSTED || result.Update.PostedEventCount != 1 {
		t.Fatalf("explicit unlinked refund was not posted atomically: result=%+v err=%v", result, err)
	}
	update, findErr := repository.FindUpdateById(nil, uid, updateId)
	if findErr != nil || update == nil || update.Status != organizer.UPDATE_STATUS_POSTED || update.PostedEventCount != 1 {
		t.Fatalf("rejected refund changed update: update=%+v err=%v", update, findErr)
	}
	assertPostingCounts(t, database, uid, 1, 1, 1)
}

func TestPostingEngineSQLiteRejectsUnresolvedAndPartialPosting(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	if err := database.SyncStructs(new(models.Transaction)); err != nil {
		t.Fatalf("create partial ledger test table: %v", err)
	}
	const uid = int64(9102)
	const updateId = int64(9202)
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{
		postingEvent(uid, updateId, 9311, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_EXPENSE),
		postingEvent(uid, updateId, 9312, organizer.EVENT_STATUS_NEEDS_ACTION, organizer.ECONOMIC_NATURE_UNKNOWN),
	})
	engine, err := organizer.NewPostingEngine(repository, &postingLedgerStub{next: 9410}, &engineIdGenerator{next: 9510})
	if err != nil {
		t.Fatalf("create partial posting engine: %v", err)
	}
	_, err = engine.Post(nil, organizer.PostRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 2, IdempotencyKey: "post-all-rejected", Mode: organizer.POST_MODE_ALL_READY})
	if !errors.Is(err, organizer.ErrPostUnresolvedEvents) {
		t.Fatalf("default posting accepted unresolved events: %v", err)
	}
	assertPostingCounts(t, database, uid, 0, 0, 0)
	_, err = engine.Post(nil, organizer.PostRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 2, IdempotencyKey: "post-ready-rejected", Mode: organizer.PostMode("ready")})
	if !errors.Is(err, organizer.ErrPostRequestInvalid) {
		t.Fatalf("partial posting mode was accepted: %v", err)
	}
	assertPostingCounts(t, database, uid, 0, 0, 0)
}

func TestPostingEngineSQLiteRollsBackLedgerAndProjectionTogether(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	if err := database.SyncStructs(new(models.Transaction)); err != nil {
		t.Fatalf("create rollback ledger test table: %v", err)
	}
	const uid = int64(9103)
	const updateId = int64(9203)
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{
		postingEvent(uid, updateId, 9321, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_EXPENSE),
		postingEvent(uid, updateId, 9322, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_EXPENSE),
	})
	ledgerFailure := errors.New("second ledger write failed")
	engine, err := organizer.NewPostingEngine(repository, &postingLedgerStub{next: 9420, failAt: 2, failure: ledgerFailure}, &engineIdGenerator{next: 9520})
	if err != nil {
		t.Fatalf("create rollback posting engine: %v", err)
	}
	_, err = engine.Post(nil, organizer.PostRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 2, IdempotencyKey: "post-rollback", Mode: organizer.POST_MODE_ALL_READY})
	if !errors.Is(err, ledgerFailure) {
		t.Fatalf("ledger failure mismatch: %v", err)
	}
	update, findErr := repository.FindUpdateById(nil, uid, updateId)
	if findErr != nil || update == nil || update.Status != organizer.UPDATE_STATUS_REVIEW || update.Version != 2 || update.PostedEventCount != 0 {
		t.Fatalf("failed posting changed update: update=%+v err=%v", update, findErr)
	}
	assertPostingCounts(t, database, uid, 0, 0, 0)
}

func seedPostingUpdate(t *testing.T, repository *organizer.Repository, uid int64, updateId int64, events []*organizer.EconomicEvent) {
	t.Helper()
	seedPostingUpdateWithRelations(t, repository, uid, updateId, events, nil)
}

func seedPostingUpdateWithRelations(t *testing.T, repository *organizer.Repository, uid int64, updateId int64, events []*organizer.EconomicEvent, relations []*organizer.EconomicEventRelation) {
	t.Helper()
	err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		if err := tx.InsertUpdate(testUpdate(uid, updateId, 100)); err != nil {
			return err
		}
		if err := tx.InsertSource(testSource(uid, updateId, updateId+100, updateId+200, updateId+300, 100)); err != nil {
			return err
		}
		for _, event := range events {
			if err := tx.InsertEvent(event); err != nil {
				return err
			}
		}
		for _, relation := range relations {
			if err := tx.InsertRelation(relation); err != nil {
				return err
			}
		}
		update, err := tx.FindUpdateById(updateId)
		if err != nil {
			return err
		}
		next := *update
		next.Status = organizer.UPDATE_STATUS_REVIEW
		next.Version = 2
		next.SourceCount = 1
		next.ValidEvidenceCount = int64(len(events))
		next.FinalEventCount = int64(len(events))
		for _, event := range events {
			switch event.Status {
			case organizer.EVENT_STATUS_READY:
				next.ReadyEventCount++
			case organizer.EVENT_STATUS_NEEDS_ACTION:
				next.NeedsActionEventCount++
			case organizer.EVENT_STATUS_EXCLUDED:
				next.ExcludedEventCount++
			}
		}
		next.UpdatedUnixTime = 101
		updated, err := tx.UpdateUpdateCAS(1, &next)
		if err != nil || !updated {
			return fmt.Errorf("seed posting update CAS: updated=%t err=%w", updated, err)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("seed posting update: %v", err)
	}
}

func postingEvent(uid int64, updateId int64, eventId int64, status organizer.EventStatus, nature organizer.EconomicNature) *organizer.EconomicEvent {
	event := testEvent(uid, updateId, eventId, status, 100)
	event.EventKey = fmt.Sprintf("%064x", eventId)
	*event.EventUnixTime += eventId % 100
	event.EconomicNature = nature
	switch nature {
	case organizer.ECONOMIC_NATURE_INCOME, organizer.ECONOMIC_NATURE_REFUND:
		event.FlowDirection = organizer.FLOW_DIRECTION_INFLOW
	case organizer.ECONOMIC_NATURE_EXPENSE, organizer.ECONOMIC_NATURE_FEE:
		event.FlowDirection = organizer.FLOW_DIRECTION_OUTFLOW
	case organizer.ECONOMIC_NATURE_INTERNAL_TRANSFER, organizer.ECONOMIC_NATURE_REPAYMENT, organizer.ECONOMIC_NATURE_BORROW:
		event.FlowDirection = organizer.FLOW_DIRECTION_NEUTRAL
		counterparty := eventId + 100000
		event.CounterpartyLedgerAccountId = &counterparty
	case organizer.ECONOMIC_NATURE_UNKNOWN:
		event.FlowDirection = organizer.FLOW_DIRECTION_INFLOW
	default:
		event.FlowDirection = organizer.FLOW_DIRECTION_NEUTRAL
	}
	return event
}

func postingRefundRelation(uid int64, updateId int64, refund *organizer.EconomicEvent, original *organizer.EconomicEvent, relationId int64) *organizer.EconomicEventRelation {
	amount := *refund.Amount
	return &organizer.EconomicEventRelation{
		Uid: uid, UpdateId: updateId, RelationKey: fmt.Sprintf("%064x", relationId),
		RelationKeyVersion: organizer.RELATION_KEY_VERSION_V1, RelationType: organizer.RELATION_TYPE_REFUND_OF,
		Status: organizer.RELATION_STATUS_CONFIRMED, Version: 1, SourceEventId: refund.EventId, TargetEventId: original.EventId,
		Amount: &amount, Currency: refund.Currency, RuleVersion: organizer.PLAN_VERSION_V1, ReasonCodesJson: "[]",
		CreatedUnixTime: 100, UpdatedUnixTime: 100, RelationId: relationId,
	}
}

func assertPostingCounts(t *testing.T, database *datastore.Database, uid int64, transactionCount int64, linkCount int64, actionCount int64) {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	transactions, transactionErr := sess.Where("uid=?", uid).Count(new(models.Transaction))
	links, linkErr := sess.Where("uid=?", uid).Count(new(organizer.EconomicEventTransaction))
	actions, actionErr := sess.Where("uid=?", uid).Count(new(organizer.FinanceAction))
	if transactionErr != nil || linkErr != nil || actionErr != nil || transactions != transactionCount || links != linkCount || actions != actionCount {
		t.Fatalf("posting counts mismatch: transactions=%d links=%d actions=%d errors=%v/%v/%v", transactions, links, actions, transactionErr, linkErr, actionErr)
	}
}

type postingLedgerStub struct {
	mu      sync.Mutex
	next    int64
	calls   int
	failAt  int
	failure error
}

func (s *postingLedgerStub) CreateTransactionInSession(_ core.Context, _ *datastore.Database, sess *xorm.Session, draft *models.Transaction, _ []int64) (*models.Transaction, *models.Transaction, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.failAt > 0 && s.calls == s.failAt {
		return nil, nil, s.failure
	}
	s.next++
	primary := *draft
	latest := new(models.Transaction)
	found, findErr := sess.Where("uid=? AND transaction_time>=?", primary.Uid, primary.TransactionTime).OrderBy("transaction_time desc").Limit(1).Get(latest)
	if findErr != nil {
		return nil, nil, findErr
	}
	if found && latest.TransactionTime >= primary.TransactionTime {
		primary.TransactionTime = latest.TransactionTime + 1
	}
	primary.TransactionId = s.next
	primary.CreatedUnixTime = 200
	primary.UpdatedUnixTime = 200
	if primary.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT {
		s.next++
		primary.RelatedId = s.next
		counterpart := primary
		counterpart.TransactionId = primary.RelatedId
		counterpart.RelatedId = primary.TransactionId
		counterpart.Type = models.TRANSACTION_DB_TYPE_TRANSFER_IN
		counterpart.TransactionTime = primary.TransactionTime + 1
		counterpart.AccountId = primary.RelatedAccountId
		counterpart.RelatedAccountId = primary.AccountId
		if inserted, err := sess.Insert(&primary, &counterpart); err != nil || inserted != 2 {
			return nil, nil, fmt.Errorf("insert transfer ledger stub: inserted=%d err=%w", inserted, err)
		}
		return &primary, &counterpart, nil
	}
	if inserted, err := sess.Insert(&primary); err != nil || inserted != 1 {
		return nil, nil, fmt.Errorf("insert ledger stub: inserted=%d err=%w", inserted, err)
	}
	return &primary, nil, nil
}

func (s *postingLedgerStub) DeleteTransactionInSession(_ core.Context, _ *datastore.Database, sess *xorm.Session, uid int64, transactionId int64, expectedUpdatedUnixTime int64, relatedTransactionId int64, expectedRelatedUpdatedUnixTime int64, deletedUnixTime int64) (*models.Transaction, *models.Transaction, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	primary := new(models.Transaction)
	found, err := sess.Where("uid=? AND transaction_id=? AND deleted=?", uid, transactionId, false).Get(primary)
	if err != nil || !found || primary.UpdatedUnixTime != expectedUpdatedUnixTime {
		return nil, nil, errors.New("ledger deletion snapshot mismatch")
	}
	var counterpart *models.Transaction
	if relatedTransactionId > 0 {
		counterpart = new(models.Transaction)
		found, err = sess.Where("uid=? AND transaction_id=? AND deleted=?", uid, relatedTransactionId, false).Get(counterpart)
		if err != nil || !found || counterpart.UpdatedUnixTime != expectedRelatedUpdatedUnixTime || primary.RelatedId != counterpart.TransactionId || counterpart.RelatedId != primary.TransactionId {
			return nil, nil, errors.New("ledger transfer deletion snapshot mismatch")
		}
	} else if primary.RelatedId != 0 {
		return nil, nil, errors.New("ledger deletion omitted transfer counterpart")
	}
	ids := []int64{primary.TransactionId}
	if counterpart != nil {
		ids = append(ids, counterpart.TransactionId)
	}
	updated, err := sess.Where("uid=? AND deleted=?", uid, false).In("transaction_id", ids).
		Cols("deleted", "deleted_unix_time").Update(&models.Transaction{Deleted: true, DeletedUnixTime: deletedUnixTime})
	if err != nil || updated != int64(len(ids)) {
		return nil, nil, fmt.Errorf("soft delete ledger stub: updated=%d err=%w", updated, err)
	}
	return primary, counterpart, nil
}
