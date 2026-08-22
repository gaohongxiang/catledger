package organizer_test

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/organizer"
	"github.com/mayswind/ezbookkeeping/pkg/uuid"
)

func TestEngineSQLitePersistsPlanAndReplaysIdempotently(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	const uid = int64(4101)
	const updateId = int64(5101)
	const batchId = int64(7101)
	if err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		if err := tx.InsertUpdate(testUpdate(uid, updateId, 10)); err != nil {
			return err
		}
		return tx.InsertSource(testSource(uid, updateId, 6101, 7100, batchId, 10))
	}); err != nil {
		t.Fatalf("seed organizer update: %v", err)
	}

	evidence := &engineEvidenceStub{
		batches: map[int64]*importing.ImportBatch{batchId: engineBatch(uid, 7100, batchId)},
		rows: map[int64][]*importing.RawImportRow{batchId: {
			plannerRow(uid, batchId, 8101, 9101, 11, 1234, 1701000000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT),
		}},
	}
	accounts := &engineAccountStub{items: map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)}}
	ids := &engineIdGenerator{next: 10000}
	engine, err := organizer.NewEngine(repository, evidence, accounts, ids)
	if err != nil {
		t.Fatalf("create organizer engine: %v", err)
	}
	request := organizer.OrganizeRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 1, IdempotencyKey: "organize-5101-v1"}
	result, err := engine.Organize(nil, request)
	if err != nil {
		t.Fatalf("organize update: %v", err)
	}
	if result.Replayed || result.Update == nil || result.Update.Status != organizer.UPDATE_STATUS_REVIEW || result.Update.Version != 3 ||
		result.Update.ReadyEventCount != 1 || result.Action == nil || result.Action.Status != organizer.ACTION_STATUS_APPLIED ||
		result.Action.AppliedUpdateVersion != 3 || len(result.Events) != 1 {
		t.Fatalf("unexpected organizer result: %+v", result)
	}
	evidenceRows, err := repository.ListEvidence(nil, uid, result.Events[0].EventId)
	if err != nil || len(evidenceRows) != 1 || evidenceRows[0].RowId != 8101 {
		t.Fatalf("persisted evidence mismatch: rows=%+v err=%v", evidenceRows, err)
	}

	replayed, err := engine.Organize(nil, request)
	if err != nil || replayed == nil || !replayed.Replayed || replayed.Action.ActionId != result.Action.ActionId || len(replayed.Events) != 1 {
		t.Fatalf("idempotent replay mismatch: result=%+v err=%v", replayed, err)
	}
	if _, err = engine.Organize(nil, organizer.OrganizeRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 1, IdempotencyKey: "organize-5101-other"}); !errors.Is(err, organizer.ErrOrganizeVersionConflict) {
		t.Fatalf("stale version was accepted: %v", err)
	}
	sess := database.NewSession(nil)
	actionCount, countErr := sess.Where("uid=?", uid).Count(new(organizer.FinanceAction))
	sess.Close()
	if countErr != nil || actionCount != 1 {
		t.Fatalf("conflicting action was not rolled back: count=%d err=%v", actionCount, countErr)
	}
}

