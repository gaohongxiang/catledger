package loans

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
)

type settlementTestLedgerRow struct {
	Uid                        int64 `xorm:"BIGINT INDEX NOT NULL"`
	PrimaryTransactionId       int64 `xorm:"BIGINT UNIQUE NOT NULL"`
	CounterpartTransactionId   *int64
	Kind                       LedgerEventKind `xorm:"VARCHAR(16) NOT NULL"`
	CategoryId                 int64           `xorm:"BIGINT NOT NULL"`
	CategoryKind               LedgerCategoryKind
	CategoryDeleted            bool
	SourceAccountId            int64 `xorm:"BIGINT NOT NULL"`
	DestinationAccountId       int64 `xorm:"BIGINT NOT NULL"`
	Amount                     int64 `xorm:"BIGINT NOT NULL"`
	TransactionUnixTime        int64 `xorm:"BIGINT NOT NULL"`
	Deleted                    bool
	CounterpartDeleted         bool
	UpdatedUnixTime            int64 `xorm:"BIGINT NOT NULL"`
	CounterpartUpdatedUnixTime *int64
	TransferComplete           bool
	RowId                      int64 `xorm:"BIGINT PK NOT NULL"`
}

func (settlementTestLedgerRow) TableName() string { return "settlement_test_ledger_event" }

type settlementTestGateway struct {
	repository    *Repository
	database      *datastore.Database
	accounts      *testAccountReader
	nextEventId   atomic.Int64
	createCalls   atomic.Int64
	failCreateAt  atomic.Int64
	mu            sync.Mutex
	lastFilter    LedgerCandidateFilter
	categoryKinds map[int64]LedgerCategoryKind
}

type settlementTestEnvironment struct {
	service    *Service
	repository *Repository
	database   *datastore.Database
	gateway    *settlementTestGateway
	ids        *atomic.Int64
}

func TestSettlementCandidatesAreBoundedDerivedAndSnapshotSafe(t *testing.T) {
	environment := newSettlementTestEnvironment(t, 1, 10_000_000)
	spec := settlementTestSpec()
	spec.Terms.EffectiveDate = "2026-01-10"
	spec.Terms.ContractDate = "2026-08-13"
	spec.Terms.UpfrontFeeAmount = 1_000
	spec.Terms.ActualDisbursementAmount = spec.Terms.PrincipalAmount - spec.Terms.UpfrontFeeAmount
	created := mustCreateSettlementContract(t, environment.service, 1001, spec, "candidate-contract-key")
	effectiveDate := mustSettlementDateUnix(t, spec.Terms.EffectiveDate)

	var chosen *LedgerEventSnapshot
	for index := 0; index < maximumSettlementCandidateResults+2; index++ {
		event := environment.gateway.insertEvent(t, 1001, COMPONENT_TYPE_DISBURSEMENT, int64(index+1), effectiveDate, 11, 12)
		if index == 10 {
			chosen = event
		}
	}
	outsideWindow := environment.gateway.insertEvent(t, 1001, COMPONENT_TYPE_DISBURSEMENT, 10,
		mustSettlementDateUnix(t, spec.Terms.ContractDate), 11, 12)
	crossUid := environment.gateway.insertEvent(t, 2002, COMPONENT_TYPE_DISBURSEMENT, 10, effectiveDate, 11, 12)
	environment.gateway.insertEvent(t, 1001, COMPONENT_TYPE_DISBURSEMENT, 10, effectiveDate, 12, 11)

	result, err := environment.service.GetSettlementCandidates(nil, SettlementCandidateRequest{Uid: 1001,
		ContractId: created.Action.ContractId, ComponentType: COMPONENT_TYPE_DISBURSEMENT})
	if err != nil || result == nil || len(result.Groups) != 1 || len(result.Groups[0].Candidates) != maximumSettlementCandidateResults ||
		!result.Groups[0].LimitReached || result.Groups[0].ExpectedAmount != spec.Terms.PrincipalAmount ||
		result.Groups[0].OutstandingAmount != spec.Terms.PrincipalAmount {
		t.Fatalf("bounded settlement candidates mismatch: %+v %v", result, err)
	}
	environment.gateway.mu.Lock()
	filter := environment.gateway.lastFilter
	environment.gateway.mu.Unlock()
	expectedMinimum := time.Unix(effectiveDate, 0).UTC().AddDate(0, 0, -settlementCandidateWindowDays).Unix()
	expectedMaximum := time.Unix(effectiveDate, 0).UTC().AddDate(0, 0, settlementCandidateWindowDays).Unix()
	if filter.MinimumAmount != 1 || filter.MaximumAmount != spec.Terms.PrincipalAmount || filter.Limit != maximumSettlementCandidateResults ||
		filter.SourceAccountId != 11 || filter.DestinationAccountId != 0 || filter.MinimumUnixTime != expectedMinimum || filter.MaximumUnixTime != expectedMaximum {
		t.Fatalf("candidate filter was not derived from effective date/current plan: %+v", filter)
	}
	for _, candidate := range result.Groups[0].Candidates {
		if candidate.TransactionId == outsideWindow.PrimaryTransactionId || candidate.TransactionId == crossUid.PrimaryTransactionId || candidate.Currency != "CNY" ||
			candidate.MaskedSourceAccount != "debt-**0011" || candidate.MaskedDestinationAccount != "asset-**0012" ||
			!candidate.Eligible || candidate.UpdatedUnixTime < 1 || candidate.CounterpartUpdatedUnixTime == nil {
			t.Fatalf("candidate leaked or omitted safe snapshot fields: %+v", candidate)
		}
	}
	if chosen == nil {
		t.Fatal("candidate fixture missing")
	}
	apply, err := environment.service.ApplySettlement(nil, ApplySettlementRequest{Uid: 1001, ContractId: created.Action.ContractId,
		ExpectedContractVersion: 1, IdempotencyKey: "candidate-apply-key", Components: []SettlementComponentCommand{{
			ComponentType: COMPONENT_TYPE_DISBURSEMENT, AllocatedAmount: chosen.Amount,
			Existing: &ExistingLedgerEventReference{ExistingTransactionId: chosen.PrimaryTransactionId,
				ExpectedUpdatedUnixTime: chosen.UpdatedUnixTime, ExpectedCounterpartUpdatedUnixTime: cloneInt64(chosen.CounterpartUpdatedUnixTime)},
		}}}, time.UTC)
	if err != nil || apply == nil || len(apply.Allocations) != 1 || apply.Allocations[0].CounterpartTransactionId == nil ||
		apply.Allocations[0].TransactionUpdatedUnixTime != chosen.UpdatedUnixTime ||
		!equalOptionalInt64(apply.Allocations[0].CounterpartUpdatedUnixTime, chosen.CounterpartUpdatedUnixTime) {
		t.Fatalf("apply existing disbursement candidate: %+v %v", apply, err)
	}
	replay, err := environment.service.ApplySettlement(nil, ApplySettlementRequest{Uid: 1001, ContractId: created.Action.ContractId,
		ExpectedContractVersion: 1, IdempotencyKey: "candidate-apply-key", Components: []SettlementComponentCommand{{
			ComponentType: COMPONENT_TYPE_DISBURSEMENT, AllocatedAmount: chosen.Amount,
			Existing: &ExistingLedgerEventReference{ExistingTransactionId: chosen.PrimaryTransactionId,
				ExpectedUpdatedUnixTime: chosen.UpdatedUnixTime, ExpectedCounterpartUpdatedUnixTime: cloneInt64(chosen.CounterpartUpdatedUnixTime)},
		}}}, time.UTC)
	if err != nil || replay == nil || !replay.Replayed || replay.Action.ActionId != apply.Action.ActionId ||
		replay.Allocations[0].AllocationId != apply.Allocations[0].AllocationId {
		t.Fatalf("same-key settlement replay was not stable: %+v %v", replay, err)
	}
	conflictRequest := ApplySettlementRequest{Uid: 1001, ContractId: created.Action.ContractId, ExpectedContractVersion: 1,
		IdempotencyKey: "candidate-apply-key", Components: []SettlementComponentCommand{{ComponentType: COMPONENT_TYPE_DISBURSEMENT,
			AllocatedAmount: chosen.Amount + 1, Existing: &ExistingLedgerEventReference{ExistingTransactionId: chosen.PrimaryTransactionId,
				ExpectedUpdatedUnixTime: chosen.UpdatedUnixTime, ExpectedCounterpartUpdatedUnixTime: cloneInt64(chosen.CounterpartUpdatedUnixTime)}}}}
	if _, err = environment.service.ApplySettlement(nil, conflictRequest, time.UTC); !errors.Is(err, ErrServiceIdempotencyConflict) {
		t.Fatalf("same key with a different settlement digest was accepted: %v", err)
	}

	result, err = environment.service.GetSettlementCandidates(nil, SettlementCandidateRequest{Uid: 1001,
		ContractId: created.Action.ContractId, ComponentType: COMPONENT_TYPE_DISBURSEMENT})
	if err != nil {
		t.Fatalf("reload candidates after allocation: %v", err)
	}
	matchedBinding := false
	for _, candidate := range result.Groups[0].Candidates {
		if candidate.TransactionId == chosen.PrimaryTransactionId {
			matchedBinding = !candidate.Eligible && containsServiceCode(candidate.ReasonCodes, SERVICE_ERROR_BINDING_CONFLICT)
		}
	}
	if !matchedBinding {
		t.Fatal("active binding was not exposed as an ineligible candidate")
	}
}

