package loans

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/migrations"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

func TestServiceCalculateFourMethodsAndReferenceGolden(t *testing.T) {
	service := &Service{}
	methods := []RepaymentMethod{
		REPAYMENT_METHOD_FLAT,
		REPAYMENT_METHOD_EQUAL_PAYMENT,
		REPAYMENT_METHOD_EQUAL_PRINCIPAL,
		REPAYMENT_METHOD_INTEREST_ONLY,
	}
	for _, method := range methods {
		terms := serviceTestTerms()
		terms.RepaymentMethod = method
		result, err := service.Calculate(CalculateRequest{Terms: terms})
		if err != nil || result == nil || len(result.Installments) != 2 || result.CalculationVersion != string(CALCULATION_VERSION_V1) {
			t.Fatal("four-method service calculation mapping failed")
		}
	}

	payment := int64(446_059)
	terms := serviceTestTerms()
	terms.FirstDueDate = "2026-01-31"
	terms.PrincipalAmount = 5_000_000
	terms.ActualDisbursementAmount = 5_000_000
	terms.TermCount = 12
	terms.InputMode = INPUT_MODE_REPAYMENT
	terms.RepaymentMethod = REPAYMENT_METHOD_EQUAL_PAYMENT
	terms.RateQuoteType = ""
	terms.QuotedRatePptr = nil
	terms.PaymentBasisAmount = &payment
	result, err := service.Calculate(CalculateRequest{Terms: terms})
	if err != nil || result.TotalPaymentAmount != 5_352_709 || len(result.Installments) != 12 || result.Installments[11].PaymentAmount != 446_060 ||
		result.IRR.SimpleAPRPPTR == nil || *result.IRR.SimpleAPRPPTR != 127_751_445_708 ||
		result.IRR.EffectiveAPRPPTR == nil || *result.IRR.EffectiveAPRPPTR != 135_503_557_792 {
		t.Fatal("service reference calculation golden mismatch")
	}

	terms.EffectiveDate = "2027-01-01"
	if _, err = service.Calculate(CalculateRequest{Terms: terms}); err != nil {
		t.Fatal("service imposed an unfrozen relative-date restriction")
	}
}

func TestServiceZeroAllocationStatusRemainsUnpaid(t *testing.T) {
	service := &Service{}
	terms := serviceTestTerms()
	terms.RepaymentMethod = REPAYMENT_METHOD_INTEREST_ONLY
	calculated, err := service.Calculate(CalculateRequest{Terms: terms})
	if err != nil {
		t.Fatal("zero-cost interest-only calculation failed")
	}
	installments := make([]*Installment, len(calculated.Installments))
	for index, row := range calculated.Installments {
		installments[index] = &Installment{InstallmentId: int64(index + 1), InstallmentNumber: row.InstallmentNumber,
			DueDate: row.DueDate, PrincipalAmount: row.PrincipalAmount, InterestAmount: row.InterestAmount, FeeAmount: row.FeeAmount}
	}
	progressRows, _, _, err := derivePlanProgress(installments, nil, "2026-09-16")
	if err != nil || progressRows[0].Status != INSTALLMENT_PROGRESS_UNPAID || progressRows[0].Overdue {
		t.Fatal("zero-allocation installment was not derived as unpaid")
	}
}

func TestServiceCreateReplayConflictAndAccountIndependentReplay(t *testing.T) {
	service, repository, accounts, _ := newSQLiteLoanService(t, 1, 100_000)
	request := CreateContractRequest{Uid: 1001, Spec: serviceTestSpec(), IdempotencyKey: "create-key-0001"}
	first, err := service.CreateContract(nil, request)
	if err != nil || first == nil || first.Action == nil || first.Replayed || first.Revision == nil || len(first.Installments) != 2 {
		t.Fatal("create contract did not persist the complete vertical slice")
	}
	persisted, err := repository.FindActionByIdempotencyKeyDigest(nil, request.Uid, idempotencyKeyDigest(request.IdempotencyKey))
	rawDigest := sha256.Sum256([]byte(request.IdempotencyKey))
	if err != nil || persisted == nil || persisted.ReasonCodesJson != "[]" || persisted.IdempotencyKeyDigest == request.IdempotencyKey ||
		persisted.IdempotencyKeyDigest == hex.EncodeToString(rawDigest[:]) {
		t.Fatal("create action did not preserve safe digest evidence")
	}

	accounts.mutate(request.Uid, request.Spec.LiabilityAccountId, func(snapshot *AccountSnapshot) { snapshot.Hidden = true })
	replay, err := service.CreateContract(nil, request)
	if err != nil || replay == nil || !replay.Replayed || replay.Action.ContractId != first.Action.ContractId || replay.Action.ActionId != first.Action.ActionId {
		t.Fatal("applied create was not replayed after account state changed")
	}
	if _, err = service.ReviseContract(nil, ReviseContractRequest{Uid: request.Uid, ContractId: first.Action.ContractId,
		ExpectedContractVersion: 1, Spec: request.Spec, IdempotencyKey: "revise-hidden-account"}); !errors.Is(err, ErrServiceAccountRejected) || ServiceErrorCodeOf(err) != SERVICE_ERROR_ACCOUNT_HIDDEN {
		t.Fatal("new revision did not revalidate the current account snapshot")
	}
	detail, err := service.GetContract(nil, request.Uid, first.Action.ContractId, "2026-10-01")
	if err != nil || detail.LedgerOutstandingAmount != nil || detail.LedgerPlanDifferenceAmount != nil {
		t.Fatal("missing ledger snapshot dependency did not produce nullable results")
	}

	conflict := request
	conflict.Spec.Note = "different"
	if _, err = service.CreateContract(nil, conflict); !errors.Is(err, ErrServiceIdempotencyConflict) || ServiceErrorCodeOf(err) != SERVICE_ERROR_IDEMPOTENCY_CONFLICT {
		t.Fatal("same idempotency key with a different request was not rejected")
	}
}

