package organizer_test

import (
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/migrations"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/organizer"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

func TestRepositorySQLiteUIDIsolationCASAndRollback(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const firstUid = int64(1001)
	const secondUid = int64(2002)

	if err := repository.DoTransaction(nil, firstUid, func(tx *organizer.RepositoryTransaction) error {
		if err := tx.InsertUpdate(testUpdate(firstUid, 101, 10)); err != nil {
			return err
		}
		if err := tx.InsertSource(testSource(firstUid, 101, 201, 301, 401, 10)); err != nil {
			return err
		}
		if err := tx.InsertEvent(testEvent(firstUid, 101, 501, organizer.EVENT_STATUS_READY, 10)); err != nil {
			return err
		}
		if err := tx.InsertEvidence(&organizer.EconomicEventEvidence{
			Uid: firstUid, UpdateId: 101, EventId: 501, RowId: 601, EvidenceRole: organizer.EVIDENCE_ROLE_PRIMARY,
			CreatedUnixTime: 10, EvidenceId: 701,
		}); err != nil {
			return err
		}
		current, err := tx.FindUpdateById(101)
		if err != nil || current == nil {
			return errors.New("inserted update is missing")
		}
		next := *current
		next.Status = organizer.UPDATE_STATUS_REVIEW
		next.Version = 2
		next.SourceCount = 1
		next.ValidEvidenceCount = 1
		next.FinalEventCount = 1
		next.ReadyEventCount = 1
		next.UpdatedUnixTime = 11
		updated, err := tx.UpdateUpdateCAS(1, &next)
		if err != nil || !updated {
			return errors.New("update CAS failed")
		}
		updated, err = tx.UpdateUpdateCAS(1, &next)
		if err != nil || updated {
			return errors.New("stale update CAS succeeded")
		}
		return nil
	}); err != nil {
		t.Fatalf("persist organizer graph: %v", err)
	}

	if err := repository.DoTransaction(nil, secondUid, func(tx *organizer.RepositoryTransaction) error {
		return tx.InsertUpdate(testUpdate(secondUid, 201, 20))
	}); err != nil {
		t.Fatalf("persist second user update: %v", err)
	}

	update, err := repository.FindUpdateById(nil, firstUid, 101)
	if err != nil || update == nil || update.Status != organizer.UPDATE_STATUS_REVIEW || update.ReadyEventCount != 1 {
		t.Fatalf("owned update mismatch: update=%+v err=%v", update, err)
	}
	foreign, err := repository.FindUpdateById(nil, firstUid, 201)
	if err != nil || foreign != nil {
		t.Fatalf("cross-user update was visible: update=%+v err=%v", foreign, err)
	}
	events, err := repository.ListEvents(nil, firstUid, 101)
	if err != nil || len(events) != 1 || events[0].EventId != 501 {
		t.Fatalf("event list mismatch: events=%+v err=%v", events, err)
	}
	evidence, err := repository.ListEvidence(nil, firstUid, 501)
	if err != nil || len(evidence) != 1 || evidence[0].RowId != 601 {
		t.Fatalf("evidence list mismatch: evidence=%+v err=%v", evidence, err)
	}
	batchedEvidence, err := repository.ListEvidenceForEvents(nil, firstUid, []int64{501})
	if err != nil || len(batchedEvidence) != 1 || batchedEvidence[0].RowId != 601 {
		t.Fatalf("batched evidence list mismatch: evidence=%+v err=%v", batchedEvidence, err)
	}
	foreignEvidence, err := repository.ListEvidenceForEvents(nil, secondUid, []int64{501})
	if err != nil || len(foreignEvidence) != 0 {
		t.Fatalf("cross-user batched evidence was visible: evidence=%+v err=%v", foreignEvidence, err)
	}

	rollbackCause := errors.New("rollback organizer transaction")
	err = repository.DoTransaction(nil, firstUid, func(tx *organizer.RepositoryTransaction) error {
		if err := tx.InsertUpdate(testUpdate(firstUid, 999, 30)); err != nil {
			return err
		}
		return rollbackCause
	})
	if !errors.Is(err, rollbackCause) {
		t.Fatalf("rollback cause mismatch: %v", err)
	}
	if update, findErr := repository.FindUpdateById(nil, firstUid, 999); findErr != nil || update != nil {
		t.Fatalf("rolled-back update remained visible: update=%+v err=%v", update, findErr)
	}
}

func TestRepositorySQLiteActionIdempotencyAndConservation(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const uid = int64(3003)
	if err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		return tx.InsertUpdate(testUpdate(uid, 301, 10))
	}); err != nil {
		t.Fatalf("insert action update: %v", err)
	}

	action := testAction(uid, 301, 401, strings.Repeat("a", 64), strings.Repeat("b", 64), 11)
	persisted, created, err := repository.CreateOrFindAction(nil, action)
	if err != nil || !created || persisted.ActionId != 401 {
		t.Fatalf("create action mismatch: action=%+v created=%t err=%v", persisted, created, err)
	}
	persisted, created, err = repository.CreateOrFindAction(nil, testAction(uid, 301, 402, strings.Repeat("a", 64), strings.Repeat("b", 64), 12))
	if err != nil || created || persisted.ActionId != 401 {
		t.Fatalf("idempotent action mismatch: action=%+v created=%t err=%v", persisted, created, err)
	}
	_, _, err = repository.CreateOrFindAction(nil, testAction(uid, 301, 403, strings.Repeat("a", 64), strings.Repeat("c", 64), 13))
	if !errors.Is(err, organizer.ErrActionRequestConflict) {
		t.Fatalf("same action key with different request was accepted: %v", err)
	}

	err = repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		current, findErr := tx.FindUpdateById(301)
		if findErr != nil || current == nil {
			return errors.New("action update is missing")
		}
		next := *current
		next.Status = organizer.UPDATE_STATUS_REVIEW
		next.Version = 2
		next.ValidEvidenceCount = 1
		next.FinalEventCount = 2
		next.ReadyEventCount = 2
		next.UpdatedUnixTime = 12
		if _, updateErr := tx.UpdateUpdateCAS(1, &next); updateErr == nil {
			return errors.New("invalid conservation counts were accepted")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("conservation validation failed: %v", err)
	}
}

