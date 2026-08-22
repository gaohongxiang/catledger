package organizer_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/organizer"
)

func TestUndoEngineSQLiteInspectsAndReversesAtomically(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	if err := database.SyncStructs(new(models.Transaction)); err != nil {
		t.Fatalf("create undo ledger table: %v", err)
	}
	const uid = int64(9601)
	const updateId = int64(9701)
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{
		postingEvent(uid, updateId, 9711, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_EXPENSE),
		postingEvent(uid, updateId, 9712, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_REFUND),
	})
	ledger := &postingLedgerStub{next: 9800}
	ids := &engineIdGenerator{next: 9900}
	posting, err := organizer.NewPostingEngine(repository, ledger, ids)
	if err != nil {
		t.Fatalf("create posting engine for undo: %v", err)
	}
	posted, err := posting.Post(nil, organizer.PostRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 2, IdempotencyKey: "undo-fixture-post", Mode: organizer.POST_MODE_ALL_READY})
	if err != nil {
		t.Fatalf("post undo fixture: %v", err)
	}
	undo, err := organizer.NewUndoEngine(repository, ledger, ids)
	if err != nil {
		t.Fatalf("create undo engine: %v", err)
	}
	impact, err := undo.Inspect(nil, uid, updateId)
	if err != nil || impact == nil || !impact.CanUndo || impact.PostedEventCount != 2 || impact.TransactionCount != 2 || len(impact.ReasonCodes) != 0 {
		t.Fatalf("safe undo impact mismatch: impact=%+v err=%v", impact, err)
	}
	request := organizer.UndoRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: posted.Update.Version, IdempotencyKey: "undo-safe"}
	result, err := undo.Undo(nil, request)
	if err != nil || result == nil || result.Replayed || result.Update.Status != organizer.UPDATE_STATUS_UNDONE ||
		result.Update.PostedEventCount != 0 || result.Update.ReadyEventCount != 2 || result.Action.Status != organizer.ACTION_STATUS_APPLIED {
		t.Fatalf("safe undo result mismatch: result=%+v err=%v", result, err)
	}
	events, err := repository.ListEvents(nil, uid, updateId)
	if err != nil || len(events) != 2 || events[0].Status != organizer.EVENT_STATUS_READY || events[1].Status != organizer.EVENT_STATUS_READY {
		t.Fatalf("undone event state mismatch: events=%+v err=%v", events, err)
	}
	assertDeletedTransactionCount(t, database, uid, 2)
	replayed, err := undo.Undo(nil, request)
	if err != nil || replayed == nil || !replayed.Replayed || replayed.Action.ActionId != result.Action.ActionId {
		t.Fatalf("undo replay mismatch: result=%+v err=%v", replayed, err)
	}
}

func TestUndoEngineSQLiteBlocksModifiedTransactionsAndPersistsImpactAction(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	if err := database.SyncStructs(new(models.Transaction)); err != nil {
		t.Fatalf("create blocked undo ledger table: %v", err)
	}
	const uid = int64(9602)
	const updateId = int64(9702)
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{
		postingEvent(uid, updateId, 9721, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_EXPENSE),
	})
	ledger := &postingLedgerStub{next: 9810}
	ids := &engineIdGenerator{next: 9910}
	posting, _ := organizer.NewPostingEngine(repository, ledger, ids)
	posted, err := posting.Post(nil, organizer.PostRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 2, IdempotencyKey: "blocked-undo-post", Mode: organizer.POST_MODE_ALL_READY})
	if err != nil {
		t.Fatalf("post blocked undo fixture: %v", err)
	}
	sess := database.NewPrivacySession(nil)
	updated, updateErr := sess.Where("uid=?", uid).Cols("updated_unix_time").Update(&models.Transaction{UpdatedUnixTime: 201})
	sess.Close()
	if updateErr != nil || updated != 1 {
		t.Fatalf("modify undo fixture transaction: updated=%d err=%v", updated, updateErr)
	}
	undo, _ := organizer.NewUndoEngine(repository, ledger, ids)
	impact, err := undo.Inspect(nil, uid, updateId)
	if err != nil || impact == nil || impact.CanUndo || impact.ModifiedTransactionCount != 1 || !strings.Contains(strings.Join(impact.ReasonCodes, ","), organizer.UNDO_REASON_TRANSACTION_MODIFIED) {
		t.Fatalf("modified undo impact mismatch: impact=%+v err=%v", impact, err)
	}
	_, err = undo.Undo(nil, organizer.UndoRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: posted.Update.Version, IdempotencyKey: "blocked-undo"})
	if !errors.Is(err, organizer.ErrUndoActionRequired) {
		t.Fatalf("modified transaction undo was not blocked: %v", err)
	}
	update, findErr := repository.FindUpdateById(nil, uid, updateId)
	if findErr != nil || update == nil || update.Status != organizer.UPDATE_STATUS_POSTED || update.Version != posted.Update.Version {
		t.Fatalf("blocked undo changed update: update=%+v err=%v", update, findErr)
	}
	sess = database.NewPrivacySession(nil)
	action := new(organizer.FinanceAction)
	found, actionErr := sess.Where("uid=? AND action_type=?", uid, organizer.ACTION_TYPE_UNDO).Get(action)
	sess.Close()
	if actionErr != nil || !found || action.Status != organizer.ACTION_STATUS_ACTION_REQUIRED || !strings.Contains(action.ReasonCodesJson, organizer.UNDO_REASON_TRANSACTION_MODIFIED) {
		t.Fatalf("blocked undo action mismatch: action=%+v found=%t err=%v", action, found, actionErr)
	}
	assertDeletedTransactionCount(t, database, uid, 0)
}

func assertDeletedTransactionCount(t *testing.T, database *datastore.Database, uid int64, want int64) {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	count, err := sess.Where("uid=? AND deleted=?", uid, true).Count(new(models.Transaction))
	if err != nil || count != want {
		t.Fatalf("deleted transaction count mismatch: count=%d want=%d err=%v", count, want, err)
	}
}
