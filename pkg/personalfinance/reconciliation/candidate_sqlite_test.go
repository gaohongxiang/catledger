package reconciliation

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/migrations"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
	"github.com/mayswind/ezbookkeeping/pkg/uuid"
)

func TestCandidateServiceSQLiteStableCasesIsolationFiltersAndNoLedgerEffects(t *testing.T) {
	service, database := newCandidateSQLiteService(t, &sequentialCandidateIds{})
	uid := int64(1001)
	foreignUid := int64(2002)
	baseTime := int64(1_720_000_000)
	insertCandidateFixtures(t, database,
		candidateTestAccount(uid, 11, importing.SOURCE_TYPE_ALIPAY),
		candidateTestAccount(uid, 22, importing.SOURCE_TYPE_BANK),
		candidateTestAccount(uid, 33, importing.SOURCE_TYPE_WECHAT),
		candidateTestAccount(foreignUid, 44, importing.SOURCE_TYPE_ALIPAY),
		candidateTestAccount(foreignUid, 55, importing.SOURCE_TYPE_BANK),
		candidateTestBatch(uid, 101, 11),
		candidateTestBatch(uid, 202, 22),
		candidateTestBatch(uid, 303, 11),
		candidateTestBatch(uid, 404, 11),
		candidateTestBatch(uid, 505, 33),
		candidateTestBatch(foreignUid, 606, 44),
		candidateTestBatch(foreignUid, 707, 55),
		candidateTestIdentity(uid, 10001, 11),
		candidateTestIdentity(uid, 20002, 22),
		candidateTestIdentity(uid, 30003, 11),
		candidateTestIdentity(uid, 40004, 11),
		candidateTestIdentity(uid, 50005, 33),
		candidateTestIdentity(uid, 50006, 33),
		candidateTestIdentity(uid, 50007, 33),
		candidateTestIdentity(foreignUid, 60006, 44),
		candidateTestIdentity(foreignUid, 70007, 55),
		candidateTestRow(uid, 1001, 101, int64Pointer(10001), importing.IDENTITY_STATE_NEW, 8800, "CNY", baseTime),
		candidateTestRow(uid, 2002, 202, int64Pointer(20002), importing.IDENTITY_STATE_NEW, 8800, "CNY", baseTime+120),
		candidateTestRow(uid, 3003, 303, int64Pointer(10001), importing.IDENTITY_STATE_EXACT_DUPLICATE, 8800, "CNY", baseTime),
		candidateTestRow(uid, 4004, 404, int64Pointer(40004), importing.IDENTITY_STATE_NEW, 8800, "CNY", baseTime+10),
		candidateTestRow(uid, 5005, 505, int64Pointer(50005), importing.IDENTITY_STATE_NEW, 8801, "CNY", baseTime),
		candidateTestRow(uid, 5006, 505, int64Pointer(50006), importing.IDENTITY_STATE_NEW, 8800, "USD", baseTime),
		candidateTestRow(uid, 5007, 505, int64Pointer(50007), importing.IDENTITY_STATE_NEW, 8800, "CNY", baseTime+candidateTimeWindowSeconds+1),
		candidateTestRow(foreignUid, 6006, 606, int64Pointer(60006), importing.IDENTITY_STATE_NEW, 8800, "CNY", baseTime),
		candidateTestRow(foreignUid, 7007, 707, int64Pointer(70007), importing.IDENTITY_STATE_NEW, 8800, "CNY", baseTime),
	)

	if err := database.SyncStructs(new(models.Transaction)); err != nil {
		t.Fatalf("create ledger transaction table for no-effect assertion: %v", err)
	}

	first, err := service.GenerateCandidates(nil, GenerateCandidatesRequest{Uid: uid, BatchId: 101})

	if err != nil || len(first.Cases) != 1 {
		t.Fatalf("generate initial candidate case: %+v %v", first, err)
	}

	second, err := service.GenerateCandidates(nil, GenerateCandidatesRequest{Uid: uid, BatchId: 101})

	if err != nil || len(second.Cases) != 1 || countCandidateRows(t, database, new(Case), "uid=?", uid) != 1 {
		t.Fatalf("repeated generation duplicated case: %+v %v", second, err)
	}

	overlap, err := service.GenerateCandidates(nil, GenerateCandidatesRequest{Uid: uid, BatchId: 303})

	if err != nil || len(overlap.Cases) != 1 || overlap.Cases[0].CaseId != first.Cases[0].CaseId {
		t.Fatalf("overlapping batch did not reuse source_identity case: %+v %v", overlap, err)
	}

	members := listCandidateMembers(t, database, uid, first.Cases[0].CaseId)

	if len(members) != 2 || members[0].MemberKind != MEMBER_KIND_SOURCE_IDENTITY || members[1].MemberKind != MEMBER_KIND_SOURCE_IDENTITY {
		t.Fatalf("stable candidate case did not use source identities: %+v", members)
	}

	foreign, err := service.GenerateCandidates(nil, GenerateCandidatesRequest{Uid: foreignUid, BatchId: 606})

	if err != nil || len(foreign.Cases) != 1 {
		t.Fatalf("foreign user could not independently generate its owned case: %+v %v", foreign, err)
	}

	if countCandidateRows(t, database, new(Case), "uid=?", uid) != 1 ||
		countCandidateRows(t, database, new(Case), "uid=?", foreignUid) != 1 {
		t.Fatalf("candidate cases were not isolated by uid")
	}

	assertNoCandidateLedgerEffects(t, database, uid)
	anchor := loadCandidateRow(t, database, uid, 1001)
	anchorBatch := loadCandidateBatch(t, database, uid, 101)

	if anchor.ProcessingState != importing.PROCESSING_STATE_PENDING ||
		anchorBatch.Status != importing.IMPORT_BATCH_STATUS_READY ||
		anchorBatch.PendingRowCount != 1 || anchorBatch.PostedRowCount != 0 {
		t.Fatalf("candidate generation changed raw-row or batch processing state")
	}
}

