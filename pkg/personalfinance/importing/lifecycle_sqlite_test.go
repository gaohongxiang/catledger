package importing_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func TestLifecycleSQLiteDiscardDeleteRetryStatisticsAndClear(t *testing.T) {
	repository, database := newSQLiteRepository(t)
	const uid = int64(7101)
	const otherUID = int64(7202)
	file := testImportFile(uid, 7301, "a", 10)
	file.FileSha256 = lifecycleDigestText([]byte("aaaa"))
	otherFile := testImportFile(otherUID, 7302, "b", 10)
	otherFile.FileSha256 = lifecycleDigestText([]byte("bbbb"))
	insertImportFile(t, repository, file)
	insertImportFile(t, repository, otherFile)
	markLifecycleFileAvailable(t, repository, uid, file.FileId)
	markLifecycleFileAvailable(t, repository, otherUID, otherFile.FileId)
	batch := testImportBatch(uid, 7401, file.FileId, 20)
	batch.Status = importing.IMPORT_BATCH_STATUS_READY
	otherBatch := testImportBatch(otherUID, 7402, otherFile.FileId, 20)
	otherBatch.Status = importing.IMPORT_BATCH_STATUS_READY
	row := testRawImportRow(uid, 7501, batch.BatchId, 1)
	batch.TotalRowCount = 1
	batch.InvalidRowCount = 1
	insertRepositoryBeans(t, database, batch, otherBatch, row)

	storage := newLifecycleTestStorage()
	storage.put(file.StorageObjectKey, []byte("aaaa"))
	storage.put(otherFile.StorageObjectKey, []byte("bbbb"))
	failingRepository := &failDeletedFinalizationRepository{Repository: repository, failOnce: true}
	service, err := importing.NewLifecycleService(failingRepository, storage, storage)
	if err != nil {
		t.Fatalf("create lifecycle service: %v", err)
	}

	discarded, err := service.DiscardImportBatch(nil, uid, batch.BatchId)
	if err != nil || discarded.Status != importing.IMPORT_BATCH_STATUS_DISCARDED {
		t.Fatalf("discard ready batch: %+v %v", discarded, err)
	}
	if _, err = service.DiscardImportBatch(nil, uid, batch.BatchId); err != nil {
		t.Fatalf("repeat discard was not idempotent: %v", err)
	}
	if _, err = service.DiscardImportBatch(nil, uid, otherBatch.BatchId); !errors.Is(err, importing.ErrImportBatchNotFound) {
		t.Fatalf("cross-user discard exposed a foreign batch: %v", err)
	}

	storage.failDeleteOnce = true
	if _, err = service.DeleteImportFileContent(nil, uid, file.FileId); !errors.Is(err, importing.ErrImportStorageUnavailable) {
		t.Fatalf("object deletion failure returned the wrong error: %v", err)
	}
	current, err := repository.FindImportFileById(nil, uid, file.FileId)
	if err != nil || current == nil || current.ContentState != importing.IMPORT_FILE_CONTENT_STATE_AVAILABLE {
		t.Fatalf("object deletion failure advanced database state: %+v %v", current, err)
	}
	if _, err = service.DeleteImportFileContent(nil, uid, file.FileId); !errors.Is(err, importing.ErrImportPersistenceUnavailable) {
		t.Fatalf("database finalization failure returned the wrong error: %v", err)
	}
	deleted, err := service.DeleteImportFileContent(nil, uid, file.FileId)
	if err != nil || deleted.ContentState != importing.IMPORT_FILE_CONTENT_STATE_DELETED || deleted.ContentDeletedUnixTime == nil {
		t.Fatalf("delete retry did not close the state machine: %+v %v", deleted, err)
	}
	if _, err = repository.FindImportBatchById(nil, uid, batch.BatchId); err != nil {
		t.Fatalf("content deletion removed batch evidence: %v", err)
	}
	rows, err := repository.ListRawImportRows(nil, uid, batch.BatchId)
	if err != nil || len(rows) != 1 {
		t.Fatalf("content deletion removed row evidence: %v", err)
	}

	statistics, err := service.GetImportDataStatistics(nil, uid)
	if err != nil || statistics.ImportFileCount != 1 || statistics.ImportBatchCount != 1 || statistics.RawImportRowCount != 1 {
		t.Fatalf("personal finance statistics are incorrect: %+v %v", statistics, err)
	}
	report, err := service.CheckUserConsistency(nil, uid)
	if err != nil || !report.Healthy() {
		t.Fatalf("consistent lifecycle fixture was reported unhealthy: %+v %v", report, err)
	}
	encodedReport, err := json.Marshal(report)
	if err != nil || strings.Contains(string(encodedReport), file.StorageObjectKey) || strings.Contains(string(encodedReport), file.OriginalFileName) || strings.Contains(string(encodedReport), "storageObjectKey") {
		t.Fatalf("consistency aggregation exposed sensitive object metadata: %s %v", encodedReport, err)
	}
	if err = service.ClearUserData(nil, uid); err != nil {
		t.Fatalf("clear personal finance user data: %v", err)
	}
	if storage.has(file.StorageObjectKey) {
		t.Fatal("clear retained the user's registered original file")
	}
	statistics, err = service.GetImportDataStatistics(nil, uid)
	if err != nil || statistics.ImportFileCount != 0 || statistics.ImportBatchCount != 0 || statistics.RawImportRowCount != 0 {
		t.Fatalf("clear retained user PF data: %+v %v", statistics, err)
	}
	otherStatistics, err := service.GetImportDataStatistics(nil, otherUID)
	if err != nil || otherStatistics.ImportFileCount != 1 || !storage.has(otherFile.StorageObjectKey) {
		t.Fatalf("clear crossed uid boundary: %+v %v", otherStatistics, err)
	}
}

