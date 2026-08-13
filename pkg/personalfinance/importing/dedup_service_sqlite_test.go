package importing_test

import (
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/migrations"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

func TestDedupServicePersistsReparseAndIdentityStates(t *testing.T) {
	repository, database := newSQLiteDedupRepository(t, 1)
	candidate, accountKey := dedupSourceAccountEvidence(t)
	const uid = int64(4101)
	const fileId = int64(4201)
	const sourceAccountId = int64(4301)
	firstLedgerAccountId := int64(4401)
	insertDedupFixtures(t, database, uid, fileId, sourceAccountId, accountKey, &firstLedgerAccountId, "a")
	service := newDedupTestService(t, repository, 10000)

	firstDocument := dedupEvidenceDocument(candidate, []importing.EvidenceRow{
		dedupValidRow(1, "tx-001", 100, false),
		dedupValidRow(2, "tx-002", 100, false),
		dedupValidRow(3, "", 200, true),
		dedupValidRow(4, "", 300, false),
		dedupInvalidRow(5),
	})
	firstBatch, err := service.PersistEvidenceDocument(nil, dedupPersistRequest(uid, fileId, sourceAccountId, "initial_parse", firstDocument))

	if err != nil {
		t.Fatalf("persist first evidence document: %v", err)
	}

	assertDedupBatchCounts(t, firstBatch, 5, 4, 1, 0, 0, 4)

	if firstBatch.Status != importing.IMPORT_BATCH_STATUS_READY ||
		firstBatch.SourceAccountId == nil || *firstBatch.SourceAccountId != sourceAccountId ||
		firstBatch.LedgerAccountId == nil || *firstBatch.LedgerAccountId != firstLedgerAccountId ||
		firstBatch.ParseOptionsDigest == "" || firstBatch.CompletedUnixTime == nil {
		t.Fatalf("first batch metadata is incomplete: %+v", firstBatch)
	}

	firstRows := listDedupRows(t, repository, uid, firstBatch.BatchId)
	assertDedupRowStates(t, firstRows, []importing.IdentityState{
		importing.IDENTITY_STATE_NEW,
		importing.IDENTITY_STATE_NEW,
		importing.IDENTITY_STATE_NEW,
		importing.IDENTITY_STATE_BATCH_LOCAL,
		importing.IDENTITY_STATE_NOT_EVALUATED,
	})

	if firstRows[4].IdentityId != nil || firstRows[4].NormalizedUnixTime != nil ||
		firstRows[4].NormalizedAmount != nil || firstRows[4].Currency != "" ||
		firstRows[4].Disposition != importing.IMPORT_DISPOSITION_NON_POSTABLE ||
		firstRows[4].ProcessingState != importing.PROCESSING_STATE_IGNORED {
		t.Fatalf("invalid evidence row was not preserved as non-postable: %+v", firstRows[4])
	}

	canonicalConflictDigest := firstRows[1].ObservedSourceCoreDigest
	secondLedgerAccountId := int64(4402)
	updateDedupSourceAccountPresentation(t, database, uid, sourceAccountId, secondLedgerAccountId)
	secondDocument := dedupEvidenceDocument(candidate, []importing.EvidenceRow{
		dedupValidRow(1, "tx-001", 100, false),
		dedupValidRow(2, "tx-002", 101, false),
		dedupValidRow(3, "tx-003", 100, false),
		dedupValidRow(4, "", 200, true),
		dedupValidRow(5, "", 300, false),
		dedupInvalidRow(6),
	})
	secondBatch, err := service.PersistEvidenceDocument(nil, dedupPersistRequest(uid, fileId, sourceAccountId, "manual_reparse", secondDocument))

	if err != nil {
		t.Fatalf("persist reparsed evidence document: %v", err)
	}

	assertDedupBatchCounts(t, secondBatch, 6, 5, 1, 2, 1, 5)

	if secondBatch.BatchId == firstBatch.BatchId || secondBatch.LedgerAccountId == nil ||
		*secondBatch.LedgerAccountId != secondLedgerAccountId {
		t.Fatalf("explicit reparse did not create a new mapping snapshot: %+v", secondBatch)
	}

	secondRows := listDedupRows(t, repository, uid, secondBatch.BatchId)
	assertDedupRowStates(t, secondRows, []importing.IdentityState{
		importing.IDENTITY_STATE_EXACT_DUPLICATE,
		importing.IDENTITY_STATE_IDENTITY_CONFLICT,
		importing.IDENTITY_STATE_NEW,
		importing.IDENTITY_STATE_EXACT_DUPLICATE,
		importing.IDENTITY_STATE_BATCH_LOCAL,
		importing.IDENTITY_STATE_NOT_EVALUATED,
	})

	if firstRows[0].IdentityId == nil || secondRows[0].IdentityId == nil ||
		*firstRows[0].IdentityId != *secondRows[0].IdentityId {
		t.Fatal("exact duplicate rows did not converge on one source identity")
	}

	if firstRows[1].IdentityId == nil || secondRows[1].IdentityId == nil ||
		*firstRows[1].IdentityId != *secondRows[1].IdentityId ||
		secondRows[1].ObservedSourceCoreDigest == canonicalConflictDigest {
		t.Fatal("identity conflict did not preserve its canonical identity and observed digest")
	}

	canonicalIdentity, err := repository.FindSourceIdentityByKey(nil, uid, firstRows[1].ObservedSourceIdentityKey)

	if err != nil || canonicalIdentity == nil || canonicalIdentity.SourceCoreDigest != canonicalConflictDigest {
		t.Fatalf("identity conflict overwrote the first core digest: %+v %v", canonicalIdentity, err)
	}

	if firstRows[3].IdentityId == nil || secondRows[4].IdentityId == nil ||
		*firstRows[3].IdentityId == *secondRows[4].IdentityId ||
		firstRows[3].ObservedSourceIdentityKey == secondRows[4].ObservedSourceIdentityKey {
		t.Fatal("batch-local evidence was merged across parse batches")
	}

	if firstRows[1].IdentityId == nil || secondRows[2].IdentityId == nil ||
		*firstRows[1].IdentityId == *secondRows[2].IdentityId {
		t.Fatal("same-time same-amount transactions with different source IDs were merged")
	}

	if count := countDedupBeans(t, database, uid, new(importing.SourceIdentity)); count != 6 {
		t.Fatalf("unexpected source identity count %d", count)
	}

	if count := countDedupBeans(t, database, uid, new(importing.RawImportRow)); count != 11 {
		t.Fatalf("not every repeated or invalid raw row was preserved: %d", count)
	}

	batches, totalCount, err := repository.ListImportBatches(nil, uid, fileId, 0, 10)

	if err != nil || totalCount != 2 || len(batches) != 2 {
		t.Fatalf("explicit reparse history is incomplete: %d %d %v", totalCount, len(batches), err)
	}

	assertDedupCrossUserIsolation(t, repository, database, service, candidate, accountKey, firstRows[0])
}

func TestDedupServiceArbitratesRepeatedIdentityWithinBatch(t *testing.T) {
	repository, database := newSQLiteDedupRepository(t, 1)
	candidate, accountKey := dedupSourceAccountEvidence(t)
	const uid = int64(4601)
	const fileId = int64(4701)
	const sourceAccountId = int64(4801)
	insertDedupFixtures(t, database, uid, fileId, sourceAccountId, accountKey, nil, "9")
	service := newDedupTestService(t, repository, 4900)
	document := dedupEvidenceDocument(candidate, []importing.EvidenceRow{
		dedupValidRow(1, "within-batch", 100, false),
		dedupValidRow(2, "within-batch", 100, false),
		dedupValidRow(3, "within-batch", 101, false),
	})

	batch, err := service.PersistEvidenceDocument(nil, dedupPersistRequest(uid, fileId, sourceAccountId, "within_batch", document))

	if err != nil {
		t.Fatalf("persist repeated identities within one batch: %v", err)
	}

	assertDedupBatchCounts(t, batch, 3, 3, 0, 1, 1, 3)
	rows := listDedupRows(t, repository, uid, batch.BatchId)
	assertDedupRowStates(t, rows, []importing.IdentityState{
		importing.IDENTITY_STATE_NEW,
		importing.IDENTITY_STATE_EXACT_DUPLICATE,
		importing.IDENTITY_STATE_IDENTITY_CONFLICT,
	})

	if rows[0].IdentityId == nil || rows[1].IdentityId == nil || rows[2].IdentityId == nil ||
		*rows[0].IdentityId != *rows[1].IdentityId || *rows[0].IdentityId != *rows[2].IdentityId ||
		countDedupBeans(t, database, uid, new(importing.SourceIdentity)) != 1 {
		t.Fatalf("repeated identities in one batch did not converge: %+v", rows)
	}
}

func TestDedupServiceRollsBackWholeBatchOnRowFailure(t *testing.T) {
	repository, database := newSQLiteDedupRepository(t, 1)
	candidate, accountKey := dedupSourceAccountEvidence(t)
	const uid = int64(5101)
	const fileId = int64(5201)
	const sourceAccountId = int64(5301)
	insertDedupFixtures(t, database, uid, fileId, sourceAccountId, accountKey, nil, "b")

	ids := []int64{6101, 6201, 6301, 6201, 6302}
	var idIndex atomic.Int64
	service, err := importing.NewDedupService(repository, func() int64 {
		index := idIndex.Add(1) - 1

		if index >= int64(len(ids)) {
			return 0
		}

		return ids[index]
	})

	if err != nil {
		t.Fatalf("create rollback test service: %v", err)
	}

	document := dedupEvidenceDocument(candidate, []importing.EvidenceRow{
		dedupValidRow(1, "rollback-tx-1", 100, false),
		dedupValidRow(2, "rollback-tx-2", 200, false),
	})
	_, err = service.PersistEvidenceDocument(nil, dedupPersistRequest(uid, fileId, sourceAccountId, "failure_test", document))

	if !errors.Is(err, importing.ErrImportPersistenceUnavailable) {
		t.Fatalf("row insertion failure was not redacted: %v", err)
	}

	for _, bean := range []any{new(importing.ImportBatch), new(importing.SourceIdentity), new(importing.RawImportRow)} {
		if count := countDedupBeans(t, database, uid, bean); count != 0 {
			t.Fatalf("failed evidence batch left persisted %T records: %d", bean, count)
		}
	}
}

func TestDedupServiceRejectsForeignAndMismatchedSourceAccounts(t *testing.T) {
	repository, database := newSQLiteDedupRepository(t, 1)
	candidate, accountKey := dedupSourceAccountEvidence(t)
	const uid = int64(7101)
	const fileId = int64(7201)
	const sourceAccountId = int64(7301)
	insertDedupFixtures(t, database, uid, fileId, sourceAccountId, accountKey, nil, "c")
	service := newDedupTestService(t, repository, 8000)
	document := dedupEvidenceDocument(candidate, []importing.EvidenceRow{dedupValidRow(1, "owned", 100, false)})

	foreignAccountRequest := dedupPersistRequest(uid, fileId, sourceAccountId+1, "foreign_account", document)
	_, err := service.PersistEvidenceDocument(nil, foreignAccountRequest)

	if !errors.Is(err, importing.ErrImportSourceAccountNotFound) {
		t.Fatalf("foreign source account was not hidden: %v", err)
	}

	mismatchedCandidate := candidate
	mismatchedCandidate.Identifier = "another@example.com"
	mismatchedDocument := dedupEvidenceDocument(mismatchedCandidate, []importing.EvidenceRow{dedupValidRow(1, "mismatch", 100, false)})
	_, err = service.PersistEvidenceDocument(nil, dedupPersistRequest(uid, fileId, sourceAccountId, "mismatched_account", mismatchedDocument))

	if !errors.Is(err, importing.ErrImportSourceAccountUnavailable) {
		t.Fatalf("mismatched stable account evidence was accepted: %v", err)
	}

	foreignFileRequest := dedupPersistRequest(uid, fileId+1, sourceAccountId, "foreign_file", document)
	_, err = service.PersistEvidenceDocument(nil, foreignFileRequest)

	if !errors.Is(err, importing.ErrImportFileNotFound) {
		t.Fatalf("foreign import file was not hidden: %v", err)
	}

	mismatchedOptionsRequest := dedupPersistRequest(uid, fileId, sourceAccountId, "mismatched_options", document)
	mismatchedOptionsRequest.ParseOptions.Currency = "USD"
	_, err = service.PersistEvidenceDocument(nil, mismatchedOptionsRequest)

	if !errors.Is(err, importing.ErrImportRequestInvalid) {
		t.Fatalf("parse options that disagree with normalized evidence were accepted: %v", err)
	}

	oversizedLocatorDocument := dedupEvidenceDocument(candidate, []importing.EvidenceRow{dedupValidRow(1, "oversized-locator", 100, false)})
	oversizedLocatorDocument.Rows[0].Locator = importing.SourceLocator{
		Kind:       importing.LOCATOR_KIND_XLSX,
		SheetIndex: 0,
		SheetName:  strings.Repeat("sheet", 64),
		XLSXRow:    1,
	}
	_, err = service.PersistEvidenceDocument(nil, dedupPersistRequest(uid, fileId, sourceAccountId, "oversized_locator", oversizedLocatorDocument))

	if !errors.Is(err, importing.ErrImportRequestInvalid) {
		t.Fatalf("source locator wider than the persistent column was accepted: %v", err)
	}

	if count := countDedupBeans(t, database, uid, new(importing.ImportBatch)); count != 0 {
		t.Fatalf("rejected requests created %d import batches", count)
	}
}

func TestDedupServiceConcurrentIdentityArbitrationSQLite(t *testing.T) {
	repository, database := newSQLiteDedupRepository(t, 8)
	assertDedupConcurrentIdentityArbitration(t, repository, database, 8101, 8201, 8301, "d")
}

func TestDedupServiceConcurrentIdentityConflictSQLite(t *testing.T) {
	repository, database := newSQLiteDedupRepository(t, 8)
	assertDedupConcurrentIdentityConflict(t, repository, database, 8401, 8501, 8601, "7")
}

func TestDedupServiceIdentityPrimaryKeyCollisionRollsBackSQLite(t *testing.T) {
	repository, database := newSQLiteDedupRepository(t, 1)
	assertDedupIdentityPrimaryKeyCollisionRollback(t, repository, database, 8701, 8801, 8901, "6", 300000)
}

func TestDedupRepositoryRejectsForgedIdentityCandidate(t *testing.T) {
	repository, database := newSQLiteDedupRepository(t, 1)
	candidate, accountKey := dedupSourceAccountEvidence(t)
	const uid = int64(8951)
	const fileId = int64(8952)
	const sourceAccountId = int64(8953)
	insertDedupFixtures(t, database, uid, fileId, sourceAccountId, accountKey, nil, "5")
	service := newDedupTestService(t, &tamperingDedupRepository{Repository: repository}, 310000)
	document := dedupEvidenceDocument(candidate, []importing.EvidenceRow{dedupValidRow(1, "forged-core", 100, false)})

	_, err := service.PersistEvidenceDocument(nil, dedupPersistRequest(uid, fileId, sourceAccountId, "forged_candidate", document))

	if !errors.Is(err, importing.ErrImportPersistenceUnavailable) {
		t.Fatalf("forged identity candidate was not rejected safely: %v", err)
	}

	for _, bean := range []any{new(importing.ImportBatch), new(importing.SourceIdentity), new(importing.RawImportRow)} {
		if count := countDedupBeans(t, database, uid, bean); count != 0 {
			t.Fatalf("forged identity candidate left persisted %T records: %d", bean, count)
		}
	}
}

func TestDedupRepositoryRejectsCorruptedCanonicalIdentity(t *testing.T) {
	repository, database := newSQLiteDedupRepository(t, 1)
	candidate, accountKey := dedupSourceAccountEvidence(t)
	const uid = int64(8961)
	const fileId = int64(8962)
	const sourceAccountId = int64(8963)
	insertDedupFixtures(t, database, uid, fileId, sourceAccountId, accountKey, nil, "3")
	document := dedupEvidenceDocument(candidate, []importing.EvidenceRow{dedupValidRow(1, "corrupted-canonical", 100, false)})
	identityCandidate, err := importing.BuildIdentityCandidate(importing.IdentityBuildInput{
		ParseState:       document.Rows[0].ParseStatus,
		SourceType:       importing.SOURCE_TYPE_ALIPAY,
		SourceAccountKey: accountKey,
		BatchId:          320001,
		RowNumber:        document.Rows[0].RowNumber,
		Identifiers:      document.Rows[0].Identifiers,
		Normalized:       document.Rows[0].Normalized,
	})

	if err != nil {
		t.Fatalf("build corrupted canonical identity key: %v", err)
	}

	versions := importing.CurrentCentralRuleVersions()
	insertRepositoryBeans(t, database, &importing.SourceIdentity{
		Uid:                uid,
		SourceAccountId:    sourceAccountId,
		IdentityKind:       identityCandidate.Kind,
		SourceIdentityKey:  identityCandidate.SourceIdentityKey,
		SourceCoreDigest:   "corrupted",
		IdentityKeyVersion: versions.IdentityKeyVersion,
		CoreDigestVersion:  versions.CoreDigestVersion,
		FingerprintVersion: versions.FingerprintVersion,
		FirstSeenUnixTime:  100,
		LastSeenUnixTime:   100,
		IdentityId:         320004,
	})
	service := newDedupTestService(t, repository, 320000)

	_, err = service.PersistEvidenceDocument(nil, dedupPersistRequest(uid, fileId, sourceAccountId, "corrupted_identity", document))

	if !errors.Is(err, importing.ErrImportPersistenceUnavailable) {
		t.Fatalf("corrupted canonical identity was not rejected safely: %v", err)
	}

	for _, bean := range []any{new(importing.ImportBatch), new(importing.RawImportRow)} {
		if count := countDedupBeans(t, database, uid, bean); count != 0 {
			t.Fatalf("corrupted canonical identity left persisted %T records: %d", bean, count)
		}
	}
}

func assertDedupConcurrentIdentityArbitration(t *testing.T, repository *importing.Repository, database *datastore.Database, uid int64, fileId int64, sourceAccountId int64, digestCharacter string) {
	t.Helper()
	candidate, accountKey := dedupSourceAccountEvidence(t)
	insertDedupFixtures(t, database, uid, fileId, sourceAccountId, accountKey, nil, digestCharacter)
	const workerCount = 4
	barrierRepository := &dedupBarrierRepository{
		Repository: repository,
		target:     workerCount,
		release:    make(chan struct{}),
	}
	services := make([]*importing.DedupService, workerCount)

	for index := range services {
		services[index] = newDedupTestService(t, barrierRepository, 100000+int64(index)*10000)
	}

	document := dedupEvidenceDocument(candidate, []importing.EvidenceRow{dedupValidRow(1, "concurrent-tx", 100, false)})
	results := make([]*importing.ImportBatch, len(services))
	errorsByWorker := make([]error, len(services))
	var workers sync.WaitGroup

	for index := range services {
		workers.Add(1)

		go func(worker int) {
			defer workers.Done()
			results[worker], errorsByWorker[worker] = services[worker].PersistEvidenceDocument(
				nil,
				dedupPersistRequest(uid, fileId, sourceAccountId, "concurrent_test", document),
			)
		}(index)
	}

	workers.Wait()

	for index, err := range errorsByWorker {
		if err != nil {
			t.Fatalf("concurrent %s worker %d failed: %v", database.DatabaseType(), index, err)
		}
	}

	states := make(map[importing.IdentityState]int)

	for _, batch := range results {
		rows := listDedupRows(t, repository, uid, batch.BatchId)

		if len(rows) != 1 {
			t.Fatalf("concurrent batch has %d rows", len(rows))
		}

		states[rows[0].IdentityState]++
	}

	if states[importing.IDENTITY_STATE_NEW] != 1 || states[importing.IDENTITY_STATE_EXACT_DUPLICATE] != workerCount-1 {
		t.Fatalf("%s unique constraint did not elect one identity winner: %+v", database.DatabaseType(), states)
	}

	if count := countDedupBeans(t, database, uid, new(importing.SourceIdentity)); count != 1 {
		t.Fatalf("concurrent %s batches created %d source identities", database.DatabaseType(), count)
	}

	if count := countDedupBeans(t, database, uid, new(importing.ImportBatch)); count != workerCount {
		t.Fatalf("concurrent %s batches created %d import batches", database.DatabaseType(), count)
	}

	if count := countDedupBeans(t, database, uid, new(importing.RawImportRow)); count != workerCount {
		t.Fatalf("concurrent %s batches created %d raw rows", database.DatabaseType(), count)
	}
}

func assertDedupConcurrentIdentityConflict(t *testing.T, repository *importing.Repository, database *datastore.Database, uid int64, fileId int64, sourceAccountId int64, digestCharacter string) {
	t.Helper()
	candidate, accountKey := dedupSourceAccountEvidence(t)
	insertDedupFixtures(t, database, uid, fileId, sourceAccountId, accountKey, nil, digestCharacter)
	barrierRepository := &dedupBarrierRepository{
		Repository: repository,
		target:     2,
		release:    make(chan struct{}),
	}
	services := []*importing.DedupService{
		newDedupTestService(t, barrierRepository, 200000),
		newDedupTestService(t, barrierRepository, 210000),
	}
	documents := []*importing.EvidenceDocument{
		dedupEvidenceDocument(candidate, []importing.EvidenceRow{dedupValidRow(1, "concurrent-conflict", 100, false)}),
		dedupEvidenceDocument(candidate, []importing.EvidenceRow{dedupValidRow(1, "concurrent-conflict", 101, false)}),
	}
	results := make([]*importing.ImportBatch, len(services))
	errorsByWorker := make([]error, len(services))
	var workers sync.WaitGroup

	for index := range services {
		workers.Add(1)

		go func(worker int) {
			defer workers.Done()
			results[worker], errorsByWorker[worker] = services[worker].PersistEvidenceDocument(
				nil,
				dedupPersistRequest(uid, fileId, sourceAccountId, "concurrent_conflict", documents[worker]),
			)
		}(index)
	}

	workers.Wait()

	for index, err := range errorsByWorker {
		if err != nil {
			t.Fatalf("concurrent %s conflict worker %d failed: %v", database.DatabaseType(), index, err)
		}
	}

	states := make(map[importing.IdentityState]int)
	var newRow *importing.RawImportRow
	var conflictRow *importing.RawImportRow

	for _, batch := range results {
		rows := listDedupRows(t, repository, uid, batch.BatchId)

		if len(rows) != 1 {
			t.Fatalf("concurrent conflict batch has %d rows", len(rows))
		}

		states[rows[0].IdentityState]++

		if rows[0].IdentityState == importing.IDENTITY_STATE_NEW {
			newRow = rows[0]
		} else if rows[0].IdentityState == importing.IDENTITY_STATE_IDENTITY_CONFLICT {
			conflictRow = rows[0]
		}
	}

	if states[importing.IDENTITY_STATE_NEW] != 1 || states[importing.IDENTITY_STATE_IDENTITY_CONFLICT] != 1 ||
		newRow == nil || conflictRow == nil || newRow.IdentityId == nil || conflictRow.IdentityId == nil ||
		*newRow.IdentityId != *conflictRow.IdentityId ||
		newRow.ObservedSourceCoreDigest == conflictRow.ObservedSourceCoreDigest {
		t.Fatalf("%s unique constraint did not preserve a concurrent semantic conflict: %+v", database.DatabaseType(), states)
	}

	identity, err := repository.FindSourceIdentityByKey(nil, uid, newRow.ObservedSourceIdentityKey)

	if err != nil || identity == nil || identity.SourceCoreDigest != newRow.ObservedSourceCoreDigest {
		t.Fatalf("%s concurrent conflict overwrote the winning core digest: %+v %v", database.DatabaseType(), identity, err)
	}

	if count := countDedupBeans(t, database, uid, new(importing.SourceIdentity)); count != 1 {
		t.Fatalf("concurrent %s conflicts created %d source identities", database.DatabaseType(), count)
	}
}

func assertDedupIdentityPrimaryKeyCollisionRollback(t *testing.T, repository *importing.Repository, database *datastore.Database, uid int64, fileId int64, sourceAccountId int64, digestCharacter string, initialId int64) {
	t.Helper()
	candidate, accountKey := dedupSourceAccountEvidence(t)
	insertDedupFixtures(t, database, uid, fileId, sourceAccountId, accountKey, nil, digestCharacter)
	versions := importing.CurrentCentralRuleVersions()
	existingIdentity := &importing.SourceIdentity{
		Uid:                uid,
		SourceAccountId:    sourceAccountId,
		IdentityKind:       importing.IDENTITY_KIND_SOURCE_TRANSACTION_ID,
		SourceIdentityKey:  strings.Repeat("1", 64),
		SourceCoreDigest:   strings.Repeat("2", 64),
		IdentityKeyVersion: versions.IdentityKeyVersion,
		CoreDigestVersion:  versions.CoreDigestVersion,
		FingerprintVersion: versions.FingerprintVersion,
		FirstSeenUnixTime:  100,
		LastSeenUnixTime:   100,
		IdentityId:         initialId + 3,
	}
	insertRepositoryBeans(t, database, existingIdentity)
	service := newDedupTestService(t, repository, initialId)
	document := dedupEvidenceDocument(candidate, []importing.EvidenceRow{dedupValidRow(1, "identity-id-collision", 100, false)})

	_, err := service.PersistEvidenceDocument(nil, dedupPersistRequest(uid, fileId, sourceAccountId, "identity_id_collision", document))

	if !errors.Is(err, importing.ErrImportPersistenceUnavailable) {
		t.Fatalf("%s identity primary-key collision was not rejected safely: %v", database.DatabaseType(), err)
	}

	persisted, findErr := repository.FindSourceIdentityByKey(nil, uid, existingIdentity.SourceIdentityKey)

	if findErr != nil || persisted == nil || persisted.IdentityId != existingIdentity.IdentityId ||
		persisted.SourceIdentityKey != existingIdentity.SourceIdentityKey ||
		persisted.SourceCoreDigest != existingIdentity.SourceCoreDigest {
		t.Fatalf("%s identity primary-key collision changed the existing identity: %+v %v", database.DatabaseType(), persisted, findErr)
	}

	if count := countDedupBeans(t, database, uid, new(importing.SourceIdentity)); count != 1 {
		t.Fatalf("%s identity primary-key collision changed identity count: %d", database.DatabaseType(), count)
	}

	for _, bean := range []any{new(importing.ImportBatch), new(importing.RawImportRow)} {
		if count := countDedupBeans(t, database, uid, bean); count != 0 {
			t.Fatalf("%s identity primary-key collision left persisted %T records: %d", database.DatabaseType(), bean, count)
		}
	}
}

type dedupBarrierRepository struct {
	*importing.Repository
	entered atomic.Int32
	target  int32
	once    sync.Once
	release chan struct{}
}

type tamperingDedupRepository struct {
	*importing.Repository
}

func (r *tamperingDedupRepository) PersistEvidenceBatch(c core.Context, persistence *importing.EvidenceBatchPersistence) error {
	forgedDigest := strings.Repeat("f", 64)
	persistence.Rows[0].IdentityCandidate.SourceCoreDigest = forgedDigest
	persistence.Rows[0].Row.ObservedSourceCoreDigest = forgedDigest
	return r.Repository.PersistEvidenceBatch(c, persistence)
}

func (r *dedupBarrierRepository) PersistEvidenceBatch(c core.Context, persistence *importing.EvidenceBatchPersistence) error {
	if r.entered.Add(1) == r.target {
		r.once.Do(func() {
			close(r.release)
		})
	}

	<-r.release
	return r.Repository.PersistEvidenceBatch(c, persistence)
}

func assertDedupCrossUserIsolation(t *testing.T, repository *importing.Repository, database *datastore.Database, service *importing.DedupService, candidate importing.SourceAccountCandidate, accountKey string, firstUserRow *importing.RawImportRow) {
	t.Helper()
	const secondUid = int64(9101)
	const secondFileId = int64(9201)
	const secondSourceAccountId = int64(9301)
	insertDedupFixtures(t, database, secondUid, secondFileId, secondSourceAccountId, accountKey, nil, "e")
	document := dedupEvidenceDocument(candidate, []importing.EvidenceRow{dedupValidRow(1, "tx-001", 100, false)})
	batch, err := service.PersistEvidenceDocument(nil, dedupPersistRequest(secondUid, secondFileId, secondSourceAccountId, "cross_user", document))

	if err != nil {
		t.Fatalf("persist second user's evidence: %v", err)
	}

	rows := listDedupRows(t, repository, secondUid, batch.BatchId)

	if len(rows) != 1 || rows[0].IdentityState != importing.IDENTITY_STATE_NEW ||
		rows[0].ObservedSourceIdentityKey != firstUserRow.ObservedSourceIdentityKey {
		t.Fatalf("second user's source identity was not independently scoped: %+v", rows)
	}

	firstIdentity, err := repository.FindSourceIdentityByKey(nil, firstUserRow.Uid, firstUserRow.ObservedSourceIdentityKey)

	if err != nil || firstIdentity == nil {
		t.Fatalf("find first user's identity: %+v %v", firstIdentity, err)
	}

	secondIdentity, err := repository.FindSourceIdentityByKey(nil, secondUid, rows[0].ObservedSourceIdentityKey)

	if err != nil || secondIdentity == nil || secondIdentity.IdentityId == firstIdentity.IdentityId {
		t.Fatalf("source identity crossed uid boundary: %+v %+v %v", firstIdentity, secondIdentity, err)
	}

	foreignBatch, err := repository.FindImportBatchById(nil, firstUserRow.Uid, batch.BatchId)

	if err != nil || foreignBatch != nil {
		t.Fatalf("second user's batch was visible to the first user: %+v %v", foreignBatch, err)
	}
}

func newSQLiteDedupRepository(t *testing.T, maximumConnections int) (*importing.Repository, *datastore.Database) {
	t.Helper()
	database, err := datastore.OpenDatabase(&settings.DatabaseConfig{
		DatabaseType:          settings.Sqlite3DbType,
		DatabasePath:          filepath.Join(t.TempDir(), "dedup.db"),
		MaxIdleConnection:     uint16(maximumConnections),
		MaxOpenConnection:     uint16(maximumConnections),
		ConnectionMaxLifeTime: 60,
	})

	if err != nil {
		t.Fatalf("open SQLite DEDUP-101 database: %v", err)
	}

	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close SQLite DEDUP-101 database: %v", err)
		}
	})

	store, err := datastore.NewDataStore(database)

	if err != nil {
		t.Fatalf("create SQLite DEDUP-101 store: %v", err)
	}

	if err := migrations.Upgrade(nil, store, migrations.ApplicationInfo{Version: "dedup-test", Commit: "test"}); err != nil {
		t.Fatalf("upgrade SQLite DEDUP-101 schema: %v", err)
	}

	repository, err := importing.NewRepository(store)

	if err != nil {
		t.Fatalf("create SQLite DEDUP-101 repository: %v", err)
	}

	return repository, database
}