func TestCandidateServiceSQLiteMatchesPendingAnchorToLinkedHistoricalEvidence(t *testing.T) {
	service, database := newCandidateSQLiteService(t, &sequentialCandidateIds{})
	uid := int64(2112)
	baseTime := int64(1_720_500_000)
	historical := candidateTestRow(uid, 9101, 701, int64Pointer(7101), importing.IDENTITY_STATE_NEW, 6688, "CNY", baseTime)
	historical.ProcessingState = importing.PROCESSING_STATE_LINKED
	historical.Disposition = importing.IMPORT_DISPOSITION_NON_POSTABLE
	current := candidateTestRow(uid, 9202, 702, int64Pointer(7202), importing.IDENTITY_STATE_NEW, 6688, "CNY", baseTime+60)
	insertCandidateFixtures(t, database,
		candidateTestAccount(uid, 71, importing.SOURCE_TYPE_ALIPAY),
		candidateTestAccount(uid, 72, importing.SOURCE_TYPE_BANK),
		candidateTestBatch(uid, 701, 71),
		candidateTestBatch(uid, 702, 72),
		candidateTestIdentity(uid, 7101, 71),
		candidateTestIdentity(uid, 7202, 72),
		historical,
		current,
	)
	result, err := service.GenerateCandidates(nil, GenerateCandidatesRequest{Uid: uid, BatchId: 702})
	if err != nil || len(result.Cases) != 1 {
		t.Fatalf("pending statement did not match linked historical evidence: result=%+v err=%v", result, err)
	}
	if loaded := loadCandidateRow(t, database, uid, historical.RowId); loaded.ProcessingState != importing.PROCESSING_STATE_LINKED {
		t.Fatalf("candidate generation changed historical evidence state: %+v", loaded)
	}
}

