package cardcycle

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/migrations"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

func TestServiceRecordsActualCoverageMarksProvisionalAndRevisesLateStatement(t *testing.T) {
	repository := newServiceSQLiteRepository(t)
	var nextId int64 = 8000
	uid := int64(1001)
	otherUID := int64(2002)
	cardID := int64(11)
	cashID := int64(22)
	accounts := &fakeCardAccounts{byUID: map[int64][]AccountSnapshot{
		uid: {
			{AccountId: cardID, DisplayName: "兴业银行信用卡", Currency: "CNY", CreditCard: true},
			{AccountId: cashID, DisplayName: "现金", Currency: "CNY"},
		},
		otherUID: {
			{AccountId: cardID, DisplayName: "他卡", Currency: "CNY", CreditCard: true},
		},
	}}
	firstStart := time.Date(2026, 7, 16, 0, 0, 0, 0, time.UTC)
	firstEnd := time.Date(2026, 8, 15, 23, 59, 59, 0, time.UTC)
	lateStart := time.Date(2026, 8, 16, 0, 0, 0, 0, time.UTC)
	lateEnd := time.Date(2026, 9, 15, 23, 59, 59, 0, time.UTC)
	evidence := &fakeCardEvidence{batches: map[int64]*importing.ImportBatch{
		301: testStatementBatch(uid, 301, cardID, firstStart, firstEnd, importing.IMPORT_BATCH_STATUS_COMPLETED),
		302: testStatementBatch(uid, 302, cardID, lateStart, lateEnd, importing.IMPORT_BATCH_STATUS_COMPLETED),
		401: testStatementBatch(otherUID, 401, cardID, firstStart, firstEnd, importing.IMPORT_BATCH_STATUS_COMPLETED),
	}}
	service, err := NewService(repository, evidence, accounts, func() int64 {
		nextId++
		return nextId
	})
	if err != nil {
		t.Fatalf("create card cycle service: %v", err)
	}
	service.now = func() time.Time { return time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC) }

	firstRule, err := service.SaveRule(nil, SaveRuleRequest{
		Uid: uid, LedgerAccountId: cardID, StatementDay: 15, DueDay: 3,
		EffectiveFrom: "2026-08-01", IdempotencyKey: "rule-key-1",
	})
	if err != nil || firstRule == nil || firstRule.RuleNumber != 1 || firstRule.Status != RULE_STATUS_ACTIVE {
		t.Fatalf("save first rule: %+v err=%v", firstRule, err)
	}
	sameRule, err := service.SaveRule(nil, SaveRuleRequest{
		Uid: uid, LedgerAccountId: cardID, StatementDay: 15, DueDay: 3,
		EffectiveFrom: "2026-08-01", IdempotencyKey: "rule-key-1b",
	})
	if err != nil || sameRule == nil || sameRule.RuleId != firstRule.RuleId {
		t.Fatalf("identical rule was rewritten: %+v err=%v", sameRule, err)
	}
	revisedRule, err := service.SaveRule(nil, SaveRuleRequest{
		Uid: uid, LedgerAccountId: cardID, StatementDay: 16, DueDay: 4,
		EffectiveFrom: "2026-09-01", IdempotencyKey: "rule-key-2",
	})
	if err != nil || revisedRule == nil || revisedRule.RuleNumber != 2 || revisedRule.Status != RULE_STATUS_ACTIVE {
		t.Fatalf("save revised rule: %+v err=%v", revisedRule, err)
	}
	rules, err := repository.ListRules(nil, uid, cardID)
	if err != nil || len(rules) != 2 || rules[0].Status != RULE_STATUS_SUPERSEDED ||
		rules[0].StatementDay != 15 || rules[1].RuleId != revisedRule.RuleId {
		t.Fatalf("old rule was rewritten or not superseded: %+v err=%v", rules, err)
	}

	if _, err := service.SaveRule(nil, SaveRuleRequest{
		Uid: uid, LedgerAccountId: cashID, StatementDay: 15, DueDay: 3,
		EffectiveFrom: "2026-08-01", IdempotencyKey: "rule-cash-1",
	}); !errors.Is(err, ErrServiceAccountRejected) {
		t.Fatalf("non-credit-card rule was accepted: %v", err)
	}

	firstCoverage, err := service.RecordCoverage(nil, RecordCoverageRequest{
		Uid: uid, BatchId: 301, LedgerAccountId: cardID, TaskId: 501,
	})
	if err != nil || firstCoverage == nil || firstCoverage.PeriodStart != "2026-07-16" ||
		firstCoverage.PeriodEnd != "2026-08-15" || firstCoverage.StatementDate != "" || firstCoverage.DueDate != "" {
		t.Fatalf("actual coverage was not recorded: %+v err=%v", firstCoverage, err)
	}
	sameCoverage, err := service.RecordCoverage(nil, RecordCoverageRequest{
		Uid: uid, BatchId: 301, LedgerAccountId: cardID, TaskId: 501,
	})
	if err != nil || sameCoverage == nil || sameCoverage.CoverageId != firstCoverage.CoverageId {
		t.Fatalf("coverage ingest was not idempotent: %+v err=%v", sameCoverage, err)
	}

	asOf := "2026-08-31"
	coverage, err := service.GetCoverage(nil, uid, cardID, asOf, "2026-08")
	if err != nil || coverage == nil || coverage.MonthStatus != MONTH_STATUS_PROVISIONAL ||
		len(coverage.Gaps) != 1 || coverage.Gaps[0].StartDate != "2026-08-16" || coverage.Gaps[0].EndDate != "2026-08-31" ||
		len(coverage.Revisions) != 0 {
		t.Fatalf("August was not provisional with uncovered swipe gap: %+v err=%v", coverage, err)
	}

	service.now = func() time.Time { return time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC) }
	lateCoverage, err := service.RecordCoverage(nil, RecordCoverageRequest{
		Uid: uid, BatchId: 302, LedgerAccountId: cardID, TaskId: 502,
	})
	if err != nil || lateCoverage == nil || lateCoverage.PeriodStart != "2026-08-16" || lateCoverage.PeriodEnd != "2026-09-15" {
		t.Fatalf("late coverage was not recorded: %+v err=%v", lateCoverage, err)
	}
	revised, err := service.GetCoverage(nil, uid, cardID, asOf, "2026-08")
	if err != nil || revised == nil || revised.MonthStatus != MONTH_STATUS_CONFIRMED || len(revised.Gaps) != 0 ||
		len(revised.Revisions) != 1 || revised.Revisions[0].ReasonCode != REASON_LATE_STATEMENT ||
		revised.Revisions[0].TaskId != 502 || revised.Revisions[0].YearMonth != "2026-08" {
		t.Fatalf("late statement did not revise August: %+v err=%v", revised, err)
	}

	accountsView, err := service.ListAccounts(nil, uid, asOf)
	if err != nil || accountsView == nil || len(accountsView.Items) != 1 || accountsView.Items[0].LedgerAccountId != cardID ||
		accountsView.Items[0].MonthStatus != MONTH_STATUS_CONFIRMED || accountsView.Items[0].UncoveredGap != nil ||
		accountsView.Items[0].ActiveRule == nil || accountsView.Items[0].ActiveRule.StatementDay != 16 {
		t.Fatalf("card account list is wrong: %+v err=%v", accountsView, err)
	}

	skipped, err := service.SaveBalanceReview(nil, SaveBalanceReviewRequest{
		Uid: uid, LedgerAccountId: cashID, Status: BALANCE_REVIEW_UNVERIFIED,
		AsOfDate: "", IdempotencyKey: "review-skip-1",
	})
	if err != nil || skipped == nil || skipped.Status != BALANCE_REVIEW_UNVERIFIED || skipped.AsOfDate != "" || skipped.Version != 1 {
		t.Fatalf("skip review was not unverified: %+v err=%v", skipped, err)
	}
	sameSkip, err := service.SaveBalanceReview(nil, SaveBalanceReviewRequest{
		Uid: uid, LedgerAccountId: cashID, Status: BALANCE_REVIEW_UNVERIFIED,
		AsOfDate: "", IdempotencyKey: "review-skip-1b",
	})
	if err != nil || sameSkip == nil || sameSkip.ReviewId != skipped.ReviewId {
		t.Fatalf("identical skip review was rewritten: %+v err=%v", sameSkip, err)
	}
	if _, err := service.SaveBalanceReview(nil, SaveBalanceReviewRequest{
		Uid: uid, LedgerAccountId: cashID, Status: BALANCE_REVIEW_VERIFIED,
		AsOfDate: "2026-08-15", ExpectedVersion: 0, IdempotencyKey: "review-verify-stale",
	}); !errors.Is(err, ErrServiceVersionConflict) {
		t.Fatalf("stale verify without CAS was accepted: %v", err)
	}
	verified, err := service.SaveBalanceReview(nil, SaveBalanceReviewRequest{
		Uid: uid, LedgerAccountId: cashID, Status: BALANCE_REVIEW_VERIFIED,
		AsOfDate: "2026-08-15", ExpectedVersion: skipped.Version, IdempotencyKey: "review-verify-1",
	})
	if err != nil || verified == nil || verified.Status != BALANCE_REVIEW_VERIFIED ||
		verified.AsOfDate != "2026-08-15" || verified.Version != 2 {
		t.Fatalf("verified review CAS failed: %+v err=%v", verified, err)
	}

	otherCoverage, err := service.GetCoverage(nil, otherUID, cardID, asOf, "2026-08")
	if err != nil || otherCoverage == nil || len(otherCoverage.Coverages) != 0 ||
		otherCoverage.MonthStatus != MONTH_STATUS_PROVISIONAL {
		t.Fatalf("cross-uid coverage leaked: %+v err=%v", otherCoverage, err)
	}
	if _, err := service.RecordCoverage(nil, RecordCoverageRequest{
		Uid: otherUID, BatchId: 301, LedgerAccountId: cardID, TaskId: 601,
	}); !errors.Is(err, ErrServiceBatchNotFound) {
		t.Fatalf("cross-uid batch coverage was accepted: %v", err)
	}
}

