package importing

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
)

func TestUploadImportFileIsDurableIdempotentAndIsolatedByUID(t *testing.T) {
	repository := newMemoryImportRepository()
	objectStorage := newMemoryImportFileStorage()
	service := newTestImportService(t, repository, objectStorage)
	content := []byte{0x01, 0x02, 0x03, 0x04}

	first, err := service.UploadImportFile(nil, testImportFileUpload(101, "fixture.csv", content))

	if err != nil {
		t.Fatalf("first upload failed: %v", err)
	}

	if first.Duplicate || first.Recovered || first.File.ContentState != IMPORT_FILE_CONTENT_STATE_AVAILABLE {
		t.Fatalf("first upload returned an invalid durable state")
	}

	if strings.Contains(first.File.StorageObjectKey, "fixture") || !isOpaqueTestObjectKey(first.File.StorageObjectKey, availableObjectKeyPrefix) {
		t.Fatalf("final storage key is not opaque")
	}

	storedContent := objectStorage.content(first.File.StorageObjectKey)

	if !bytes.Equal(storedContent, content) {
		t.Fatalf("final object content changed")
	}

	repository.mutex.Lock()
	repository.batches[memoryImportKey(101, 9001)] = &ImportBatch{
		Uid:             101,
		BatchId:         9001,
		FileId:          first.File.FileId,
		CreatedUnixTime: 1700000001,
	}
	repository.mutex.Unlock()

	second, err := service.UploadImportFile(nil, testImportFileUpload(101, "renamed.csv", content))

	if err != nil {
		t.Fatalf("idempotent upload failed: %v", err)
	}

	if !second.Duplicate || second.Recovered || second.File.FileId != first.File.FileId ||
		second.LatestBatch == nil || second.LatestBatch.BatchId != 9001 {
		t.Fatalf("same uid and content did not return the existing file")
	}

	otherUser, err := service.UploadImportFile(nil, testImportFileUpload(202, "fixture.csv", content))

	if err != nil {
		t.Fatalf("other-user upload failed: %v", err)
	}

	if otherUser.Duplicate || otherUser.File.FileId == first.File.FileId {
		t.Fatalf("file identity escaped uid isolation")
	}

	if _, err := service.GetImportFile(nil, 101, otherUser.File.FileId); !errors.Is(err, ErrImportFileNotFound) {
		t.Fatalf("cross-user file id was visible")
	}

	if repository.fileCount(101) != 1 || repository.fileCount(202) != 1 {
		t.Fatalf("idempotent upload created an unexpected file count")
	}

	if objectStorage.temporaryObjectCount() != 0 {
		t.Fatalf("temporary objects were not compensated")
	}
}

func TestUploadImportFilePromotionFailureIsRetryable(t *testing.T) {
	repository := newMemoryImportRepository()
	objectStorage := newMemoryImportFileStorage()
	objectStorage.failPromoteCount = 1
	objectStorage.promoteError = errors.New("backend rejected opaque object")
	service := newTestImportService(t, repository, objectStorage)
	content := []byte{0x11, 0x12, 0x13}
	upload := testImportFileUpload(303, "retry.csv", content)

	_, err := service.UploadImportFile(nil, upload)

	if !errors.Is(err, ErrImportStorageUnavailable) || strings.Contains(err.Error(), "backend") {
		t.Fatalf("storage failure was not returned as a stable safe error")
	}

	failed := repository.fileByContent(303, content)

	if failed == nil || failed.ContentState != IMPORT_FILE_CONTENT_STATE_FAILED {
		t.Fatalf("failed promotion left a false completed state")
	}

	result, err := service.UploadImportFile(nil, upload)

	if err != nil {
		t.Fatalf("retry upload failed: %v", err)
	}

	if !result.Duplicate || !result.Recovered || result.File.FileId != failed.FileId ||
		result.File.ContentState != IMPORT_FILE_CONTENT_STATE_AVAILABLE {
		t.Fatalf("retry did not recover the existing file record")
	}

	if objectStorage.temporaryObjectCount() != 0 {
		t.Fatalf("retry left temporary objects")
	}
}

