package migrations

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/organizer"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
	"github.com/mayswind/ezbookkeeping/pkg/utils"
)

func TestSchemaV009BackfillsPostedEvidenceWithoutLegacyRuntimeAdapter(t *testing.T) {
	database, err := datastore.OpenDatabase(&settings.DatabaseConfig{
		DatabaseType: settings.Sqlite3DbType, DatabasePath: filepath.Join(t.TempDir(), "pf-v009-backfill.db"),
		MaxIdleConnection: 1, MaxOpenConnection: 1, ConnectionMaxLifeTime: 60,
	})
	if err != nil {
		t.Fatalf("open SQLite v009 backfill database: %v", err)
	}
	t.Cleanup(func() {
		if closeErr := database.Close(); closeErr != nil {
			t.Errorf("close SQLite v009 backfill database: %v", closeErr)
		}
	})
	if err = database.SyncStructs(new(models.Account), new(models.Transaction)); err != nil {
		t.Fatalf("create core ledger fixtures schema: %v", err)
	}
	store, err := datastore.NewDataStore(database)
	if err != nil {
		t.Fatalf("create v009 backfill store: %v", err)
	}
	runner := &migrationRunner{
		applicationInfo: ApplicationInfo{Version: "test", Commit: "through-v008"}, runnerId: strings.Repeat("1", 32),
		databaseNow: currentDatabaseUnixTimeWithContext, leaseSeconds: migrationLeaseSeconds, migrations: registeredMigrations()[:8],
	}
	if err = runner.upgradeDatabase(database); err != nil {
		t.Fatalf("prepare v008 baseline: %v", err)
	}

	const (
		uid           = int64(4101)
		accountId     = int64(4102)
		fileId        = int64(4103)
		sourceId      = int64(4104)
		batchId       = int64(4105)
		postingId     = int64(4106)
		transactionId = int64(4107)
		firstRowId    = int64(4108)
		secondRowId   = int64(4109)
		now           = int64(1700000000)
	)
	account := &models.Account{AccountId: accountId, Uid: uid, Category: models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT,
		Type: models.ACCOUNT_TYPE_SINGLE_ACCOUNT, Name: "test", Currency: "CNY", CreatedUnixTime: now, UpdatedUnixTime: now}
	transaction := &models.Transaction{TransactionId: transactionId, Uid: uid, Type: models.TRANSACTION_DB_TYPE_EXPENSE,
		AccountId: accountId, TransactionTime: utils.GetMinTransactionTimeFromUnixTime(now), Amount: 8800,
		CreatedUnixTime: now, UpdatedUnixTime: now}
	file := &importing.ImportFile{Uid: uid, ContentState: importing.IMPORT_FILE_CONTENT_STATE_AVAILABLE,
		OriginalFileName: "sanitized.csv", FileSize: 10, FileSha256: strings.Repeat("a", 64), MimeType: "text/csv",
		FileExtension: "csv", StorageObjectKey: "test/object", CreatedIp: "127.0.0.1",
		CreatedUnixTime: now, UpdatedUnixTime: now, FileId: fileId}
	source := &importing.SourceAccount{Uid: uid, SourceType: importing.SOURCE_TYPE_ALIPAY,
		SourceAccountKey: strings.Repeat("b", 64), SourceAccountKeyVersion: importing.SOURCE_ACCOUNT_KEY_VERSION_V1,
		LedgerAccountId: pointerToInt64V009(accountId), Status: importing.SOURCE_ACCOUNT_STATUS_ACTIVE, MaskedDisplayName: "test***",
		DiscoveryMethod: importing.SOURCE_ACCOUNT_DISCOVERY_USER_SELECTED, CreatedUnixTime: now, UpdatedUnixTime: now,
		SourceAccountId: sourceId}
	batch := &importing.ImportBatch{Uid: uid, FileId: fileId, SourceAccountId: pointerToInt64V009(sourceId), Status: importing.IMPORT_BATCH_STATUS_COMPLETED,
		SourceTypeSnapshot: importing.SOURCE_TYPE_ALIPAY, LedgerAccountId: pointerToInt64V009(accountId), ParserName: "test",
		ParserVersion: "parser-v1", NormalizationVersion: "normalization-v1", IdentityKeyVersion: importing.IDENTITY_KEY_VERSION_V1,
		CoreDigestVersion: importing.CORE_DIGEST_VERSION_V1, FingerprintVersion: importing.FINGERPRINT_VERSION_V1,
		RawSnapshotVersion: importing.RAW_SNAPSHOT_VERSION_V1, ParseOptionsDigest: strings.Repeat("c", 64),
		TotalRowCount: 2, ValidRowCount: 2, ExactDuplicateRowCount: 1, PostedRowCount: 2,
		CreatedUnixTime: now, CompletedUnixTime: pointerToInt64V009(now), UpdatedUnixTime: now, BatchId: batchId}
	posting := &importing.ImportPosting{Uid: uid, BatchId: batchId, IdempotencyKeyDigest: strings.Repeat("d", 64),
		IdempotencyKeyVersion: importing.IDEMPOTENCY_KEY_VERSION_V1, RequestDigest: strings.Repeat("e", 64),
		RequestDigestVersion: importing.POSTING_REQUEST_VERSION_V1, Status: importing.IMPORT_POSTING_STATUS_COMPLETED,
		SelectedRowCount: 2, CreatedTransactionCount: 1, CreatedUnixTime: now, CompletedUnixTime: pointerToInt64V009(now),
		UpdatedUnixTime: now, PostingId: postingId}
	firstRow := legacyBackfillRowV009(uid, batchId, firstRowId, 1, now)
	secondRow := legacyBackfillRowV009(uid, batchId, secondRowId, 2, now)
	firstLink := &importing.RawRowTransactionLink{Uid: uid, RowId: firstRowId, TransactionId: transactionId,
		RelationRole: importing.RAW_ROW_TRANSACTION_RELATION_PRIMARY, CreationMethod: importing.RAW_ROW_TRANSACTION_CREATION_POSTING_CREATED,
		PostingId: postingId, RuleVersion: importing.POSTING_LINK_VERSION_V1, TransactionUpdatedUnixTime: now,
		CreatedUnixTime: now, LinkId: 4110}
	secondLink := &importing.RawRowTransactionLink{Uid: uid, RowId: secondRowId, TransactionId: transactionId,
		RelationRole: importing.RAW_ROW_TRANSACTION_RELATION_PRIMARY, CreationMethod: importing.RAW_ROW_TRANSACTION_CREATION_EXACT_IDENTITY_REUSED,
		PostingId: postingId, RuleVersion: importing.POSTING_LINK_VERSION_V1, TransactionUpdatedUnixTime: now,
		CreatedUnixTime: now, LinkId: 4111}
	sess := database.NewSession(nil)
	for _, bean := range []any{account, transaction, file, source, batch, firstRow, secondRow, posting, firstLink, secondLink} {
		inserted, insertErr := sess.Insert(bean)
		if insertErr != nil || inserted != 1 {
			sess.Close()
			t.Fatalf("insert v009 backfill fixture %T: inserted=%d err=%v", bean, inserted, insertErr)
		}
	}
	sess.Close()

	if err = Upgrade(nil, store, ApplicationInfo{Version: "test", Commit: "v009-backfill"}); err != nil {
		t.Fatalf("upgrade to v009 with legacy evidence: %v", err)
	}
	if err = Upgrade(nil, store, ApplicationInfo{Version: "test", Commit: "v009-repeat"}); err != nil {
		t.Fatalf("repeat v009 backfill upgrade: %v", err)
	}

	repository, err := organizer.NewRepository(store)
	if err != nil {
		t.Fatalf("create organizer repository after backfill: %v", err)
	}
	update, err := repository.FindUpdateById(nil, uid, transactionId)
	if err != nil || update == nil || update.Status != organizer.UPDATE_STATUS_POSTED || update.SourceCount != 1 ||
		update.ValidEvidenceCount != 2 || update.DuplicateEvidenceCount != 1 || update.FinalEventCount != 1 || update.PostedEventCount != 1 {
		t.Fatalf("backfilled update mismatch: update=%+v err=%v", update, err)
	}
	events, err := repository.ListEvents(nil, uid, transactionId)
	if err != nil || len(events) != 1 || events[0].EventId != transactionId || events[0].EconomicNature != organizer.ECONOMIC_NATURE_EXPENSE {
		t.Fatalf("backfilled event mismatch: events=%+v err=%v", events, err)
	}
	evidence, err := repository.ListEvidence(nil, uid, transactionId)
	if err != nil || len(evidence) != 2 || evidence[0].RowId != firstRowId || evidence[1].RowId != secondRowId {
		t.Fatalf("backfilled evidence mismatch: evidence=%+v err=%v", evidence, err)
	}
	links, err := repository.ListEventTransactions(nil, uid, transactionId)
	if err != nil || len(links) != 1 || links[0].TransactionId != transactionId {
		t.Fatalf("backfilled transaction links mismatch: links=%+v err=%v", links, err)
	}
}