func TestCandidateServiceSQLiteHidesOldOpenCasesAndRefreshesThemToV4(t *testing.T) {
	service, database := newCandidateSQLiteService(t, &sequentialCandidateIds{})
	uid := int64(3113)
	baseTime := int64(1_720_600_000)
	insertCandidateFixtures(t, database,
		candidateTestAccount(uid, 81, importing.SOURCE_TYPE_ALIPAY),
		candidateTestAccount(uid, 82, importing.SOURCE_TYPE_BANK),
		candidateTestBatch(uid, 801, 81),
		candidateTestBatch(uid, 802, 82),
		candidateTestIdentity(uid, 8101, 81),
		candidateTestIdentity(uid, 8202, 82),
		candidateTestRow(uid, 81001, 801, int64Pointer(8101), importing.IDENTITY_STATE_NEW, 5200, "CNY", baseTime),
		candidateTestRow(uid, 82002, 802, int64Pointer(8202), importing.IDENTITY_STATE_NEW, 5200, "CNY", baseTime+30),
	)
	generated, err := service.GenerateCandidates(nil, GenerateCandidatesRequest{Uid: uid, BatchId: 801})
	if err != nil || len(generated.Cases) != 1 {
		t.Fatalf("generate current candidate: %+v %v", generated, err)
	}
	caseId := generated.Cases[0].CaseId
	sess := database.NewSession(nil)
	updated, err := sess.Where("uid=? AND case_id=?", uid, caseId).Cols("candidate_rule_version", "explanation_version").Update(&Case{
		CandidateRuleVersion: CANDIDATE_RULE_VERSION_V1,
		ExplanationVersion:   EXPLANATION_VERSION_V1,
	})
	sess.Close()
	if err != nil || updated != 1 {
		t.Fatalf("downgrade open fixture to v1: %v", err)
	}
	store, err := datastore.NewDataStore(database)
	if err != nil {
		t.Fatalf("create case store: %v", err)
	}
	cases, err := NewCaseService(store)
	if err != nil {
		t.Fatalf("create case service: %v", err)
	}
	page, err := cases.ListCases(nil, ListCasesRequest{Uid: uid, Status: CASE_STATUS_OPEN, Limit: 20})
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("stale v1 open case remained visible: %+v %v", page, err)
	}
	refreshed, err := service.GenerateCandidates(nil, GenerateCandidatesRequest{Uid: uid, BatchId: 801})
	if err != nil || len(refreshed.Cases) != 1 || refreshed.Cases[0].CaseId != caseId || refreshed.Cases[0].CandidateRuleVersion != CANDIDATE_RULE_VERSION_V4 {
		t.Fatalf("v1 open case was not refreshed in place to v4: %+v %v", refreshed, err)
	}
}

func TestCandidateServiceSQLiteBatchLocalAndGenerationLimits(t *testing.T) {
	service, database := newCandidateSQLiteService(t, &sequentialCandidateIds{})
	uid := int64(3003)
	baseTime := int64(1_720_100_000)
	insertCandidateFixtures(t, database,
		candidateTestAccount(uid, 61, importing.SOURCE_TYPE_ALIPAY),
		candidateTestAccount(uid, 62, importing.SOURCE_TYPE_BANK),
		candidateTestBatch(uid, 801, 61),
		candidateTestBatch(uid, 802, 62),
		candidateTestIdentity(uid, 62001, 62),
		candidateTestRow(uid, 81001, 801, nil, importing.IDENTITY_STATE_BATCH_LOCAL, 100, "CNY", baseTime),
		candidateTestRow(uid, 82001, 802, int64Pointer(62001), importing.IDENTITY_STATE_NEW, 100, "CNY", baseTime),
	)

	local, err := service.GenerateCandidates(nil, GenerateCandidatesRequest{Uid: uid, BatchId: 801})

	if err != nil || len(local.Cases) != 1 {
		t.Fatalf("generate batch-local candidate: %+v %v", local, err)
	}

	members := listCandidateMembers(t, database, uid, local.Cases[0].CaseId)
	foundRawRow := false

	for _, member := range members {
		if member.MemberKind == MEMBER_KIND_RAW_ROW && member.MemberRefId == 81001 {
			foundRawRow = true
		}
	}

	if !foundRawRow {
		t.Fatalf("batch-local candidate was not bound to its raw row: %+v", members)
	}

	limitUid := int64(4004)
	fixtures := []any{
		candidateTestAccount(limitUid, 71, importing.SOURCE_TYPE_ALIPAY),
		candidateTestBatch(limitUid, 901, 71),
	}

	for anchorIndex := int64(0); anchorIndex < 41; anchorIndex++ {
		identityId := int64(71000 + anchorIndex)
		fixtures = append(fixtures,
			candidateTestIdentity(limitUid, identityId, 71),
			candidateTestRow(limitUid, 91000+anchorIndex, 901, int64Pointer(identityId), importing.IDENTITY_STATE_NEW, 777, "CNY", baseTime),
		)
	}

	for candidateIndex := int64(0); candidateIndex < 6; candidateIndex++ {
		sourceAccountId := int64(72 + candidateIndex)
		batchId := int64(902 + candidateIndex)
		identityId := int64(72000 + candidateIndex)
		fixtures = append(fixtures,
			candidateTestAccount(limitUid, sourceAccountId, importing.SOURCE_TYPE_BANK),
			candidateTestBatch(limitUid, batchId, sourceAccountId),
			candidateTestIdentity(limitUid, identityId, sourceAccountId),
			candidateTestRow(limitUid, 92000+candidateIndex, batchId, int64Pointer(identityId), importing.IDENTITY_STATE_NEW, 777, "CNY", baseTime+candidateIndex),
		)
	}

	insertCandidateFixtures(t, database, fixtures...)
	limited, err := service.GenerateCandidates(nil, GenerateCandidatesRequest{Uid: limitUid, BatchId: 901})

	if err != nil || len(limited.Cases) != candidateMaximumCases || !limited.LimitReached {
		t.Fatalf("candidate generation limits were not enforced: cases=%d anchors=%d limited=%v err=%v", len(limited.Cases), limited.EvaluatedAnchorCount, limited.LimitReached, err)
	}

	if limited.EvaluatedAnchorCount != candidateMaximumCases/candidateMaximumPerAnchor {
		t.Fatalf("per-anchor candidate cap was not applied before total cap: %d", limited.EvaluatedAnchorCount)
	}
}