func TestUploadImportFileRepairsMissingAvailableObject(t *testing.T) {
	repository := newMemoryImportRepository()
	objectStorage := newMemoryImportFileStorage()
	service := newTestImportService(t, repository, objectStorage)
	content := []byte{0x21, 0x22, 0x23}
	upload := testImportFileUpload(404, "repair.csv", content)

	first, err := service.UploadImportFile(nil, upload)

	if err != nil {
		t.Fatalf("initial upload failed: %v", err)
	}

	objectStorage.remove(first.File.StorageObjectKey)
	result, err := service.UploadImportFile(nil, upload)

	if err != nil {
		t.Fatalf("repair upload failed: %v", err)
	}

	if !result.Duplicate || !result.Recovered || result.File.FileId != first.File.FileId ||
		result.File.ContentState != IMPORT_FILE_CONTENT_STATE_AVAILABLE {
		t.Fatalf("missing final object was not repaired in place")
	}

	if !bytes.Equal(objectStorage.content(result.File.StorageObjectKey), content) {
		t.Fatalf("repaired final object content changed")
	}
}

func TestUploadImportFileRestoresDeletedContent(t *testing.T) {
	repository := newMemoryImportRepository()
	objectStorage := newMemoryImportFileStorage()
	service := newTestImportService(t, repository, objectStorage)
	content := []byte{0x24, 0x25, 0x26}
	upload := testImportFileUpload(405, "restore.csv", content)

	first, err := service.UploadImportFile(nil, upload)

	if err != nil {
		t.Fatalf("initial upload failed: %v", err)
	}

	deletedUnixTime := int64(1700000001)
	repository.mutex.Lock()
	stored := repository.files[memoryImportKey(405, first.File.FileId)]
	stored.ContentState = IMPORT_FILE_CONTENT_STATE_DELETED
	stored.ContentDeletedUnixTime = &deletedUnixTime
	repository.mutex.Unlock()
	objectStorage.remove(first.File.StorageObjectKey)

	restored, err := service.UploadImportFile(nil, upload)

	if err != nil {
		t.Fatalf("restore upload failed: %v", err)
	}

	if !restored.Duplicate || !restored.Recovered || restored.File.FileId != first.File.FileId ||
		restored.File.ContentState != IMPORT_FILE_CONTENT_STATE_AVAILABLE || restored.File.ContentDeletedUnixTime != nil {
		t.Fatalf("deleted content was not restored on the existing file identity")
	}
}

func TestUploadImportFileDatabaseFinalizationFailureStaysRecoverable(t *testing.T) {
	repository := newMemoryImportRepository()
	repository.failAvailableUpdateCount = 1
	objectStorage := newMemoryImportFileStorage()
	service := newTestImportService(t, repository, objectStorage)
	content := []byte{0x31, 0x32, 0x33}
	upload := testImportFileUpload(505, "finalize.csv", content)

	_, err := service.UploadImportFile(nil, upload)

	if !errors.Is(err, ErrImportPersistenceUnavailable) {
		t.Fatalf("database finalization failure returned the wrong error")
	}

	pending := repository.fileByContent(505, content)

	if pending == nil || pending.ContentState != IMPORT_FILE_CONTENT_STATE_PENDING {
		t.Fatalf("database failure left a false completed state")
	}

	if !bytes.Equal(objectStorage.content(pending.StorageObjectKey), content) {
		t.Fatalf("pending database state cannot recover its final object")
	}

	result, err := service.UploadImportFile(nil, upload)

	if err != nil {
		t.Fatalf("database finalization retry failed: %v", err)
	}

	if !result.Duplicate || !result.Recovered || result.File.FileId != pending.FileId ||
		result.File.ContentState != IMPORT_FILE_CONTENT_STATE_AVAILABLE {
		t.Fatalf("database finalization retry did not converge")
	}
}

