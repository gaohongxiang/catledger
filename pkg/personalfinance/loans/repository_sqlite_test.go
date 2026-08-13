package loans_test

import (
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/migrations"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

func TestRepositorySQLiteUIDIsolationPaginationCASAndAggregation(t *testing.T) {
	repository, _ := newSQLiteLoanRepository(t)
	const firstUid = int64(1001)
	const secondUid = int64(2002)

	if err := repository.DoTransaction(nil, firstUid, func(tx *loans.RepositoryTransaction) error {
		if err := tx.InsertContract(testContract(firstUid, 101, 301, 10)); err != nil {
			return err
		}

		if err := tx.InsertContract(testContract(firstUid, 102, 302, 10)); err != nil {
			return err
		}

		if err := tx.InsertRevision(testRevision(firstUid, 101, 301, 401, 10)); err != nil {
			return err
		}

		return tx.InsertInstallments([]*loans.Installment{
			testInstallment(firstUid, 101, 301, 501, 1, "2026-09-15", 10),
			testInstallment(firstUid, 101, 301, 502, 2, "2026-10-15", 10),
		})
	}); err != nil {
		t.Fatalf("insert first-user loan fixtures: %v", err)
	}

	if err := repository.DoTransaction(nil, secondUid, func(tx *loans.RepositoryTransaction) error {
		return tx.InsertContract(testContract(secondUid, 201, 601, 99))
	}); err != nil {
		t.Fatalf("insert second-user loan fixture: %v", err)
	}

	firstPage, err := repository.ListContracts(nil, firstUid, loans.CONTRACT_STATUS_ACTIVE, nil, 1)

	if err != nil || len(firstPage.Items) != 1 || firstPage.Items[0].ContractId != 102 || firstPage.NextCursor == nil {
		t.Fatalf("first contract page is not stable: page=%+v err=%v", firstPage, err)
	}

	secondPage, err := repository.ListContracts(nil, firstUid, loans.CONTRACT_STATUS_ACTIVE, firstPage.NextCursor, 1)

	if err != nil || len(secondPage.Items) != 1 || secondPage.Items[0].ContractId != 101 || secondPage.NextCursor != nil {
		t.Fatalf("second contract page is not stable: page=%+v err=%v", secondPage, err)
	}

	if contract, findErr := repository.FindContractById(nil, firstUid, 201); findErr != nil || contract != nil {
		t.Fatalf("cross-user contract was visible: contract=%+v err=%v", contract, findErr)
	}

	installmentPage, err := repository.ListInstallmentsByRevision(nil, firstUid, 101, 301, nil, 1)

	if err != nil || len(installmentPage.Items) != 1 || installmentPage.Items[0].InstallmentId != 501 || installmentPage.NextCursor == nil {
		t.Fatalf("first installment page is not stable: page=%+v err=%v", installmentPage, err)
	}

	installmentPage, err = repository.ListInstallmentsByRevision(nil, firstUid, 101, 301, installmentPage.NextCursor, 1)

	if err != nil || len(installmentPage.Items) != 1 || installmentPage.Items[0].InstallmentId != 502 || installmentPage.NextCursor != nil {
		t.Fatalf("second installment page is not stable: page=%+v err=%v", installmentPage, err)
	}

	if installment, findErr := repository.FindInstallmentById(nil, firstUid, 501); findErr != nil || installment == nil {
		t.Fatalf("owned installment lookup failed: installment=%+v err=%v", installment, findErr)
	}

	if installment, findErr := repository.FindInstallmentById(nil, secondUid, 501); findErr != nil || installment != nil {
		t.Fatalf("cross-user installment was visible: installment=%+v err=%v", installment, findErr)
	}

	if err := repository.DoTransaction(nil, firstUid, func(tx *loans.RepositoryTransaction) error {
		contract, findErr := tx.FindContractById(101)

		if findErr != nil || contract == nil {
			return errors.New("owned contract is missing in transaction")
		}

		next := *contract
		next.Name = "updated"
		next.Version = 2
		next.UpdatedUnixTime = 11
		updated, updateErr := tx.UpdateContractCAS(1, &next)

		if updateErr != nil || !updated {
			return errors.New("owned contract CAS failed")
		}

		updated, updateErr = tx.UpdateContractCAS(1, &next)

		if updateErr != nil || updated {
			return errors.New("stale contract CAS succeeded")
		}

		crossUser := *testContract(firstUid, 201, 601, 100)
		crossUser.Version = 2
		updated, updateErr = tx.UpdateContractCAS(1, &crossUser)

		if updateErr != nil || updated {
			return errors.New("cross-user contract CAS succeeded")
		}

		return nil
	}); err != nil {
		t.Fatalf("exercise contract CAS: %v", err)
	}

	assertActionIdempotency(t, repository, firstUid, secondUid)
	assertBindingAllocationAndAggregate(t, repository, firstUid, secondUid)

	rollbackErr := errors.New("rollback loan repository transaction")
	err = repository.DoTransaction(nil, firstUid, func(tx *loans.RepositoryTransaction) error {
		if err := tx.InsertContract(testContract(firstUid, 999, 999, 200)); err != nil {
			return err
		}

		return rollbackErr
	})

	if !errors.Is(err, rollbackErr) {
		t.Fatalf("transaction did not return rollback cause: %v", err)
	}

	if contract, findErr := repository.FindContractById(nil, firstUid, 999); findErr != nil || contract != nil {
		t.Fatalf("rolled-back contract remained visible: contract=%+v err=%v", contract, findErr)
	}
}

func TestRepositorySQLiteConcurrentUniqueAdjudication(t *testing.T) {
	repository, _ := newSQLiteLoanRepositoryWithConnections(t, 8)
	const uid = int64(3003)
	const workers = 8
	digest := strings.Repeat("8", 64)
	type actionResult struct {
		actionId int64
		created  bool
		err      error
	}
	actionResults := make(chan actionResult, workers)
	start := make(chan struct{})
	var group sync.WaitGroup

	for worker := 0; worker < workers; worker++ {
		worker := worker
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			candidate := testAction(uid, 100, int64(1000+worker), digest, strings.Repeat("9", 64), int64(100+worker))
			action, created, err := repository.CreateOrFindAction(nil, candidate)
			result := actionResult{created: created, err: err}

			if action != nil {
				result.actionId = action.ActionId
			}

			actionResults <- result
		}()
	}

	close(start)
	group.Wait()
	close(actionResults)
	winnerActionId := int64(0)
	createdCount := 0

	for result := range actionResults {
		if result.err != nil || result.actionId < 1 {
			t.Fatalf("concurrent action persistence failed: %+v", result)
		}

		if winnerActionId == 0 {
			winnerActionId = result.actionId
		} else if result.actionId != winnerActionId {
			t.Fatalf("concurrent actions did not converge: first=%d result=%+v", winnerActionId, result)
		}

		if result.created {
			createdCount++
		}
	}

	if createdCount != 1 {
		t.Fatalf("concurrent action unique constraint produced %d creators", createdCount)
	}

	type bindingResult struct {
		bindingId int64
		created   bool
		err       error
	}
	bindingResults := make(chan bindingResult, workers)
	start = make(chan struct{})
	group = sync.WaitGroup{}

	for worker := 0; worker < workers; worker++ {
		worker := worker
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			candidate := testBinding(uid, int64(2000+worker), 99001, int64(200+worker))
			var persisted *loans.TransactionBinding
			created := false
			var err error

			for attempt := 0; attempt < 20; attempt++ {
				err = repository.DoTransaction(nil, uid, func(tx *loans.RepositoryTransaction) error {
					var createErr error
					persisted, created, createErr = tx.CreateOrFindTransactionBinding(candidate)
					return createErr
				})

				if err == nil {
					break
				}

				time.Sleep(time.Duration(attempt+1) * time.Millisecond)
			}

			result := bindingResult{created: created, err: err}

			if persisted != nil {
				result.bindingId = persisted.BindingId
			}

			bindingResults <- result
		}()
	}

	close(start)
	group.Wait()
	close(bindingResults)
	winnerBindingId := int64(0)
	createdCount = 0

	for result := range bindingResults {
		if result.err != nil || result.bindingId < 1 {
			t.Fatalf("concurrent binding persistence failed: %+v", result)
		}

		if winnerBindingId == 0 {
			winnerBindingId = result.bindingId
		} else if result.bindingId != winnerBindingId {
			t.Fatalf("concurrent bindings did not converge: first=%d result=%+v", winnerBindingId, result)
		}

		if result.created {
			createdCount++
		}
	}

	if createdCount != 1 {
		t.Fatalf("concurrent binding unique constraint produced %d creators", createdCount)
	}
}