func TestCandidateServiceSQLiteUsesRawMemberForDateOnlyStatementOccurrence(t *testing.T) {
	service, database := newCandidateSQLiteService(t, &sequentialCandidateIds{})
	uid := int64(3663)
	location := time.FixedZone("cst", 8*3600)
	midnight := time.Date(2026, 7, 6, 0, 0, 0, 0, location).Unix()
	afternoon := time.Date(2026, 7, 6, 10, 50, 0, 0, location).Unix()
	detail := candidateTestRow(uid, 91001, 901, int64Pointer(9101), importing.IDENTITY_STATE_NEW, 4350, "CNY", afternoon)
	statement := candidateTestRow(uid, 92002, 902, int64Pointer(9202), importing.IDENTITY_STATE_EXACT_DUPLICATE, 4350, "CNY", midnight)
	detail.RawCounterparty, detail.RawPaymentMethod = "详细商户", "光大银行信用卡(2690)"
	statement.RawCounterparty, statement.RawPaymentMethod = "支付宝 持卡人", "末四位2690"
	statement.NormalizedTransactionType = importing.SOURCE_TRANSACTION_TYPE_OTHER
	insertCandidateFixtures(t, database,
		candidateTestAccount(uid, 91, importing.SOURCE_TYPE_ALIPAY),
		candidateTestAccount(uid, 92, importing.SOURCE_TYPE_BANK),
		candidateTestBatch(uid, 901, 91),
		candidateTestBatch(uid, 902, 92),
		candidateTestIdentity(uid, 9101, 91),
		candidateTestIdentity(uid, 9202, 92),
		detail,
		statement,
	)
	generated, err := service.GenerateCandidates(nil, GenerateCandidatesRequest{Uid: uid, BatchId: 901})
	if err != nil || len(generated.Cases) != 1 {
		t.Fatalf("generate date-only statement candidate: %+v %v", generated, err)
	}
	members := listCandidateMembers(t, database, uid, generated.Cases[0].CaseId)
	foundRawStatement := false
	for _, member := range members {
		if member.MemberKind == MEMBER_KIND_RAW_ROW && member.MemberRefId == statement.RowId {
			foundRawStatement = true
		}
	}
	if !foundRawStatement {
		t.Fatalf("date-only statement occurrence was not persisted as a raw member: %+v", members)
	}
	store, err := datastore.NewDataStore(database)
	if err != nil {
		t.Fatalf("create case store: %v", err)
	}
	cases, err := NewCaseService(store)
	if err != nil {
		t.Fatalf("create case service: %v", err)
	}
	caseIds, err := cases.repository.findCaseIdsForRows(nil, uid, []int64{statement.RowId}, 10)
	if err != nil || len(caseIds) != 1 || caseIds[0] != generated.Cases[0].CaseId {
		t.Fatalf("task row lookup omitted stable raw-row member: %+v %v", caseIds, err)
	}
}