func TestSettlementUpfrontFeeFundingRules(t *testing.T) {
	t.Run("cash disbursement combines principal transfer and upfront expense", func(t *testing.T) {
		environment := newSettlementTestEnvironment(t, 1, 15_000_000)
		spec := settlementTestSpec()
		spec.Terms.UpfrontFeeAmount = 1_000
		spec.Terms.ActualDisbursementAmount = spec.Terms.PrincipalAmount - spec.Terms.UpfrontFeeAmount
		created := mustCreateSettlementContract(t, environment.service, 1001, spec, "upfront-cash-contract")

		disbursementCandidates, err := environment.service.GetSettlementCandidates(nil, SettlementCandidateRequest{Uid: 1001,
			ContractId: created.Action.ContractId, ComponentType: COMPONENT_TYPE_DISBURSEMENT})
		if err != nil || disbursementCandidates == nil || len(disbursementCandidates.Groups) != 1 ||
			disbursementCandidates.Groups[0].ExpectedAmount != spec.Terms.PrincipalAmount ||
			disbursementCandidates.Groups[0].OutstandingAmount != spec.Terms.PrincipalAmount {
			t.Fatalf("cash disbursement candidates did not use principal: %+v %v", disbursementCandidates, err)
		}
		upfrontCandidates, err := environment.service.GetSettlementCandidates(nil, SettlementCandidateRequest{Uid: 1001,
			ContractId: created.Action.ContractId, ComponentType: COMPONENT_TYPE_FEE})
		if err != nil || upfrontCandidates == nil || len(upfrontCandidates.Groups) != 1 ||
			upfrontCandidates.Groups[0].ExpectedAmount != spec.Terms.UpfrontFeeAmount ||
			upfrontCandidates.Groups[0].OutstandingAmount != spec.Terms.UpfrontFeeAmount {
			t.Fatalf("upfront fee candidates did not use upfront amount: %+v %v", upfrontCandidates, err)
		}

		request := ApplySettlementRequest{Uid: 1001, ContractId: created.Action.ContractId, ExpectedContractVersion: 1,
			IdempotencyKey: "upfront-cash-apply", Components: []SettlementComponentCommand{
				{ComponentType: COMPONENT_TYPE_FEE, AllocatedAmount: spec.Terms.UpfrontFeeAmount,
					Draft: settlementExpenseDraft(spec.Terms.EffectiveDate, spec.Terms.UpfrontFeeAmount)},
				{ComponentType: COMPONENT_TYPE_DISBURSEMENT, AllocatedAmount: spec.Terms.PrincipalAmount,
					Draft: settlementTransferDraft(spec.Terms.EffectiveDate, spec.Terms.PrincipalAmount, 11, 12)},
			}}
		result, err := environment.service.ApplySettlement(nil, request, time.UTC)
		if err != nil || result == nil || result.Action.AppliedContractVersion != 2 || len(result.Allocations) != 2 ||
			environment.gateway.countEvents(t, 1001) != 2 {
			t.Fatalf("cash upfront settlement was not atomic: %+v %v", result, err)
		}
		components := make(map[ComponentType]*SettlementAllocationResult, len(result.Allocations))
		for _, allocation := range result.Allocations {
			components[allocation.ComponentType] = allocation
			if allocation.InstallmentId != nil || allocation.Status != ALLOCATION_STATUS_ACTIVE ||
				allocation.CreationMethod != ALLOCATION_CREATION_METHOD_LOAN_CREATED ||
				allocation.TransactionUpdatedUnixTime < 1 || allocation.CreatedUnixTime < 1 || allocation.UpdatedUnixTime < 1 {
				t.Fatalf("nil-installment allocation safety fields mismatch: %+v", allocation)
			}
		}
		if components[COMPONENT_TYPE_DISBURSEMENT] == nil || components[COMPONENT_TYPE_DISBURSEMENT].AllocatedAmount != spec.Terms.PrincipalAmount ||
			components[COMPONENT_TYPE_DISBURSEMENT].CounterpartTransactionId == nil ||
			components[COMPONENT_TYPE_DISBURSEMENT].CounterpartUpdatedUnixTime == nil ||
			components[COMPONENT_TYPE_FEE] == nil || components[COMPONENT_TYPE_FEE].AllocatedAmount != spec.Terms.UpfrontFeeAmount ||
			components[COMPONENT_TYPE_FEE].CounterpartTransactionId != nil || components[COMPONENT_TYPE_FEE].CounterpartUpdatedUnixTime != nil {
			t.Fatalf("principal/upfront allocation semantics mismatch: %+v", result.Allocations)
		}

		detail, err := environment.service.GetContract(nil, 1001, created.Action.ContractId, spec.Terms.FirstDueDate)
		if err != nil || detail == nil || detail.ActionRequired || detail.InvalidAllocationCount != 0 {
			t.Fatalf("valid upfront allocations failed stored validation: %+v %v", detail, err)
		}
		nilAggregates := make(map[ComponentType]int64)
		for _, aggregate := range detail.ActiveAllocationAggregates {
			if aggregate.InstallmentId == nil {
				nilAggregates[aggregate.ComponentType] += aggregate.AllocatedAmount
			}
		}
		if nilAggregates[COMPONENT_TYPE_DISBURSEMENT] != spec.Terms.PrincipalAmount ||
			nilAggregates[COMPONENT_TYPE_FEE] != spec.Terms.UpfrontFeeAmount {
			t.Fatalf("nil-installment active aggregates mismatch: %+v", nilAggregates)
		}

		replayRequest := request
		replayRequest.Components = []SettlementComponentCommand{request.Components[1], request.Components[0]}
		replay, err := environment.service.ApplySettlement(nil, replayRequest, time.UTC)
		if err != nil || replay == nil || !replay.Replayed || replay.Action.ActionId != result.Action.ActionId || len(replay.Allocations) != 2 {
			t.Fatalf("upfront multi-component replay was not stable: %+v %v", replay, err)
		}

		overage := ApplySettlementRequest{Uid: 1001, ContractId: created.Action.ContractId, ExpectedContractVersion: 2,
			IdempotencyKey: "upfront-cash-overage", Components: []SettlementComponentCommand{{ComponentType: COMPONENT_TYPE_FEE,
				AllocatedAmount: 1, Draft: settlementExpenseDraft(spec.Terms.EffectiveDate, 1)}}}
		if _, err = environment.service.ApplySettlement(nil, overage, time.UTC); ServiceErrorCodeOf(err) != SERVICE_ERROR_AMOUNT_EXCEEDED {
			t.Fatalf("upfront aggregate overage was not action_required: %v", err)
		}
		contract, _ := environment.repository.FindContractById(nil, 1001, created.Action.ContractId)
		action, _ := environment.repository.FindActionByIdempotencyKeyDigest(nil, 1001, idempotencyKeyDigest(overage.IdempotencyKey))
		if contract == nil || contract.Version != 2 || action == nil || action.Status != ACTION_STATUS_ACTION_REQUIRED ||
			environment.gateway.countEvents(t, 1001) != 2 ||
			countSettlementRows(t, environment.database, new(TransactionAllocation), "uid=? AND contract_id=? AND status=?", 1001, created.Action.ContractId, ALLOCATION_STATUS_ACTIVE) != 2 {
			t.Fatalf("upfront overage changed active effects: contract=%+v action=%+v", contract, action)
		}
	})

	t.Run("purchase installment allows only upfront fee without installment", func(t *testing.T) {
		environment := newSettlementTestEnvironment(t, 1, 17_000_000)
		spec := settlementTestSpec()
		spec.Terms.FundingType = FUNDING_TYPE_PURCHASE_INSTALLMENT
		spec.Terms.UpfrontFeeAmount = 750
		spec.Terms.ActualDisbursementAmount = spec.Terms.PrincipalAmount - spec.Terms.UpfrontFeeAmount
		spec.DefaultPaymentAccountId = nil
		created := mustCreateSettlementContract(t, environment.service, 1001, spec, "upfront-purchase-contract")

		candidates, err := environment.service.GetSettlementCandidates(nil, SettlementCandidateRequest{Uid: 1001,
			ContractId: created.Action.ContractId, ComponentType: COMPONENT_TYPE_FEE})
		if err != nil || candidates == nil || len(candidates.Groups) != 1 || candidates.Groups[0].ExpectedAmount != spec.Terms.UpfrontFeeAmount ||
			candidates.Groups[0].OutstandingAmount != spec.Terms.UpfrontFeeAmount || len(candidates.Groups[0].Candidates) != 0 {
			t.Fatalf("missing default payment account did not return an empty upfront candidate group: %+v %v", candidates, err)
		}

		disbursement := ApplySettlementRequest{Uid: 1001, ContractId: created.Action.ContractId, ExpectedContractVersion: 1,
			IdempotencyKey: "purchase-disbursement-rejected", Components: []SettlementComponentCommand{{ComponentType: COMPONENT_TYPE_DISBURSEMENT,
				AllocatedAmount: spec.Terms.PrincipalAmount,
				Draft:           settlementTransferDraft(spec.Terms.EffectiveDate, spec.Terms.PrincipalAmount, 11, 12)}}}
		if _, err = environment.service.ApplySettlement(nil, disbursement, time.UTC); ServiceErrorCodeOf(err) != SERVICE_ERROR_COMPONENT_MISMATCH {
			t.Fatalf("purchase installment accepted a disbursement: %v", err)
		}
		if environment.gateway.countEvents(t, 1001) != 0 ||
			countSettlementRows(t, environment.database, new(TransactionAllocation), "uid=? AND contract_id=?", 1001, created.Action.ContractId) != 0 {
			t.Fatal("rejected purchase disbursement left ledger or allocation effects")
		}

		fee := ApplySettlementRequest{Uid: 1001, ContractId: created.Action.ContractId, ExpectedContractVersion: 1,
			IdempotencyKey: "purchase-upfront-fee", Components: []SettlementComponentCommand{{ComponentType: COMPONENT_TYPE_FEE,
				AllocatedAmount: spec.Terms.UpfrontFeeAmount,
				Draft:           settlementExpenseDraft(spec.Terms.EffectiveDate, spec.Terms.UpfrontFeeAmount)}}}
		result, err := environment.service.ApplySettlement(nil, fee, time.UTC)
		if err != nil || result == nil || len(result.Allocations) != 1 || result.Allocations[0].InstallmentId != nil ||
			result.Allocations[0].ComponentType != COMPONENT_TYPE_FEE || result.Allocations[0].AllocatedAmount != spec.Terms.UpfrontFeeAmount ||
			environment.gateway.countEvents(t, 1001) != 1 {
			t.Fatalf("purchase upfront fee settlement failed: %+v %v", result, err)
		}
		detail, err := environment.service.GetContract(nil, 1001, created.Action.ContractId, spec.Terms.FirstDueDate)
		if err != nil || detail == nil || detail.ActionRequired || detail.InvalidAllocationCount != 0 {
			t.Fatalf("purchase upfront fee failed stored validation: %+v %v", detail, err)
		}
		found := false
		for _, aggregate := range detail.ActiveAllocationAggregates {
			if aggregate.InstallmentId == nil && aggregate.ComponentType == COMPONENT_TYPE_FEE &&
				aggregate.AllocatedAmount == spec.Terms.UpfrontFeeAmount && aggregate.AllocationCount == 1 {
				found = true
			}
		}
		if !found {
			t.Fatalf("purchase upfront fee aggregate missing: %+v", detail.ActiveAllocationAggregates)
		}
	})
}