func assertActionIdempotency(t *testing.T, repository *loans.Repository, firstUid int64, secondUid int64) {
	t.Helper()
	digest := strings.Repeat("a", 64)
	first := testAction(firstUid, 101, 701, digest, strings.Repeat("b", 64), 20)
	persisted, created, err := repository.CreateOrFindAction(nil, first)

	if err != nil || !created || persisted.ActionId != first.ActionId {
		t.Fatalf("create first loan action: action=%+v created=%t err=%v", persisted, created, err)
	}

	replay := testAction(firstUid, 101, 702, digest, strings.Repeat("c", 64), 21)
	persisted, created, err = repository.CreateOrFindAction(nil, replay)

	if err != nil || created || persisted.ActionId != first.ActionId || persisted.RequestDigest != first.RequestDigest {
		t.Fatalf("action unique adjudication failed: action=%+v created=%t err=%v", persisted, created, err)
	}

	otherUser := testAction(secondUid, 201, 703, digest, strings.Repeat("d", 64), 22)
	persisted, created, err = repository.CreateOrFindAction(nil, otherUser)

	if err != nil || !created || persisted.ActionId != otherUser.ActionId {
		t.Fatalf("action idempotency scope leaked across users: action=%+v created=%t err=%v", persisted, created, err)
	}

	if action, findErr := repository.FindActionByIdempotencyKeyDigest(nil, firstUid, digest); findErr != nil || action == nil || action.ActionId != first.ActionId {
		t.Fatalf("find first-user action by digest: action=%+v err=%v", action, findErr)
	}

	if err := repository.DoTransaction(nil, firstUid, func(tx *loans.RepositoryTransaction) error {
		next := *first
		started := int64(23)
		next.Status = loans.ACTION_STATUS_APPLYING
		next.StartedUnixTime = &started
		next.UpdatedUnixTime = started
		updated, updateErr := tx.UpdateActionStatus(first.ActionId, loans.ACTION_STATUS_READY, &next)

		if updateErr != nil || !updated {
			return errors.New("claim loan action failed")
		}

		updated, updateErr = tx.UpdateActionStatus(first.ActionId, loans.ACTION_STATUS_READY, &next)

		if updateErr != nil || updated {
			return errors.New("stale loan action claim succeeded")
		}

		return nil
	}); err != nil {
		t.Fatalf("exercise action conditional update: %v", err)
	}
}