func TestCandidateServiceSQLiteRefreshProtectionAndTransactionRollback(t *testing.T) {
	service, database := newCandidateSQLiteService(t, &sequentialCandidateIds{})
	uid := int64(5005)
	baseTime := int64(1_720_200_000)
	insertCandidateFixtures(t, database,
		candidateTestAccount(uid, 81, importing.SOURCE_TYPE_ALIPAY),
		candidateTestAccount(uid, 82, importing.SOURCE_TYPE_BANK),
		candidateTestBatch(uid, 1001, 81),
		candidateTestBatch(uid, 1002, 82),
		candidateTestIdentity(uid, 81001, 81),
		candidateTestIdentity(uid, 82001, 82),
		candidateTestRow(uid, 10101, 1001, int64Pointer(81001), importing.IDENTITY_STATE_NEW, 333, "CNY", baseTime),
		candidateTestRow(uid, 10201, 1002, int64Pointer(82001), importing.IDENTITY_STATE_NEW, 333, "CNY", baseTime+1),
	)

	generated, err := service.GenerateCandidates(nil, GenerateCandidatesRequest{Uid: uid, BatchId: 1001})

	if err != nil || len(generated.Cases) != 1 {
		t.Fatalf("generate refresh-protection fixture: %+v %v", generated, err)
	}

	caseId := generated.Cases[0].CaseId
	setCandidateCaseState(t, database, uid, caseId, CASE_STATUS_OPEN, nil, -1, "[]")
	refreshed, err := service.GenerateCandidates(nil, GenerateCandidatesRequest{Uid: uid, BatchId: 1001})

	if err != nil || refreshed.Cases[0].CandidateScore <= 0 || refreshed.Cases[0].ReasonCodesJson == "[]" {
		t.Fatalf("open undecided case was not refreshed: %+v %v", refreshed, err)
	}

	protectedStatuses := []CaseStatus{CASE_STATUS_RESOLVED, CASE_STATUS_DEFERRED, CASE_STATUS_ACTION_REQUIRED}

	for _, status := range protectedStatuses {
		setCandidateCaseState(t, database, uid, caseId, status, nil, -7, "[]")
		result, generateErr := service.GenerateCandidates(nil, GenerateCandidatesRequest{Uid: uid, BatchId: 1001})

		if generateErr != nil || result.Cases[0].CandidateScore != -7 || result.Cases[0].Status != status || result.Cases[0].ReasonCodesJson != "[]" {
			t.Fatalf("protected case %s was overwritten: %+v %v", status, result, generateErr)
		}
	}

	decisionId := int64(99001)
	setCandidateCaseState(t, database, uid, caseId, CASE_STATUS_OPEN, &decisionId, -9, "[]")
	decided, err := service.GenerateCandidates(nil, GenerateCandidatesRequest{Uid: uid, BatchId: 1001})

	if err != nil || decided.Cases[0].CandidateScore != -9 || decided.Cases[0].CurrentDecisionId == nil || *decided.Cases[0].CurrentDecisionId != decisionId {
		t.Fatalf("open case with an artificial-decision guard was overwritten: %+v %v", decided, err)
	}

	rollbackService, rollbackDatabase := newCandidateSQLiteService(t, repeatedCandidateIds{value: 777_777})
	rollbackUid := int64(6006)
	insertCandidateFixtures(t, rollbackDatabase,
		candidateTestAccount(rollbackUid, 91, importing.SOURCE_TYPE_ALIPAY),
		candidateTestAccount(rollbackUid, 92, importing.SOURCE_TYPE_BANK),
		candidateTestBatch(rollbackUid, 1101, 91),
		candidateTestBatch(rollbackUid, 1102, 92),
		candidateTestIdentity(rollbackUid, 91001, 91),
		candidateTestIdentity(rollbackUid, 92001, 92),
		candidateTestRow(rollbackUid, 11101, 1101, int64Pointer(91001), importing.IDENTITY_STATE_NEW, 444, "CNY", baseTime),
		candidateTestRow(rollbackUid, 11201, 1102, int64Pointer(92001), importing.IDENTITY_STATE_NEW, 444, "CNY", baseTime),
	)

	if _, err := rollbackService.GenerateCandidates(nil, GenerateCandidatesRequest{Uid: rollbackUid, BatchId: 1101}); err == nil {
		t.Fatalf("duplicate member ids did not fail candidate transaction")
	}

	if countCandidateRows(t, rollbackDatabase, new(Case), "uid=?", rollbackUid) != 0 ||
		countCandidateRows(t, rollbackDatabase, new(CaseMember), "uid=?", rollbackUid) != 0 {
		t.Fatalf("failed candidate transaction left a partial case or member")
	}
}