func TestServiceConcurrentCreateConvergesToWinner(t *testing.T) {
	service, _, _, _ := newSQLiteLoanService(t, 8, 200_000)
	request := CreateContractRequest{Uid: 1001, Spec: serviceTestSpec(), IdempotencyKey: "create-key-concurrent"}
	start := make(chan struct{})
	results := make(chan *CommandResult, 2)
	errorsByWorker := make(chan error, 2)
	var group sync.WaitGroup
	for worker := 0; worker < 2; worker++ {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			result, err := service.CreateContract(nil, request)
			results <- result
			errorsByWorker <- err
		}()
	}
	close(start)
	group.Wait()
	close(results)
	close(errorsByWorker)
	for err := range errorsByWorker {
		if err != nil {
			t.Fatalf("concurrent create returned stable code %s", ServiceErrorCodeOf(err))
		}
	}
	var winnerContractId int64
	var winnerActionId int64
	for result := range results {
		if result == nil || result.Action == nil {
			t.Fatal("concurrent create returned no stable result")
		}
		if winnerContractId == 0 {
			winnerContractId = result.Action.ContractId
			winnerActionId = result.Action.ActionId
		} else if result.Action.ContractId != winnerContractId || result.Action.ActionId != winnerActionId {
			t.Fatal("concurrent create did not converge to one winner")
		}
	}
}

func TestServiceReviseAppendsAndConcurrentCASAdjudicates(t *testing.T) {
	service, repository, _, _ := newSQLiteLoanService(t, 8, 300_000)
	created := mustCreateServiceContract(t, service, 1001, "create-key-revise")
	oldRevisionId := created.Revision.RevisionId
	initialRevision, initialErr := repository.FindRevisionById(nil, 1001, oldRevisionId)
	if initialErr != nil || initialRevision == nil {
		t.Fatal("initial revision lookup failed")
	}
	oldDigest := initialRevision.ScheduleDigest
	oldInstallmentIds := []int64{created.Installments[0].InstallmentId, created.Installments[1].InstallmentId}

	revisedSpec := serviceTestSpec()
	revisedSpec.Terms.TermCount = 3
	result, err := service.ReviseContract(nil, ReviseContractRequest{Uid: 1001, ContractId: created.Action.ContractId,
		ExpectedContractVersion: 1, Spec: revisedSpec, IdempotencyKey: "revise-key-0001"})
	if err != nil || result.Revision == nil || result.Revision.PreviousRevisionId == nil || *result.Revision.PreviousRevisionId != oldRevisionId ||
		result.Revision.RevisionNumber != 2 || len(result.Installments) != 3 {
		t.Fatal("revise did not append a linked revision")
	}
	oldRevision, err := repository.FindRevisionById(nil, 1001, oldRevisionId)
	oldRows, rowsErr := service.loadAllInstallments(nil, 1001, created.Action.ContractId, oldRevisionId)
	if err != nil || rowsErr != nil || oldRevision == nil || oldRevision.ScheduleDigest != oldDigest || len(oldRows) != 2 ||
		oldRows[0].InstallmentId != oldInstallmentIds[0] || oldRows[1].InstallmentId != oldInstallmentIds[1] {
		t.Fatal("revise mutated the old immutable plan")
	}

	concurrentCreated := mustCreateServiceContract(t, service, 1001, "create-key-cas")
	start := make(chan struct{})
	errCh := make(chan error, 2)
	var group sync.WaitGroup
	for worker := 0; worker < 2; worker++ {
		worker := worker
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			spec := serviceTestSpec()
			spec.Note = string(rune('a' + worker))
			_, reviseErr := service.ReviseContract(nil, ReviseContractRequest{Uid: 1001, ContractId: concurrentCreated.Action.ContractId,
				ExpectedContractVersion: 1, Spec: spec, IdempotencyKey: "revise-key-cas-" + string(rune('a'+worker))})
			errCh <- reviseErr
		}()
	}
	close(start)
	group.Wait()
	close(errCh)
	successes := 0
	conflicts := 0
	for reviseErr := range errCh {
		if reviseErr == nil {
			successes++
		} else if errors.Is(reviseErr, ErrServiceVersionConflict) {
			conflicts++
		} else {
			t.Fatalf("concurrent revise returned stable code %s", ServiceErrorCodeOf(reviseErr))
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatal("contract CAS did not adjudicate concurrent revisions")
	}
}