func newDedupTestService(t *testing.T, repository importing.EvidenceDedupRepository, initialId int64) *importing.DedupService {
	t.Helper()
	var nextId atomic.Int64
	nextId.Store(initialId)
	service, err := importing.NewDedupService(repository, func() int64 {
		return nextId.Add(1)
	})

	if err != nil {
		t.Fatalf("create DEDUP-101 service: %v", err)
	}

	return service
}

func dedupSourceAccountEvidence(t *testing.T) (importing.SourceAccountCandidate, string) {
	t.Helper()
	candidate := importing.SourceAccountCandidate{
		Kind:            importing.SOURCE_ACCOUNT_EVIDENCE_STABLE_IDENTIFIER,
		Identifier:      "owner@example.com",
		DiscoveryMethod: importing.SOURCE_ACCOUNT_DISCOVERY_ALIPAY_PREAMBLE_ACCOUNT,
	}
	key, err := importing.ComputeSourceAccountKey(importing.SOURCE_TYPE_ALIPAY, candidate)

	if err != nil {
		t.Fatalf("compute DEDUP-101 source account key: %v", err)
	}

	return candidate, key
}

func insertDedupFixtures(t *testing.T, database *datastore.Database, uid int64, fileId int64, sourceAccountId int64, accountKey string, ledgerAccountId *int64, digestCharacter string) {
	t.Helper()
	file := testImportFile(uid, fileId, digestCharacter, 100)
	file.ContentState = importing.IMPORT_FILE_CONTENT_STATE_AVAILABLE
	versions := importing.CurrentCentralRuleVersions()
	account := &importing.SourceAccount{
		Uid:                     uid,
		SourceType:              importing.SOURCE_TYPE_ALIPAY,
		SourceAccountKey:        accountKey,
		SourceAccountKeyVersion: versions.SourceAccountKeyVersion,
		LedgerAccountId:         ledgerAccountId,
		Status:                  importing.SOURCE_ACCOUNT_STATUS_ACTIVE,
		MaskedDisplayName:       "o***@e******.com",
		DiscoveryMethod:         importing.SOURCE_ACCOUNT_DISCOVERY_ALIPAY_PREAMBLE_ACCOUNT,
		CreatedUnixTime:         100,
		UpdatedUnixTime:         100,
		SourceAccountId:         sourceAccountId,
	}
	insertRepositoryBeans(t, database, file, account)
}

