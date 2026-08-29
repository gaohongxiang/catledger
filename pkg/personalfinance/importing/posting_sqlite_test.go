package importing_test

import (
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"xorm.io/xorm"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/errs"
	"github.com/gaohongxiang/catledger/pkg/models"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
)

func TestPostingServiceSQLiteAtomicPartialReplayReuseAndRollback(t *testing.T) {
	repository, database := newSQLiteRepository(t)

	if err := database.SyncStructs(new(models.Transaction)); err != nil {
		t.Fatalf("create ledger transaction table: %v", err)
	}

	assertPostingServiceDatabaseContract(t, repository, database)
}

func assertPostingServiceDatabaseContract(t *testing.T, repository *importing.Repository, database *datastore.Database) {
	t.Helper()

	const uid = int64(9101)
	const fileId = int64(9201)
	insertImportFile(t, repository, testImportFile(uid, fileId, "d", 10))
	insertPostingBatchRows(t, database, uid, fileId, 9301, []postingRowFixture{
		{rowId: 9401, identityId: 9501, identityState: importing.IDENTITY_STATE_NEW, digestCharacter: "1"},
		{rowId: 9402, identityId: 9502, identityState: importing.IDENTITY_STATE_NEW, digestCharacter: "2"},
	})

	var generatedId atomic.Int64
	generatedId.Store(10000)
	ledger := new(postingTestLedger)
	ledger.nextTransactionId.Store(20000)
	service, err := importing.NewPostingService(repository, postingTestAuthorizer{}, ledger, func() int64 {
		return generatedId.Add(1)
	})

	if err != nil {
		t.Fatalf("create posting service: %v", err)
	}

	firstRequest := postingRequest(uid, 9301, "partial-posting-1", 9401, 101)
	results := make([]*importing.ImportPostingResult, 2)
	errorsByRequest := make([]error, 2)
	start := make(chan struct{})
	var waitGroup sync.WaitGroup

	for index := range results {
		waitGroup.Add(1)
		go func(resultIndex int) {
			defer waitGroup.Done()
			<-start
			results[resultIndex], errorsByRequest[resultIndex] = service.PostImportBatch(nil, firstRequest, time.UTC)
		}(index)
	}

	close(start)
	waitGroup.Wait()

	for index := range results {
		if errorsByRequest[index] != nil || results[index] == nil || results[index].Posting.Status != importing.IMPORT_POSTING_STATUS_COMPLETED ||
			results[index].Posting.CreatedTransactionCount != 1 || results[index].Posting.ReusedTransactionCount != 0 {
			t.Fatalf("concurrent partial posting %d failed: %+v %v", index, results[index], errorsByRequest[index])
		}
	}

	first := results[0]

	if results[1].Posting.PostingId != first.Posting.PostingId {
		t.Fatal("concurrent idempotent requests did not converge on one posting")
	}

	assertPostingBatchState(t, database, uid, 9301, importing.IMPORT_BATCH_STATUS_PARTIALLY_POSTED, 1, 1)

	replayed, err := service.PostImportBatch(nil, firstRequest, time.UTC)

	if err != nil || replayed == nil || !replayed.Replayed || replayed.Posting.PostingId != first.Posting.PostingId {
		t.Fatalf("completed posting did not replay stably: %+v %v", replayed, err)
	}

	conflictingRequest := firstRequest
	conflictingRequest.Commands = append([]importing.PostingIdentityCommand(nil), firstRequest.Commands...)
	conflictingDraft := *firstRequest.Commands[0].Draft
	conflictingDraft.SourceAmount++
	conflictingRequest.Commands[0].Draft = &conflictingDraft
	_, err = service.PostImportBatch(nil, conflictingRequest, time.UTC)

	if !errors.Is(err, importing.ErrImportPostingIdempotencyConflict) {
		t.Fatalf("same key with another request was not rejected: %v", err)
	}

	second, err := service.PostImportBatch(nil, postingRequest(uid, 9301, "partial-posting-2", 9402, 202), time.UTC)

	if err != nil || second.Posting.CreatedTransactionCount != 1 {
		t.Fatalf("second partial posting failed: %+v %v", second, err)
	}

	assertPostingBatchState(t, database, uid, 9301, importing.IMPORT_BATCH_STATUS_COMPLETED, 0, 2)

	insertPostingBatchRows(t, database, uid, fileId, 9302, []postingRowFixture{
		{rowId: 9403, identityId: 9501, identityState: importing.IDENTITY_STATE_EXACT_DUPLICATE, digestCharacter: "1"},
	})
	reused, err := service.PostImportBatch(nil, importing.PostImportBatchRequest{
		Uid:            uid,
		BatchId:        9302,
		IdempotencyKey: "exact-reuse-1",
		CreatedIp:      "192.0.2.10",
		Commands:       []importing.PostingIdentityCommand{{RowIds: []int64{9403}}},
	}, time.UTC)

	if err != nil || reused.Posting.CreatedTransactionCount != 0 || reused.Posting.ReusedTransactionCount != 1 {
		t.Fatalf("exact identity was not reused: %+v %v", reused, err)
	}

	transactions := listPostingTransactions(t, database, uid)

	if len(transactions) != 2 {
		t.Fatalf("posting created an unexpected transaction count: %d", len(transactions))
	}

	evidence, err := service.GetTransactionEvidence(nil, uid, transactions[0].TransactionId)

	if err != nil || evidence == nil || len(evidence.Items) != 2 || evidence.Items[0].File.FileId != fileId {
		t.Fatalf("transaction evidence down-drill is incomplete: %+v %v", evidence, err)
	}

	foreignEvidence, err := service.GetTransactionEvidence(nil, uid+1, transactions[0].TransactionId)

	if err != nil || foreignEvidence == nil || len(foreignEvidence.Items) != 0 {
		t.Fatalf("cross-user evidence was visible: %+v %v", foreignEvidence, err)
	}

	insertPostingBatchRows(t, database, uid, fileId, 9304, []postingRowFixture{
		{rowId: 9405, identityId: 9505, identityState: importing.IDENTITY_STATE_NEW, digestCharacter: "5"},
	})
	insertPostingBatchRows(t, database, uid, fileId, 9305, []postingRowFixture{
		{rowId: 9406, identityId: 9505, identityState: importing.IDENTITY_STATE_EXACT_DUPLICATE, digestCharacter: "5"},
	})
	identityRaceRequests := []importing.PostImportBatchRequest{
		postingRequest(uid, 9304, "identity-race-1", 9405, 505),
		postingRequest(uid, 9305, "identity-race-2", 9406, 505),
	}
	identityRaceResults := make([]*importing.ImportPostingResult, len(identityRaceRequests))
	identityRaceErrors := make([]error, len(identityRaceRequests))
	start = make(chan struct{})
	waitGroup = sync.WaitGroup{}

	for index := range identityRaceRequests {
		waitGroup.Add(1)
		go func(resultIndex int) {
			defer waitGroup.Done()
			<-start
			identityRaceResults[resultIndex], identityRaceErrors[resultIndex] = service.PostImportBatch(nil, identityRaceRequests[resultIndex], time.UTC)
		}(index)
	}

	close(start)
	waitGroup.Wait()
	totalCreated := int64(0)
	totalReused := int64(0)

	for index := range identityRaceResults {
		if identityRaceErrors[index] != nil || identityRaceResults[index] == nil {
			t.Fatalf("concurrent identity posting %d failed: %+v %v", index, identityRaceResults[index], identityRaceErrors[index])
		}

		totalCreated += identityRaceResults[index].Posting.CreatedTransactionCount
		totalReused += identityRaceResults[index].Posting.ReusedTransactionCount
	}

	if totalCreated != 1 || totalReused != 1 || len(listPostingTransactions(t, database, uid)) != 3 {
		t.Fatalf("concurrent exact identity did not converge: created=%d reused=%d", totalCreated, totalReused)
	}

	insertPostingBatchRows(t, database, uid, fileId, 9303, []postingRowFixture{
		{rowId: 9404, identityId: 9504, identityState: importing.IDENTITY_STATE_NEW, digestCharacter: "4"},
	})
	ledger.failAfterInsert.Store(true)
	_, err = service.PostImportBatch(nil, postingRequest(uid, 9303, "rollback-posting-1", 9404, 404), time.UTC)

	if !errors.Is(err, importing.ErrImportPostingLedgerRejected) {
		t.Fatalf("ledger failure was not returned stably: %v", err)
	}

	if transactions = listPostingTransactions(t, database, uid); len(transactions) != 3 {
		t.Fatalf("failed posting left a ledger transaction: %d", len(transactions))
	}

	assertPostingBatchState(t, database, uid, 9303, importing.IMPORT_BATCH_STATUS_READY, 1, 0)
	assertPostingRowState(t, database, uid, 9404, importing.PROCESSING_STATE_PENDING)
}