func assertBindingAllocationAndAggregate(t *testing.T, repository *loans.Repository, firstUid int64, secondUid int64) {
	t.Helper()
	firstBinding := testBinding(firstUid, 801, 9001, 30)
	secondBinding := testBinding(firstUid, 802, 9002, 30)

	if err := repository.DoTransaction(nil, firstUid, func(tx *loans.RepositoryTransaction) error {
		persisted, created, createErr := tx.CreateOrFindTransactionBinding(firstBinding)

		if createErr != nil || !created || persisted.BindingId != firstBinding.BindingId {
			return errors.New("create first transaction binding failed")
		}

		duplicate := testBinding(firstUid, 899, firstBinding.TransactionId, 31)
		persisted, created, createErr = tx.CreateOrFindTransactionBinding(duplicate)

		if createErr != nil || created || persisted.BindingId != firstBinding.BindingId {
			return errors.New("binding unique adjudication failed")
		}

		if _, created, createErr = tx.CreateOrFindTransactionBinding(secondBinding); createErr != nil || !created {
			return errors.New("create second transaction binding failed")
		}

		firstAllocation := testAllocation(firstUid, 101, 501, 901, firstBinding.BindingId, 40, 32)
		secondAllocation := testAllocation(firstUid, 101, 501, 902, secondBinding.BindingId, 60, 32)

		if insertErr := tx.InsertAllocation(firstAllocation); insertErr != nil {
			return insertErr
		}

		if insertErr := tx.InsertAllocation(secondAllocation); insertErr != nil {
			return insertErr
		}

		if updated, updateErr := tx.UpdateTransactionBindingCAS(firstBinding.BindingId, 1, nil, &firstAllocation.AllocationId, 32); updateErr != nil || !updated {
			return errors.New("assign first binding failed")
		}

		if updated, updateErr := tx.UpdateTransactionBindingCAS(secondBinding.BindingId, 1, nil, &secondAllocation.AllocationId, 32); updateErr != nil || !updated {
			return errors.New("assign second binding failed")
		}

		aggregates, aggregateErr := tx.AggregateActiveAllocations(101)

		if aggregateErr != nil || len(aggregates) != 1 || aggregates[0].AllocatedAmount != 100 || aggregates[0].AllocationCount != 2 {
			return errors.New("transaction allocation aggregate failed")
		}

		count, countErr := tx.CountActiveAllocations(101)

		if countErr != nil || count != 2 {
			return errors.New("transaction allocation count failed")
		}

		return nil
	}); err != nil {
		t.Fatalf("insert binding and allocation fixtures: %v", err)
	}

	if err := repository.DoTransaction(nil, secondUid, func(tx *loans.RepositoryTransaction) error {
		_, created, createErr := tx.CreateOrFindTransactionBinding(testBinding(secondUid, 803, firstBinding.TransactionId, 33))

		if createErr != nil || !created {
			return errors.New("binding unique scope leaked across users")
		}

		return nil
	}); err != nil {
		t.Fatalf("create second-user transaction binding: %v", err)
	}

	if binding, findErr := repository.FindTransactionBindingByTransactionId(nil, firstUid, firstBinding.TransactionId); findErr != nil || binding == nil || binding.BindingId != firstBinding.BindingId || binding.CurrentAllocationId == nil || *binding.CurrentAllocationId != 901 {
		t.Fatalf("owned binding lookup failed: binding=%+v err=%v", binding, findErr)
	}

	if binding, findErr := repository.FindTransactionBindingByTransactionId(nil, secondUid, firstBinding.TransactionId); findErr != nil || binding == nil || binding.BindingId != 803 {
		t.Fatalf("second-user binding scope failed: binding=%+v err=%v", binding, findErr)
	}

	page, err := repository.ListAllocations(nil, firstUid, 101, loans.ALLOCATION_STATUS_ACTIVE, nil, 1)

	if err != nil || len(page.Items) != 1 || page.Items[0].AllocationId != 902 || page.NextCursor == nil {
		t.Fatalf("first allocation page is not stable: page=%+v err=%v", page, err)
	}

	page, err = repository.ListAllocations(nil, firstUid, 101, loans.ALLOCATION_STATUS_ACTIVE, page.NextCursor, 1)

	if err != nil || len(page.Items) != 1 || page.Items[0].AllocationId != 901 || page.NextCursor != nil {
		t.Fatalf("second allocation page is not stable: page=%+v err=%v", page, err)
	}

	aggregates, err := repository.AggregateActiveAllocations(nil, firstUid, 101)

	if err != nil || len(aggregates) != 1 || aggregates[0].InstallmentId == nil || *aggregates[0].InstallmentId != 501 ||
		aggregates[0].ComponentType != loans.COMPONENT_TYPE_INTEREST || aggregates[0].AllocatedAmount != 100 || aggregates[0].AllocationCount != 2 {
		t.Fatalf("active allocation aggregate mismatch: aggregates=%+v err=%v", aggregates, err)
	}

	count, err := repository.CountActiveAllocations(nil, firstUid, 101)

	if err != nil || count != 2 {
		t.Fatalf("active allocation count mismatch: count=%d err=%v", count, err)
	}

	if count, err = repository.CountActiveAllocations(nil, secondUid, 101); err != nil || count != 0 {
		t.Fatalf("cross-user allocation count leaked: count=%d err=%v", count, err)
	}

	firstAllocationId := int64(901)
	if err := repository.DoTransaction(nil, firstUid, func(tx *loans.RepositoryTransaction) error {
		updated, updateErr := tx.UpdateTransactionBindingCAS(firstBinding.BindingId, 1, nil, nil, 34)

		if updateErr != nil || updated {
			return errors.New("stale binding CAS succeeded")
		}

		updated, updateErr = tx.UpdateTransactionBindingCAS(firstBinding.BindingId, 2, &firstAllocationId, nil, 35)

		if updateErr != nil || !updated {
			return errors.New("clear binding allocation failed")
		}

		updated, updateErr = tx.UpdateAllocationStatus(901, loans.ALLOCATION_STATUS_ACTIVE, loans.ALLOCATION_STATUS_REVERSED, 704, 35)

		if updateErr != nil || !updated {
			return errors.New("reverse allocation failed")
		}

		updated, updateErr = tx.UpdateAllocationStatus(901, loans.ALLOCATION_STATUS_ACTIVE, loans.ALLOCATION_STATUS_REVERSED, 704, 35)

		if updateErr != nil || updated {
			return errors.New("stale allocation update succeeded")
		}

		return nil
	}); err != nil {
		t.Fatalf("exercise allocation conditional update: %v", err)
	}

	count, err = repository.CountActiveAllocations(nil, firstUid, 101)

	if err != nil || count != 1 {
		t.Fatalf("reversed allocation remained active: count=%d err=%v", count, err)
	}

	binding, err := repository.FindTransactionBindingByTransactionId(nil, firstUid, firstBinding.TransactionId)

	if err != nil || binding == nil || binding.CurrentAllocationId != nil || binding.Version != 3 {
		t.Fatalf("cleared binding state mismatch: binding=%+v err=%v", binding, err)
	}
}