func updateDedupSourceAccountPresentation(t *testing.T, database *datastore.Database, uid int64, sourceAccountId int64, ledgerAccountId int64) {
	t.Helper()
	session := database.NewPrivacySession(nil)
	defer session.Close()
	updated, err := session.Where("uid=? AND source_account_id=?", uid, sourceAccountId).
		Cols("ledger_account_id", "masked_display_name", "updated_unix_time").
		Update(&importing.SourceAccount{
			LedgerAccountId:   &ledgerAccountId,
			MaskedDisplayName: "renamed-account",
			UpdatedUnixTime:   200,
		})

	if err != nil || updated != 1 {
		t.Fatalf("update source account presentation: %d %v", updated, err)
	}
}

func dedupPersistRequest(uid int64, fileId int64, sourceAccountId int64, reason string, document *importing.EvidenceDocument) importing.PersistEvidenceDocumentRequest {
	return importing.PersistEvidenceDocumentRequest{
		Uid:               uid,
		FileId:            fileId,
		SourceAccountId:   sourceAccountId,
		Descriptor:        dedupParserDescriptor(),
		ParseOptions:      importing.ResolvedParseOptions{Currency: "CNY", TimezoneUtcOffset: 480},
		ReparseReasonCode: reason,
		Document:          document,
	}
}