func TestRepositorySQLiteEventPageUsesStableStatusCursor(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const uid = int64(4004)
	if err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		if err := tx.InsertUpdate(testUpdate(uid, 401, 10)); err != nil {
			return err
		}
		for index, spec := range []struct {
			id     int64
			status organizer.EventStatus
			now    int64
			key    byte
		}{{501, organizer.EVENT_STATUS_READY, 10, 'a'}, {502, organizer.EVENT_STATUS_NEEDS_ACTION, 20, 'b'}, {503, organizer.EVENT_STATUS_READY, 30, 'c'}} {
			event := testEvent(uid, 401, spec.id, spec.status, spec.now)
			event.EventKey = strings.Repeat(string(spec.key), 64)
			if err := tx.InsertEvent(event); err != nil {
				return errors.New("insert paged event " + strconv.Itoa(index))
			}
		}
		return nil
	}); err != nil {
		t.Fatalf("seed event page: %v", err)
	}
	first, err := repository.ListEventsPage(nil, uid, 401, organizer.EVENT_STATUS_READY, nil, 1)
	if err != nil || len(first.Items) != 1 || first.Items[0].EventId != 503 || first.NextCursor == nil {
		t.Fatalf("first event page mismatch: page=%+v err=%v", first, err)
	}
	second, err := repository.ListEventsPage(nil, uid, 401, organizer.EVENT_STATUS_READY, first.NextCursor, 1)
	if err != nil || len(second.Items) != 1 || second.Items[0].EventId != 501 || second.NextCursor != nil {
		t.Fatalf("second event page mismatch: page=%+v err=%v", second, err)
	}
}