func newSQLiteLoanRepository(t *testing.T) (*loans.Repository, *datastore.Database) {
	return newSQLiteLoanRepositoryWithConnections(t, 1)
}

func newSQLiteLoanRepositoryWithConnections(t *testing.T, maxOpenConnections uint16) (*loans.Repository, *datastore.Database) {
	t.Helper()
	database, err := datastore.OpenDatabase(&settings.DatabaseConfig{
		DatabaseType:          settings.Sqlite3DbType,
		DatabasePath:          filepath.Join(t.TempDir(), "loans.db"),
		MaxIdleConnection:     1,
		MaxOpenConnection:     maxOpenConnections,
		ConnectionMaxLifeTime: 60,
	})

	if err != nil {
		t.Fatalf("open SQLite loan database: %v", err)
	}

	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close SQLite loan database: %v", err)
		}
	})

	store, err := datastore.NewDataStore(database)

	if err != nil {
		t.Fatalf("create SQLite loan store: %v", err)
	}

	if err := migrations.Upgrade(nil, store, migrations.ApplicationInfo{Version: "test", Commit: "loan-db-301"}); err != nil {
		t.Fatalf("upgrade SQLite loan schema: %v", err)
	}

	repository, err := loans.NewRepository(store)

	if err != nil {
		t.Fatalf("create SQLite loan repository: %v", err)
	}

	return repository, database
}

