package organizer_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/organizer"
)

func TestCorrectionEngineSQLiteLearnsCategoryAliasesFromImmutableEvidence(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const uid = int64(10100)
	const updateId = int64(10200)
	const eventId = int64(10300)
	const rowId = int64(10600)
	event := postingEvent(uid, updateId, eventId, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_EXPENSE)
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{event})
	if err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		return tx.InsertEvidence(&organizer.EconomicEventEvidence{Uid: uid, UpdateId: updateId, EventId: eventId, RowId: rowId, EvidenceRole: organizer.EVIDENCE_ROLE_PRIMARY, CreatedUnixTime: 102, EvidenceId: 10700})
	}); err != nil {
		t.Fatalf("seed category evidence: %v", err)
	}
	batchId := updateId + 300
	evidence := &engineEvidenceStub{rows: map[int64][]*importing.RawImportRow{
		batchId: {{Uid: uid, BatchId: batchId, RowId: rowId, RawTransactionType: "餐饮美食", RawCounterparty: "美团平台商户", RawItem: "外卖订单"}},
	}}
	engine, err := organizer.NewCorrectionEngine(repository, &engineIdGenerator{next: 10800}, evidence)
	if err != nil {
		t.Fatalf("create category correction engine: %v", err)
	}
	categoryId := int64(10900)
	result, err := engine.Correct(nil, organizer.CorrectEventRequest{
		Uid: uid, UpdateId: updateId, EventId: eventId, ExpectedUpdateVersion: 2, ExpectedEventVersion: 1,
		IdempotencyKey: "learn-category-aliases", Correction: organizer.EventCorrection{FieldMask: organizer.MANUAL_FIELD_CATEGORY, CategoryId: &categoryId},
	})
	if err != nil || result == nil || result.Event.CategoryId == nil || *result.Event.CategoryId != categoryId {
		t.Fatalf("category correction mismatch: result=%+v err=%v", result, err)
	}
	aliases, err := repository.ListCategoryAliases(nil, uid)
	if err != nil || len(aliases) != 3 {
		t.Fatalf("category aliases mismatch: aliases=%+v err=%v", aliases, err)
	}
	for _, alias := range aliases {
		if alias.SourceType != importing.SOURCE_TYPE_ALIPAY || alias.LedgerCategoryId != categoryId || alias.AliasKeyVersion != organizer.CATEGORY_ALIAS_VERSION_V1 {
			t.Fatalf("unexpected category alias: %+v", alias)
		}
	}
}