func dedupParserDescriptor() importing.ParserDescriptor {
	return importing.ParserDescriptor{
		Name:                 "dedup_test_parser",
		SourceType:           importing.SOURCE_TYPE_ALIPAY,
		Format:               importing.EVIDENCE_FORMAT_ALIPAY_APP_CSV,
		ParserVersion:        "parser-v1",
		NormalizationVersion: "normalization-v1",
	}
}

func dedupEvidenceDocument(candidate importing.SourceAccountCandidate, rows []importing.EvidenceRow) *importing.EvidenceDocument {
	return &importing.EvidenceDocument{
		Metadata: importing.DocumentMetadata{
			SourceType:    importing.SOURCE_TYPE_ALIPAY,
			SourceAccount: candidate,
		},
		Rows: rows,
	}
}

func dedupValidRow(rowNumber int64, transactionId string, amount int64, strongFingerprint bool) importing.EvidenceRow {
	unixTime := int64(1720000000)
	fingerprint := importing.StrongFingerprintMaterials{}

	if strongFingerprint {
		fingerprint = importing.StrongFingerprintMaterials{
			Counterparty:  "stable merchant",
			Item:          "stable item",
			PaymentMethod: "balance",
		}
	}

	return importing.EvidenceRow{
		RowNumber: rowNumber,
		Locator: importing.SourceLocator{
			Kind:        importing.LOCATOR_KIND_CSV,
			CSVStartRow: rowNumber + 10,
			CSVEndRow:   rowNumber + 10,
		},
		RawFields: []importing.RawField{
			{Name: "transaction_id", Value: transactionId},
			{Name: "amount", Value: "1.00"},
		},
		Raw: importing.CanonicalRawEvidence{
			TransactionTime: "2024-07-03 17:46:40",
			Amount:          "1.00",
			Direction:       "支出",
			Status:          "交易成功",
			TransactionType: "消费",
			Counterparty:    "stable merchant",
			Item:            "stable item",
			PaymentMethod:   "balance",
		},
		Identifiers: importing.SourceIdentifiers{TransactionId: transactionId},
		Normalized: importing.NormalizedEvidence{
			UnixTime:          &unixTime,
			TimezoneUtcOffset: 480,
			Amount:            &amount,
			Currency:          "CNY",
			Direction:         importing.NORMALIZED_DIRECTION_EXPENSE,
			TransactionType:   importing.SOURCE_TRANSACTION_TYPE_PAYMENT,
			EconomicEffect:    importing.ECONOMIC_EFFECT_NORMAL,
		},
		FingerprintMaterials: fingerprint,
		ParseStatus:          importing.PARSE_STATE_VALID,
	}
}