func TestServiceLifecycleAllocationGuardsAndProgress(t *testing.T) {
	ledger := &testLiabilityReader{amounts: map[int64]int64{11: 90_000}}
	service, repository, _, _ := newSQLiteLoanServiceWithLedger(t, 1, 400_000, ledger)

	plain := mustCreateServiceContract(t, service, 1001, "create-key-lifecycle")
	if _, err := service.CloseContract(nil, CloseContractRequest{Uid: 1001, ContractId: plain.Action.ContractId,
		ExpectedContractVersion: 1, Reason: CLOSE_REASON_PAID_OFF, IdempotencyKey: "close-paid-reject"}); !errors.Is(err, ErrServicePlanNotPaidOff) {
		t.Fatal("paid-off close accepted an outstanding plan")
	}
	closed, err := service.CloseContract(nil, CloseContractRequest{Uid: 1001, ContractId: plain.Action.ContractId,
		ExpectedContractVersion: 1, Reason: CLOSE_REASON_MANUAL_CLOSE, IdempotencyKey: "close-manual-key"})
	if err != nil || closed.Remaining == nil || closed.Remaining.PaymentAmount == 0 ||
		closed.LedgerOutstandingAmount == nil || closed.LedgerPlanDifferenceAmount == nil {
		t.Fatal("manual close did not preserve explicit remaining plan")
	}
	if _, err = service.ReopenContract(nil, ContractCommandRequest{Uid: 1001, ContractId: plain.Action.ContractId,
		ExpectedContractVersion: 2, IdempotencyKey: "reopen-key-0001"}); err != nil {
		t.Fatal("closed contract did not reopen")
	}
	if _, err = service.CancelContract(nil, ContractCommandRequest{Uid: 1001, ContractId: plain.Action.ContractId,
		ExpectedContractVersion: 3, IdempotencyKey: "cancel-key-0001"}); err != nil {
		t.Fatal("allocation-free active contract did not cancel")
	}
	if _, err = service.ReopenContract(nil, ContractCommandRequest{Uid: 1001, ContractId: plain.Action.ContractId,
		ExpectedContractVersion: 4, IdempotencyKey: "reopen-cancelled"}); !errors.Is(err, ErrServiceStateConflict) {
		t.Fatal("cancelled contract accepted an illegal transition")
	}

	allocated := mustCreateServiceContract(t, service, 1001, "create-key-allocation")
	first := allocated.Installments[0]
	allocationId, bindingId := insertServiceAllocation(t, repository, 1001, allocated.Action.ContractId, first.InstallmentId,
		COMPONENT_TYPE_PRINCIPAL, first.PrincipalAmount/2, ALLOCATION_STATUS_ACTIVE, 900_001, 910_001)
	reviseBlocked := ReviseContractRequest{Uid: 1001, ContractId: allocated.Action.ContractId,
		ExpectedContractVersion: 1, Spec: serviceTestSpec(), IdempotencyKey: "revise-active-allocation"}
	if _, err = service.ReviseContract(nil, reviseBlocked); !errors.Is(err, ErrServiceActiveAllocation) {
		t.Fatal("active allocation did not block revision")
	}
	if _, err = service.CancelContract(nil, ContractCommandRequest{Uid: 1001, ContractId: allocated.Action.ContractId,
		ExpectedContractVersion: 1, IdempotencyKey: "cancel-active-allocation"}); !errors.Is(err, ErrServiceAllocationHistory) ||
		ServiceErrorCodeOf(err) != SERVICE_ERROR_ALLOCATION_HISTORY {
		t.Fatal("allocation history did not block cancellation with its stable code")
	}

	detail, err := service.GetContract(nil, 1001, allocated.Action.ContractId, "2026-10-01")
	if err != nil || len(detail.InstallmentProgress) != 2 || detail.InstallmentProgress[0].Status != INSTALLMENT_PROGRESS_PARTIAL ||
		!detail.InstallmentProgress[0].Overdue || detail.InstallmentProgress[1].Status != INSTALLMENT_PROGRESS_UNPAID ||
		detail.Progress.OverdueInstallmentCount != 1 || detail.LedgerOutstandingAmount == nil || detail.LedgerPlanDifferenceAmount == nil {
		t.Fatal("progress, overdue, or ledger difference derivation failed")
	}
	list, err := service.ListContracts(nil, 1001, CONTRACT_STATUS_ACTIVE, nil, 10, "2026-10-01")
	if err != nil || len(list.Items) < 1 || list.Items[0].CurrentRevision == nil || list.Items[0].NextInstallment == nil ||
		list.Items[0].NextInstallment.Installment == nil || list.Items[0].NextInstallment.Progress == nil ||
		list.Items[0].Progress.NextDueDate == nil || list.Items[0].NextInstallment.Installment.DueDate != *list.Items[0].Progress.NextDueDate ||
		list.Items[0].NextInstallment.Progress.OutstandingPayment < 1 {
		t.Fatal("contract list omitted the current calculation summary")
	}

	reverseServiceAllocation(t, repository, 1001, allocationId, bindingId, 900_001)
	if _, err = service.ReviseContract(nil, reviseBlocked); !errors.Is(err, ErrServiceActiveAllocation) {
		t.Fatal("action-required revision did not replay its original stable result")
	}
	if _, err = service.CancelContract(nil, ContractCommandRequest{Uid: 1001, ContractId: allocated.Action.ContractId,
		ExpectedContractVersion: 1, IdempotencyKey: "cancel-reversed-allocation"}); !errors.Is(err, ErrServiceAllocationHistory) {
		t.Fatal("reversed allocation history did not block cancellation")
	}

	written := mustCreateServiceContract(t, service, 1001, "create-key-written")
	writtenResult, err := service.CloseContract(nil, CloseContractRequest{Uid: 1001, ContractId: written.Action.ContractId,
		ExpectedContractVersion: 1, Reason: CLOSE_REASON_WRITTEN_OFF, IdempotencyKey: "close-written-key"})
	if err != nil || writtenResult.Remaining == nil || writtenResult.Remaining.PaymentAmount == 0 ||
		writtenResult.LedgerOutstandingAmount == nil || writtenResult.LedgerPlanDifferenceAmount == nil {
		t.Fatal("written-off close did not preserve explicit remaining plan")
	}
}