func TestCorrectionEngineSQLiteCategorizesMatchingUncategorizedEventsAtomically(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const uid = int64(10110)
	const updateId = int64(10210)
	first := postingEvent(uid, updateId, 10310, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_EXPENSE)
	second := postingEvent(uid, updateId, 10311, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_EXPENSE)
	third := postingEvent(uid, updateId, 10312, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_EXPENSE)
	firstAmount, secondAmount := int64(5777), int64(5668)
	first.Amount, second.Amount = &firstAmount, &secondAmount
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{first, second, third})
	if err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		for index, event := range []*organizer.EconomicEvent{first, second, third} {
			if err := tx.InsertEvidence(&organizer.EconomicEventEvidence{
				Uid: uid, UpdateId: updateId, EventId: event.EventId, RowId: 10610 + int64(index),
				EvidenceRole: organizer.EVIDENCE_ROLE_PRIMARY, CreatedUnixTime: 102, EvidenceId: 10710 + int64(index),
			}); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatalf("seed batch category evidence: %v", err)
	}
	batchId := updateId + 300
	evidence := &engineEvidenceStub{rows: map[int64][]*importing.RawImportRow{
		batchId: {
			{Uid: uid, BatchId: batchId, RowId: 10610, RawTransactionType: "商户消费", RawCounterparty: "美团平台商户", RawItem: "订单甲"},
			{Uid: uid, BatchId: batchId, RowId: 10611, RawTransactionType: "商户消费", RawCounterparty: "美团平台商户", RawItem: "订单乙"},
			{Uid: uid, BatchId: batchId, RowId: 10612, RawTransactionType: "商户消费", RawCounterparty: "另一商户", RawItem: "订单丙"},
		},
	}}
	engine, err := organizer.NewCorrectionEngine(repository, &engineIdGenerator{next: 10810}, evidence)
	if err != nil {
		t.Fatalf("create batch category correction engine: %v", err)
	}
	preview, err := engine.InspectCategoryCorrectionScope(nil, uid, updateId, first.EventId)
	if err != nil || preview == nil || preview.MatchingEventCount != 2 {
		t.Fatalf("batch category preview mismatch: preview=%+v err=%v", preview, err)
	}
	singlePreview, err := engine.InspectCategoryCorrectionScope(nil, uid, updateId, third.EventId)
	if err != nil || singlePreview == nil || singlePreview.MatchingEventCount != 1 {
		t.Fatalf("single category preview mismatch: preview=%+v err=%v", singlePreview, err)
	}
	categoryId := int64(10910)
	result, err := engine.Correct(nil, organizer.CorrectEventRequest{
		Uid: uid, UpdateId: updateId, EventId: first.EventId, ExpectedUpdateVersion: 2, ExpectedEventVersion: 1,
		IdempotencyKey: "batch-category-aliases", CategoryScope: organizer.CATEGORY_CORRECTION_SCOPE_MATCHING_UNCATEGORIZED,
		Correction: organizer.EventCorrection{FieldMask: organizer.MANUAL_FIELD_CATEGORY, CategoryId: &categoryId},
	})
	if err != nil || result == nil || len(result.Events) != 2 || result.Update.Version != 3 || result.Update.ReadyEventCount != 3 {
		t.Fatalf("batch category correction mismatch: result=%+v err=%v", result, err)
	}
	for _, eventId := range []int64{first.EventId, second.EventId} {
		event, findErr := repository.FindEventById(nil, uid, eventId)
		if findErr != nil || event == nil || event.CategoryId == nil || *event.CategoryId != categoryId || event.Version != 2 {
			t.Fatalf("matching event was not categorized: event=%+v err=%v", event, findErr)
		}
	}
	unchanged, err := repository.FindEventById(nil, uid, third.EventId)
	if err != nil || unchanged == nil || unchanged.CategoryId != nil || unchanged.Version != 1 {
		t.Fatalf("unrelated event changed: event=%+v err=%v", unchanged, err)
	}
}

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
	expectedManualMask := organizer.MANUAL_FIELD_FLOW_DIRECTION | organizer.MANUAL_FIELD_ECONOMIC_NATURE
	if err != nil || result == nil || result.Replayed || result.Update.Version != 3 || result.Update.ReadyEventCount != 1 ||
		result.Update.NeedsActionEventCount != 0 || result.Event.Version != 2 || result.Event.Status != organizer.EVENT_STATUS_READY ||
		result.Event.EconomicNature != organizer.ECONOMIC_NATURE_INCOME || result.Event.ManualFieldMask != expectedManualMask ||
		!strings.Contains(result.Event.FieldSourcesJson, "action:") || strings.Contains(result.Event.FieldSourcesJson, "\"status\"") ||
		result.Action.Status != organizer.ACTION_STATUS_APPLIED {
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

func TestCorrectionEngineSQLiteAllowsExplicitUnlinkedRefund(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const uid = int64(10104)
	const updateId = int64(10204)
	event := postingEvent(uid, updateId, 10331, organizer.EVENT_STATUS_NEEDS_ACTION, organizer.ECONOMIC_NATURE_UNKNOWN)
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{event})
	engine, _ := organizer.NewCorrectionEngine(repository, &engineIdGenerator{next: 10430})
	result, err := engine.Correct(nil, organizer.CorrectEventRequest{
		Uid: uid, UpdateId: updateId, EventId: event.EventId, ExpectedUpdateVersion: 2, ExpectedEventVersion: 1,
		IdempotencyKey: "refund-without-relation",
		Correction: organizer.EventCorrection{
			FieldMask: organizer.MANUAL_FIELD_STATUS | organizer.MANUAL_FIELD_FLOW_DIRECTION | organizer.MANUAL_FIELD_ECONOMIC_NATURE,
			Status:    organizer.EVENT_STATUS_READY, FlowDirection: organizer.FLOW_DIRECTION_INFLOW, EconomicNature: organizer.ECONOMIC_NATURE_REFUND,
		},
	})
	if err != nil || result == nil || result.Event.Status != organizer.EVENT_STATUS_READY ||
		result.Update.ReadyEventCount != 1 || result.Update.NeedsActionEventCount != 0 ||
		strings.Contains(result.Event.ReasonCodesJson, "refund_relation_required") {
		t.Fatalf("explicit unlinked refund was rejected: result=%+v err=%v", result, err)
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
