package cardcycle_test

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/cardcycle"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/migrations"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

func TestRepositorySQLiteUIDIsolationCASCoverageAndRevisions(t *testing.T) {
	repository, _ := newSQLiteCardCycleRepository(t)
	const firstUid = int64(1001)
	const secondUid = int64(2002)

	if err := repository.DoTransaction(nil, firstUid, func(tx *cardcycle.RepositoryTransaction) error {
		if err := tx.InsertRule(testRule(firstUid, 11, 101, 1, cardcycle.RULE_STATUS_ACTIVE, 10)); err != nil {
			return err
		}
		if err := tx.InsertCoverage(testCoverage(firstUid, 11, 201, 301, "2026-07-16", "2026-08-15", 10)); err != nil {
			return err
		}
		if err := tx.InsertMonthRevision(testMonthRevision(firstUid, 401, "2026-07", 501, 10)); err != nil {
			return err
		}
		if err := tx.InsertMonthRevision(testMonthRevision(firstUid, 402, "2026-07", 501, 11)); err != nil {
			return err
		}
		return tx.InsertBalanceReview(testBalanceReview(firstUid, 11, 601, cardcycle.BALANCE_REVIEW_UNVERIFIED, "", 10))
	}); err != nil {
		t.Fatalf("insert first-user card cycle fixtures: %v", err)
	}

	if err := repository.DoTransaction(nil, secondUid, func(tx *cardcycle.RepositoryTransaction) error {
		if err := tx.InsertRule(testRule(secondUid, 11, 201, 1, cardcycle.RULE_STATUS_ACTIVE, 20)); err != nil {
			return err
		}
		return tx.InsertBalanceReview(testBalanceReview(secondUid, 11, 701, cardcycle.BALANCE_REVIEW_UNVERIFIED, "", 20))
	}); err != nil {
		t.Fatalf("insert second-user card cycle fixtures: %v", err)
	}

	rules, err := repository.ListRules(nil, firstUid, 11)
	if err != nil || len(rules) != 1 || rules[0].RuleId != 101 {
		t.Fatalf("owned rules were not listed: rules=%+v err=%v", rules, err)
	}
	if rules, findErr := repository.ListRules(nil, secondUid, 11); findErr != nil || len(rules) != 1 || rules[0].RuleId != 201 {
		t.Fatalf("second-user rules were mixed: rules=%+v err=%v", rules, findErr)
	}

	coverage, err := repository.FindCoverageByBatch(nil, firstUid, 301)
	if err != nil || coverage == nil || coverage.CoverageId != 201 || coverage.StatementDate != "" || coverage.DueDate != "" {
		t.Fatalf("owned coverage lookup failed: coverage=%+v err=%v", coverage, err)
	}
	if coverage, findErr := repository.FindCoverageByBatch(nil, secondUid, 301); findErr != nil || coverage != nil {
		t.Fatalf("cross-user coverage was visible: coverage=%+v err=%v", coverage, findErr)
	}

	revisions, err := repository.ListMonthRevisions(nil, firstUid, "2026-07", 10)
	if err != nil || len(revisions) != 2 || revisions[0].RevisionId != 402 || revisions[1].RevisionId != 401 {
		t.Fatalf("month revisions were not listed newest first: revisions=%+v err=%v", revisions, err)
	}

	review, err := repository.FindBalanceReviewByAccount(nil, firstUid, 11)
	if err != nil || review == nil || review.ReviewId != 601 || review.AsOfDate != "" {
		t.Fatalf("owned unverified review lookup failed: review=%+v err=%v", review, err)
	}
	if review, findErr := repository.FindBalanceReviewByAccount(nil, secondUid, 11); findErr != nil || review == nil || review.ReviewId != 701 {
		t.Fatalf("second-user review was mixed: review=%+v err=%v", review, findErr)
	}

	if err := repository.DoTransaction(nil, firstUid, func(tx *cardcycle.RepositoryTransaction) error {
		if err := tx.InsertRule(testRule(firstUid, 11, 102, 2, cardcycle.RULE_STATUS_ACTIVE, 12)); err != nil {
			return err
		}
		duplicateRule := testRule(firstUid, 11, 103, 1, cardcycle.RULE_STATUS_SUPERSEDED, 13)
		if err := tx.InsertRule(duplicateRule); err == nil {
			return errors.New("duplicate card rule number was accepted")
		}

		duplicateCoverage := testCoverage(firstUid, 11, 202, 301, "2026-08-16", "2026-09-15", 13)
		if err := tx.InsertCoverage(duplicateCoverage); err == nil {
			return errors.New("duplicate coverage batch was accepted")
		}

		invalidDay := testRule(firstUid, 12, 104, 1, cardcycle.RULE_STATUS_ACTIVE, 13)
		invalidDay.StatementDay = 29
		if err := tx.InsertRule(invalidDay); err == nil {
			return errors.New("statement day 29 was accepted")
		}

		next := *testBalanceReview(firstUid, 11, 601, cardcycle.BALANCE_REVIEW_VERIFIED, "2026-08-15", 14)
		next.Version = 2
		updated, updateErr := tx.UpdateBalanceReviewCAS(1, &next)
		if updateErr != nil || !updated {
			return errors.New("owned balance review CAS failed")
		}
		updated, updateErr = tx.UpdateBalanceReviewCAS(1, &next)
		if updateErr != nil || updated {
			return errors.New("stale balance review CAS succeeded")
		}

		crossUser := *testBalanceReview(firstUid, 11, 701, cardcycle.BALANCE_REVIEW_VERIFIED, "2026-08-15", 15)
		crossUser.Version = 2
		updated, updateErr = tx.UpdateBalanceReviewCAS(1, &crossUser)
		if updateErr != nil || updated {
			return errors.New("cross-user balance review CAS succeeded")
		}

		invalidVerified := *testBalanceReview(firstUid, 11, 601, cardcycle.BALANCE_REVIEW_VERIFIED, "", 16)
		invalidVerified.Version = 3
		if _, updateErr = tx.UpdateBalanceReviewCAS(2, &invalidVerified); updateErr == nil {
			return errors.New("verified review without as-of date was accepted")
		}
		return nil
	}); err != nil {
		t.Fatalf("exercise card cycle uniqueness and CAS: %v", err)
	}

	verified, err := repository.FindBalanceReviewByAccount(nil, firstUid, 11)
	if err != nil || verified == nil || verified.Status != cardcycle.BALANCE_REVIEW_VERIFIED || verified.AsOfDate != "2026-08-15" {
		t.Fatalf("verified review was not persisted: review=%+v err=%v", verified, err)
	}

	rollbackErr := errors.New("rollback card cycle repository transaction")
	err = repository.DoTransaction(nil, firstUid, func(tx *cardcycle.RepositoryTransaction) error {
		if err := tx.InsertCoverage(testCoverage(firstUid, 11, 999, 399, "2026-09-16", "2026-10-15", 200)); err != nil {
			return err
		}
		return rollbackErr
	})
	if !errors.Is(err, rollbackErr) {
		t.Fatalf("transaction did not return rollback cause: %v", err)
	}
	if coverage, findErr := repository.FindCoverageByBatch(nil, firstUid, 399); findErr != nil || coverage != nil {
		t.Fatalf("rolled-back coverage remained visible: coverage=%+v err=%v", coverage, findErr)
	}
}