func TestUploadImportFileConcurrentSameContentConverges(t *testing.T) {
	repository := newMemoryImportRepository()
	objectStorage := newMemoryImportFileStorage()
	service := newTestImportService(t, repository, objectStorage)
	upload := testImportFileUpload(555, "concurrent.csv", []byte{0x35, 0x36, 0x37})
	const uploadCount = 16
	start := make(chan struct{})
	results := make(chan *ImportFileUploadResult, uploadCount)
	errorsChannel := make(chan error, uploadCount)
	var workers sync.WaitGroup

	for index := 0; index < uploadCount; index++ {
		workers.Add(1)

		go func() {
			defer workers.Done()
			<-start
			result, err := service.UploadImportFile(nil, upload)
			results <- result
			errorsChannel <- err
		}()
	}

	close(start)
	workers.Wait()
	close(results)
	close(errorsChannel)

	for err := range errorsChannel {
		if err != nil {
			t.Fatalf("concurrent upload failed: %v", err)
		}
	}

	var durableFileId int64

	for result := range results {
		if result == nil || result.File == nil || result.File.ContentState != IMPORT_FILE_CONTENT_STATE_AVAILABLE {
			t.Fatalf("concurrent upload returned a non-durable result")
		}

		if durableFileId == 0 {
			durableFileId = result.File.FileId
		} else if durableFileId != result.File.FileId {
			t.Fatalf("concurrent upload returned multiple file identities")
		}
	}

	if repository.fileCount(555) != 1 || objectStorage.temporaryObjectCount() != 0 {
		t.Fatalf("concurrent upload did not converge cleanly")
	}

	if objectStorage.promotionCount() != 1 {
		t.Fatalf("same final object was promoted more than once")
	}
}

func TestNormalizeImportFileUploadRejectsUnsafeMetadata(t *testing.T) {
	valid := testImportFileUpload(606, "fixture.csv", []byte{0x41})

	tests := []ImportFileUpload{
		{Uid: 0, OriginalFileName: valid.OriginalFileName, MimeType: valid.MimeType, CreatedIp: valid.CreatedIp, Content: valid.Content},
		{Uid: valid.Uid, OriginalFileName: ".", MimeType: valid.MimeType, CreatedIp: valid.CreatedIp, Content: valid.Content},
		{Uid: valid.Uid, OriginalFileName: "..", MimeType: valid.MimeType, CreatedIp: valid.CreatedIp, Content: valid.Content},
		{Uid: valid.Uid, OriginalFileName: "unsafe\nname.csv", MimeType: valid.MimeType, CreatedIp: valid.CreatedIp, Content: valid.Content},
		{Uid: valid.Uid, OriginalFileName: "fixture.bad-extension", MimeType: valid.MimeType, CreatedIp: valid.CreatedIp, Content: valid.Content},
		{Uid: valid.Uid, OriginalFileName: valid.OriginalFileName, MimeType: "not a mime", CreatedIp: valid.CreatedIp, Content: valid.Content},
		{Uid: valid.Uid, OriginalFileName: valid.OriginalFileName, MimeType: valid.MimeType, CreatedIp: "not-an-ip", Content: valid.Content},
	}

	for index, upload := range tests {
		if _, err := normalizeImportFileUpload(upload); !errors.Is(err, ErrImportRequestInvalid) {
			t.Fatalf("unsafe upload metadata case %d was accepted", index)
		}
	}
}

func TestUploadImportFileRejectsNonOpaqueGeneratedKey(t *testing.T) {
	repository := newMemoryImportRepository()
	objectStorage := newMemoryImportFileStorage()
	service := newTestImportService(t, repository, objectStorage)
	service.randomHex = func(int) (string, error) {
		return "../predictable-name", nil
	}

	_, err := service.UploadImportFile(nil, testImportFileUpload(607, "fixture.csv", []byte{0x42}))

	if !errors.Is(err, ErrImportIdentifierUnavailable) || repository.fileCount(607) != 0 || objectStorage.temporaryObjectCount() != 0 {
		t.Fatalf("non-opaque generated key was accepted")
	}
}

