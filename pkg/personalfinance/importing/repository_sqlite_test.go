package importing_test

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/migrations"
	"github.com/gaohongxiang/catledger/pkg/settings"
)

func TestRepositorySQLiteUIDIsolationAndStablePagination(t *testing.T) {
	repository, database := newSQLiteRepository(t)
	assertRepositoryContract(t, repository, database)
}

func assertRepositoryContract(t *testing.T, repository *importing.Repository, database *datastore.Database) {
	t.Helper()
	firstUid := int64(1001)
	secondUid := int64(2002)
	insertImportFile(t, repository, testImportFile(firstUid, 101, "1", 10))
	insertImportFile(t, repository, testImportFile(firstUid, 102, "2", 10))
	insertImportFile(t, repository, testImportFile(secondUid, 201, "1", 99))

	files, totalCount, err := repository.ListImportFiles(nil, firstUid, 0, 1)

	if err != nil || totalCount != 2 || len(files) != 1 || files[0].FileId != 102 {
		t.Fatalf("first import file page is not stable")
	}

	files, totalCount, err = repository.ListImportFiles(nil, firstUid, 1, 1)

	if err != nil || totalCount != 2 || len(files) != 1 || files[0].FileId != 101 {
		t.Fatalf("second import file page is not stable")
	}

	if file, findErr := repository.FindImportFileById(nil, firstUid, 201); findErr != nil || file != nil {
		t.Fatalf("cross-user import file was visible")
	}

	changed, err := repository.UpdateImportFileContentState(
		nil,
		firstUid,
		201,
		[]importing.ImportFileContentState{importing.IMPORT_FILE_CONTENT_STATE_PENDING},
		importing.IMPORT_FILE_CONTENT_STATE_AVAILABLE,
		11,
	)

	if err != nil || changed {
		t.Fatalf("cross-user content state update was accepted")
	}

	changed, err = repository.UpdateImportFileContentState(
		nil,
		firstUid,
		101,
		[]importing.ImportFileContentState{importing.IMPORT_FILE_CONTENT_STATE_PENDING},
		importing.IMPORT_FILE_CONTENT_STATE_AVAILABLE,
		11,
	)

	if err != nil || !changed {
		t.Fatalf("owned content state update failed")
	}

	deletedUnixTime := int64(12)
	updateDeleted := &importing.ImportFile{
		ContentState:           importing.IMPORT_FILE_CONTENT_STATE_DELETED,
		UpdatedUnixTime:        deletedUnixTime,
		ContentDeletedUnixTime: &deletedUnixTime,
	}
	privacySession := database.NewPrivacySession(nil)
	updated, updateErr := privacySession.Where("uid=? AND file_id=?", firstUid, 101).
		Cols("content_state", "updated_unix_time", "content_deleted_unix_time").
		Update(updateDeleted)
	privacySession.Close()

	if updateErr != nil || updated != 1 {
		t.Fatalf("prepare deleted content state")
	}

	changed, err = repository.UpdateImportFileContentState(
		nil,
		firstUid,
		101,
		[]importing.ImportFileContentState{importing.IMPORT_FILE_CONTENT_STATE_DELETED},
		importing.IMPORT_FILE_CONTENT_STATE_PENDING,
		13,
	)

	if err != nil || !changed {
		t.Fatalf("deleted content state was not retryable")
	}

	restoredFile, err := repository.FindImportFileById(nil, firstUid, 101)

	if err != nil || restoredFile == nil || restoredFile.ContentDeletedUnixTime != nil {
		t.Fatalf("restored content retained the deletion timestamp")
	}

	insertRepositoryBeans(t, database,
		testImportBatch(firstUid, 301, 101, 20),
		testImportBatch(firstUid, 302, 102, 20),
		testImportBatch(secondUid, 401, 201, 99),
		testRawImportRow(firstUid, 501, 301, 2),
		testRawImportRow(firstUid, 502, 301, 1),
		testRawImportRow(secondUid, 601, 401, 1),
	)

	batches, totalCount, err := repository.ListImportBatches(nil, firstUid, 0, 0, 1)

	if err != nil || totalCount != 2 || len(batches) != 1 || batches[0].BatchId != 302 {
		t.Fatalf("first import batch page is not stable")
	}

	batches, totalCount, err = repository.ListImportBatches(nil, firstUid, 0, 1, 1)

	if err != nil || totalCount != 2 || len(batches) != 1 || batches[0].BatchId != 301 {
		t.Fatalf("second import batch page is not stable")
	}

	latest, err := repository.FindLatestImportBatchByFileId(nil, firstUid, 101)

	if err != nil || latest == nil || latest.BatchId != 301 {
		t.Fatalf("latest batch lookup failed")
	}

	if latest, findErr := repository.FindLatestImportBatchByFileId(nil, firstUid, 201); findErr != nil || latest != nil {
		t.Fatalf("cross-user latest batch was visible")
	}

	rows, totalCount, err := repository.ListRawImportRowsPage(nil, firstUid, 301, 0, 1)

	if err != nil || totalCount != 2 || len(rows) != 1 || rows[0].RowId != 502 {
		t.Fatalf("first raw row page is not stable")
	}

	rows, totalCount, err = repository.ListRawImportRowsPage(nil, firstUid, 301, 1, 1)

	if err != nil || totalCount != 2 || len(rows) != 1 || rows[0].RowId != 501 {
		t.Fatalf("second raw row page is not stable")
	}

	rows, totalCount, err = repository.ListRawImportRowsPage(nil, firstUid, 401, 0, 20)

	if err != nil || totalCount != 0 || len(rows) != 0 {
		t.Fatalf("cross-user raw rows were visible")
	}

	batchedRows, err := repository.FindRawImportRowsByIds(nil, firstUid, []int64{502, 601, 501, 502})
	if err != nil || len(batchedRows) != 2 || batchedRows[0].RowId != 501 || batchedRows[1].RowId != 502 {
		t.Fatalf("batched raw rows were not stable or isolated: rows=%+v err=%v", batchedRows, err)
	}

	assertPaymentAccountRepositoryContract(t, repository, database, firstUid)
}