func TestServicePaidOffCloseAndCrossUIDIsolation(t *testing.T) {
	service, repository, accounts, _ := newSQLiteLoanService(t, 1, 500_000)
	accounts.addDefaults(2002)
	created := mustCreateServiceContract(t, service, 1001, "create-key-paid")
	for index, installment := range created.Installments {
		insertServiceAllocation(t, repository, 1001, created.Action.ContractId, installment.InstallmentId,
			COMPONENT_TYPE_PRINCIPAL, installment.PrincipalAmount, ALLOCATION_STATUS_ACTIVE, int64(920_000+index), int64(930_000+index))
	}
	if _, err := service.CloseContract(nil, CloseContractRequest{Uid: 1001, ContractId: created.Action.ContractId,
		ExpectedContractVersion: 1, Reason: CLOSE_REASON_PAID_OFF, IdempotencyKey: "close-paid-success"}); err != nil {
		t.Fatal("fully allocated zero-cost plan did not close as paid off")
	}
	if _, err := service.GetContract(nil, 2002, created.Action.ContractId, "2026-10-01"); !errors.Is(err, ErrServiceContractNotFound) {
		t.Fatal("cross-user contract lookup was not isolated")
	}
}

func TestServiceAccountValidationAndRollback(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(spec *ContractSpec, accounts *testAccountReader)
		code   ServiceErrorCode
	}{
		{name: "liability kind", mutate: func(spec *ContractSpec, accounts *testAccountReader) {
			accounts.mutate(1001, spec.LiabilityAccountId, func(snapshot *AccountSnapshot) { snapshot.Kind = ACCOUNT_KIND_ASSET })
		}, code: SERVICE_ERROR_LIABILITY_REQUIRED},
		{name: "currency", mutate: func(spec *ContractSpec, accounts *testAccountReader) {
			accounts.mutate(1001, spec.LiabilityAccountId, func(snapshot *AccountSnapshot) { snapshot.Currency = "USD" })
		}, code: SERVICE_ERROR_ACCOUNT_CURRENCY},
		{name: "hidden", mutate: func(spec *ContractSpec, accounts *testAccountReader) {
			accounts.mutate(1001, spec.LiabilityAccountId, func(snapshot *AccountSnapshot) { snapshot.Hidden = true })
		}, code: SERVICE_ERROR_ACCOUNT_HIDDEN},
		{name: "multi", mutate: func(spec *ContractSpec, accounts *testAccountReader) {
			accounts.mutate(1001, spec.LiabilityAccountId, func(snapshot *AccountSnapshot) { snapshot.Single = false })
		}, code: SERVICE_ERROR_ACCOUNT_NOT_SINGLE},
		{name: "payment kind", mutate: func(spec *ContractSpec, accounts *testAccountReader) {
			accounts.mutate(1001, *spec.DefaultPaymentAccountId, func(snapshot *AccountSnapshot) { snapshot.Kind = ACCOUNT_KIND_DEBT })
		}, code: SERVICE_ERROR_ASSET_REQUIRED},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service, _, accounts, _ := newSQLiteLoanService(t, 1, 600_000)
			spec := serviceTestSpec()
			test.mutate(&spec, accounts)
			_, err := service.CreateContract(nil, CreateContractRequest{Uid: 1001, Spec: spec, IdempotencyKey: "invalid-account-key"})
			if !errors.Is(err, ErrServiceAccountRejected) || ServiceErrorCodeOf(err) != test.code {
				t.Fatal("account validation returned an unexpected stable error")
			}
		})
	}

	repository, _ := newSQLiteServiceRepository(t, 1)
	accounts := newTestAccountReader()
	accounts.addDefaults(1001)
	sequence := &fixedServiceIds{values: []int64{700_001, 700_002, 700_003, 700_004, 700_004}}
	service, err := NewService(repository, accounts, nil, sequence.next)
	if err != nil {
		t.Fatal("create rollback service failed")
	}
	service.now = func() time.Time { return time.Unix(1_700_000_000, 0) }
	request := CreateContractRequest{Uid: 1001, Spec: serviceTestSpec(), IdempotencyKey: "rollback-key-0001"}
	if _, err = service.CreateContract(nil, request); !errors.Is(err, ErrServicePersistenceFailed) {
		t.Fatal("mid-transaction installment failure was not surfaced safely")
	}
	contract, findErr := repository.FindContractById(nil, 1001, 700_001)
	action, actionErr := repository.FindActionByIdempotencyKeyDigest(nil, 1001, idempotencyKeyDigest(request.IdempotencyKey))
	if findErr != nil || actionErr != nil || contract != nil || action != nil {
		t.Fatal("failed create left partial contract or action state")
	}
}

