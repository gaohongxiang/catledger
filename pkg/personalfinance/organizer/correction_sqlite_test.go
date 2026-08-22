package organizer_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/organizer"
)

func TestCorrectionEngineSQLiteResolvesOneEventAndReplays(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const uid = int64(10101)
	const updateId = int64(10201)
	event := postingEvent(uid, updateId, 10301, organizer.EVENT_STATUS_NEEDS_ACTION, organizer.ECONOMIC_NATURE_UNKNOWN)
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{event})
	engine, err := organizer.NewCorrectionEngine(repository, &engineIdGenerator{next: 10400})
	if err != nil {
		t.Fatalf("create correction engine: %v", err)
	}
	request := organizer.CorrectEventRequest{
		Uid: uid, UpdateId: updateId, EventId: event.EventId, ExpectedUpdateVersion: 2, ExpectedEventVersion: 1,
		IdempotencyKey: "resolve-event-10301",
		Correction: organizer.EventCorrection{
			FieldMask: organizer.MANUAL_FIELD_STATUS | organizer.MANUAL_FIELD_FLOW_DIRECTION | organizer.MANUAL_FIELD_ECONOMIC_NATURE,
			Status:    organizer.EVENT_STATUS_READY, FlowDirection: organizer.FLOW_DIRECTION_INFLOW, EconomicNature: organizer.ECONOMIC_NATURE_INCOME,
		},
	}
	result, err := engine.Correct(nil, request)
	if err != nil || result == nil || result.Replayed || result.Update.Version != 3 || result.Update.ReadyEventCount != 1 ||
		result.Update.NeedsActionEventCount != 0 || result.Event.Version != 2 || result.Event.Status != organizer.EVENT_STATUS_READY ||
		result.Event.EconomicNature != organizer.ECONOMIC_NATURE_INCOME || result.Event.ManualFieldMask != request.Correction.FieldMask ||
		!strings.Contains(result.Event.FieldSourcesJson, "action:") || result.Action.Status != organizer.ACTION_STATUS_APPLIED {
		t.Fatalf("resolved correction mismatch: result=%+v err=%v", result, err)
	}
	replayed, err := engine.Correct(nil, request)
	if err != nil || replayed == nil || !replayed.Replayed || replayed.Action.ActionId != result.Action.ActionId || replayed.Event.Version != 2 {
		t.Fatalf("correction replay mismatch: result=%+v err=%v", replayed, err)
	}
	_, err = engine.Correct(nil, organizer.CorrectEventRequest{
		Uid: uid, UpdateId: updateId, EventId: event.EventId, ExpectedUpdateVersion: 2, ExpectedEventVersion: 1,
		IdempotencyKey: "stale-correction", Correction: request.Correction,
	})
	if !errors.Is(err, organizer.ErrCorrectionUpdateConflict) {
		t.Fatalf("stale correction was accepted: %v", err)
	}
}

func TestCorrectionEngineSQLiteExcludesNeedsActionEventWithoutTouchingOthers(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const uid = int64(10102)
	const updateId = int64(10202)
	first := postingEvent(uid, updateId, 10311, organizer.EVENT_STATUS_NEEDS_ACTION, organizer.ECONOMIC_NATURE_UNKNOWN)
	second := postingEvent(uid, updateId, 10312, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_EXPENSE)
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{first, second})
	engine, _ := organizer.NewCorrectionEngine(repository, &engineIdGenerator{next: 10410})
	result, err := engine.Correct(nil, organizer.CorrectEventRequest{
		Uid: uid, UpdateId: updateId, EventId: first.EventId, ExpectedUpdateVersion: 2, ExpectedEventVersion: 1,
		IdempotencyKey: "exclude-first", Correction: organizer.EventCorrection{FieldMask: organizer.MANUAL_FIELD_STATUS, Status: organizer.EVENT_STATUS_EXCLUDED},
	})
	if err != nil || result.Update.ReadyEventCount != 1 || result.Update.NeedsActionEventCount != 0 || result.Update.ExcludedEventCount != 1 || result.Event.Status != organizer.EVENT_STATUS_EXCLUDED {
		t.Fatalf("exclude correction mismatch: result=%+v err=%v", result, err)
	}
	unchanged, err := repository.FindEventById(nil, uid, second.EventId)
	if err != nil || unchanged == nil || unchanged.Status != organizer.EVENT_STATUS_READY || unchanged.Version != 1 || unchanged.ManualFieldMask != 0 {
		t.Fatalf("unrelated event changed: event=%+v err=%v", unchanged, err)
	}
}

func TestCorrectionEngineSQLiteRequiresSafeRebuildForPostedEvent(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	if err := database.SyncStructs(new(models.Transaction)); err != nil {
		t.Fatalf("create correction ledger table: %v", err)
	}
	const uid = int64(10103)
	const updateId = int64(10203)
	event := postingEvent(uid, updateId, 10321, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_EXPENSE)
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{event})
	ids := &engineIdGenerator{next: 10420}
	posting, _ := organizer.NewPostingEngine(repository, &postingLedgerStub{next: 10500}, ids)
	posted, err := posting.Post(nil, organizer.PostRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 2, IdempotencyKey: "posted-correction-fixture", Mode: organizer.POST_MODE_ALL_READY})
	if err != nil {
		t.Fatalf("post correction fixture: %v", err)
	}
	engine, _ := organizer.NewCorrectionEngine(repository, ids)
	categoryId := int64(99)
	_, err = engine.Correct(nil, organizer.CorrectEventRequest{
		Uid: uid, UpdateId: updateId, EventId: event.EventId, ExpectedUpdateVersion: posted.Update.Version, ExpectedEventVersion: 2,
		IdempotencyKey: "posted-correction", Correction: organizer.EventCorrection{FieldMask: organizer.MANUAL_FIELD_CATEGORY, CategoryId: &categoryId},
	})
	if !errors.Is(err, organizer.ErrCorrectionPostedRequiresRebuild) {
		t.Fatalf("posted correction bypassed safe rebuild: %v", err)
	}
}
