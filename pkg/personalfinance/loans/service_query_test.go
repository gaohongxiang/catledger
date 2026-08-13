package loans

import (
	"testing"
	"time"
)

func TestContractDetailLatestSettlementActionTracksActiveAllocationOrder(t *testing.T) {
	environment := newSettlementTestEnvironment(t, 1, 81_000_000)
	created := mustCreateSettlementContract(t, environment.service, 1001, settlementTestSpec(), "latest-action-contract")
	installment := created.Installments[0]
	detail, err := environment.service.GetContract(nil, 1001, created.Action.ContractId, installment.DueDate)
	if err != nil || detail == nil || detail.LatestSettlementActionId != nil {
		t.Fatalf("empty contract exposed a settlement action: detail=%+v error=%v", detail, err)
	}

	environment.service.now = func() time.Time { return time.Unix(1_910_000_000, 0) }
	amount := installment.PrincipalAmount / 4
	first, err := environment.service.ApplySettlement(nil, ApplySettlementRequest{Uid: 1001, ContractId: created.Action.ContractId,
		ExpectedContractVersion: 1, InstallmentId: &installment.InstallmentId, IdempotencyKey: "latest-action-first",
		Components: []SettlementComponentCommand{{ComponentType: COMPONENT_TYPE_PRINCIPAL, AllocatedAmount: amount,
			Draft: settlementTransferDraft(installment.DueDate, amount, 12, 11)}}}, time.UTC)
	if err != nil || first == nil {
		t.Fatalf("create first settlement: result=%+v error=%v", first, err)
	}
	second, err := environment.service.ApplySettlement(nil, ApplySettlementRequest{Uid: 1001, ContractId: created.Action.ContractId,
		ExpectedContractVersion: 2, InstallmentId: &installment.InstallmentId, IdempotencyKey: "latest-action-second",
		Components: []SettlementComponentCommand{{ComponentType: COMPONENT_TYPE_PRINCIPAL, AllocatedAmount: amount,
			Draft: settlementTransferDraft(installment.DueDate, amount, 12, 11)}}}, time.UTC)
	if err != nil || second == nil || second.Allocations[0].CreatedUnixTime != first.Allocations[0].CreatedUnixTime ||
		second.Allocations[0].AllocationId <= first.Allocations[0].AllocationId {
		t.Fatalf("create tied settlement fixtures: first=%+v second=%+v error=%v", first, second, err)
	}
	detail, err = environment.service.GetContract(nil, 1001, created.Action.ContractId, installment.DueDate)
	if err != nil || detail.LatestSettlementActionId == nil || *detail.LatestSettlementActionId != second.Action.ActionId {
		t.Fatalf("latest action did not use created-time/allocation-id order: detail=%+v error=%v", detail, err)
	}

	if _, err = environment.service.ReverseSettlement(nil, ReverseSettlementRequest{Uid: 1001, ContractId: created.Action.ContractId,
		ApplyActionId: second.Action.ActionId, ExpectedContractVersion: 3, IdempotencyKey: "latest-action-undo-second"}); err != nil {
		t.Fatalf("reverse newest settlement: %v", err)
	}
	detail, err = environment.service.GetContract(nil, 1001, created.Action.ContractId, installment.DueDate)
	if err != nil || detail.LatestSettlementActionId == nil || *detail.LatestSettlementActionId != first.Action.ActionId {
		t.Fatalf("latest action did not fall back to remaining active allocation: detail=%+v error=%v", detail, err)
	}

	if _, err = environment.service.ReverseSettlement(nil, ReverseSettlementRequest{Uid: 1001, ContractId: created.Action.ContractId,
		ApplyActionId: first.Action.ActionId, ExpectedContractVersion: 4, IdempotencyKey: "latest-action-undo-first"}); err != nil {
		t.Fatalf("reverse remaining settlement: %v", err)
	}
	detail, err = environment.service.GetContract(nil, 1001, created.Action.ContractId, installment.DueDate)
	if err != nil || detail.LatestSettlementActionId != nil {
		t.Fatalf("reversed allocations left a latest action: detail=%+v error=%v", detail, err)
	}
}

func TestContractDetailLatestSettlementActionScansBeyondValidationLimit(t *testing.T) {
	environment := newSettlementTestEnvironment(t, 1, 82_000_000)
	created := mustCreateSettlementContract(t, environment.service, 1001, settlementTestSpec(), "latest-action-limit-contract")
	installmentId := created.Installments[0].InstallmentId
	const latestActionId int64 = 99_999_999
	rows := make([]*TransactionAllocation, 0, maximumValidatedAllocations+1)
	for index := 0; index <= maximumValidatedAllocations; index++ {
		allocationId := int64(100_000 + index)
		createdUnixTime := int64(1_920_000_000)
		createdActionId := int64(200_000 + index)
		if index == maximumValidatedAllocations {
			createdUnixTime++
			createdActionId = latestActionId
		}
		rows = append(rows, &TransactionAllocation{Uid: 1001, ContractId: created.Action.ContractId, InstallmentId: &installmentId,
			PrimaryBindingId: int64(300_000 + index), ComponentType: COMPONENT_TYPE_PRINCIPAL, AllocatedAmount: 1,
			CreationMethod: ALLOCATION_CREATION_METHOD_ATTACHED_EXISTING, Status: ALLOCATION_STATUS_ACTIVE,
			TransactionUpdatedUnixTime: 1, CreatedActionId: createdActionId, LastActionId: createdActionId,
			CreatedUnixTime: createdUnixTime, UpdatedUnixTime: int64(500_000 - index), AllocationId: allocationId})
	}
	sess := environment.database.NewPrivacySession(nil)
	defer sess.Close()
	for start := 0; start < len(rows); start += 100 {
		end := start + 100
		if end > len(rows) {
			end = len(rows)
		}
		batch := rows[start:end]
		inserted, err := sess.Insert(&batch)
		if err != nil || inserted != int64(len(batch)) {
			t.Fatalf("insert active allocation limit fixture at %d: inserted=%d error=%v", start, inserted, err)
		}
	}

	detail, err := environment.service.GetContract(nil, 1001, created.Action.ContractId, created.Installments[0].DueDate)
	if err != nil || detail == nil || !detail.ActionRequired || detail.InvalidAllocationCount != maximumValidatedAllocations+1 ||
		detail.LatestSettlementActionId == nil || *detail.LatestSettlementActionId != latestActionId ||
		!containsServiceCode(detail.ReasonCodes, SERVICE_ERROR_ALLOCATION_LIMIT) {
		t.Fatalf("latest action beyond validation limit was lost: detail=%+v error=%v", detail, err)
	}
}