func TestLifecycleSQLiteRejectsLedgerImpactAndAggregatesUndoImpact(t *testing.T) {
	repository, database := newSQLiteRepository(t)
	if err := database.SyncStructs(new(models.Transaction)); err != nil {
		t.Fatalf("create transaction table: %v", err)
	}
	const uid = int64(8101)
	file := testImportFile(uid, 8201, "c", 10)
	file.FileSha256 = lifecycleDigestText([]byte("cccc"))
	insertImportFile(t, repository, file)
	markLifecycleFileAvailable(t, repository, uid, file.FileId)
	batch := testImportBatch(uid, 8301, file.FileId, 20)
	batch.Status = importing.IMPORT_BATCH_STATUS_READY
	batch.TotalRowCount = 1
	batch.ValidRowCount = 1
	batch.PostedRowCount = 1
	row := testRawImportRow(uid, 8401, batch.BatchId, 1)
	row.ParseState = importing.PARSE_STATE_VALID
	row.ProcessingState = importing.PROCESSING_STATE_LINKED
	row.IdentityState = importing.IDENTITY_STATE_NEW
	row.SemanticEligibility = importing.SEMANTIC_ELIGIBILITY_POSTABLE
	transaction := &models.Transaction{TransactionId: 8501, Uid: uid, Deleted: false, Type: models.TRANSACTION_DB_TYPE_EXPENSE, CategoryId: 1, AccountId: 1, TransactionTime: 1000, UpdatedUnixTime: 99}
	posting := &importing.ImportPosting{Uid: uid, BatchId: batch.BatchId, IdempotencyKeyDigest: repeatedDigest("d"), IdempotencyKeyVersion: importing.IDEMPOTENCY_KEY_VERSION_V1, RequestDigest: repeatedDigest("e"), RequestDigestVersion: importing.POSTING_REQUEST_VERSION_V1, Status: importing.IMPORT_POSTING_STATUS_COMPLETED, SelectedRowCount: 1, CreatedTransactionCount: 1, CreatedUnixTime: 30, UpdatedUnixTime: 30, PostingId: 8601}
	link := &importing.RawRowTransactionLink{Uid: uid, RowId: row.RowId, TransactionId: transaction.TransactionId, RelationRole: importing.RAW_ROW_TRANSACTION_RELATION_PRIMARY, CreationMethod: importing.RAW_ROW_TRANSACTION_CREATION_POSTING_CREATED, PostingId: posting.PostingId, RuleVersion: importing.POSTING_LINK_VERSION_V1, TransactionUpdatedUnixTime: 88, CreatedUnixTime: 30, LinkId: 8701}
	insertRepositoryBeans(t, database, batch, row, transaction, posting, link)
	storage := newLifecycleTestStorage()
	storage.put(file.StorageObjectKey, []byte("cccc"))
	service, _ := importing.NewLifecycleService(repository, storage, storage)
	if _, err := service.DiscardImportBatch(nil, uid, batch.BatchId); !errors.Is(err, importing.ErrImportBatchNotDiscardable) {
		t.Fatalf("batch with ledger impact was discardable: %v", err)
	}
	impact, err := service.GetUndoImpact(nil, uid, batch.BatchId)
	if err != nil || impact.LinkedTransactionCount != 1 || impact.PostingCreatedCount != 1 || impact.ModifiedTransactionCount != 1 || len(impact.ReasonCodes) < 2 {
		t.Fatalf("undo impact aggregation is incomplete: %+v %v", impact, err)
	}
}