func TestEngineSQLiteReplacesOnlyUnpostedAutomaticPlan(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	const uid = int64(4151)
	const updateId = int64(5151)
	const batchId = int64(7151)
	if err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		if err := tx.InsertUpdate(testUpdate(uid, updateId, 10)); err != nil {
			return err
		}
		return tx.InsertSource(testSource(uid, updateId, 6151, 7150, batchId, 10))
	}); err != nil {
		t.Fatalf("seed replaceable organizer update: %v", err)
	}
	row := plannerRow(uid, batchId, 8151, 9151, 11, 1234, 1701500000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	evidence := &engineEvidenceStub{
		batches: map[int64]*importing.ImportBatch{batchId: engineBatch(uid, 7150, batchId)},
		rows:    map[int64][]*importing.RawImportRow{batchId: {row}},
	}
	engine, err := organizer.NewEngine(repository, evidence,
		&engineAccountStub{items: map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)}},
		&engineIdGenerator{next: 15000})
	if err != nil {
		t.Fatalf("create replaceable organizer engine: %v", err)
	}
	first, err := engine.Organize(nil, organizer.OrganizeRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 1, IdempotencyKey: "organize-5151-v1"})
	if err != nil || first == nil || len(first.Events) != 1 {
		t.Fatalf("create first organizer plan: result=%+v err=%v", first, err)
	}
	firstEventId := first.Events[0].EventId
	newAmount := int64(2345)
	row.NormalizedAmount = &newAmount
	row.NormalizedTransactionType = importing.SOURCE_TRANSACTION_TYPE_UNKNOWN
	row.SemanticEligibility = importing.SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED
	row.Disposition = importing.IMPORT_DISPOSITION_REVIEW_REQUIRED
	rebuilt, err := engine.Organize(nil, organizer.OrganizeRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 3, IdempotencyKey: "organize-5151-v3"})
	if err != nil || rebuilt == nil || rebuilt.Update.Version != 5 || rebuilt.Update.ReadyEventCount != 1 || len(rebuilt.Events) != 1 ||
		rebuilt.Events[0].Amount == nil || *rebuilt.Events[0].Amount != newAmount || rebuilt.Events[0].EconomicNature != organizer.ECONOMIC_NATURE_EXPENSE {
		t.Fatalf("replace organizer plan mismatch: result=%+v err=%v", rebuilt, err)
	}
	if old, findErr := repository.FindEventById(nil, uid, firstEventId); findErr != nil || old != nil {
		t.Fatalf("old automatic event survived replacement: event=%+v err=%v", old, findErr)
	}
	sess := database.NewSession(nil)
	actionCount, actionErr := sess.Where("uid=? AND update_id=?", uid, updateId).Count(new(organizer.FinanceAction))
	eventCount, eventErr := sess.Where("uid=? AND update_id=?", uid, updateId).Count(new(organizer.EconomicEvent))
	sess.Close()
	if actionErr != nil || eventErr != nil || actionCount != 2 || eventCount != 1 {
		t.Fatalf("replaced plan audit mismatch: actions=%d events=%d errors=%v/%v", actionCount, eventCount, actionErr, eventErr)
	}
}

func TestEngineSQLiteMarksSnapshotFailureWithoutPartialPlan(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const uid = int64(4202)
	const updateId = int64(5202)
	const batchId = int64(7202)
	if err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		if err := tx.InsertUpdate(testUpdate(uid, updateId, 10)); err != nil {
			return err
		}
		return tx.InsertSource(testSource(uid, updateId, 6202, 7200, batchId, 10))
	}); err != nil {
		t.Fatalf("seed failing organizer update: %v", err)
	}
	batch := engineBatch(uid, 7200, batchId)
	batch.ParserVersion = "different-parser"
	engine, err := organizer.NewEngine(repository, &engineEvidenceStub{batches: map[int64]*importing.ImportBatch{batchId: batch}, rows: map[int64][]*importing.RawImportRow{batchId: {}}},
		&engineAccountStub{items: map[int64]*models.Account{}}, &engineIdGenerator{next: 20000})
	if err != nil {
		t.Fatalf("create failing organizer engine: %v", err)
	}
	_, err = engine.Organize(nil, organizer.OrganizeRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 1, IdempotencyKey: "organize-5202-v1"})
	if err == nil {
		t.Fatal("source snapshot mismatch was accepted")
	}
	update, findErr := repository.FindUpdateById(nil, uid, updateId)
	if findErr != nil || update == nil || update.Status != organizer.UPDATE_STATUS_FAILED || update.Version != 3 || update.ErrorCode != "source_snapshot_invalid" {
		t.Fatalf("failed update state mismatch: update=%+v err=%v", update, findErr)
	}
	events, listErr := repository.ListEvents(nil, uid, updateId)
	if listErr != nil || len(events) != 0 {
		t.Fatalf("snapshot failure left a partial plan: events=%+v err=%v", events, listErr)
	}
	if update.CurrentActionId == nil {
		t.Fatal("failed update lost its action audit")
	}
	action, actionErr := repository.FindActionById(nil, uid, *update.CurrentActionId)
	if actionErr != nil || action == nil || action.Status != organizer.ACTION_STATUS_FAILED || action.ErrorCode != "source_snapshot_invalid" {
		t.Fatalf("failed action mismatch: action=%+v err=%v", action, actionErr)
	}
}

