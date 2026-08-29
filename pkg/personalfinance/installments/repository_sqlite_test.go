package installments_test

import (
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/installments"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/migrations"
	"github.com/gaohongxiang/catledger/pkg/settings"
)

func TestRepositorySQLiteUnknownAmountsStayNullAndCASClearsThem(t *testing.T) {
	repository, _ := newSQLiteInstallmentRepository(t)
	const firstUid = int64(1001)
	const secondUid = int64(2002)
	key := strings.Repeat("c", 64)

	created, createdFlag, err := repository.CreateOrFindCandidate(nil, testCandidate(firstUid, 101, key, 10))
	if err != nil || !createdFlag || created == nil {
		t.Fatalf("insert owned installment candidate: created=%t candidate=%+v err=%v", createdFlag, created, err)
	}
	if created.PrincipalAmount != nil || created.PaymentAmount != nil || created.InterestAmount != nil ||
		created.FeeAmount != nil || created.TermCount != nil || created.CurrentPeriod != nil ||
		created.RepaymentMethod != installments.REPAYMENT_METHOD_UNKNOWN || created.FirstDueDate != "" {
		t.Fatalf("unknown installment fields were not persisted as empty/NULL: %+v", created)
	}

	if _, _, err := repository.CreateOrFindCandidate(nil, testCandidate(secondUid, 201, key, 20)); err != nil {
		t.Fatalf("insert second-user installment candidate: %v", err)
	}

	if candidate, findErr := repository.FindCandidateById(nil, firstUid, 201); findErr != nil || candidate != nil {
		t.Fatalf("cross-user candidate was visible: candidate=%+v err=%v", candidate, findErr)
	}

	loaded, err := repository.FindCandidateById(nil, firstUid, 101)
	if err != nil || loaded == nil || loaded.PrincipalAmount != nil || loaded.TermCount != nil {
		t.Fatalf("reloaded unknown amounts were not NULL: candidate=%+v err=%v", loaded, err)
	}

	if err := repository.DoTransaction(nil, firstUid, func(tx *installments.RepositoryTransaction) error {
		principal := int64(10000)
		termCount := int64(12)
		next := *loaded
		next.Status = installments.CANDIDATE_STATUS_NEEDS_DETAILS
		next.Version = 2
		next.PrincipalAmount = &principal
		next.TermCount = &termCount
		next.RepaymentMethod = installments.REPAYMENT_METHOD_EQUAL_PAYMENT
		next.FirstDueDate = "2026-09-15"
		next.UpdatedUnixTime = 11
		updated, updateErr := tx.UpdateCandidateCAS(1, &next)
		if updateErr != nil || !updated {
			return errors.New("owned candidate CAS failed")
		}

		cleared := next
		cleared.Version = 3
		cleared.PrincipalAmount = nil
		cleared.TermCount = nil
		cleared.UpdatedUnixTime = 12
		updated, updateErr = tx.UpdateCandidateCAS(2, &cleared)
		if updateErr != nil || !updated {
			return errors.New("candidate CAS could not restore unknown NULL")
		}

		if err := tx.InsertMember(testCandidateMember(firstUid, 101, 301, installments.MEMBER_KIND_SOURCE_IDENTITY, 401, 10)); err != nil {
			return err
		}
		duplicate := testCandidateMember(firstUid, 101, 302, installments.MEMBER_KIND_SOURCE_IDENTITY, 401, 11)
		if err := tx.InsertMember(duplicate); err == nil {
			return errors.New("duplicate candidate member was accepted")
		}

		crossUser := *loaded
		crossUser.Uid = firstUid
		crossUser.CandidateId = 201
		crossUser.Version = 2
		crossUser.UpdatedUnixTime = 13
		updated, updateErr = tx.UpdateCandidateCAS(1, &crossUser)
		if updateErr != nil || updated {
			return errors.New("cross-user candidate CAS succeeded")
		}
		return nil
	}); err != nil {
		t.Fatalf("exercise installment candidate CAS and members: %v", err)
	}

	reloaded, err := repository.FindCandidateById(nil, firstUid, 101)
	if err != nil || reloaded == nil || reloaded.PrincipalAmount != nil || reloaded.TermCount != nil ||
		reloaded.RepaymentMethod != installments.REPAYMENT_METHOD_EQUAL_PAYMENT || reloaded.FirstDueDate != "2026-09-15" {
		t.Fatalf("cleared unknown amounts did not remain NULL: candidate=%+v err=%v", reloaded, err)
	}

	members, err := repository.ListMembers(nil, firstUid, 101)
	if err != nil || len(members) != 1 || members[0].MemberId != 301 {
		t.Fatalf("owned members were not listed: members=%+v err=%v", members, err)
	}
	if members, findErr := repository.ListMembers(nil, secondUid, 101); findErr != nil || len(members) != 0 {
		t.Fatalf("cross-user members were visible: members=%+v err=%v", members, findErr)
	}

	rollbackErr := errors.New("rollback installment repository transaction")
	err = repository.DoTransaction(nil, firstUid, func(tx *installments.RepositoryTransaction) error {
		if _, _, err := tx.CreateOrFindCandidate(testCandidate(firstUid, 999, strings.Repeat("d", 64), 200)); err != nil {
			return err
		}
		return rollbackErr
	})
	if !errors.Is(err, rollbackErr) {
		t.Fatalf("transaction did not return rollback cause: %v", err)
	}
	if candidate, findErr := repository.FindCandidateById(nil, firstUid, 999); findErr != nil || candidate != nil {
		t.Fatalf("rolled-back candidate remained visible: candidate=%+v err=%v", candidate, findErr)
	}

	zero := int64(0)
	knownZero := testCandidate(firstUid, 102, strings.Repeat("f", 64), 10)
	knownZero.FeeAmount = &zero
	if persisted, created, persistErr := repository.CreateOrFindCandidate(nil, knownZero); persistErr != nil || !created || persisted == nil || persisted.FeeAmount == nil || *persisted.FeeAmount != 0 {
		t.Fatalf("known zero fee was not persisted: created=%t candidate=%+v err=%v", created, persisted, persistErr)
	}

	negative := int64(-1)
	invalid := testCandidate(firstUid, 103, strings.Repeat("1", 64), 10)
	invalid.PrincipalAmount = &negative
	if _, _, persistErr := repository.CreateOrFindCandidate(nil, invalid); persistErr == nil {
		t.Fatal("negative principal was accepted")
	}
}