func TestCandidateServiceSQLiteConcurrentUniqueCase(t *testing.T) {
	service, database := newCandidateSQLiteService(t, &sequentialCandidateIds{})
	uid := int64(7007)
	baseTime := int64(1_720_300_000)
	insertCandidateFixtures(t, database,
		candidateTestAccount(uid, 101, importing.SOURCE_TYPE_ALIPAY),
		candidateTestAccount(uid, 102, importing.SOURCE_TYPE_BANK),
		candidateTestBatch(uid, 1201, 101),
		candidateTestBatch(uid, 1202, 102),
		candidateTestIdentity(uid, 101001, 101),
		candidateTestIdentity(uid, 102001, 102),
		candidateTestRow(uid, 12101, 1201, int64Pointer(101001), importing.IDENTITY_STATE_NEW, 555, "CNY", baseTime),
		candidateTestRow(uid, 12201, 1202, int64Pointer(102001), importing.IDENTITY_STATE_NEW, 555, "CNY", baseTime),
	)

	const workers = 8
	start := make(chan struct{})
	errorsByWorker := make([]error, workers)
	var waitGroup sync.WaitGroup
	waitGroup.Add(workers)

	for index := 0; index < workers; index++ {
		go func(worker int) {
			defer waitGroup.Done()
			<-start
			_, errorsByWorker[worker] = service.GenerateCandidates(nil, GenerateCandidatesRequest{Uid: uid, BatchId: 1201})
		}(index)
	}

	close(start)
	waitGroup.Wait()

	for index, err := range errorsByWorker {
		if err != nil {
			t.Fatalf("concurrent candidate worker %d failed: %v", index, err)
		}
	}

	if countCandidateRows(t, database, new(Case), "uid=?", uid) != 1 ||
		countCandidateRows(t, database, new(CaseMember), "uid=?", uid) != 2 {
		t.Fatalf("concurrent candidate generation did not converge on one complete case")
	}
}

type sequentialCandidateIds struct {
	value atomic.Int64
}

func (generator *sequentialCandidateIds) GenerateUuid(uuidType uuid.UuidType) int64 {
	if uuidType != uuid.UUID_TYPE_PERSONAL_FINANCE {
		return 0
	}

	if generator.value.Load() == 0 {
		generator.value.CompareAndSwap(0, 1_000_000)
	}

	return generator.value.Add(1)
}

type repeatedCandidateIds struct {
	value int64
}

func (generator repeatedCandidateIds) GenerateUuid(uuidType uuid.UuidType) int64 {
	if uuidType != uuid.UUID_TYPE_PERSONAL_FINANCE {
		return 0
	}

	return generator.value
}

func newCandidateSQLiteService(t *testing.T, idGenerator CandidateIdGenerator) (*CandidateService, *datastore.Database) {
	t.Helper()
	database, err := datastore.OpenDatabase(&settings.DatabaseConfig{
		DatabaseType:          settings.Sqlite3DbType,
		DatabasePath:          filepath.Join(t.TempDir(), "reconciliation-candidate.db"),
		MaxIdleConnection:     8,
		MaxOpenConnection:     8,
		ConnectionMaxLifeTime: 60,
	})

	if err != nil {
		t.Fatalf("open reconciliation candidate SQLite database: %v", err)
	}

	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close reconciliation candidate SQLite database: %v", err)
		}
	})

	store, err := datastore.NewDataStore(database)

	if err != nil {
		t.Fatalf("create reconciliation candidate store: %v", err)
	}

	if err := migrations.Upgrade(nil, store, migrations.ApplicationInfo{Version: "test", Commit: "test"}); err != nil {
		t.Fatalf("upgrade reconciliation candidate SQLite schema: %v", err)
	}

	service, err := NewCandidateService(store, idGenerator)

	if err != nil {
		t.Fatalf("create reconciliation candidate service: %v", err)
	}

	service.now = func() time.Time { return time.Unix(1_800_000_000, 0) }
	return service, database
}