func dedupInvalidRow(rowNumber int64) importing.EvidenceRow {
	return importing.EvidenceRow{
		RowNumber: rowNumber,
		Locator: importing.SourceLocator{
			Kind:        importing.LOCATOR_KIND_CSV,
			CSVStartRow: rowNumber + 10,
			CSVEndRow:   rowNumber + 10,
		},
		RawFields: []importing.RawField{{Name: "amount", Value: "invalid-amount"}},
		Raw: importing.CanonicalRawEvidence{
			Amount: "invalid-amount",
		},
		ParseStatus: importing.PARSE_STATE_INVALID,
		Issues: []importing.EvidenceIssue{{
			Code:     importing.ISSUE_CODE_ROW_AMOUNT_INVALID,
			Severity: importing.ISSUE_SEVERITY_ERROR,
			Field:    "amount",
		}},
	}
}

func listDedupRows(t *testing.T, repository *importing.Repository, uid int64, batchId int64) []*importing.RawImportRow {
	t.Helper()
	rows, err := repository.ListRawImportRows(nil, uid, batchId)

	if err != nil {
		t.Fatalf("list DEDUP-101 rows: %v", err)
	}

	return rows
}

func assertDedupBatchCounts(t *testing.T, batch *importing.ImportBatch, total int64, valid int64, invalid int64, duplicate int64, conflict int64, pending int64) {
	t.Helper()

	if batch.TotalRowCount != total || batch.ValidRowCount != valid || batch.InvalidRowCount != invalid ||
		batch.ExactDuplicateRowCount != duplicate || batch.IdentityConflictRowCount != conflict ||
		batch.PendingRowCount != pending || batch.PostedRowCount != 0 {
		t.Fatalf("unexpected DEDUP-101 batch counts: %+v", batch)
	}
}