func TestServiceRejectsInvalidRuleDaysAndMissingAsOfDate(t *testing.T) {
	repository := newServiceSQLiteRepository(t)
	service, err := NewService(repository, &fakeCardEvidence{}, &fakeCardAccounts{byUID: map[int64][]AccountSnapshot{
		1001: {{AccountId: 11, DisplayName: "卡", Currency: "CNY", CreditCard: true}},
	}}, func() int64 { return 1 })
	if err != nil {
		t.Fatalf("create card cycle service: %v", err)
	}
	if _, err := service.SaveRule(nil, SaveRuleRequest{
		Uid: 1001, LedgerAccountId: 11, StatementDay: 29, DueDay: 3,
		EffectiveFrom: "2026-08-01", IdempotencyKey: "rule-invalid",
	}); !errors.Is(err, ErrServiceInvalidRequest) {
		t.Fatalf("statement day 29 was accepted: %v", err)
	}
	if _, err := service.SaveBalanceReview(nil, SaveBalanceReviewRequest{
		Uid: 1001, LedgerAccountId: 11, Status: BALANCE_REVIEW_VERIFIED,
		AsOfDate: "", IdempotencyKey: "review-invalid",
	}); !errors.Is(err, ErrServiceInvalidRequest) {
		t.Fatalf("verified review without as-of date was accepted: %v", err)
	}
	if _, err := service.ListAccounts(nil, 1001, ""); !errors.Is(err, ErrServiceInvalidRequest) {
		t.Fatalf("empty as-of date was accepted: %v", err)
	}
}

