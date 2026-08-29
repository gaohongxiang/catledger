package organizer_test

import (
	"errors"
	"testing"

	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/organizer"
)

func TestCreateEngineSQLiteFreezesSourcesAndReplays(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const uid = int64(160401)
	evidence := &engineEvidenceStub{batches: map[int64]*importing.ImportBatch{
		101: organizerCreateBatch(uid, 101, 201),
		102: organizerCreateBatch(uid, 102, 202),
	}}
	engine, err := organizer.NewCreateEngine(repository, evidence, &engineIdGenerator{next: 160410})
	if err != nil {
		t.Fatalf("create update engine: %v", err)
	}
	request := organizer.CreateUpdateRequest{Uid: uid, BatchIds: []int64{102, 101}, IdempotencyKey: "create-160401"}
	result, err := engine.Create(nil, request)
	if err != nil || result == nil || result.Replayed || result.Update.Status != organizer.UPDATE_STATUS_DRAFT ||
		result.Update.Version != 1 || result.Update.SourceCount != 2 || len(result.Sources) != 2 ||
		result.Sources[0].BatchId != 102 || result.Sources[0].SourceOrder != 0 || result.Sources[1].BatchId != 101 ||
		result.Action.Status != organizer.ACTION_STATUS_APPLIED || result.Action.AppliedUpdateVersion != 1 {
		t.Fatalf("created update mismatch: result=%+v err=%v", result, err)
	}
	replayed, err := engine.Create(nil, request)
	if err != nil || replayed == nil || !replayed.Replayed || replayed.Update.UpdateId != result.Update.UpdateId ||
		replayed.Action.ActionId != result.Action.ActionId {
		t.Fatalf("create replay mismatch: result=%+v err=%v", replayed, err)
	}
	_, err = engine.Create(nil, organizer.CreateUpdateRequest{Uid: uid, BatchIds: []int64{101}, IdempotencyKey: request.IdempotencyKey})
	if !errors.Is(err, organizer.ErrActionRequestConflict) {
		t.Fatalf("same key with different sources was accepted: %v", err)
	}
	_, err = engine.Create(nil, organizer.CreateUpdateRequest{Uid: uid, BatchIds: []int64{102}, IdempotencyKey: "create-duplicate-batch"})
	if !errors.Is(err, organizer.ErrCreateUpdateStateConflict) {
		t.Fatalf("same batch was claimed by another active update: %v", err)
	}
}

func TestCreateEngineSQLiteRejectsNonReadyBatchWithoutState(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	const uid = int64(160402)
	batch := organizerCreateBatch(uid, 103, 203)
	batch.Status = importing.IMPORT_BATCH_STATUS_FAILED
	engine, err := organizer.NewCreateEngine(repository, &engineEvidenceStub{batches: map[int64]*importing.ImportBatch{103: batch}}, &engineIdGenerator{next: 160420})
	if err != nil {
		t.Fatalf("create update engine: %v", err)
	}
	_, err = engine.Create(nil, organizer.CreateUpdateRequest{Uid: uid, BatchIds: []int64{103}, IdempotencyKey: "create-failed"})
	if !errors.Is(err, organizer.ErrCreateUpdateBatchNotReady) {
		t.Fatalf("non-ready batch was accepted: %v", err)
	}
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	updates, updateErr := sess.Where("uid=?", uid).Count(new(organizer.FinanceUpdate))
	actions, actionErr := sess.Where("uid=?", uid).Count(new(organizer.FinanceAction))
	if updateErr != nil || actionErr != nil || updates != 0 || actions != 0 {
		t.Fatalf("rejected create left state: updates=%d actions=%d errors=%v/%v", updates, actions, updateErr, actionErr)
	}
}

func organizerCreateBatch(uid int64, batchId int64, fileId int64) *importing.ImportBatch {
	return &importing.ImportBatch{
		Uid: uid, BatchId: batchId, FileId: fileId, Status: importing.IMPORT_BATCH_STATUS_READY,
		SourceTypeSnapshot: importing.SOURCE_TYPE_ALIPAY, ParserVersion: "parser-v1",
		NormalizationVersion: "normalization-v1", IdentityKeyVersion: importing.IDENTITY_KEY_VERSION_V1,
	}
}