func assertDedupRowStates(t *testing.T, rows []*importing.RawImportRow, expected []importing.IdentityState) {
	t.Helper()

	if len(rows) != len(expected) {
		t.Fatalf("unexpected DEDUP-101 row count %d", len(rows))
	}

	for index := range rows {
		if rows[index].RowNumber != int64(index+1) || rows[index].IdentityState != expected[index] {
			t.Fatalf("unexpected DEDUP-101 row %d state: %+v", index+1, rows[index])
		}
	}
}

func countDedupBeans(t *testing.T, database *datastore.Database, uid int64, bean any) int64 {
	t.Helper()
	session := database.NewPrivacySession(nil)
	defer session.Close()
	count, err := session.Where("uid=?", uid).Count(bean)

	if err != nil {
		t.Fatalf("count DEDUP-101 %T records: %v", bean, err)
	}

	return count
}

func TestDedupServiceErrorsNeverEchoRawEvidence(t *testing.T) {
	sensitive := "raw-redaction-canary"
	repository := &failingDedupRepository{err: errors.New(sensitive)}
	service := newDedupTestService(t, repository, 12000)
	candidate, _ := dedupSourceAccountEvidence(t)
	repository.file = &importing.ImportFile{
		Uid:          1,
		FileId:       2,
		FileSha256:   strings.Repeat("1", 64),
		ContentState: importing.IMPORT_FILE_CONTENT_STATE_AVAILABLE,
	}
	repository.account = &importing.SourceAccount{
		Uid:                     1,
		SourceAccountId:         3,
		SourceType:              importing.SOURCE_TYPE_ALIPAY,
		SourceAccountKey:        strings.Repeat("a", 64),
		SourceAccountKeyVersion: importing.SOURCE_ACCOUNT_KEY_VERSION_V1,
		Status:                  importing.SOURCE_ACCOUNT_STATUS_ACTIVE,
	}
	document := dedupEvidenceDocument(candidate, []importing.EvidenceRow{dedupValidRow(1, "private", 100, false)})
	request := dedupPersistRequest(1, 2, 3, "privacy_test", document)
	request.Document.Metadata.SourceAccount = importing.SourceAccountCandidate{
		Kind:            importing.SOURCE_ACCOUNT_EVIDENCE_MISSING,
		DiscoveryMethod: importing.SOURCE_ACCOUNT_DISCOVERY_MISSING,
	}
	_, err := service.PersistEvidenceDocument(nil, request)

	if !errors.Is(err, importing.ErrImportPersistenceUnavailable) || strings.Contains(err.Error(), sensitive) {
		t.Fatalf("persistence error exposed raw evidence: %v", err)
	}
}

type failingDedupRepository struct {
	file    *importing.ImportFile
	account *importing.SourceAccount
	err     error
}

func (r *failingDedupRepository) FindImportFileById(core.Context, int64, int64) (*importing.ImportFile, error) {
	return r.file, nil
}

func (r *failingDedupRepository) FindSourceAccountById(core.Context, int64, int64) (*importing.SourceAccount, error) {
	return r.account, nil
}

func (r *failingDedupRepository) PersistEvidenceBatch(core.Context, *importing.EvidenceBatchPersistence) error {
	return r.err
}