func TestSettlementExistingEventIsUidIsolated(t *testing.T) {
	environment := newSettlementTestEnvironment(t, 1, 18_000_000)
	created := mustCreateSettlementContract(t, environment.service, 1001, settlementTestSpec(), "cross-uid-settlement-contract")
	installment := created.Installments[0]
	event := environment.gateway.insertEvent(t, 2002, COMPONENT_TYPE_PRINCIPAL, installment.PrincipalAmount,
		mustSettlementDateUnix(t, installment.DueDate), 12, 11)
	request := ApplySettlementRequest{Uid: 1001, ContractId: created.Action.ContractId, ExpectedContractVersion: 1,
		InstallmentId: &installment.InstallmentId, IdempotencyKey: "cross-uid-settlement-apply",
		Components: []SettlementComponentCommand{{ComponentType: COMPONENT_TYPE_PRINCIPAL, AllocatedAmount: event.Amount,
			Existing: &ExistingLedgerEventReference{ExistingTransactionId: event.PrimaryTransactionId,
				ExpectedUpdatedUnixTime: event.UpdatedUnixTime, ExpectedCounterpartUpdatedUnixTime: cloneInt64(event.CounterpartUpdatedUnixTime)}}}}
	if _, err := environment.service.ApplySettlement(nil, request, time.UTC); ServiceErrorCodeOf(err) != SERVICE_ERROR_LEDGER_EVENT_MISSING {
		t.Fatalf("cross-uid formal event was accepted: %v", err)
	}
	action, _ := environment.repository.FindActionByIdempotencyKeyDigest(nil, 1001, idempotencyKeyDigest(request.IdempotencyKey))
	contract, _ := environment.repository.FindContractById(nil, 1001, created.Action.ContractId)
	if action == nil || action.Status != ACTION_STATUS_ACTION_REQUIRED || contract == nil || contract.Version != 1 ||
		countSettlementRows(t, environment.database, new(TransactionAllocation), "uid=? AND contract_id=?", 1001, created.Action.ContractId) != 0 ||
		countSettlementRows(t, environment.database, new(TransactionBinding), "uid=?", 1001) != 0 {
		t.Fatalf("cross-uid rejection persisted settlement effects: action=%+v contract=%+v", action, contract)
	}
}