func TestRepositorySQLiteConcurrentCandidateAdjudication(t *testing.T) {
	repository, _ := newSQLiteInstallmentRepositoryWithConnections(t, 8)
	const uid = int64(3003)
	const workers = 8
	key := strings.Repeat("e", 64)
	type result struct {
		candidateId int64
		created     bool
		err         error
	}
	results := make(chan result, workers)
	start := make(chan struct{})
	var group sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		worker := worker
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			candidate, created, err := repository.CreateOrFindCandidate(nil, testCandidate(uid, int64(1000+worker), key, int64(10+worker)))
			item := result{created: created, err: err}
			if candidate != nil {
				item.candidateId = candidate.CandidateId
			}
			results <- item
		}()
	}
	close(start)
	group.Wait()
	close(results)

	winner := int64(0)
	createdCount := 0
	for item := range results {
		if item.err != nil || item.candidateId < 1 {
			t.Fatalf("concurrent candidate persistence failed: %+v", item)
		}
		if winner == 0 {
			winner = item.candidateId
		} else if item.candidateId != winner {
			t.Fatalf("concurrent candidates did not converge: first=%d result=%+v", winner, item)
		}
		if item.created {
			createdCount++
		}
	}
	if createdCount != 1 {
		t.Fatalf("concurrent candidate unique constraint produced %d creators", createdCount)
	}
}

func newSQLiteInstallmentRepository(t *testing.T) (*installments.Repository, *datastore.Database) {
	return newSQLiteInstallmentRepositoryWithConnections(t, 1)
}

func newSQLiteInstallmentRepositoryWithConnections(t *testing.T, maxOpenConnections uint16) (*installments.Repository, *datastore.Database) {
	t.Helper()
	database, err := datastore.OpenDatabase(&settings.DatabaseConfig{
		DatabaseType:          settings.Sqlite3DbType,
		DatabasePath:          filepath.Join(t.TempDir(), "installments.db"),
		MaxIdleConnection:     1,
		MaxOpenConnection:     maxOpenConnections,
		ConnectionMaxLifeTime: 60,
	})
	if err != nil {
		t.Fatalf("open SQLite installment database: %v", err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close SQLite installment database: %v", err)
		}
	})

	store, err := datastore.NewDataStore(database)
	if err != nil {
		t.Fatalf("create SQLite installment store: %v", err)
	}
	if err := migrations.Upgrade(nil, store, migrations.ApplicationInfo{Version: "test", Commit: "inst-db-701"}); err != nil {
		t.Fatalf("upgrade SQLite installment schema: %v", err)
	}

	repository, err := installments.NewRepository(store)
	if err != nil {
		t.Fatalf("create SQLite installment repository: %v", err)
	}
	return repository, database
}

func testCandidate(uid int64, candidateId int64, key string, now int64) *installments.Candidate {
	return &installments.Candidate{
		Uid:                 uid,
		CandidateKey:        key,
		CandidateKeyVersion: installments.CANDIDATE_KEY_VERSION_V1,
		Status:              installments.CANDIDATE_STATUS_PENDING,
		Version:             1,
		PurchaseRelation:    installments.PURCHASE_RELATION_UNRESOLVED,
		CreatedUnixTime:     now,
		UpdatedUnixTime:     now,
		CandidateId:         candidateId,
	}
}

func testCandidateMember(uid int64, candidateId int64, memberId int64, kind installments.MemberKind, refId int64, now int64) *installments.CandidateMember {
	return &installments.CandidateMember{
		Uid:             uid,
		CandidateId:     candidateId,
		MemberKind:      kind,
		MemberRefId:     refId,
		MemberRole:      installments.MEMBER_ROLE_INSTALLMENT_CHARGE,
		CreatedUnixTime: now,
		MemberId:        memberId,
	}
}