type postingTestAuthorizer struct{}

func (postingTestAuthorizer) AuthorizeTransactionCreation(core.Context, int64, *time.Location, []*models.Transaction) error {
	return nil
}

type postingTestLedger struct {
	nextTransactionId atomic.Int64
	failAfterInsert   atomic.Bool
}

func (l *postingTestLedger) CreateTransactionInSession(_ core.Context, _ *datastore.Database, sess *xorm.Session, draft *models.Transaction, _ []int64) (*models.Transaction, *models.Transaction, error) {
	transaction := *draft
	transaction.TransactionId = l.nextTransactionId.Add(1)
	transaction.CreatedUnixTime = time.Now().Unix()
	transaction.UpdatedUnixTime = transaction.CreatedUnixTime
	inserted, err := sess.Insert(&transaction)

	if err != nil || inserted != 1 {
		return nil, nil, errors.New("insert synthetic ledger transaction")
	}

	if l.failAfterInsert.Load() {
		return nil, nil, errs.ErrTransactionTypeInvalid
	}

	return &transaction, nil, nil
}

type postingRowFixture struct {
	rowId           int64
	identityId      int64
	identityState   importing.IdentityState
	digestCharacter string
}

func insertPostingBatchRows(t *testing.T, database *datastore.Database, uid int64, fileId int64, batchId int64, fixtures []postingRowFixture) {
	t.Helper()
	versions := importing.CurrentCentralRuleVersions()
	now := time.Now().Unix()
	started := now
	completed := now
	batch := &importing.ImportBatch{
		Uid:                  uid,
		FileId:               fileId,
		Status:               importing.IMPORT_BATCH_STATUS_READY,
		SourceTypeSnapshot:   importing.SOURCE_TYPE_ALIPAY,
		ParserName:           "posting_test",
		ParserVersion:        "parser-v1",
		NormalizationVersion: "normalization-v1",
		IdentityKeyVersion:   versions.IdentityKeyVersion,
		CoreDigestVersion:    versions.CoreDigestVersion,
		FingerprintVersion:   versions.FingerprintVersion,
		RawSnapshotVersion:   versions.RawSnapshotVersion,
		ParseOptionsDigest:   strings.Repeat("a", 64),
		TotalRowCount:        int64(len(fixtures)),
		ValidRowCount:        int64(len(fixtures)),
		PendingRowCount:      int64(len(fixtures)),
		CreatedUnixTime:      now,
		StartedUnixTime:      &started,
		CompletedUnixTime:    &completed,
		UpdatedUnixTime:      now,
		BatchId:              batchId,
	}
	beans := []any{batch}

	for index, fixture := range fixtures {
		identity := &importing.SourceIdentity{
			Uid:                uid,
			SourceAccountId:    1,
			IdentityKind:       importing.IDENTITY_KIND_SOURCE_TRANSACTION_ID,
			SourceIdentityKey:  strings.Repeat(fixture.digestCharacter, 64),
			SourceCoreDigest:   strings.Repeat(fixture.digestCharacter, 64),
			IdentityKeyVersion: versions.IdentityKeyVersion,
			CoreDigestVersion:  versions.CoreDigestVersion,
			FingerprintVersion: versions.FingerprintVersion,
			FirstSeenUnixTime:  now,
			LastSeenUnixTime:   now,
			IdentityId:         fixture.identityId,
		}

		if fixture.identityState != importing.IDENTITY_STATE_EXACT_DUPLICATE {
			beans = append(beans, identity)
		}

		identityId := fixture.identityId
		beans = append(beans, &importing.RawImportRow{
			Uid:                         uid,
			BatchId:                     batchId,
			ParseState:                  importing.PARSE_STATE_VALID,
			IdentityState:               fixture.identityState,
			ProcessingState:             importing.PROCESSING_STATE_PENDING,
			IdentityId:                  &identityId,
			RowNumber:                   int64(index + 1),
			SourceLocator:               "v1:csv:1:1",
			NormalizedUnixTime:          &now,
			NormalizedTimezoneUtcOffset: new(int16),
			NormalizedAmount:            new(int64),
			Currency:                    "CNY",
			NormalizedDirection:         importing.NORMALIZED_DIRECTION_EXPENSE,
			NormalizedTransactionType:   importing.SOURCE_TRANSACTION_TYPE_PAYMENT,
			EconomicEffect:              importing.ECONOMIC_EFFECT_NORMAL,
			ObservedSourceIdentityKey:   identity.SourceIdentityKey,
			ObservedSourceCoreDigest:    identity.SourceCoreDigest,
			RawFieldsJson:               "[]",
			IssuesJson:                  "[]",
			RawSnapshotVersion:          versions.RawSnapshotVersion,
			ParserVersion:               "parser-v1",
			NormalizationVersion:        "normalization-v1",
			IdentityKeyVersion:          versions.IdentityKeyVersion,
			CoreDigestVersion:           versions.CoreDigestVersion,
			FingerprintVersion:          versions.FingerprintVersion,
			SemanticEligibility:         importing.SEMANTIC_ELIGIBILITY_POSTABLE,
			Disposition:                 importing.IMPORT_DISPOSITION_POSTABLE,
			CreatedUnixTime:             now,
			RowId:                       fixture.rowId,
		})
	}

	insertRepositoryBeans(t, database, beans...)
}