func TestEngineSQLiteConcurrentReplayKeepsOnePlan(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	const uid = int64(4303)
	const updateId = int64(5303)
	const batchId = int64(7303)
	if err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		if err := tx.InsertUpdate(testUpdate(uid, updateId, 10)); err != nil {
			return err
		}
		return tx.InsertSource(testSource(uid, updateId, 6303, 7300, batchId, 10))
	}); err != nil {
		t.Fatalf("seed concurrent organizer update: %v", err)
	}
	evidence := &engineEvidenceStub{
		batches: map[int64]*importing.ImportBatch{batchId: engineBatch(uid, 7300, batchId)},
		rows: map[int64][]*importing.RawImportRow{batchId: {
			plannerRow(uid, batchId, 8303, 9303, 11, 4321, 1702000000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT),
		}},
		barrier: make(chan struct{}),
	}
	engine, err := organizer.NewEngine(repository, evidence,
		&engineAccountStub{items: map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)}},
		&engineIdGenerator{next: 30000})
	if err != nil {
		t.Fatalf("create concurrent organizer engine: %v", err)
	}
	request := organizer.OrganizeRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 1, IdempotencyKey: "organize-5303-v1"}
	results := make([]*organizer.OrganizeResult, 2)
	errorsByCall := make([]error, 2)
	var wait sync.WaitGroup
	for index := range results {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			results[index], errorsByCall[index] = engine.Organize(nil, request)
		}(index)
	}
	wait.Wait()
	for index := range results {
		if errorsByCall[index] != nil || results[index] == nil || results[index].Update.Status != organizer.UPDATE_STATUS_REVIEW || len(results[index].Events) != 1 {
			t.Fatalf("concurrent organize call %d failed: result=%+v err=%v", index, results[index], errorsByCall[index])
		}
	}
	if results[0].Action.ActionId != results[1].Action.ActionId {
		t.Fatalf("concurrent replay created different actions: %d %d", results[0].Action.ActionId, results[1].Action.ActionId)
	}
	sess := database.NewSession(nil)
	actionCount, actionErr := sess.Where("uid=? AND update_id=?", uid, updateId).Count(new(organizer.FinanceAction))
	eventCount, eventErr := sess.Where("uid=? AND update_id=?", uid, updateId).Count(new(organizer.EconomicEvent))
	sess.Close()
	if actionErr != nil || eventErr != nil || actionCount != 1 || eventCount != 1 {
		t.Fatalf("concurrent organizer duplicated state: actions=%d events=%d actionErr=%v eventErr=%v", actionCount, eventCount, actionErr, eventErr)
	}
}

type engineEvidenceStub struct {
	batches map[int64]*importing.ImportBatch
	rows    map[int64][]*importing.RawImportRow
	mu      sync.Mutex
	calls   int
	barrier chan struct{}
}

func (s *engineEvidenceStub) FindImportBatchById(_ core.Context, uid int64, batchId int64) (*importing.ImportBatch, error) {
	if s.barrier != nil {
		s.mu.Lock()
		s.calls++
		if s.calls == 2 {
			close(s.barrier)
		}
		barrier := s.barrier
		s.mu.Unlock()
		select {
		case <-barrier:
		case <-time.After(5 * time.Second):
		}
	}
	batch := s.batches[batchId]
	if batch == nil || batch.Uid != uid {
		return nil, nil
	}
	cloned := *batch
	return &cloned, nil
}

func (s *engineEvidenceStub) ListRawImportRows(_ core.Context, uid int64, batchId int64) ([]*importing.RawImportRow, error) {
	result := make([]*importing.RawImportRow, 0, len(s.rows[batchId]))
	for _, row := range s.rows[batchId] {
		if row.Uid != uid {
			continue
		}
		cloned := *row
		result = append(result, &cloned)
	}
	return result, nil
}

type engineAccountStub struct {
	items map[int64]*models.Account
}

func (s *engineAccountStub) GetAccountsByAccountIds(_ core.Context, uid int64, accountIds []int64) (map[int64]*models.Account, error) {
	result := make(map[int64]*models.Account)
	for _, accountId := range accountIds {
		if account := s.items[accountId]; account != nil && account.Uid == uid {
			cloned := *account
			result[accountId] = &cloned
		}
	}
	return result, nil
}

type engineIdGenerator struct {
	mu   sync.Mutex
	next int64
}

func (g *engineIdGenerator) GenerateUuid(_ uuid.UuidType) int64 {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.next++
	return g.next
}

func engineBatch(uid int64, fileId int64, batchId int64) *importing.ImportBatch {
	return &importing.ImportBatch{
		Uid: uid, FileId: fileId, Status: importing.IMPORT_BATCH_STATUS_READY, SourceTypeSnapshot: importing.SOURCE_TYPE_ALIPAY,
		ParserVersion: "parser-v1", NormalizationVersion: "normalization-v1", IdentityKeyVersion: "identity-v1", BatchId: batchId,
	}
}