func candidateTestAccount(uid int64, sourceAccountId int64, sourceType importing.SourceType) *importing.SourceAccount {
	return &importing.SourceAccount{
		Uid:                     uid,
		SourceType:              sourceType,
		SourceAccountKey:        candidateDigest(sourceAccountId),
		SourceAccountKeyVersion: importing.SOURCE_ACCOUNT_KEY_VERSION_V1,
		Status:                  importing.SOURCE_ACCOUNT_STATUS_ACTIVE,
		MaskedDisplayName:       "synthetic account",
		DiscoveryMethod:         importing.SOURCE_ACCOUNT_DISCOVERY_USER_SELECTED,
		CreatedUnixTime:         1,
		UpdatedUnixTime:         1,
		SourceAccountId:         sourceAccountId,
	}
}

func candidateTestBatch(uid int64, batchId int64, sourceAccountId int64) *importing.ImportBatch {
	return &importing.ImportBatch{
		Uid:                  uid,
		FileId:               batchId + 100_000,
		SourceAccountId:      int64Pointer(sourceAccountId),
		Status:               importing.IMPORT_BATCH_STATUS_READY,
		SourceTypeSnapshot:   importing.SOURCE_TYPE_BANK,
		ParserName:           "synthetic_parser",
		ParserVersion:        "parser-v1",
		NormalizationVersion: "normalization-v1",
		IdentityKeyVersion:   importing.IDENTITY_KEY_VERSION_V1,
		CoreDigestVersion:    importing.CORE_DIGEST_VERSION_V1,
		FingerprintVersion:   importing.FINGERPRINT_VERSION_V1,
		RawSnapshotVersion:   importing.RAW_SNAPSHOT_VERSION_V1,
		ParseOptionsDigest:   candidateDigest(batchId),
		ReparseReasonCode:    "synthetic_test",
		TotalRowCount:        1,
		ValidRowCount:        1,
		PendingRowCount:      1,
		CreatedUnixTime:      1,
		UpdatedUnixTime:      1,
		BatchId:              batchId,
	}
}

func candidateTestIdentity(uid int64, identityId int64, sourceAccountId int64) *importing.SourceIdentity {
	return &importing.SourceIdentity{
		Uid:                uid,
		SourceAccountId:    sourceAccountId,
		IdentityKind:       importing.IDENTITY_KIND_SOURCE_TRANSACTION_ID,
		SourceIdentityKey:  candidateDigest(identityId),
		SourceCoreDigest:   candidateDigest(identityId + 1_000_000),
		IdentityKeyVersion: importing.IDENTITY_KEY_VERSION_V1,
		CoreDigestVersion:  importing.CORE_DIGEST_VERSION_V1,
		FingerprintVersion: importing.FINGERPRINT_VERSION_V1,
		FirstSeenUnixTime:  1,
		LastSeenUnixTime:   1,
		IdentityId:         identityId,
	}
}

func candidateTestRow(uid int64, rowId int64, batchId int64, identityId *int64, identityState importing.IdentityState, amount int64, currency string, unixTime int64) *importing.RawImportRow {
	return &importing.RawImportRow{
		Uid:                         uid,
		BatchId:                     batchId,
		ParseState:                  importing.PARSE_STATE_VALID,
		IdentityState:               identityState,
		ProcessingState:             importing.PROCESSING_STATE_PENDING,
		IdentityId:                  identityId,
		RowNumber:                   rowId,
		SourceLocator:               "synthetic",
		RawTransactionTime:          "synthetic",
		RawAmount:                   "synthetic",
		RawDirection:                "synthetic",
		RawStatus:                   "synthetic",
		RawTransactionType:          "synthetic",
		RawCounterparty:             "synthetic merchant",
		RawItem:                     "synthetic item",
		RawPaymentMethod:            "synthetic channel",
		NormalizedUnixTime:          int64Pointer(unixTime),
		NormalizedTimezoneUtcOffset: int16Pointer(480),
		NormalizedAmount:            int64Pointer(amount),
		Currency:                    currency,
		NormalizedDirection:         importing.NORMALIZED_DIRECTION_EXPENSE,
		NormalizedTransactionType:   importing.SOURCE_TRANSACTION_TYPE_PAYMENT,
		EconomicEffect:              importing.ECONOMIC_EFFECT_NORMAL,
		ObservedSourceIdentityKey:   candidateDigest(rowId),
		ObservedSourceCoreDigest:    candidateDigest(rowId + 2_000_000),
		RawFieldsJson:               "[]",
		IssuesJson:                  "[]",
		RawSnapshotVersion:          importing.RAW_SNAPSHOT_VERSION_V1,
		ParserVersion:               "parser-v1",
		NormalizationVersion:        "normalization-v1",
		IdentityKeyVersion:          importing.IDENTITY_KEY_VERSION_V1,
		CoreDigestVersion:           importing.CORE_DIGEST_VERSION_V1,
		FingerprintVersion:          importing.FINGERPRINT_VERSION_V1,
		SemanticEligibility:         importing.SEMANTIC_ELIGIBILITY_POSTABLE,
		Disposition:                 importing.IMPORT_DISPOSITION_POSTABLE,
		CreatedUnixTime:             1,
		RowId:                       rowId,
	}
}

