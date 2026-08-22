package organizer_test

import (
	"errors"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/organizer"
)

func TestRebuildEngineSQLiteReplacesPostedTransactionAndPreservesHistory(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	if err := database.SyncStructs(new(models.Transaction)); err != nil {
		t.Fatalf("create rebuild ledger table: %v", err)
	}
	const uid = int64(11101)
	const updateId = int64(11201)
	event := postingEvent(uid, updateId, 11301, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_EXPENSE)
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{event})
	ledger := &postingLedgerStub{next: 11400}
	ids := &engineIdGenerator{next: 11500}
	posting, _ := organizer.NewPostingEngine(repository, ledger, ids)
	posted, err := posting.Post(nil, organizer.PostRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 2, IdempotencyKey: "rebuild-fixture-post", Mode: organizer.POST_MODE_ALL_READY})
	if err != nil {
		t.Fatalf("post rebuild fixture: %v", err)
	}
	rebuild, err := organizer.NewRebuildEngine(repository, ledger, ids)
	if err != nil {
		t.Fatalf("create rebuild engine: %v", err)
	}
	impact, err := rebuild.Inspect(nil, uid, updateId, event.EventId)
	if err != nil || impact == nil || !impact.CanUndo || impact.TransactionCount != 1 {
		t.Fatalf("rebuild impact mismatch: impact=%+v err=%v", impact, err)
	}
	categoryId := int64(77)
	request := organizer.CorrectEventRequest{
		Uid: uid, UpdateId: updateId, EventId: event.EventId, ExpectedUpdateVersion: posted.Update.Version, ExpectedEventVersion: 2,
		IdempotencyKey: "rebuild-category", Correction: organizer.EventCorrection{FieldMask: organizer.MANUAL_FIELD_CATEGORY, CategoryId: &categoryId},
	}
	result, err := rebuild.Rebuild(nil, request)
	if err != nil || result == nil || result.Replayed || result.Update.Status != organizer.UPDATE_STATUS_POSTED || result.Update.Version != 5 ||
		result.Event.Status != organizer.EVENT_STATUS_POSTED || result.Event.Version != 3 || result.Event.CategoryId == nil || *result.Event.CategoryId != categoryId {
		t.Fatalf("rebuild result mismatch: result=%+v err=%v", result, err)
	}
	links, err := repository.ListEventTransactions(nil, uid, event.EventId)
	if err != nil || len(links) != 2 || links[0].Role != organizer.EVENT_TRANSACTION_ROLE_HISTORICAL_PRIMARY || links[1].Role != organizer.EVENT_TRANSACTION_ROLE_PRIMARY {
		t.Fatalf("rebuild link history mismatch: links=%+v err=%v", links, err)
	}
	assertTransactionLifecycleCounts(t, database, uid, 1, 1)
	replayed, err := rebuild.Rebuild(nil, request)
	if err != nil || replayed == nil || !replayed.Replayed || replayed.Action.ActionId != result.Action.ActionId {
		t.Fatalf("rebuild replay mismatch: result=%+v err=%v", replayed, err)
	}
	undo, _ := organizer.NewUndoEngine(repository, ledger, ids)
	afterImpact, err := undo.Inspect(nil, uid, updateId)
	if err != nil || afterImpact == nil || !afterImpact.CanUndo || afterImpact.TransactionCount != 1 {
		t.Fatalf("rebuild left undo unsafe: impact=%+v err=%v", afterImpact, err)
	}
}

func TestRebuildEngineSQLiteBlocksExternallyModifiedTransaction(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	if err := database.SyncStructs(new(models.Transaction)); err != nil {
		t.Fatalf("create blocked rebuild ledger table: %v", err)
	}
	const uid = int64(11102)
	const updateId = int64(11202)
	event := postingEvent(uid, updateId, 11311, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_EXPENSE)
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{event})
	ledger := &postingLedgerStub{next: 11410}
	ids := &engineIdGenerator{next: 11510}
	posting, _ := organizer.NewPostingEngine(repository, ledger, ids)
	posted, err := posting.Post(nil, organizer.PostRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 2, IdempotencyKey: "blocked-rebuild-post", Mode: organizer.POST_MODE_ALL_READY})
	if err != nil {
		t.Fatalf("post blocked rebuild fixture: %v", err)
	}
	sess := database.NewPrivacySession(nil)
	updated, updateErr := sess.Where("uid=?", uid).Cols("updated_unix_time").Update(&models.Transaction{UpdatedUnixTime: 201})
	sess.Close()
	if updateErr != nil || updated != 1 {
		t.Fatalf("modify rebuild fixture: updated=%d err=%v", updated, updateErr)
	}
	rebuild, _ := organizer.NewRebuildEngine(repository, ledger, ids)
	categoryId := int64(88)
	_, err = rebuild.Rebuild(nil, organizer.CorrectEventRequest{
		Uid: uid, UpdateId: updateId, EventId: event.EventId, ExpectedUpdateVersion: posted.Update.Version, ExpectedEventVersion: 2,
		IdempotencyKey: "blocked-rebuild", Correction: organizer.EventCorrection{FieldMask: organizer.MANUAL_FIELD_CATEGORY, CategoryId: &categoryId},
	})
	if !errors.Is(err, organizer.ErrRebuildActionRequired) {
		t.Fatalf("modified transaction rebuild was not blocked: %v", err)
	}
	current, findErr := repository.FindEventById(nil, uid, event.EventId)
	if findErr != nil || current == nil || current.Version != 2 || current.CategoryId != nil || current.Status != organizer.EVENT_STATUS_POSTED {
		t.Fatalf("blocked rebuild changed event: event=%+v err=%v", current, findErr)
	}
	assertTransactionLifecycleCounts(t, database, uid, 1, 0)
}

func assertTransactionLifecycleCounts(t *testing.T, database *datastore.Database, uid int64, activeWant int64, deletedWant int64) {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	active, activeErr := sess.Where("uid=? AND deleted=?", uid, false).Count(new(models.Transaction))
	deleted, deletedErr := sess.Where("uid=? AND deleted=?", uid, true).Count(new(models.Transaction))
	if activeErr != nil || deletedErr != nil || active != activeWant || deleted != deletedWant {
		t.Fatalf("transaction lifecycle mismatch: active=%d/%d deleted=%d/%d errors=%v/%v", active, activeWant, deleted, deletedWant, activeErr, deletedErr)
	}
}