func newSQLiteRepository(t *testing.T) (*importing.Repository, *datastore.Database) {
	t.Helper()
	database, err := datastore.OpenDatabase(&settings.DatabaseConfig{
		DatabaseType:          settings.Sqlite3DbType,
		DatabasePath:          filepath.Join(t.TempDir(), "repository.db"),
		MaxIdleConnection:     1,
		MaxOpenConnection:     1,
		ConnectionMaxLifeTime: 60,
	})

	if err != nil {
		t.Fatalf("open SQLite repository database: %v", err)
	}

	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close SQLite repository database: %v", err)
		}
	})

	store, err := datastore.NewDataStore(database)

	if err != nil {
		t.Fatalf("create SQLite repository store: %v", err)
	}

	if err := migrations.Upgrade(nil, store, migrations.ApplicationInfo{Version: "test", Commit: "test"}); err != nil {
		t.Fatalf("upgrade SQLite repository schema: %v", err)
	}

	repository, err := importing.NewRepository(store)

	if err != nil {
		t.Fatalf("create SQLite repository: %v", err)
	}

	return repository, database
}

func insertImportFile(t *testing.T, repository *importing.Repository, file *importing.ImportFile) {
	t.Helper()

	if err := repository.InsertImportFile(nil, file); err != nil {
		t.Fatalf("insert import file fixture: %v", err)
	}
}

func insertRepositoryBeans(t *testing.T, database *datastore.Database, beans ...any) {
	t.Helper()
	session := database.NewPrivacySession(nil)
	defer session.Close()

	for _, bean := range beans {
		inserted, err := session.Insert(bean)

		if err != nil || inserted != 1 {
			t.Fatalf("insert repository fixture %T", bean)
		}
	}
}

func testImportFile(uid int64, fileId int64, digestCharacter string, createdUnixTime int64) *importing.ImportFile {
	return &importing.ImportFile{
		Uid:              uid,
		ContentState:     importing.IMPORT_FILE_CONTENT_STATE_PENDING,
		OriginalFileName: "fixture.csv",
		FileSize:         4,
		FileSha256:       strings.Repeat(digestCharacter, 64),
		MimeType:         "text/csv",
		FileExtension:    "csv",
		StorageObjectKey: "objects/" + strings.Repeat(digestCharacter, 64),
		CreatedIp:        "192.0.2.10",
		CreatedUnixTime:  createdUnixTime,
		UpdatedUnixTime:  createdUnixTime,
		FileId:           fileId,
	}
}

func testImportBatch(uid int64, batchId int64, fileId int64, createdUnixTime int64) *importing.ImportBatch {
	versions := importing.CurrentCentralRuleVersions()
	return &importing.ImportBatch{
		Uid:                  uid,
		FileId:               fileId,
		Status:               importing.IMPORT_BATCH_STATUS_RECEIVING,
		SourceTypeSnapshot:   importing.SOURCE_TYPE_ALIPAY,
		ParserName:           "test_parser",
		ParserVersion:        "parser-v1",
		NormalizationVersion: "normalization-v1",
		IdentityKeyVersion:   versions.IdentityKeyVersion,
		CoreDigestVersion:    versions.CoreDigestVersion,
		FingerprintVersion:   versions.FingerprintVersion,
		RawSnapshotVersion:   versions.RawSnapshotVersion,
		ParseOptionsDigest:   strings.Repeat("a", 64),
		CreatedUnixTime:      createdUnixTime,
		UpdatedUnixTime:      createdUnixTime,
		BatchId:              batchId,
	}
}

func testRawImportRow(uid int64, rowId int64, batchId int64, rowNumber int64) *importing.RawImportRow {
	versions := importing.CurrentCentralRuleVersions()
	return &importing.RawImportRow{
		Uid:                       uid,
		BatchId:                   batchId,
		ParseState:                importing.PARSE_STATE_INVALID,
		IdentityState:             importing.IDENTITY_STATE_NOT_EVALUATED,
		ProcessingState:           importing.PROCESSING_STATE_IGNORED,
		RowNumber:                 rowNumber,
		SourceLocator:             "v1:csv:1:1",
		RawFieldsJson:             "[]",
		IssuesJson:                "[]",
		RawSnapshotVersion:        versions.RawSnapshotVersion,
		IdentityKeyVersion:        versions.IdentityKeyVersion,
		CoreDigestVersion:         versions.CoreDigestVersion,
		FingerprintVersion:        versions.FingerprintVersion,
		SemanticEligibility:       importing.SEMANTIC_ELIGIBILITY_NON_POSTABLE,
		Disposition:               importing.IMPORT_DISPOSITION_NON_POSTABLE,
		NormalizedDirection:       importing.NORMALIZED_DIRECTION_UNKNOWN,
		NormalizedTransactionType: importing.SOURCE_TRANSACTION_TYPE_UNKNOWN,
		EconomicEffect:            importing.ECONOMIC_EFFECT_UNKNOWN,
		CreatedUnixTime:           30,
		RowId:                     rowId,
	}
}