func TestSettlementPartialComponentAccumulatesAcrossActions(t *testing.T) {
	environment := newSettlementTestEnvironment(t, 1, 19_000_000)
	created := mustCreateSettlementContract(t, environment.service, 1001, settlementTestSpec(), "partial-settlement-contract")
	installment := created.Installments[0]
	firstAmount := installment.PrincipalAmount / 3
	secondAmount := installment.PrincipalAmount / 4
	firstEvent := environment.gateway.insertEvent(t, 1001, COMPONENT_TYPE_PRINCIPAL, firstAmount,
		mustSettlementDateUnix(t, installment.DueDate), 12, 11)
	first, err := environment.service.ApplySettlement(nil, ApplySettlementRequest{Uid: 1001, ContractId: created.Action.ContractId,
		ExpectedContractVersion: 1, InstallmentId: &installment.InstallmentId, IdempotencyKey: "partial-settlement-first",
		Components: []SettlementComponentCommand{{ComponentType: COMPONENT_TYPE_PRINCIPAL, AllocatedAmount: firstAmount,
			Existing: &ExistingLedgerEventReference{ExistingTransactionId: firstEvent.PrimaryTransactionId,
				ExpectedUpdatedUnixTime:            firstEvent.UpdatedUnixTime,
				ExpectedCounterpartUpdatedUnixTime: cloneInt64(firstEvent.CounterpartUpdatedUnixTime)}}}}, time.UTC)
	if err != nil || first == nil || first.Action.AppliedContractVersion != 2 || len(first.Allocations) != 1 {
		t.Fatalf("first partial settlement failed: %+v %v", first, err)
	}
	second, err := environment.service.ApplySettlement(nil, ApplySettlementRequest{Uid: 1001, ContractId: created.Action.ContractId,
		ExpectedContractVersion: 2, InstallmentId: &installment.InstallmentId, IdempotencyKey: "partial-settlement-second",
		Components: []SettlementComponentCommand{{ComponentType: COMPONENT_TYPE_PRINCIPAL, AllocatedAmount: secondAmount,
			Draft: settlementTransferDraft(installment.DueDate, secondAmount, 12, 11)}}}, time.UTC)
	if err != nil || second == nil || second.Action.AppliedContractVersion != 3 || len(second.Allocations) != 1 ||
		second.Allocations[0].AllocationId == first.Allocations[0].AllocationId {
		t.Fatalf("second partial settlement failed: %+v %v", second, err)
	}
	detail, err := environment.service.GetContract(nil, 1001, created.Action.ContractId, installment.DueDate)
	if err != nil || detail == nil || detail.ActionRequired ||
		detail.InstallmentProgress[0].Components.AllocatedPrincipalAmount != firstAmount+secondAmount ||
		detail.InstallmentProgress[0].Components.OutstandingPrincipal != installment.PrincipalAmount-firstAmount-secondAmount ||
		countSettlementRows(t, environment.database, new(TransactionAllocation),
			"uid=? AND contract_id=? AND installment_id=? AND component_type=? AND status=?", 1001, created.Action.ContractId,
			installment.InstallmentId, COMPONENT_TYPE_PRINCIPAL, ALLOCATION_STATUS_ACTIVE) != 2 {
		t.Fatalf("partial settlements did not accumulate safely: %+v %v", detail, err)
	}
}

func TestSettlementMultiComponentDriftImpactAndRelationshipOnlyUndo(t *testing.T) {
	environment := newSettlementTestEnvironment(t, 1, 20_000_000)
	spec := settlementTestSpec()
	created := mustCreateSettlementContract(t, environment.service, 1001, spec, "multi-contract-key")
	installment := created.Installments[0]
	if installment.InterestAmount <= 0 || installment.FeeAmount <= 0 || installment.PrincipalAmount <= 1 {
		t.Fatalf("multi-component fixture has no payable components: %+v", installment)
	}
	principalAmount := installment.PrincipalAmount / 2
	principalEvent := environment.gateway.insertEvent(t, 1001, COMPONENT_TYPE_PRINCIPAL, principalAmount,
		mustSettlementDateUnix(t, installment.DueDate), 12, 11)
	request := ApplySettlementRequest{Uid: 1001, ContractId: created.Action.ContractId, ExpectedContractVersion: 1,
		InstallmentId: &installment.InstallmentId, IdempotencyKey: "multi-apply-key", CreatedIp: "192.0.2.10",
		Components: []SettlementComponentCommand{
			{ComponentType: COMPONENT_TYPE_PRINCIPAL, AllocatedAmount: principalAmount,
				Existing: &ExistingLedgerEventReference{ExistingTransactionId: principalEvent.PrimaryTransactionId,
					ExpectedUpdatedUnixTime: principalEvent.UpdatedUnixTime, ExpectedCounterpartUpdatedUnixTime: cloneInt64(principalEvent.CounterpartUpdatedUnixTime)}},
			{ComponentType: COMPONENT_TYPE_INTEREST, AllocatedAmount: installment.InterestAmount,
				Draft: settlementExpenseDraft(installment.DueDate, installment.InterestAmount)},
			{ComponentType: COMPONENT_TYPE_FEE, AllocatedAmount: installment.FeeAmount,
				Draft: settlementExpenseDraft(installment.DueDate, installment.FeeAmount)},
		}}
	result, err := environment.service.ApplySettlement(nil, request, time.UTC)
	if err != nil || result == nil || len(result.Allocations) != 3 || result.Action.AppliedContractVersion != 2 {
		t.Fatalf("atomic multi-component settlement failed: %+v %v", result, err)
	}
	createdMethods := 0
	for _, allocation := range result.Allocations {
		if allocation.CreationMethod == ALLOCATION_CREATION_METHOD_LOAN_CREATED {
			createdMethods++
		}
		if allocation.CreatedUnixTime < 1 || allocation.UpdatedUnixTime < 1 || allocation.ReasonCodes == nil {
			t.Fatalf("allocation safety result omitted time/reasons: %+v", allocation)
		}
	}
	if createdMethods != 2 {
		t.Fatalf("existing/created event methods mismatch: %+v", result.Allocations)
	}
	detail, err := environment.service.GetContract(nil, 1001, created.Action.ContractId, installment.DueDate)
	if err != nil || detail.ActionRequired || detail.InstallmentProgress[0].Components.AllocatedPrincipalAmount != principalAmount ||
		detail.InstallmentProgress[0].Components.AllocatedInterestAmount != installment.InterestAmount ||
		detail.InstallmentProgress[0].Components.AllocatedFeeAmount != installment.FeeAmount {
		t.Fatalf("valid allocations did not derive plan progress: %+v %v", detail, err)
	}

	environment.gateway.updateEvent(t, 1001, principalEvent.PrimaryTransactionId, func(row *settlementTestLedgerRow) {
		row.UpdatedUnixTime++
	})
	detail, err = environment.service.GetContract(nil, 1001, created.Action.ContractId, installment.DueDate)
	if err != nil || !detail.ActionRequired || detail.InvalidAllocationCount != 1 ||
		detail.InstallmentProgress[0].Components.AllocatedPrincipalAmount != 0 ||
		detail.InstallmentProgress[0].Components.OutstandingPrincipal != installment.PrincipalAmount ||
		!containsServiceCode(detail.ReasonCodes, SERVICE_ERROR_LEDGER_EVENT_MODIFIED) {
		t.Fatalf("modified formal event still counted as paid: %+v %v", detail, err)
	}
	replay, err := environment.service.ApplySettlement(nil, request, time.UTC)
	if err != nil || replay == nil || !containsServiceCode(replay.ReasonCodes, SERVICE_ERROR_LEDGER_EVENT_MODIFIED) {
		t.Fatalf("replayed allocation omitted drift safety reason: %+v %v", replay, err)
	}
	impact, err := environment.service.GetSettlementUndoImpact(nil, SettlementUndoImpactRequest{Uid: 1001,
		ContractId: created.Action.ContractId, ApplyActionId: result.Action.ActionId})
	if err != nil || !impact.CanUndoRelationships || impact.ActiveAllocationCount != 3 || impact.RelationshipCount != 4 ||
		impact.AffectedTransactionCount != 4 || impact.LoanCreatedTransactionCount != 2 || impact.ModifiedTransactionCount != 1 {
		t.Fatalf("modified settlement undo impact mismatch: %+v %v", impact, err)
	}

	environment.gateway.updateEvent(t, 1001, principalEvent.PrimaryTransactionId, func(row *settlementTestLedgerRow) {
		row.UpdatedUnixTime = principalEvent.UpdatedUnixTime
		row.TransferComplete = false
	})
	impact, err = environment.service.GetSettlementUndoImpact(nil, SettlementUndoImpactRequest{Uid: 1001,
		ContractId: created.Action.ContractId, ApplyActionId: result.Action.ActionId})
	if err != nil || impact.IncompleteTransferPairCount != 1 || !impact.CanUndoRelationships {
		t.Fatalf("incomplete transfer impact mismatch: %+v %v", impact, err)
	}
	environment.gateway.updateEvent(t, 1001, principalEvent.PrimaryTransactionId, func(row *settlementTestLedgerRow) {
		row.TransferComplete = true
		row.Deleted = true
	})
	impact, err = environment.service.GetSettlementUndoImpact(nil, SettlementUndoImpactRequest{Uid: 1001,
		ContractId: created.Action.ContractId, ApplyActionId: result.Action.ActionId})
	if err != nil || impact.MissingTransactionCount != 1 || !impact.CanUndoRelationships {
		t.Fatalf("missing formal event impact mismatch: %+v %v", impact, err)
	}
	environment.gateway.updateEvent(t, 1001, principalEvent.PrimaryTransactionId, func(row *settlementTestLedgerRow) {
		row.Deleted = false
		row.UpdatedUnixTime++
	})

	formalCountBefore := environment.gateway.countEvents(t, 1001)
	undo, err := environment.service.ReverseSettlement(nil, ReverseSettlementRequest{Uid: 1001, ContractId: created.Action.ContractId,
		ApplyActionId: result.Action.ActionId, ExpectedContractVersion: 2, IdempotencyKey: "multi-undo-key"})
	if err != nil || undo == nil || undo.ReversedAllocationCount != 3 || len(undo.Allocations) != 3 ||
		environment.gateway.countEvents(t, 1001) != formalCountBefore {
		t.Fatalf("relationship-only undo changed formal ledger or missed allocations: %+v %v", undo, err)
	}
	for _, allocation := range undo.Allocations {
		if allocation.Status != ALLOCATION_STATUS_REVERSED {
			t.Fatalf("undo did not retain reversed allocation history: %+v", allocation)
		}
	}
	undoReplay, err := environment.service.ReverseSettlement(nil, ReverseSettlementRequest{Uid: 1001, ContractId: created.Action.ContractId,
		ApplyActionId: result.Action.ActionId, ExpectedContractVersion: 2, IdempotencyKey: "multi-undo-key"})
	if err != nil || undoReplay == nil || !undoReplay.Replayed || undoReplay.Action.ActionId != undo.Action.ActionId ||
		undoReplay.ReversedAllocationCount != 3 {
		t.Fatalf("same-key undo replay was not stable: %+v %v", undoReplay, err)
	}
	if _, err = environment.service.ReverseSettlement(nil, ReverseSettlementRequest{Uid: 1001, ContractId: created.Action.ContractId,
		ApplyActionId: result.Action.ActionId, ExpectedContractVersion: 3, IdempotencyKey: "multi-undo-repeat"}); ServiceErrorCodeOf(err) != SERVICE_ERROR_SETTLEMENT_ALREADY_REVERSED {
		t.Fatalf("repeated undo was not stably adjudicated: %v", err)
	}
}