func TestImportPageOffsetUsesRepositoryPageConvention(t *testing.T) {
	tests := []struct {
		name           string
		page           int32
		count          int32
		expectedOffset int
		expectedLimit  int
	}{
		{name: "default page and count", page: 0, count: 0, expectedOffset: 0, expectedLimit: int(defaultImportPageSize)},
		{name: "explicit first page", page: 1, count: 1, expectedOffset: 0, expectedLimit: 1},
		{name: "second page", page: 2, count: 1, expectedOffset: 1, expectedLimit: 1},
		{name: "second page with default count", page: 2, count: 0, expectedOffset: int(defaultImportPageSize), expectedLimit: int(defaultImportPageSize)},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			offset, limit, err := importPageOffset(test.page, test.count)

			if err != nil || offset != test.expectedOffset || limit != test.expectedLimit {
				t.Fatalf("unexpected page offset: offset=%d limit=%d", offset, limit)
			}
		})
	}

	if _, _, err := importPageOffset(-1, 1); !errors.Is(err, ErrImportRequestInvalid) {
		t.Fatalf("negative page was accepted")
	}
}

func TestImportQueriesUseUIDIsolationAndStablePagination(t *testing.T) {
	repository := newMemoryImportRepository()
	objectStorage := newMemoryImportFileStorage()
	service := newTestImportService(t, repository, objectStorage)
	fileOne := &ImportFile{Uid: 701, FileId: 101, FileSha256: strings.Repeat("1", 64), ContentState: IMPORT_FILE_CONTENT_STATE_AVAILABLE, StorageObjectKey: "objects/" + strings.Repeat("a", 64), CreatedUnixTime: 10}
	fileTwo := &ImportFile{Uid: 701, FileId: 102, FileSha256: strings.Repeat("2", 64), ContentState: IMPORT_FILE_CONTENT_STATE_AVAILABLE, StorageObjectKey: "objects/" + strings.Repeat("b", 64), CreatedUnixTime: 10}
	otherFile := &ImportFile{Uid: 702, FileId: 201, FileSha256: strings.Repeat("1", 64), ContentState: IMPORT_FILE_CONTENT_STATE_AVAILABLE, StorageObjectKey: "objects/" + strings.Repeat("c", 64), CreatedUnixTime: 99}
	repository.files[memoryImportKey(701, 101)] = cloneImportFile(fileOne)
	repository.files[memoryImportKey(701, 102)] = cloneImportFile(fileTwo)
	repository.files[memoryImportKey(702, 201)] = cloneImportFile(otherFile)
	repository.batches[memoryImportKey(701, 301)] = &ImportBatch{Uid: 701, BatchId: 301, FileId: 101, CreatedUnixTime: 20}
	repository.batches[memoryImportKey(701, 302)] = &ImportBatch{Uid: 701, BatchId: 302, FileId: 102, CreatedUnixTime: 20}
	repository.batches[memoryImportKey(702, 401)] = &ImportBatch{Uid: 702, BatchId: 401, FileId: 201, CreatedUnixTime: 99}
	repository.rows[memoryImportKey(701, 501)] = &RawImportRow{Uid: 701, RowId: 501, BatchId: 301, RowNumber: 2, RawFieldsJson: "[]", IssuesJson: "[]"}
	repository.rows[memoryImportKey(701, 502)] = &RawImportRow{Uid: 701, RowId: 502, BatchId: 301, RowNumber: 1, RawFieldsJson: "[]", IssuesJson: "[]"}
	repository.rows[memoryImportKey(702, 601)] = &RawImportRow{Uid: 702, RowId: 601, BatchId: 401, RowNumber: 1, RawFieldsJson: "[]", IssuesJson: "[]"}

	defaultFilePage, err := service.ListImportFiles(nil, 701, 0, 1)

	if err != nil || defaultFilePage.TotalCount != 2 || len(defaultFilePage.Items) != 1 || defaultFilePage.Items[0].FileId != 102 {
		t.Fatalf("default file page is invalid")
	}

	firstFilePage, err := service.ListImportFiles(nil, 701, 1, 1)

	if err != nil || firstFilePage.TotalCount != 2 || len(firstFilePage.Items) != 1 || firstFilePage.Items[0].FileId != 102 {
		t.Fatalf("explicit first file page is invalid")
	}

	secondFilePage, err := service.ListImportFiles(nil, 701, 2, 1)

	if err != nil || len(secondFilePage.Items) != 1 || secondFilePage.Items[0].FileId != 101 {
		t.Fatalf("second file page is invalid")
	}

	defaultBatchPage, err := service.ListImportBatches(nil, 701, 0, 0, 1)

	if err != nil || defaultBatchPage.TotalCount != 2 || len(defaultBatchPage.Items) != 1 || defaultBatchPage.Items[0].Batch.BatchId != 302 {
		t.Fatalf("default batch page is invalid")
	}

	firstBatchPage, err := service.ListImportBatches(nil, 701, 0, 1, 1)

	if err != nil || firstBatchPage.TotalCount != 2 || len(firstBatchPage.Items) != 1 || firstBatchPage.Items[0].Batch.BatchId != 302 {
		t.Fatalf("explicit first batch page is invalid")
	}

	secondBatchPage, err := service.ListImportBatches(nil, 701, 0, 2, 1)

	if err != nil || len(secondBatchPage.Items) != 1 || secondBatchPage.Items[0].Batch.BatchId != 301 {
		t.Fatalf("second stable batch page is invalid")
	}

	if _, err := service.GetImportBatch(nil, 701, 401); !errors.Is(err, ErrImportBatchNotFound) {
		t.Fatalf("cross-user batch id was visible")
	}

	defaultRowPage, err := service.ListRawImportRows(nil, 701, 301, 0, 1, false)

	if err != nil || defaultRowPage.TotalCount != 2 || len(defaultRowPage.Items) != 1 || defaultRowPage.Items[0].RowId != 502 {
		t.Fatalf("default row page is invalid")
	}

	firstRowPage, err := service.ListRawImportRows(nil, 701, 301, 1, 1, false)

	if err != nil || firstRowPage.TotalCount != 2 || len(firstRowPage.Items) != 1 || firstRowPage.Items[0].RowId != 502 {
		t.Fatalf("explicit first row page is invalid")
	}

	secondRowPage, err := service.ListRawImportRows(nil, 701, 301, 2, 1, true)

	if err != nil || len(secondRowPage.Items) != 1 || secondRowPage.Items[0].RowId != 501 || secondRowPage.Batch.File.FileId != 101 {
		t.Fatalf("second stable row page is invalid")
	}

	if _, err := service.ListRawImportRows(nil, 701, 401, 0, 20, false); !errors.Is(err, ErrImportBatchNotFound) {
		t.Fatalf("cross-user row query was visible")
	}
}