func postingRequest(uid int64, batchId int64, key string, rowId int64, amount int64) importing.PostImportBatchRequest {
	return importing.PostImportBatchRequest{
		Uid:            uid,
		BatchId:        batchId,
		IdempotencyKey: key,
		CreatedIp:      "192.0.2.10",
		Commands: []importing.PostingIdentityCommand{{
			RowIds: []int64{rowId},
			Draft: &importing.LedgerTransactionDraft{
				Type:            models.TRANSACTION_TYPE_EXPENSE,
				CategoryId:      1,
				UnixTime:        1_700_000_000 + rowId,
				SourceAccountId: 1,
				SourceAmount:    amount,
			},
		}},
	}
}

func assertPostingBatchState(t *testing.T, database *datastore.Database, uid int64, batchId int64, status importing.ImportBatchStatus, pending int64, posted int64) {
	t.Helper()
	batch := new(importing.ImportBatch)
	sess := database.NewPrivacySession(nil)
	found, err := sess.Where("uid=? AND batch_id=?", uid, batchId).Get(batch)
	sess.Close()

	if err != nil || !found || batch.Status != status || batch.PendingRowCount != pending || batch.PostedRowCount != posted {
		t.Fatalf("unexpected posting batch state: %+v %v", batch, err)
	}
}

func assertPostingRowState(t *testing.T, database *datastore.Database, uid int64, rowId int64, state importing.ProcessingState) {
	t.Helper()
	row := new(importing.RawImportRow)
	sess := database.NewPrivacySession(nil)
	found, err := sess.Where("uid=? AND row_id=?", uid, rowId).Get(row)
	sess.Close()

	if err != nil || !found || row.ProcessingState != state {
		t.Fatalf("unexpected posting row state: %+v %v", row, err)
	}
}

func listPostingTransactions(t *testing.T, database *datastore.Database, uid int64) []*models.Transaction {
	t.Helper()
	transactions := make([]*models.Transaction, 0)
	sess := database.NewPrivacySession(nil)
	err := sess.Where("uid=?", uid).Asc("transaction_id").Find(&transactions)
	sess.Close()

	if err != nil {
		t.Fatalf("list posting ledger transactions: %v", err)
	}

	return transactions
}