func TestSettlementOverageSemanticFailureAndMiddleFailureRollback(t *testing.T) {
	t.Run("overage is persistent action required", func(t *testing.T) {
		environment := newSettlementTestEnvironment(t, 1, 30_000_000)
		created := mustCreateSettlementContract(t, environment.service, 1001, settlementTestSpec(), "overage-contract")
		installment := created.Installments[0]
		request := ApplySettlementRequest{Uid: 1001, ContractId: created.Action.ContractId, ExpectedContractVersion: 1,
			InstallmentId: &installment.InstallmentId, IdempotencyKey: "overage-apply-key", Components: []SettlementComponentCommand{{
				ComponentType: COMPONENT_TYPE_PRINCIPAL, AllocatedAmount: installment.PrincipalAmount + 1,
				Draft: settlementTransferDraft(installment.DueDate, installment.PrincipalAmount+1, 12, 11),
			}}}
		if _, err := environment.service.ApplySettlement(nil, request, time.UTC); ServiceErrorCodeOf(err) != SERVICE_ERROR_AMOUNT_EXCEEDED {
			t.Fatalf("extra principal was not action_required: %v", err)
		}
		action, err := environment.repository.FindActionByIdempotencyKeyDigest(nil, 1001, idempotencyKeyDigest(request.IdempotencyKey))
		contract, contractErr := environment.repository.FindContractById(nil, 1001, created.Action.ContractId)
		if err != nil || contractErr != nil || action == nil || action.Status != ACTION_STATUS_ACTION_REQUIRED || contract.Version != 1 ||
			environment.gateway.countEvents(t, 1001) != 0 {
			t.Fatalf("overage adjudication persisted effects: action=%+v contract=%+v errors=%v/%v", action, contract, err, contractErr)
		}
	})

	t.Run("wrong existing semantics is action required", func(t *testing.T) {
		environment := newSettlementTestEnvironment(t, 1, 40_000_000)
		created := mustCreateSettlementContract(t, environment.service, 1001, settlementTestSpec(), "semantic-contract")
		installment := created.Installments[0]
		wrong := environment.gateway.insertEvent(t, 1001, COMPONENT_TYPE_INTEREST, installment.PrincipalAmount,
			mustSettlementDateUnix(t, installment.DueDate), 12, 0)
		counterpartSnapshot := int64(1)
		request := ApplySettlementRequest{Uid: 1001, ContractId: created.Action.ContractId, ExpectedContractVersion: 1,
			InstallmentId: &installment.InstallmentId, IdempotencyKey: "semantic-apply-key", Components: []SettlementComponentCommand{{
				ComponentType: COMPONENT_TYPE_PRINCIPAL, AllocatedAmount: installment.PrincipalAmount,
				Existing: &ExistingLedgerEventReference{ExistingTransactionId: wrong.PrimaryTransactionId,
					ExpectedUpdatedUnixTime: wrong.UpdatedUnixTime, ExpectedCounterpartUpdatedUnixTime: &counterpartSnapshot},
			}}}
		if _, err := environment.service.ApplySettlement(nil, request, time.UTC); ServiceErrorCodeOf(err) != SERVICE_ERROR_TRANSFER_INCOMPLETE {
			t.Fatalf("expense was accepted as principal transfer: %v", err)
		}
		contract, _ := environment.repository.FindContractById(nil, 1001, created.Action.ContractId)
		if contract.Version != 1 || countSettlementRows(t, environment.database, new(TransactionAllocation), "uid=? AND contract_id=?", 1001, created.Action.ContractId) != 0 {
			t.Fatal("wrong existing semantics left settlement effects")
		}
	})

	t.Run("second component failure rolls back outer transaction", func(t *testing.T) {
		environment := newSettlementTestEnvironment(t, 1, 50_000_000)
		created := mustCreateSettlementContract(t, environment.service, 1001, settlementTestSpec(), "rollback-contract")
		installment := created.Installments[0]
		environment.gateway.failCreateAt.Store(2)
		request := ApplySettlementRequest{Uid: 1001, ContractId: created.Action.ContractId, ExpectedContractVersion: 1,
			InstallmentId: &installment.InstallmentId, IdempotencyKey: "rollback-apply-key", Components: []SettlementComponentCommand{
				{ComponentType: COMPONENT_TYPE_PRINCIPAL, AllocatedAmount: installment.PrincipalAmount,
					Draft: settlementTransferDraft(installment.DueDate, installment.PrincipalAmount, 12, 11)},
				{ComponentType: COMPONENT_TYPE_INTEREST, AllocatedAmount: installment.InterestAmount,
					Draft: settlementExpenseDraft(installment.DueDate, installment.InterestAmount)},
			}}
		if _, err := environment.service.ApplySettlement(nil, request, time.UTC); err == nil || ServiceErrorCodeOf(err) != SERVICE_ERROR_PERSISTENCE {
			t.Fatalf("synthetic middle failure was not returned: %v", err)
		}
		contract, _ := environment.repository.FindContractById(nil, 1001, created.Action.ContractId)
		action, _ := environment.repository.FindActionByIdempotencyKeyDigest(nil, 1001, idempotencyKeyDigest(request.IdempotencyKey))
		if contract.Version != 1 || action != nil || environment.gateway.countEvents(t, 1001) != 0 ||
			countSettlementRows(t, environment.database, new(TransactionAllocation), "uid=? AND contract_id=?", 1001, created.Action.ContractId) != 0 ||
			countSettlementRows(t, environment.database, new(TransactionBinding), "uid=? AND current_allocation_id IS NOT NULL", 1001) != 0 {
			t.Fatalf("middle failure escaped outer rollback: contract=%+v action=%+v", contract, action)
		}
	})
}