func newSQLiteCardCycleRepository(t *testing.T) (*cardcycle.Repository, *datastore.Database) {
	t.Helper()
	database, err := datastore.OpenDatabase(&settings.DatabaseConfig{
		DatabaseType:          settings.Sqlite3DbType,
		DatabasePath:          filepath.Join(t.TempDir(), "cardcycle.db"),
		MaxIdleConnection:     1,
		MaxOpenConnection:     1,
		ConnectionMaxLifeTime: 60,
	})
	if err != nil {
		t.Fatalf("open SQLite card cycle database: %v", err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close SQLite card cycle database: %v", err)
		}
	})

	store, err := datastore.NewDataStore(database)
	if err != nil {
		t.Fatalf("create SQLite card cycle store: %v", err)
	}
	if err := migrations.Upgrade(nil, store, migrations.ApplicationInfo{Version: "test", Commit: "card-db-701"}); err != nil {
		t.Fatalf("upgrade SQLite card cycle schema: %v", err)
	}

	repository, err := cardcycle.NewRepository(store)
	if err != nil {
		t.Fatalf("create SQLite card cycle repository: %v", err)
	}
	return repository, database
}

func testRule(uid int64, ledgerAccountId int64, ruleId int64, number int64, status cardcycle.RuleStatus, now int64) *cardcycle.CycleRule {
	return &cardcycle.CycleRule{
		Uid:             uid,
		LedgerAccountId: ledgerAccountId,
		RuleNumber:      number,
		StatementDay:    15,
		DueDay:          3,
		EffectiveFrom:   "2026-08-01",
		Status:          status,
		CreatedUnixTime: now,
		RuleId:          ruleId,
	}
}

func testCoverage(uid int64, ledgerAccountId int64, coverageId int64, batchId int64, periodStart string, periodEnd string, now int64) *cardcycle.StatementCoverage {
	return &cardcycle.StatementCoverage{
		Uid:             uid,
		LedgerAccountId: ledgerAccountId,
		BatchId:         batchId,
		PeriodStart:     periodStart,
		PeriodEnd:       periodEnd,
		CreatedUnixTime: now,
		CoverageId:      coverageId,
	}
}

func testMonthRevision(uid int64, revisionId int64, yearMonth string, taskId int64, now int64) *cardcycle.MonthReportRevision {
	return &cardcycle.MonthReportRevision{
		Uid:             uid,
		YearMonth:       yearMonth,
		TaskId:          taskId,
		ReasonCode:      "late_statement",
		CreatedUnixTime: now,
		RevisionId:      revisionId,
	}
}

func testBalanceReview(uid int64, ledgerAccountId int64, reviewId int64, status cardcycle.BalanceReviewStatus, asOfDate string, now int64) *cardcycle.BalanceReview {
	return &cardcycle.BalanceReview{
		Uid:             uid,
		LedgerAccountId: ledgerAccountId,
		Status:          status,
		AsOfDate:        asOfDate,
		Version:         1,
		UpdatedUnixTime: now,
		ReviewId:        reviewId,
	}
}