func newSQLiteOrganizerRepository(t *testing.T) (*organizer.Repository, *datastore.Database) {
	t.Helper()
	database, err := datastore.OpenDatabase(&settings.DatabaseConfig{
		DatabaseType:          settings.Sqlite3DbType,
		DatabasePath:          filepath.Join(t.TempDir(), "organizer.db"),
		MaxIdleConnection:     1,
		MaxOpenConnection:     4,
		ConnectionMaxLifeTime: 60,
	})
	if err != nil {
		t.Fatalf("open SQLite organizer database: %v", err)
	}
	t.Cleanup(func() {
		if closeErr := database.Close(); closeErr != nil {
			t.Errorf("close SQLite organizer database: %v", closeErr)
		}
	})
	store, err := datastore.NewDataStore(database)
	if err != nil {
		t.Fatalf("create SQLite organizer store: %v", err)
	}
	if err = migrations.Upgrade(nil, store, migrations.ApplicationInfo{Version: "test", Commit: "pfv2-1601"}); err != nil {
		t.Fatalf("upgrade SQLite organizer schema: %v", err)
	}
	repository, err := organizer.NewRepository(store)
	if err != nil {
		t.Fatalf("create organizer repository: %v", err)
	}
	return repository, database
}

func testUpdate(uid int64, updateId int64, now int64) *organizer.FinanceUpdate {
	return &organizer.FinanceUpdate{
		Uid: uid, Status: organizer.UPDATE_STATUS_DRAFT, Version: 1, PlanVersion: organizer.PLAN_VERSION_V1,
		CreatedUnixTime: now, UpdatedUnixTime: now, UpdateId: updateId,
	}
}

func testSource(uid int64, updateId int64, sourceId int64, fileId int64, batchId int64, now int64) *organizer.FinanceUpdateSource {
	return &organizer.FinanceUpdateSource{
		Uid: uid, UpdateId: updateId, FileId: fileId, BatchId: batchId, SourceTypeSnapshot: "alipay",
		ParserVersion: "parser-v1", NormalizationVersion: "normalization-v1", IdentityKeyVersion: "identity-v1",
		CreatedUnixTime: now, SourceId: sourceId,
	}
}

func testEvent(uid int64, updateId int64, eventId int64, status organizer.EventStatus, now int64) *organizer.EconomicEvent {
	accountId := int64(801)
	eventTime := int64(900)
	offset := int16(480)
	amount := int64(1234)
	return &organizer.EconomicEvent{
		Uid: uid, UpdateId: updateId, EventKey: strings.Repeat("d", 64), EventKeyVersion: organizer.EVENT_KEY_VERSION_V1,
		Status: status, Version: 1, FlowDirection: organizer.FLOW_DIRECTION_OUTFLOW, EconomicNature: organizer.ECONOMIC_NATURE_EXPENSE,
		LedgerAccountId: &accountId, EventUnixTime: &eventTime, TimezoneUtcOffset: &offset, Amount: &amount, Currency: "CNY",
		RuleVersion: organizer.PLAN_VERSION_V1, FieldSourcesJson: "{}", ReasonCodesJson: "[]",
		CreatedUnixTime: now, UpdatedUnixTime: now, EventId: eventId,
	}
}

func testAction(uid int64, updateId int64, actionId int64, keyDigest string, requestDigest string, now int64) *organizer.FinanceAction {
	return &organizer.FinanceAction{
		Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 1, ActionType: organizer.ACTION_TYPE_ORGANIZE,
		IdempotencyKeyDigest: keyDigest, IdempotencyKeyVersion: organizer.ACTION_IDEMPOTENCY_VERSION_V1,
		RequestDigest: requestDigest, RequestDigestVersion: organizer.ACTION_REQUEST_VERSION_V1,
		Status: organizer.ACTION_STATUS_READY, ReasonCodesJson: "[]", CreatedUnixTime: now, UpdatedUnixTime: now, ActionId: actionId,
	}
}