func TestRawSnapshotValidationDoesNotEchoSensitiveContent(t *testing.T) {
	repository := newMemoryImportRepository()
	service := newTestImportService(t, repository, newMemoryImportFileStorage())
	file := &ImportFile{Uid: 801, FileId: 101, FileSha256: strings.Repeat("1", 64), ContentState: IMPORT_FILE_CONTENT_STATE_AVAILABLE, StorageObjectKey: "objects/" + strings.Repeat("a", 64)}
	repository.files[memoryImportKey(801, 101)] = file
	repository.batches[memoryImportKey(801, 301)] = &ImportBatch{Uid: 801, BatchId: 301, FileId: 101}
	sensitive := "raw-redaction-canary"
	repository.rows[memoryImportKey(801, 501)] = &RawImportRow{Uid: 801, RowId: 501, BatchId: 301, RowNumber: 1, RawFieldsJson: sensitive, IssuesJson: "[]"}

	_, err := service.ListRawImportRows(nil, 801, 301, 0, 20, true)

	if !errors.Is(err, ErrImportEvidenceUnavailable) || strings.Contains(err.Error(), sensitive) {
		t.Fatalf("invalid raw snapshot leaked its content")
	}

	page, err := service.ListRawImportRows(nil, 801, 301, 0, 20, false)

	if err != nil || len(page.Items) != 1 || page.Items[0].RawFieldsJson != "" || page.Items[0].IssuesJson != "" {
		t.Fatalf("summary row query should not decode raw snapshots")
	}
}