func TestSettlementConcurrentContractAndBindingCAS(t *testing.T) {
	t.Run("contract CAS", func(t *testing.T) {
		environment := newSettlementTestEnvironment(t, 8, 60_000_000)
		created := mustCreateSettlementContract(t, environment.service, 1001, settlementTestSpec(), "contract-cas-fixture")
		installment := created.Installments[0]
		events := []*LedgerEventSnapshot{
			environment.gateway.insertEvent(t, 1001, COMPONENT_TYPE_PRINCIPAL, installment.PrincipalAmount/3,
				mustSettlementDateUnix(t, installment.DueDate), 12, 11),
			environment.gateway.insertEvent(t, 1001, COMPONENT_TYPE_PRINCIPAL, installment.PrincipalAmount/4,
				mustSettlementDateUnix(t, installment.DueDate), 12, 11),
		}
		requests := make([]ApplySettlementRequest, 2)
		for index, event := range events {
			requests[index] = ApplySettlementRequest{Uid: 1001, ContractId: created.Action.ContractId, ExpectedContractVersion: 1,
				InstallmentId: &installment.InstallmentId, IdempotencyKey: "contract-cas-key-" + string(rune('a'+index)),
				Components: []SettlementComponentCommand{{ComponentType: COMPONENT_TYPE_PRINCIPAL, AllocatedAmount: event.Amount,
					Existing: &ExistingLedgerEventReference{ExistingTransactionId: event.PrimaryTransactionId,
						ExpectedUpdatedUnixTime: event.UpdatedUnixTime, ExpectedCounterpartUpdatedUnixTime: cloneInt64(event.CounterpartUpdatedUnixTime)}}}}
		}
		results, codes := runConcurrentSettlements(environment.service, requests)
		if results != 1 || codes[SERVICE_ERROR_VERSION_CONFLICT] != 1 {
			t.Fatalf("contract CAS did not select one winner: results=%d codes=%v", results, codes)
		}
	})

	t.Run("binding CAS", func(t *testing.T) {
		environment := newSettlementTestEnvironment(t, 8, 70_000_000)
		first := mustCreateSettlementContract(t, environment.service, 1001, settlementTestSpec(), "binding-cas-first")
		second := mustCreateSettlementContract(t, environment.service, 1001, settlementTestSpec(), "binding-cas-second")
		firstInstallment := first.Installments[0]
		secondInstallment := second.Installments[0]
		amount := firstInstallment.PrincipalAmount / 5
		event := environment.gateway.insertEvent(t, 1001, COMPONENT_TYPE_PRINCIPAL, amount,
			mustSettlementDateUnix(t, firstInstallment.DueDate), 12, 11)
		requests := []ApplySettlementRequest{
			{Uid: 1001, ContractId: first.Action.ContractId, ExpectedContractVersion: 1, InstallmentId: &firstInstallment.InstallmentId,
				IdempotencyKey: "binding-cas-key-a", Components: []SettlementComponentCommand{{ComponentType: COMPONENT_TYPE_PRINCIPAL,
					AllocatedAmount: amount, Existing: &ExistingLedgerEventReference{ExistingTransactionId: event.PrimaryTransactionId,
						ExpectedUpdatedUnixTime: event.UpdatedUnixTime, ExpectedCounterpartUpdatedUnixTime: cloneInt64(event.CounterpartUpdatedUnixTime)}}}},
			{Uid: 1001, ContractId: second.Action.ContractId, ExpectedContractVersion: 1, InstallmentId: &secondInstallment.InstallmentId,
				IdempotencyKey: "binding-cas-key-b", Components: []SettlementComponentCommand{{ComponentType: COMPONENT_TYPE_PRINCIPAL,
					AllocatedAmount: amount, Existing: &ExistingLedgerEventReference{ExistingTransactionId: event.PrimaryTransactionId,
						ExpectedUpdatedUnixTime: event.UpdatedUnixTime, ExpectedCounterpartUpdatedUnixTime: cloneInt64(event.CounterpartUpdatedUnixTime)}}}},
		}
		results, codes := runConcurrentSettlements(environment.service, requests)
		if results != 1 || codes[SERVICE_ERROR_BINDING_CONFLICT] != 1 ||
			countSettlementRows(t, environment.database, new(TransactionAllocation), "uid=? AND status=?", 1001, ALLOCATION_STATUS_ACTIVE) != 1 {
			t.Fatalf("binding CAS did not select one winner: results=%d codes=%v", results, codes)
		}
		loserActionCount := countSettlementRows(t, environment.database, new(Action),
			"uid=? AND action_type=? AND status=?", 1001, ACTION_TYPE_APPLY_SETTLEMENT, ACTION_STATUS_ACTION_REQUIRED)
		if loserActionCount != 1 {
			t.Fatalf("binding loser did not persist stable action_required: %d", loserActionCount)
		}
	})

	t.Run("reverse contract CAS", func(t *testing.T) {
		environment := newSettlementTestEnvironment(t, 8, 75_000_000)
		created := mustCreateSettlementContract(t, environment.service, 1001, settlementTestSpec(), "reverse-cas-contract")
		installment := created.Installments[0]
		event := environment.gateway.insertEvent(t, 1001, COMPONENT_TYPE_PRINCIPAL, installment.PrincipalAmount/2,
			mustSettlementDateUnix(t, installment.DueDate), 12, 11)
		applied, err := environment.service.ApplySettlement(nil, ApplySettlementRequest{Uid: 1001, ContractId: created.Action.ContractId,
			ExpectedContractVersion: 1, InstallmentId: &installment.InstallmentId, IdempotencyKey: "reverse-cas-apply",
			Components: []SettlementComponentCommand{{ComponentType: COMPONENT_TYPE_PRINCIPAL, AllocatedAmount: event.Amount,
				Existing: &ExistingLedgerEventReference{ExistingTransactionId: event.PrimaryTransactionId,
					ExpectedUpdatedUnixTime:            event.UpdatedUnixTime,
					ExpectedCounterpartUpdatedUnixTime: cloneInt64(event.CounterpartUpdatedUnixTime)}}}}, time.UTC)
		if err != nil || applied == nil {
			t.Fatalf("create reverse CAS fixture: %+v %v", applied, err)
		}
		requests := []ReverseSettlementRequest{
			{Uid: 1001, ContractId: created.Action.ContractId, ApplyActionId: applied.Action.ActionId,
				ExpectedContractVersion: 2, IdempotencyKey: "reverse-cas-key-a"},
			{Uid: 1001, ContractId: created.Action.ContractId, ApplyActionId: applied.Action.ActionId,
				ExpectedContractVersion: 2, IdempotencyKey: "reverse-cas-key-b"},
		}
		results, codes := runConcurrentReversals(environment.service, requests)
		if results != 1 || codes[SERVICE_ERROR_VERSION_CONFLICT] != 1 ||
			countSettlementRows(t, environment.database, new(TransactionAllocation), "uid=? AND contract_id=? AND status=?",
				1001, created.Action.ContractId, ALLOCATION_STATUS_REVERSED) != 1 || environment.gateway.countEvents(t, 1001) != 1 {
			t.Fatalf("reverse CAS did not select one relationship-only winner: results=%d codes=%v", results, codes)
		}
	})
}