func TestServiceWithoutSettlementGatewayRejectsActiveAllocationReads(t *testing.T) {
	repository, _ := newSQLiteServiceRepository(t, 1)
	accounts := newTestAccountReader()
	accounts.addDefaults(1001)
	ids := new(atomic.Int64)
	ids.Store(580_000)
	service, err := NewService(repository, accounts, nil, func() int64 { return ids.Add(1) })
	if err != nil {
		t.Fatalf("create calculation-only loan service: %v", err)
	}
	service.now = func() time.Time { return time.Unix(1_700_000_000, 0) }
	created := mustCreateServiceContract(t, service, 1001, "create-without-settlement-gateway")
	installment := created.Installments[0]
	insertServiceAllocation(t, repository, 1001, created.Action.ContractId, installment.InstallmentId,
		COMPONENT_TYPE_PRINCIPAL, installment.PrincipalAmount/2, ALLOCATION_STATUS_ACTIVE, 980_001, 990_001)
	if _, err = service.GetContract(nil, 1001, created.Action.ContractId, installment.DueDate); !errors.Is(err, ErrServiceLedgerValidationRequired) || ServiceErrorCodeOf(err) != SERVICE_ERROR_LEDGER_VALIDATION_REQUIRED {
		t.Fatalf("active allocation was silently counted without ledger validation: %v", err)
	}
}

func TestServiceUnicodeLimitsAndRedactedErrors(t *testing.T) {
	spec := serviceTestSpec()
	spec.Name = strings.Repeat("贷", maximumContractNameCharacters)
	if _, _, err := normalizeContractSpec(spec); err != nil {
		t.Fatal("valid Unicode contract name was rejected before the character limit")
	}
	spec.Name += "款"
	if _, _, err := normalizeContractSpec(spec); !errors.Is(err, ErrServiceInvalidRequest) {
		t.Fatal("contract name beyond the Unicode character limit was accepted")
	}

	service, _, accounts, _ := newSQLiteLoanService(t, 1, 650_000)
	spec = serviceTestSpec()
	spec.Name = "private-name"
	spec.LenderName = "private-lender"
	spec.Note = "private-note"
	accounts.mutate(1001, spec.LiabilityAccountId, func(snapshot *AccountSnapshot) { snapshot.Hidden = true })
	_, err := service.CreateContract(nil, CreateContractRequest{Uid: 1001, Spec: spec, IdempotencyKey: "private-idempotency-key"})
	if err == nil {
		t.Fatal("invalid account fixture unexpectedly succeeded")
	}
	for _, forbidden := range []string{spec.Name, spec.LenderName, spec.Note, "private-idempotency-key", "100000"} {
		if strings.Contains(err.Error(), forbidden) {
			t.Fatal("service error exposed private request material")
		}
	}
}