func newTestImportService(t *testing.T, repository ImportRepository, objectStorage ImportFileStorage) *ImportService {
	t.Helper()
	var nextId atomic.Int64
	nextId.Store(1000)
	service, err := NewImportService(repository, objectStorage, func() int64 {
		return nextId.Add(1)
	})

	if err != nil {
		t.Fatalf("create import service: %v", err)
	}

	service.now = func() time.Time { return time.Unix(1700000000, 0) }
	return service
}

func testImportFileUpload(uid int64, fileName string, content []byte) ImportFileUpload {
	return ImportFileUpload{
		Uid:              uid,
		OriginalFileName: fileName,
		MimeType:         "text/csv; charset=utf-8",
		CreatedIp:        "192.0.2.10",
		Content:          append([]byte(nil), content...),
	}
}

func isOpaqueTestObjectKey(objectKey string, prefix string) bool {
	parts := strings.Split(objectKey, "/")

	if len(parts) != 2 || parts[0] != prefix || len(parts[1]) != opaqueObjectKeyRandomBytes*2 {
		return false
	}

	_, err := hex.DecodeString(parts[1])
	return err == nil
}

type memoryImportRepository struct {
	mutex                    sync.Mutex
	files                    map[string]*ImportFile
	batches                  map[string]*ImportBatch
	rows                     map[string]*RawImportRow
	failAvailableUpdateCount int
}

func newMemoryImportRepository() *memoryImportRepository {
	return &memoryImportRepository{
		files:   make(map[string]*ImportFile),
		batches: make(map[string]*ImportBatch),
		rows:    make(map[string]*RawImportRow),
	}
}

func (r *memoryImportRepository) FindImportFileById(_ core.Context, uid int64, fileId int64) (*ImportFile, error) {
	r.mutex.Lock()
	defer r.mutex.Unlock()

	file := r.files[memoryImportKey(uid, fileId)]
	return cloneImportFile(file), nil
}

func (r *memoryImportRepository) FindImportFileBySHA256(_ core.Context, uid int64, fileSHA256 string) (*ImportFile, error) {
	r.mutex.Lock()
	defer r.mutex.Unlock()

	for _, file := range r.files {
		if file.Uid == uid && file.FileSha256 == fileSHA256 {
			return cloneImportFile(file), nil
		}
	}

	return nil, nil
}

func (r *memoryImportRepository) InsertImportFile(_ core.Context, file *ImportFile) error {
	r.mutex.Lock()
	defer r.mutex.Unlock()

	for _, existing := range r.files {
		if existing.Uid == file.Uid && existing.FileSha256 == file.FileSha256 {
			return errors.New("unique import file")
		}
	}

	key := memoryImportKey(file.Uid, file.FileId)

	if r.files[key] != nil {
		return errors.New("duplicate import file id")
	}

	r.files[key] = cloneImportFile(file)
	return nil
}