func runConcurrentSettlements(service *Service, requests []ApplySettlementRequest) (int, map[ServiceErrorCode]int) {
	start := make(chan struct{})
	type outcome struct {
		result *SettlementResult
		err    error
	}
	outcomes := make(chan outcome, len(requests))
	for _, request := range requests {
		request := request
		go func() {
			<-start
			result, err := service.ApplySettlement(nil, request, time.UTC)
			outcomes <- outcome{result: result, err: err}
		}()
	}
	close(start)
	results := 0
	codes := make(map[ServiceErrorCode]int)
	for range requests {
		outcome := <-outcomes
		if outcome.err == nil && outcome.result != nil {
			results++
		} else {
			codes[ServiceErrorCodeOf(outcome.err)]++
		}
	}
	return results, codes
}

func runConcurrentReversals(service *Service, requests []ReverseSettlementRequest) (int, map[ServiceErrorCode]int) {
	start := make(chan struct{})
	type outcome struct {
		result *SettlementResult
		err    error
	}
	outcomes := make(chan outcome, len(requests))
	for _, request := range requests {
		request := request
		go func() {
			<-start
			result, err := service.ReverseSettlement(nil, request)
			outcomes <- outcome{result: result, err: err}
		}()
	}
	close(start)
	results := 0
	codes := make(map[ServiceErrorCode]int)
	for range requests {
		outcome := <-outcomes
		if outcome.err == nil && outcome.result != nil {
			results++
		} else {
			codes[ServiceErrorCodeOf(outcome.err)]++
		}
	}
	return results, codes
}

func newSettlementTestEnvironment(t *testing.T, maxConnections uint16, firstId int64) *settlementTestEnvironment {
	t.Helper()
	repository, database := newSQLiteServiceRepository(t, maxConnections)
	if err := database.SyncStructs(new(settlementTestLedgerRow)); err != nil {
		t.Fatalf("create settlement test ledger: %v", err)
	}
	accounts := newTestAccountReader()
	accounts.addDefaults(1001)
	accounts.addDefaults(2002)
	gateway := &settlementTestGateway{repository: repository, database: database, accounts: accounts,
		categoryKinds: map[int64]LedgerCategoryKind{31: LEDGER_CATEGORY_KIND_TRANSFER, 41: LEDGER_CATEGORY_KIND_EXPENSE}}
	gateway.nextEventId.Store(80_000_000)
	ids := new(atomic.Int64)
	ids.Store(firstId)
	service, err := NewServiceWithSettlementLedger(repository, gateway, func() int64 { return ids.Add(1) })
	if err != nil {
		t.Fatalf("create full settlement service: %v", err)
	}
	service.now = func() time.Time { return time.Unix(1_900_000_000, 0) }
	return &settlementTestEnvironment{service: service, repository: repository, database: database, gateway: gateway, ids: ids}
}

func settlementTestSpec() ContractSpec {
	spec := serviceTestSpec()
	rate := int64(120_000_000_000)
	spec.Terms.QuotedRatePptr = &rate
	spec.Terms.PerPeriodFeeAmount = 500
	return spec
}

func mustCreateSettlementContract(t *testing.T, service *Service, uid int64, spec ContractSpec, key string) *CommandResult {
	t.Helper()
	result, err := service.CreateContract(nil, CreateContractRequest{Uid: uid, Spec: spec, IdempotencyKey: key})
	if err != nil || result == nil {
		t.Fatalf("create settlement contract: %+v %v", result, err)
	}
	return result
}

func settlementTransferDraft(date string, amount int64, source int64, destination int64) *SettlementLedgerDraft {
	value, _ := time.Parse("2006-01-02", date)
	return &SettlementLedgerDraft{Kind: LEDGER_EVENT_KIND_TRANSFER, TransactionUnixTime: value.Unix(), SourceAccountId: source,
		DestinationAccountId: destination, CategoryId: 31, Amount: amount, Currency: "CNY"}
}

func settlementExpenseDraft(date string, amount int64) *SettlementLedgerDraft {
	value, _ := time.Parse("2006-01-02", date)
	return &SettlementLedgerDraft{Kind: LEDGER_EVENT_KIND_EXPENSE, TransactionUnixTime: value.Unix(), SourceAccountId: 12,
		CategoryId: 41, Amount: amount, Currency: "CNY"}
}

func mustSettlementDateUnix(t *testing.T, date string) int64 {
	t.Helper()
	value, err := time.Parse("2006-01-02", date)
	if err != nil {
		t.Fatalf("parse settlement fixture date: %v", err)
	}
	return value.Unix()
}

func containsServiceCode(values []ServiceErrorCode, expected ServiceErrorCode) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func countSettlementRows(t *testing.T, database *datastore.Database, bean any, query string, args ...any) int64 {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	count, err := sess.Where(query, args...).Count(bean)
	if err != nil {
		t.Fatalf("count settlement rows: %v", err)
	}
	return count
}

func (g *settlementTestGateway) LoadAccountSnapshots(c core.Context, uid int64, accountIds []int64) ([]AccountSnapshot, error) {
	return g.accounts.LoadAccountSnapshots(c, uid, accountIds)
}

func (*settlementTestGateway) ReadLiabilityOutstanding(core.Context, int64, int64) (*int64, error) {
	return nil, nil
}

func (*settlementTestGateway) AuthorizeSettlementCreation(core.Context, int64, *time.Location, []LedgerCreateDraft) error {
	return nil
}

func (g *settlementTestGateway) ListSettlementCandidates(c core.Context, uid int64, filter LedgerCandidateFilter) (*LedgerCandidatePage, error) {
	g.mu.Lock()
	g.lastFilter = filter
	g.mu.Unlock()
	sess := g.database.NewPrivacySession(c)
	defer sess.Close()
	rows := make([]*settlementTestLedgerRow, 0, filter.Limit+1)
	query := sess.Where("uid=? AND deleted=? AND kind=? AND source_account_id=? AND amount>=? AND amount<=? AND transaction_unix_time>=? AND transaction_unix_time<=?",
		uid, false, filter.Kind, filter.SourceAccountId, filter.MinimumAmount, filter.MaximumAmount, filter.MinimumUnixTime, filter.MaximumUnixTime)
	if filter.DestinationAccountId > 0 {
		query = query.And("destination_account_id=?", filter.DestinationAccountId)
	}
	if err := query.Desc("transaction_unix_time", "primary_transaction_id").Limit(filter.Limit + 1).Find(&rows); err != nil {
		return nil, err
	}
	limitReached := len(rows) > filter.Limit
	if limitReached {
		rows = rows[:filter.Limit]
	}
	items := make([]*LedgerEventSnapshot, 0, len(rows))
	for _, row := range rows {
		items = append(items, g.snapshot(row))
	}
	return &LedgerCandidatePage{Items: items, LimitReached: limitReached}, nil
}

func (g *settlementTestGateway) LoadSettlementEvents(c core.Context, uid int64, transactionIds []int64) (map[int64]*LedgerEventSnapshot, error) {
	sess := g.database.NewPrivacySession(c)
	defer sess.Close()
	return g.loadEvents(sess, uid, transactionIds)
}

func (g *settlementTestGateway) LoadSettlementEventsInSession(_ core.Context, database *datastore.Database, sess *xorm.Session, uid int64, transactionIds []int64) (map[int64]*LedgerEventSnapshot, error) {
	if database != g.database || database.ValidateTransactionSession(sess) != nil {
		return nil, errors.New("invalid settlement test transaction")
	}
	return g.loadEvents(sess, uid, transactionIds)
}