type failDeletedFinalizationRepository struct {
	*importing.Repository
	failOnce bool
}

func (r *failDeletedFinalizationRepository) MarkImportFileContentDeleted(c core.Context, uid int64, fileId int64, now int64) (bool, error) {
	if r.failOnce {
		r.failOnce = false
		return false, errors.New("synthetic finalization failure")
	}
	return r.Repository.MarkImportFileContentDeleted(c, uid, fileId, now)
}

type lifecycleTestStorage struct {
	mutex          sync.Mutex
	objects        map[string][]byte
	failDeleteOnce bool
}

func newLifecycleTestStorage() *lifecycleTestStorage {
	return &lifecycleTestStorage{objects: make(map[string][]byte)}
}
func (s *lifecycleTestStorage) put(key string, value []byte) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.objects[key] = append([]byte(nil), value...)
}
func (s *lifecycleTestStorage) has(key string) bool {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	_, ok := s.objects[key]
	return ok
}
func (s *lifecycleTestStorage) SaveTemporary(core.Context, string, []byte) error { return nil }
func (s *lifecycleTestStorage) Promote(core.Context, string, string) error       { return nil }
func (s *lifecycleTestStorage) Verify(_ core.Context, key, expected string, size int64) (bool, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	value, ok := s.objects[key]
	if !ok || int64(len(value)) != size {
		return false, nil
	}
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:]) == expected, nil
}
func (s *lifecycleTestStorage) Delete(_ core.Context, key string) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if s.failDeleteOnce {
		s.failDeleteOnce = false
		return errors.New("synthetic object deletion failure")
	}
	delete(s.objects, key)
	return nil
}
func (s *lifecycleTestStorage) ListObjectKeys(core.Context) ([]string, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	keys := make([]string, 0, len(s.objects))
	for key := range s.objects {
		keys = append(keys, key)
	}
	return keys, nil
}

func repeatedDigest(character string) string {
	value := ""
	for len(value) < 64 {
		value += character
	}
	return value
}

func lifecycleDigestText(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func markLifecycleFileAvailable(t *testing.T, repository *importing.Repository, uid int64, fileId int64) {
	t.Helper()
	changed, err := repository.UpdateImportFileContentState(nil, uid, fileId, []importing.ImportFileContentState{importing.IMPORT_FILE_CONTENT_STATE_PENDING}, importing.IMPORT_FILE_CONTENT_STATE_AVAILABLE, 11)
	if err != nil || !changed {
		t.Fatalf("mark lifecycle file available: %v", err)
	}
}