func (r *memoryImportRepository) UpdateImportFileContentState(_ core.Context, uid int64, fileId int64, expectedStates []ImportFileContentState, nextState ImportFileContentState, updatedUnixTime int64) (bool, error) {
	r.mutex.Lock()
	defer r.mutex.Unlock()

	if nextState == IMPORT_FILE_CONTENT_STATE_AVAILABLE && r.failAvailableUpdateCount > 0 {
		r.failAvailableUpdateCount--
		return false, errors.New("database finalization failed")
	}

	file := r.files[memoryImportKey(uid, fileId)]

	if file == nil || !containsImportFileContentState(expectedStates, file.ContentState) {
		return false, nil
	}

	file.ContentState = nextState
	file.UpdatedUnixTime = updatedUnixTime

	if nextState == IMPORT_FILE_CONTENT_STATE_PENDING && containsImportFileContentState(expectedStates, IMPORT_FILE_CONTENT_STATE_DELETED) {
		file.ContentDeletedUnixTime = nil
	}

	return true, nil
}

func (r *memoryImportRepository) ListImportFiles(_ core.Context, uid int64, offset int, limit int) ([]*ImportFile, int64, error) {
	r.mutex.Lock()
	defer r.mutex.Unlock()

	files := make([]*ImportFile, 0)

	for _, file := range r.files {
		if file.Uid == uid {
			files = append(files, cloneImportFile(file))
		}
	}

	sort.Slice(files, func(i, j int) bool {
		if files[i].CreatedUnixTime != files[j].CreatedUnixTime {
			return files[i].CreatedUnixTime > files[j].CreatedUnixTime
		}

		return files[i].FileId > files[j].FileId
	})

	return pageImportFiles(files, offset, limit), int64(len(files)), nil
}

func (r *memoryImportRepository) FindImportBatchById(_ core.Context, uid int64, batchId int64) (*ImportBatch, error) {
	r.mutex.Lock()
	defer r.mutex.Unlock()

	batch := r.batches[memoryImportKey(uid, batchId)]

	if batch == nil {
		return nil, nil
	}

	copy := *batch
	return &copy, nil
}

func (r *memoryImportRepository) FindCardHeaderByBatch(_ core.Context, _ int64, _ int64) (*CardHeader, error) {
	return nil, nil
}

func (r *memoryImportRepository) FindLatestImportBatchByFileId(_ core.Context, uid int64, fileId int64) (*ImportBatch, error) {
	r.mutex.Lock()
	defer r.mutex.Unlock()

	var latest *ImportBatch

	for _, batch := range r.batches {
		if batch.Uid != uid || batch.FileId != fileId {
			continue
		}

		if latest == nil || batch.CreatedUnixTime > latest.CreatedUnixTime ||
			(batch.CreatedUnixTime == latest.CreatedUnixTime && batch.BatchId > latest.BatchId) {
			copy := *batch
			latest = &copy
		}
	}

	return latest, nil
}

func (r *memoryImportRepository) ListImportBatchIssues(_ core.Context, _ int64, _ int64) ([]*ImportBatchIssue, error) {
	return []*ImportBatchIssue{}, nil
}

func (r *memoryImportRepository) ListImportBatches(_ core.Context, uid int64, fileId int64, offset int, limit int) ([]*ImportBatch, int64, error) {
	r.mutex.Lock()
	defer r.mutex.Unlock()

	batches := make([]*ImportBatch, 0)

	for _, batch := range r.batches {
		if batch.Uid == uid && (fileId == 0 || batch.FileId == fileId) {
			copy := *batch
			batches = append(batches, &copy)
		}
	}

	sort.Slice(batches, func(i, j int) bool {
		if batches[i].CreatedUnixTime != batches[j].CreatedUnixTime {
			return batches[i].CreatedUnixTime > batches[j].CreatedUnixTime
		}

		return batches[i].BatchId > batches[j].BatchId
	})

	total := len(batches)

	if offset >= total {
		return []*ImportBatch{}, int64(total), nil
	}

	end := offset + limit

	if end > total {
		end = total
	}

	return batches[offset:end], int64(total), nil
}