func (g *settlementTestGateway) ValidateSettlementDraftInSession(_ core.Context, database *datastore.Database, sess *xorm.Session, draft LedgerCreateDraft) (*LedgerEventSnapshot, error) {
	if database != g.database || database.ValidateTransactionSession(sess) != nil {
		return nil, errors.New("invalid settlement test draft transaction")
	}
	sourceValues, _ := g.accounts.LoadAccountSnapshots(nil, draft.Uid, []int64{draft.SourceAccountId})
	snapshot := &LedgerEventSnapshot{Kind: draft.Kind, CategoryId: draft.CategoryId, CategoryKind: g.categoryKinds[draft.CategoryId],
		Amount: draft.Amount, TransferComplete: draft.Kind == LEDGER_EVENT_KIND_TRANSFER}
	if len(sourceValues) == 1 {
		snapshot.SourceAccount = sourceValues[0]
	}
	if draft.Kind == LEDGER_EVENT_KIND_TRANSFER {
		destinationValues, _ := g.accounts.LoadAccountSnapshots(nil, draft.Uid, []int64{draft.DestinationAccountId})
		if len(destinationValues) == 1 {
			destination := destinationValues[0]
			snapshot.DestinationAccount = &destination
		}
		counterpartId := int64(1)
		counterpartUpdated := int64(1)
		snapshot.CounterpartTransactionId = &counterpartId
		snapshot.CounterpartUpdatedUnixTime = &counterpartUpdated
	}
	return snapshot, nil
}

func (g *settlementTestGateway) CreateSettlementEventInSession(_ core.Context, database *datastore.Database, sess *xorm.Session, draft LedgerCreateDraft) (*LedgerEventSnapshot, error) {
	if database != g.database || database.ValidateTransactionSession(sess) != nil {
		return nil, errors.New("invalid settlement test create transaction")
	}
	primaryId := g.nextEventId.Add(1)
	updated := int64(1_900_000_000 + primaryId%1000)
	row := &settlementTestLedgerRow{Uid: draft.Uid, PrimaryTransactionId: primaryId, Kind: draft.Kind, CategoryId: draft.CategoryId,
		CategoryKind: g.categoryKinds[draft.CategoryId], SourceAccountId: draft.SourceAccountId,
		DestinationAccountId: draft.DestinationAccountId, Amount: draft.Amount, TransactionUnixTime: draft.UnixTime,
		UpdatedUnixTime: updated, TransferComplete: draft.Kind == LEDGER_EVENT_KIND_TRANSFER, RowId: primaryId}
	if draft.Kind == LEDGER_EVENT_KIND_TRANSFER {
		counterpartId := g.nextEventId.Add(1)
		counterpartUpdated := updated
		row.CounterpartTransactionId = &counterpartId
		row.CounterpartUpdatedUnixTime = &counterpartUpdated
	}
	if inserted, err := sess.Insert(row); err != nil || inserted != 1 {
		return nil, errors.New("insert settlement test ledger event")
	}
	call := g.createCalls.Add(1)
	if expected := g.failCreateAt.Load(); expected > 0 && call == expected {
		return nil, errors.New("synthetic settlement ledger failure")
	}
	return g.snapshot(row), nil
}

func (g *settlementTestGateway) insertEvent(t *testing.T, uid int64, component ComponentType, amount int64, unixTime int64, source int64, destination int64) *LedgerEventSnapshot {
	t.Helper()
	kind := LEDGER_EVENT_KIND_EXPENSE
	categoryId := int64(41)
	if component == COMPONENT_TYPE_DISBURSEMENT || component == COMPONENT_TYPE_PRINCIPAL {
		kind = LEDGER_EVENT_KIND_TRANSFER
		categoryId = 31
	}
	primaryId := g.nextEventId.Add(1)
	updated := int64(1_800_000_000 + primaryId%1000)
	row := &settlementTestLedgerRow{Uid: uid, PrimaryTransactionId: primaryId, Kind: kind, CategoryId: categoryId,
		CategoryKind: g.categoryKinds[categoryId], SourceAccountId: source, DestinationAccountId: destination,
		Amount: amount, TransactionUnixTime: unixTime, UpdatedUnixTime: updated, TransferComplete: kind == LEDGER_EVENT_KIND_TRANSFER,
		RowId: primaryId}
	if kind == LEDGER_EVENT_KIND_TRANSFER {
		counterpartId := g.nextEventId.Add(1)
		counterpartUpdated := updated + 1
		row.CounterpartTransactionId = &counterpartId
		row.CounterpartUpdatedUnixTime = &counterpartUpdated
	}
	sess := g.database.NewPrivacySession(nil)
	defer sess.Close()
	if inserted, err := sess.Insert(row); err != nil || inserted != 1 {
		t.Fatalf("insert settlement formal event: inserted=%d err=%v", inserted, err)
	}
	return g.snapshot(row)
}

func (g *settlementTestGateway) updateEvent(t *testing.T, uid int64, primaryTransactionId int64, mutate func(row *settlementTestLedgerRow)) {
	t.Helper()
	sess := g.database.NewPrivacySession(nil)
	defer sess.Close()
	row := new(settlementTestLedgerRow)
	found, err := sess.Where("uid=? AND primary_transaction_id=?", uid, primaryTransactionId).Get(row)
	if err != nil || !found {
		t.Fatalf("load settlement event for mutation: found=%v err=%v", found, err)
	}
	mutate(row)
	updated, err := sess.Where("uid=? AND primary_transaction_id=?", uid, primaryTransactionId).AllCols().Update(row)
	if err != nil || updated != 1 {
		t.Fatalf("mutate settlement event: updated=%d err=%v", updated, err)
	}
}

func (g *settlementTestGateway) countEvents(t *testing.T, uid int64) int64 {
	t.Helper()
	return countSettlementRows(t, g.database, new(settlementTestLedgerRow), "uid=?", uid)
}

func (g *settlementTestGateway) loadEvents(sess *xorm.Session, uid int64, transactionIds []int64) (map[int64]*LedgerEventSnapshot, error) {
	result := make(map[int64]*LedgerEventSnapshot, len(transactionIds))
	for _, transactionId := range transactionIds {
		row := new(settlementTestLedgerRow)
		found, err := sess.Where("uid=? AND (primary_transaction_id=? OR counterpart_transaction_id=?)", uid, transactionId, transactionId).Get(row)
		if err != nil {
			return nil, err
		}
		if found {
			result[transactionId] = g.snapshot(row)
		}
	}
	return result, nil
}

func (g *settlementTestGateway) snapshot(row *settlementTestLedgerRow) *LedgerEventSnapshot {
	if row == nil {
		return nil
	}
	sourceValues, _ := g.accounts.LoadAccountSnapshots(nil, row.Uid, []int64{row.SourceAccountId})
	result := &LedgerEventSnapshot{PrimaryTransactionId: row.PrimaryTransactionId,
		CounterpartTransactionId: cloneInt64(row.CounterpartTransactionId), Kind: row.Kind, CategoryId: row.CategoryId,
		CategoryKind: row.CategoryKind, CategoryDeleted: row.CategoryDeleted, Amount: row.Amount,
		TransactionUnixTime: row.TransactionUnixTime, Deleted: row.Deleted, CounterpartDeleted: row.CounterpartDeleted,
		UpdatedUnixTime: row.UpdatedUnixTime, CounterpartUpdatedUnixTime: cloneInt64(row.CounterpartUpdatedUnixTime),
		TransferComplete: row.TransferComplete}
	if len(sourceValues) == 1 {
		result.SourceAccount = sourceValues[0]
	}
	if row.DestinationAccountId > 0 {
		destinationValues, _ := g.accounts.LoadAccountSnapshots(nil, row.Uid, []int64{row.DestinationAccountId})
		if len(destinationValues) == 1 {
			destination := destinationValues[0]
			result.DestinationAccount = &destination
		}
	}
	return result
}

var _ SettlementLedgerGateway = (*settlementTestGateway)(nil)