type fakeCardAccounts struct {
	byUID map[int64][]AccountSnapshot
}

func (f *fakeCardAccounts) ListCreditCardAccounts(_ core.Context, uid int64) ([]AccountSnapshot, error) {
	items := make([]AccountSnapshot, 0)
	for _, account := range f.byUID[uid] {
		if account.CreditCard {
			items = append(items, account)
		}
	}
	return items, nil
}

func (f *fakeCardAccounts) GetAccount(_ core.Context, uid int64, accountId int64) (*AccountSnapshot, error) {
	for _, account := range f.byUID[uid] {
		if account.AccountId == accountId {
			cloned := account
			return &cloned, nil
		}
	}
	return nil, nil
}

type fakeCardEvidence struct {
	batches map[int64]*importing.ImportBatch
}

func (f *fakeCardEvidence) FindImportBatchById(_ core.Context, uid int64, batchId int64) (*importing.ImportBatch, error) {
	batch := f.batches[batchId]
	if batch == nil || batch.Uid != uid {
		return nil, nil
	}
	return batch, nil
}

func testStatementBatch(uid int64, batchId int64, ledgerAccountId int64, start time.Time, end time.Time, status importing.ImportBatchStatus) *importing.ImportBatch {
	startUnix := start.Unix()
	endUnix := end.Unix()
	accountId := ledgerAccountId
	return &importing.ImportBatch{
		Uid: uid, BatchId: batchId, LedgerAccountId: &accountId, Status: status,
		StatementStartUnixTime: &startUnix, StatementEndUnixTime: &endUnix,
	}
}

func newServiceSQLiteRepository(t *testing.T) *Repository {
	t.Helper()
	database, err := datastore.OpenDatabase(&settings.DatabaseConfig{
		DatabaseType:          settings.Sqlite3DbType,
		DatabasePath:          filepath.Join(t.TempDir(), "cardcycle-service.db"),
		MaxIdleConnection:     1,
		MaxOpenConnection:     1,
		ConnectionMaxLifeTime: 60,
	})
	if err != nil {
		t.Fatalf("open SQLite card cycle service database: %v", err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close SQLite card cycle service database: %v", err)
		}
	})

	store, err := datastore.NewDataStore(database)
	if err != nil {
		t.Fatalf("create SQLite card cycle service store: %v", err)
	}
	if err := migrations.Upgrade(nil, store, migrations.ApplicationInfo{Version: "test", Commit: "card-cycle-701"}); err != nil {
		t.Fatalf("upgrade SQLite card cycle service schema: %v", err)
	}

	repository, err := NewRepository(store)
	if err != nil {
		t.Fatalf("create SQLite card cycle service repository: %v", err)
	}
	return repository
}