func testContract(uid int64, contractId int64, revisionId int64, now int64) *loans.Contract {
	return &loans.Contract{
		Uid:                uid,
		Name:               "fixture",
		LenderName:         "fixture lender",
		ContractType:       loans.CONTRACT_TYPE_BANK_LOAN,
		LiabilityAccountId: contractId + 1000,
		Status:             loans.CONTRACT_STATUS_ACTIVE,
		CloseReasonCode:    loans.CLOSE_REASON_NONE,
		Currency:           "CNY",
		Note:               "",
		Version:            1,
		CurrentRevisionId:  revisionId,
		CreatedUnixTime:    now,
		UpdatedUnixTime:    now,
		ContractId:         contractId,
	}
}

func testRevision(uid int64, contractId int64, revisionId int64, actionId int64, now int64) *loans.ContractRevision {
	zero := int64(0)
	return &loans.ContractRevision{
		Uid:                           uid,
		ContractId:                    contractId,
		RevisionNumber:                1,
		ActionId:                      actionId,
		EffectiveDate:                 "2026-08-13",
		ContractDate:                  "2026-08-13",
		FirstDueDate:                  "2026-09-15",
		FundingType:                   loans.FUNDING_TYPE_CASH_DISBURSEMENT,
		InputMode:                     loans.INPUT_MODE_RATE,
		RepaymentMethod:               loans.REPAYMENT_METHOD_EQUAL_PAYMENT,
		RateQuoteType:                 loans.RATE_QUOTE_TYPE_ANNUAL,
		FrequencyType:                 loans.FREQUENCY_TYPE_MONTHLY,
		FrequencyInterval:             1,
		PrincipalAmount:               1000,
		ActualDisbursementAmount:      1000,
		TermCount:                     2,
		DiscountType:                  loans.DISCOUNT_TYPE_NONE,
		CalculationVersion:            loans.CALCULATION_VERSION_V1,
		RoundingVersion:               loans.ROUNDING_VERSION_V1,
		IrrVersion:                    loans.IRR_VERSION_V1,
		ScheduleDigest:                strings.Repeat("e", 64),
		PreDiscountTotalPaymentAmount: 1000,
		PreDiscountTotalCostAmount:    0,
		TotalPaymentAmount:            1000,
		TotalCostAmount:               0,
		CostRatioPptr:                 0,
		IrrStatus:                     loans.IRR_STATUS_SOLVED_ZERO,
		MonthlyIrrPptr:                &zero,
		SimpleAprPptr:                 &zero,
		EffectiveAprPptr:              &zero,
		CreatedUnixTime:               now,
		RevisionId:                    revisionId,
	}
}