func mustCreateServiceContract(t *testing.T, service *Service, uid int64, key string) *CommandResult {
	t.Helper()
	result, err := service.CreateContract(nil, CreateContractRequest{Uid: uid, Spec: serviceTestSpec(), IdempotencyKey: key})
	if err != nil || result == nil {
		t.Fatal("create service fixture failed")
	}
	return result
}

func serviceTestTerms() CalculationTerms {
	zero := int64(0)
	return CalculationTerms{EffectiveDate: "2026-08-13", ContractDate: "2026-08-13", FirstDueDate: "2026-09-15",
		FundingType: FUNDING_TYPE_CASH_DISBURSEMENT, InputMode: INPUT_MODE_RATE, RepaymentMethod: REPAYMENT_METHOD_EQUAL_PAYMENT,
		RateQuoteType: RATE_QUOTE_TYPE_ANNUAL, PrincipalAmount: 100_000, ActualDisbursementAmount: 100_000,
		TermCount: 2, QuotedRatePptr: &zero, DiscountType: DISCOUNT_TYPE_NONE}
}

func serviceTestSpec() ContractSpec {
	paymentId := int64(12)
	return ContractSpec{Name: "fixture", LenderName: "lender", ContractType: CONTRACT_TYPE_BANK_LOAN,
		LiabilityAccountId: 11, DefaultPaymentAccountId: &paymentId, Currency: "CNY", Terms: serviceTestTerms()}
}

type testAccountReader struct {
	mu       sync.RWMutex
	accounts map[int64]map[int64]AccountSnapshot
}

func newTestAccountReader() *testAccountReader {
	return &testAccountReader{accounts: make(map[int64]map[int64]AccountSnapshot)}
}

func (reader *testAccountReader) addDefaults(uid int64) {
	reader.mu.Lock()
	defer reader.mu.Unlock()
	reader.accounts[uid] = map[int64]AccountSnapshot{
		11: {AccountId: 11, Uid: uid, Kind: ACCOUNT_KIND_DEBT, Single: true, Currency: "CNY"},
		12: {AccountId: 12, Uid: uid, Kind: ACCOUNT_KIND_ASSET, Single: true, Currency: "CNY"},
	}
}

func (reader *testAccountReader) LoadAccountSnapshots(_ core.Context, uid int64, accountIds []int64) ([]AccountSnapshot, error) {
	reader.mu.RLock()
	defer reader.mu.RUnlock()
	result := make([]AccountSnapshot, 0, len(accountIds))
	for _, accountId := range accountIds {
		if snapshot, exists := reader.accounts[uid][accountId]; exists {
			result = append(result, snapshot)
		}
	}
	return result, nil
}

func (reader *testAccountReader) mutate(uid int64, accountId int64, mutate func(snapshot *AccountSnapshot)) {
	reader.mu.Lock()
	defer reader.mu.Unlock()
	snapshot := reader.accounts[uid][accountId]
	mutate(&snapshot)
	reader.accounts[uid][accountId] = snapshot
}

type testLiabilityReader struct {
	amounts map[int64]int64
}

func (reader *testLiabilityReader) ReadLiabilityOutstanding(_ core.Context, _ int64, liabilityAccountId int64) (*int64, error) {
	amount, exists := reader.amounts[liabilityAccountId]
	if !exists {
		return nil, nil
	}
	return &amount, nil
}

type fixedServiceIds struct {
	mu     sync.Mutex
	values []int64
	index  int
}

func (ids *fixedServiceIds) next() int64 {
	ids.mu.Lock()
	defer ids.mu.Unlock()
	if ids.index >= len(ids.values) {
		return 0
	}
	value := ids.values[ids.index]
	ids.index++
	return value
}

func newSQLiteLoanService(t *testing.T, maxConnections uint16, firstId int64) (*Service, *Repository, *testAccountReader, *atomic.Int64) {
	return newSQLiteLoanServiceWithLedger(t, maxConnections, firstId, nil)
}

func newSQLiteLoanServiceWithLedger(t *testing.T, maxConnections uint16, firstId int64, ledger LiabilityOutstandingReader) (*Service, *Repository, *testAccountReader, *atomic.Int64) {
	t.Helper()
	repository, _ := newSQLiteServiceRepository(t, maxConnections)
	accounts := newTestAccountReader()
	accounts.addDefaults(1001)
	ids := new(atomic.Int64)
	ids.Store(firstId)
	settlementLedger := &testServiceSettlementLedger{repository: repository, accounts: accounts, liability: ledger}
	service, err := NewServiceWithSettlementLedger(repository, settlementLedger, func() int64 { return ids.Add(1) })
	if err != nil {
		t.Fatal("create loan service failed")
	}
	service.now = func() time.Time { return time.Unix(1_700_000_000, 0) }
	return service, repository, accounts, ids
}