func insertCandidateFixtures(t *testing.T, database *datastore.Database, fixtures ...any) {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()

	for _, fixture := range fixtures {
		inserted, err := sess.Insert(fixture)

		if err != nil || inserted != 1 {
			t.Fatalf("insert reconciliation candidate fixture %T: inserted=%d err=%v", fixture, inserted, err)
		}
	}
}

func listCandidateMembers(t *testing.T, database *datastore.Database, uid int64, caseId int64) []*CaseMember {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	members := make([]*CaseMember, 0)

	if err := sess.Where("uid=? AND case_id=?", uid, caseId).Asc("member_order").Find(&members); err != nil {
		t.Fatalf("list reconciliation candidate members: %v", err)
	}

	return members
}

func loadCandidateRow(t *testing.T, database *datastore.Database, uid int64, rowId int64) *importing.RawImportRow {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	row := new(importing.RawImportRow)
	found, err := sess.Where("uid=? AND row_id=?", uid, rowId).Get(row)

	if err != nil || !found {
		t.Fatalf("load reconciliation candidate raw row: %v", err)
	}

	return row
}

func loadCandidateBatch(t *testing.T, database *datastore.Database, uid int64, batchId int64) *importing.ImportBatch {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	batch := new(importing.ImportBatch)
	found, err := sess.Where("uid=? AND batch_id=?", uid, batchId).Get(batch)

	if err != nil || !found {
		t.Fatalf("load reconciliation candidate batch: %v", err)
	}

	return batch
}

func countCandidateRows(t *testing.T, database *datastore.Database, bean any, condition string, arguments ...any) int64 {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	count, err := sess.Where(condition, arguments...).Count(bean)

	if err != nil {
		t.Fatalf("count reconciliation candidate rows %T: %v", bean, err)
	}

	return count
}

func setCandidateCaseState(t *testing.T, database *datastore.Database, uid int64, caseId int64, status CaseStatus, decisionId *int64, score int64, reasons string) {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	updated, err := sess.Where("uid=? AND case_id=?", uid, caseId).
		Cols("status", "current_decision_id", "candidate_score", "reason_codes_json").
		Update(&Case{Status: status, CurrentDecisionId: decisionId, CandidateScore: score, ReasonCodesJson: reasons})

	if err != nil || updated != 1 {
		t.Fatalf("set reconciliation candidate case state: updated=%d err=%v", updated, err)
	}
}

func assertNoCandidateLedgerEffects(t *testing.T, database *datastore.Database, uid int64) {
	t.Helper()
	if countCandidateRows(t, database, new(models.Transaction), "uid=?", uid) != 0 ||
		countCandidateRows(t, database, new(importing.ImportPosting), "uid=?", uid) != 0 ||
		countCandidateRows(t, database, new(importing.RawRowTransactionLink), "uid=?", uid) != 0 ||
		countCandidateRows(t, database, new(Decision), "uid=?", uid) != 0 ||
		countCandidateRows(t, database, new(TransactionLink), "uid=?", uid) != 0 ||
		countCandidateRows(t, database, new(LedgerEffect), "uid=?", uid) != 0 {
		t.Fatalf("candidate generation produced a formal ledger effect")
	}
}

func candidateDigest(value int64) string {
	digest := sha256.Sum256([]byte(fmt.Sprintf("synthetic-%d", value)))
	return hex.EncodeToString(digest[:])
}

func int64Pointer(value int64) *int64 {
	return &value
}

func int16Pointer(value int16) *int16 {
	return &value
}