func testInstallment(uid int64, contractId int64, revisionId int64, installmentId int64, number int64, dueDate string, now int64) *loans.Installment {
	return &loans.Installment{
		Uid:                      uid,
		ContractId:               contractId,
		RevisionId:               revisionId,
		InstallmentNumber:        number,
		DueDate:                  dueDate,
		BeginningPrincipalAmount: 1000 - (number-1)*500,
		PrincipalAmount:          500,
		PaymentAmount:            500,
		EndingPrincipalAmount:    1000 - number*500,
		PreDiscountPaymentAmount: 500,
		CreatedUnixTime:          now,
		InstallmentId:            installmentId,
	}
}

func testAction(uid int64, contractId int64, actionId int64, idempotencyDigest string, requestDigest string, now int64) *loans.Action {
	return &loans.Action{
		Uid:                     uid,
		ContractId:              contractId,
		ExpectedContractVersion: 1,
		ActionType:              loans.ACTION_TYPE_REVISE_CONTRACT,
		IdempotencyKeyDigest:    idempotencyDigest,
		IdempotencyKeyVersion:   loans.IDEMPOTENCY_KEY_VERSION_V1,
		RequestDigest:           requestDigest,
		RequestDigestVersion:    loans.ACTION_REQUEST_DIGEST_VERSION_V1,
		Status:                  loans.ACTION_STATUS_READY,
		ReasonCodesJson:         "[]",
		CreatedUnixTime:         now,
		UpdatedUnixTime:         now,
		ActionId:                actionId,
	}
}

func testBinding(uid int64, bindingId int64, transactionId int64, now int64) *loans.TransactionBinding {
	return &loans.TransactionBinding{
		Uid:             uid,
		TransactionId:   transactionId,
		Version:         1,
		CreatedUnixTime: now,
		UpdatedUnixTime: now,
		BindingId:       bindingId,
	}
}

func testAllocation(uid int64, contractId int64, installmentId int64, allocationId int64, bindingId int64, amount int64, now int64) *loans.TransactionAllocation {
	return &loans.TransactionAllocation{
		Uid:                        uid,
		ContractId:                 contractId,
		InstallmentId:              &installmentId,
		PrimaryBindingId:           bindingId,
		ComponentType:              loans.COMPONENT_TYPE_INTEREST,
		AllocatedAmount:            amount,
		CreationMethod:             loans.ALLOCATION_CREATION_METHOD_ATTACHED_EXISTING,
		Status:                     loans.ALLOCATION_STATUS_ACTIVE,
		TransactionUpdatedUnixTime: now,
		CreatedActionId:            701,
		LastActionId:               701,
		CreatedUnixTime:            now,
		UpdatedUnixTime:            now,
		AllocationId:               allocationId,
	}
}