func (r *memoryImportRepository) ListRawImportRowsPage(_ core.Context, uid int64, batchId int64, offset int, limit int) ([]*RawImportRow, int64, error) {
	r.mutex.Lock()
	defer r.mutex.Unlock()

	rows := make([]*RawImportRow, 0)

	for _, row := range r.rows {
		if row.Uid == uid && row.BatchId == batchId {
			copy := *row
			rows = append(rows, &copy)
		}
	}

	sort.Slice(rows, func(i, j int) bool {
		if rows[i].RowNumber != rows[j].RowNumber {
			return rows[i].RowNumber < rows[j].RowNumber
		}

		return rows[i].RowId < rows[j].RowId
	})

	total := len(rows)

	if offset >= total {
		return []*RawImportRow{}, int64(total), nil
	}

	end := offset + limit

	if end > total {
		end = total
	}

	return rows[offset:end], int64(total), nil
}

func (r *memoryImportRepository) fileByContent(uid int64, content []byte) *ImportFile {
	digest := sha256.Sum256(content)
	file, _ := r.FindImportFileBySHA256(nil, uid, hex.EncodeToString(digest[:]))
	return file
}

func (r *memoryImportRepository) fileCount(uid int64) int {
	r.mutex.Lock()
	defer r.mutex.Unlock()

	count := 0

	for _, file := range r.files {
		if file.Uid == uid {
			count++
		}
	}

	return count
}

func memoryImportKey(uid int64, id int64) string {
	return fmt.Sprintf("%d:%d", uid, id)
}

func cloneImportFile(file *ImportFile) *ImportFile {
	if file == nil {
		return nil
	}

	copy := *file

	if file.ContentDeletedUnixTime != nil {
		deleted := *file.ContentDeletedUnixTime
		copy.ContentDeletedUnixTime = &deleted
	}

	return &copy
}

func pageImportFiles(files []*ImportFile, offset int, limit int) []*ImportFile {
	if offset >= len(files) {
		return []*ImportFile{}
	}

	end := offset + limit

	if end > len(files) {
		end = len(files)
	}

	return files[offset:end]
}

type memoryImportFileStorage struct {
	mutex            sync.Mutex
	objects          map[string][]byte
	promoteCount     int
	failPromoteCount int
	promoteError     error
}

func newMemoryImportFileStorage() *memoryImportFileStorage {
	return &memoryImportFileStorage{objects: make(map[string][]byte)}
}

func (s *memoryImportFileStorage) SaveTemporary(_ core.Context, temporaryObjectKey string, content []byte) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.objects[temporaryObjectKey] = append([]byte(nil), content...)
	return nil
}

func (s *memoryImportFileStorage) Promote(_ core.Context, temporaryObjectKey string, availableObjectKey string) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.promoteCount++

	if s.failPromoteCount > 0 {
		s.failPromoteCount--

		if s.promoteError != nil {
			return s.promoteError
		}

		return errors.New("promotion failed")
	}

	content, exists := s.objects[temporaryObjectKey]

	if !exists {
		return errors.New("temporary object missing")
	}

	s.objects[availableObjectKey] = append([]byte(nil), content...)
	return nil
}

func (s *memoryImportFileStorage) Verify(_ core.Context, objectKey string, expectedSHA256 string, expectedSize int64) (bool, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	content, exists := s.objects[objectKey]

	if !exists {
		return false, nil
	}

	digest := sha256.Sum256(content)
	return int64(len(content)) == expectedSize && hex.EncodeToString(digest[:]) == expectedSHA256, nil
}

func (s *memoryImportFileStorage) Delete(_ core.Context, objectKey string) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	delete(s.objects, objectKey)
	return nil
}

func (s *memoryImportFileStorage) content(objectKey string) []byte {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return append([]byte(nil), s.objects[objectKey]...)
}

func (s *memoryImportFileStorage) remove(objectKey string) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	delete(s.objects, objectKey)
}

func (s *memoryImportFileStorage) temporaryObjectCount() int {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	count := 0

	for objectKey := range s.objects {
		if strings.HasPrefix(objectKey, temporaryObjectKeyPrefix+"/") {
			count++
		}
	}

	return count
}

func (s *memoryImportFileStorage) promotionCount() int {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.promoteCount
}