func newSQLiteServiceRepository(t *testing.T, maxConnections uint16) (*Repository, *datastore.Database) {
	t.Helper()
	database, err := datastore.OpenDatabase(&settings.DatabaseConfig{DatabaseType: settings.Sqlite3DbType,
		DatabasePath: filepath.Join(t.TempDir(), "service.db"), MaxIdleConnection: 1, MaxOpenConnection: maxConnections, ConnectionMaxLifeTime: 60})
	if err != nil {
		t.Fatal("open SQLite service database failed")
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error("close SQLite service database failed")
		}
	})
	store, err := datastore.NewDataStore(database)
	if err != nil {
		t.Fatal("create SQLite service store failed")
	}
	if err = migrations.Upgrade(nil, store, migrations.ApplicationInfo{Version: "test", Commit: "loan-svc-301"}); err != nil {
		t.Fatal("upgrade SQLite service schema failed")
	}
	repository, err := NewRepository(store)
	if err != nil {
		t.Fatal("create SQLite service repository failed")
	}
	return repository, database
}

func insertServiceAllocation(t *testing.T, repository *Repository, uid int64, contractId int64, installmentId int64,
	component ComponentType, amount int64, status AllocationStatus, allocationId int64, bindingId int64) (int64, int64) {
	t.Helper()
	transactionId := bindingId + 100_000
	counterpartBindingId := bindingId + 1_000_000
	counterpartTransactionId := transactionId + 2_000_000
	err := repository.DoTransaction(nil, uid, func(tx *RepositoryTransaction) error {
		binding := &TransactionBinding{Uid: uid, TransactionId: transactionId, Version: 1, CreatedUnixTime: 1_700_000_001,
			UpdatedUnixTime: 1_700_000_001, BindingId: bindingId}
		if _, created, err := tx.CreateOrFindTransactionBinding(binding); err != nil || !created {
			return errors.New("binding insert failed")
		}
		counterpart := &TransactionBinding{Uid: uid, TransactionId: counterpartTransactionId, Version: 1,
			CreatedUnixTime: 1_700_000_001, UpdatedUnixTime: 1_700_000_001, BindingId: counterpartBindingId}
		if _, created, err := tx.CreateOrFindTransactionBinding(counterpart); err != nil || !created {
			return errors.New("counterpart binding insert failed")
		}
		allocation := &TransactionAllocation{Uid: uid, ContractId: contractId, InstallmentId: &installmentId,
			PrimaryBindingId: bindingId, CounterpartBindingId: &counterpartBindingId, ComponentType: component, AllocatedAmount: amount,
			CreationMethod: ALLOCATION_CREATION_METHOD_ATTACHED_EXISTING, Status: ALLOCATION_STATUS_ACTIVE,
			TransactionUpdatedUnixTime: 1_700_000_001, CounterpartUpdatedUnixTime: func() *int64 { value := int64(1_700_000_001); return &value }(), CreatedActionId: 1, LastActionId: 1,
			CreatedUnixTime: 1_700_000_001, UpdatedUnixTime: 1_700_000_001, AllocationId: allocationId}
		if err := tx.InsertAllocation(allocation); err != nil {
			return err
		}
		if updated, err := tx.UpdateTransactionBindingCAS(bindingId, 1, nil, &allocationId, 1_700_000_001); err != nil || !updated {
			return errors.New("binding assignment failed")
		}
		if updated, err := tx.UpdateTransactionBindingCAS(counterpartBindingId, 1, nil, &allocationId, 1_700_000_001); err != nil || !updated {
			return errors.New("counterpart binding assignment failed")
		}
		if status != ALLOCATION_STATUS_ACTIVE {
			if updated, err := tx.UpdateAllocationStatus(allocationId, ALLOCATION_STATUS_ACTIVE, status, 1, 1_700_000_002); err != nil || !updated {
				return errors.New("allocation status update failed")
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal("insert allocation fixture failed")
	}
	return allocationId, bindingId
}

func reverseServiceAllocation(t *testing.T, repository *Repository, uid int64, allocationId int64, bindingId int64, lastActionId int64) {
	t.Helper()
	err := repository.DoTransaction(nil, uid, func(tx *RepositoryTransaction) error {
		if updated, err := tx.UpdateTransactionBindingCAS(bindingId, 2, &allocationId, nil, 1_700_000_003); err != nil || !updated {
			return errors.New("binding release failed")
		}
		if updated, err := tx.UpdateTransactionBindingCAS(bindingId+1_000_000, 2, &allocationId, nil, 1_700_000_003); err != nil || !updated {
			return errors.New("counterpart binding release failed")
		}
		if updated, err := tx.UpdateAllocationStatus(allocationId, ALLOCATION_STATUS_ACTIVE, ALLOCATION_STATUS_REVERSED, lastActionId, 1_700_000_003); err != nil || !updated {
			return errors.New("allocation reversal failed")
		}
		return nil
	})
	if err != nil {
		t.Fatal("reverse allocation fixture failed")
	}
}

type testServiceSettlementLedger struct {
	repository *Repository
	accounts   *testAccountReader
	liability  LiabilityOutstandingReader
}

func (l *testServiceSettlementLedger) LoadAccountSnapshots(c core.Context, uid int64, accountIds []int64) ([]AccountSnapshot, error) {
	return l.accounts.LoadAccountSnapshots(c, uid, accountIds)
}

func (l *testServiceSettlementLedger) ReadLiabilityOutstanding(c core.Context, uid int64, liabilityAccountId int64) (*int64, error) {
	if l.liability == nil {
		return nil, nil
	}
	return l.liability.ReadLiabilityOutstanding(c, uid, liabilityAccountId)
}

func (*testServiceSettlementLedger) AuthorizeSettlementCreation(core.Context, int64, *time.Location, []LedgerCreateDraft) error {
	return nil
}

func (*testServiceSettlementLedger) ListSettlementCandidates(core.Context, int64, LedgerCandidateFilter) (*LedgerCandidatePage, error) {
	return &LedgerCandidatePage{}, nil
}

func (l *testServiceSettlementLedger) LoadSettlementEvents(c core.Context, uid int64, transactionIds []int64) (map[int64]*LedgerEventSnapshot, error) {
	database, err := l.repository.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return l.loadEvents(sess, uid, transactionIds)
}

func (l *testServiceSettlementLedger) LoadSettlementEventsInSession(_ core.Context, _ *datastore.Database, sess *xorm.Session, uid int64, transactionIds []int64) (map[int64]*LedgerEventSnapshot, error) {
	return l.loadEvents(sess, uid, transactionIds)
}

func (*testServiceSettlementLedger) ValidateSettlementDraftInSession(core.Context, *datastore.Database, *xorm.Session, LedgerCreateDraft) (*LedgerEventSnapshot, error) {
	return nil, errors.New("not implemented by lifecycle fixture")
}

func (*testServiceSettlementLedger) CreateSettlementEventInSession(core.Context, *datastore.Database, *xorm.Session, LedgerCreateDraft) (*LedgerEventSnapshot, error) {
	return nil, errors.New("not implemented by lifecycle fixture")
}

func (l *testServiceSettlementLedger) loadEvents(sess *xorm.Session, uid int64, transactionIds []int64) (map[int64]*LedgerEventSnapshot, error) {
	result := make(map[int64]*LedgerEventSnapshot, len(transactionIds))
	for _, transactionId := range transactionIds {
		binding := new(TransactionBinding)
		found, err := sess.Where("uid=? AND transaction_id=?", uid, transactionId).Get(binding)
		if err != nil || !found || binding.CurrentAllocationId == nil {
			if err != nil {
				return nil, err
			}
			continue
		}
		allocation := new(TransactionAllocation)
		found, err = sess.Where("uid=? AND allocation_id=?", uid, *binding.CurrentAllocationId).Get(allocation)
		if err != nil || !found {
			if err != nil {
				return nil, err
			}
			continue
		}
		primaryBinding := new(TransactionBinding)
		found, err = sess.Where("uid=? AND binding_id=?", uid, allocation.PrimaryBindingId).Get(primaryBinding)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, errors.New("primary binding fixture missing")
		}
		counterpartBinding := new(TransactionBinding)
		found, err = sess.Where("uid=? AND binding_id=?", uid, *allocation.CounterpartBindingId).Get(counterpartBinding)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, errors.New("counterpart binding fixture missing")
		}
		contract := new(Contract)
		found, err = sess.Where("uid=? AND contract_id=?", uid, allocation.ContractId).Get(contract)
		if err != nil {
			return nil, err
		}
		if !found || contract.DefaultPaymentAccountId == nil {
			return nil, errors.New("contract fixture missing")
		}
		counterpartId := counterpartBinding.TransactionId
		counterpartUpdated := *allocation.CounterpartUpdatedUnixTime
		l.accounts.mu.RLock()
		source := l.accounts.accounts[uid][*contract.DefaultPaymentAccountId]
		destination := l.accounts.accounts[uid][contract.LiabilityAccountId]
		l.accounts.mu.RUnlock()
		result[transactionId] = &LedgerEventSnapshot{PrimaryTransactionId: primaryBinding.TransactionId,
			CounterpartTransactionId: &counterpartId, Kind: LEDGER_EVENT_KIND_TRANSFER, CategoryId: 1,
			CategoryKind: LEDGER_CATEGORY_KIND_TRANSFER, SourceAccount: source, DestinationAccount: &destination,
			Amount: allocation.AllocatedAmount, UpdatedUnixTime: allocation.TransactionUpdatedUnixTime,
			CounterpartUpdatedUnixTime: &counterpartUpdated, TransferComplete: true}
	}
	return result, nil
}