func legacyBackfillRowV009(uid int64, batchId int64, rowId int64, rowNumber int64, now int64) *importing.RawImportRow {
	amount := int64(8800)
	eventTime := now
	offset := int16(480)
	return &importing.RawImportRow{Uid: uid, BatchId: batchId, ParseState: importing.PARSE_STATE_VALID,
		IdentityState: importing.IDENTITY_STATE_EXACT_DUPLICATE, ProcessingState: importing.PROCESSING_STATE_LINKED,
		RowNumber: rowNumber, SourceLocator: "v1:csv:" + string(rune('0'+rowNumber)), RawTransactionTime: "sanitized",
		RawAmount: "sanitized", RawDirection: "sanitized", RawStatus: "sanitized", RawTransactionType: "sanitized",
		RawCounterparty: "sanitized", RawItem: "sanitized", RawPaymentMethod: "sanitized", RawNote: "sanitized",
		NormalizedUnixTime: &eventTime, NormalizedTimezoneUtcOffset: &offset, NormalizedAmount: &amount, Currency: "CNY",
		NormalizedDirection: importing.NORMALIZED_DIRECTION_EXPENSE, NormalizedTransactionType: importing.SOURCE_TRANSACTION_TYPE_PAYMENT,
		EconomicEffect: importing.ECONOMIC_EFFECT_NORMAL, RawFieldsJson: "[]", IssuesJson: "[]",
		RawSnapshotVersion: importing.RAW_SNAPSHOT_VERSION_V1, ParserVersion: "parser-v1", NormalizationVersion: "normalization-v1",
		IdentityKeyVersion: importing.IDENTITY_KEY_VERSION_V1, CoreDigestVersion: importing.CORE_DIGEST_VERSION_V1,
		FingerprintVersion: importing.FINGERPRINT_VERSION_V1, SemanticEligibility: importing.SEMANTIC_ELIGIBILITY_POSTABLE,
		Disposition: importing.IMPORT_DISPOSITION_POSTABLE, CreatedUnixTime: now, RowId: rowId}
}

func pointerToInt64V009(value int64) *int64 { return &value }
