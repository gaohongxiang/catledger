package loans

import (
	"sort"

	"github.com/gaohongxiang/catledger/pkg/core"
)

type allocationValidationReport struct {
	aggregates   []*AllocationAggregate
	invalidCount int64
	reasonCodes  []ServiceErrorCode
	allocations  []*TransactionAllocation
	bindings     map[int64]*TransactionBinding
}

func (s *Service) validateActiveAllocations(c core.Context, tx *RepositoryTransaction, contract *Contract, revision *ContractRevision, installments []*Installment) (*allocationValidationReport, error) {
	if s == nil || s.repository == nil || contract == nil || revision == nil || contract.Uid < 1 || revision.Uid != contract.Uid ||
		revision.ContractId != contract.ContractId || revision.RevisionId != contract.CurrentRevisionId {
		return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	var allocations []*TransactionAllocation
	var limitReached bool
	var err error
	if tx == nil {
		allocations, limitReached, err = s.repository.ListActiveAllocationsForValidation(c, contract.Uid, contract.ContractId)
	} else {
		allocations, limitReached, err = tx.ListActiveAllocationsForValidation(contract.ContractId)
	}
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	report := &allocationValidationReport{allocations: allocations, bindings: make(map[int64]*TransactionBinding)}
	if limitReached {
		report.invalidCount = int64(len(allocations)) + 1
		report.reasonCodes = []ServiceErrorCode{SERVICE_ERROR_ALLOCATION_LIMIT}
		return report, nil
	}
	if len(allocations) == 0 {
		return report, nil
	}
	if s.settlementLedger == nil {
		return nil, serviceError(ErrServiceLedgerValidationRequired, SERVICE_ERROR_LEDGER_VALIDATION_REQUIRED)
	}

	installmentById := make(map[int64]*Installment, len(installments))
	for _, installment := range installments {
		if installment == nil || installment.Uid != contract.Uid || installment.ContractId != contract.ContractId ||
			installment.RevisionId != revision.RevisionId || installment.InstallmentId < 1 || installmentById[installment.InstallmentId] != nil {
			return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}
		installmentById[installment.InstallmentId] = installment
	}
	for _, allocation := range allocations {
		if allocation == nil || allocation.ComponentType == COMPONENT_TYPE_DISBURSEMENT || allocation.InstallmentId == nil ||
			installmentById[*allocation.InstallmentId] != nil {
			continue
		}
		var installment *Installment
		if tx == nil {
			installment, err = s.repository.FindInstallmentById(c, contract.Uid, *allocation.InstallmentId)
		} else {
			installment, err = tx.FindInstallmentById(*allocation.InstallmentId)
		}
		if err != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		if installment != nil && installment.ContractId == contract.ContractId && installment.RevisionId == revision.RevisionId {
			installmentById[installment.InstallmentId] = installment
		}
	}

	bindingIds := make([]int64, 0, len(allocations)*2)
	bindingSeen := make(map[int64]struct{}, len(allocations)*2)
	for _, allocation := range allocations {
		if allocation == nil || allocation.Uid != contract.Uid || allocation.ContractId != contract.ContractId || allocation.AllocationId < 1 {
			return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}
		for _, bindingId := range []int64{allocation.PrimaryBindingId, valueOrZero(allocation.CounterpartBindingId)} {
			if bindingId < 1 {
				continue
			}
			if _, exists := bindingSeen[bindingId]; !exists {
				bindingSeen[bindingId] = struct{}{}
				bindingIds = append(bindingIds, bindingId)
			}
		}
	}
	sort.Slice(bindingIds, func(i, j int) bool { return bindingIds[i] < bindingIds[j] })
	if tx == nil {
		report.bindings, err = s.repository.FindTransactionBindingsByIds(c, contract.Uid, bindingIds)
	} else {
		report.bindings, err = tx.FindTransactionBindingsByIds(bindingIds)
	}
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}

	transactionIds := make([]int64, 0, len(report.bindings))
	transactionSeen := make(map[int64]struct{}, len(report.bindings))
	for _, binding := range report.bindings {
		if binding == nil || binding.TransactionId < 1 {
			continue
		}
		if _, exists := transactionSeen[binding.TransactionId]; !exists {
			transactionSeen[binding.TransactionId] = struct{}{}
			transactionIds = append(transactionIds, binding.TransactionId)
		}
	}
	sort.Slice(transactionIds, func(i, j int) bool { return transactionIds[i] < transactionIds[j] })
	var events map[int64]*LedgerEventSnapshot
	if tx == nil {
		events, err = s.settlementLedger.LoadSettlementEvents(c, contract.Uid, transactionIds)
	} else {
		database, session, resourceErr := tx.LedgerResources()
		if resourceErr != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		events, err = s.settlementLedger.LoadSettlementEventsInSession(c, database, session, contract.Uid, transactionIds)
	}
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}

	reasons := make(map[ServiceErrorCode]struct{})
	type aggregateKey struct {
		installmentId int64
		component     ComponentType
	}
	aggregated := make(map[aggregateKey]*AllocationAggregate)
	for _, allocation := range allocations {
		reason := validateStoredAllocation(contract, revision, installmentById, allocation, report.bindings, events)
		if reason != "" {
			report.invalidCount++
			reasons[reason] = struct{}{}
			continue
		}
		key := aggregateKey{component: allocation.ComponentType}
		if allocation.InstallmentId != nil {
			key.installmentId = *allocation.InstallmentId
		}
		aggregate := aggregated[key]
		if aggregate == nil {
			var installmentId *int64
			if key.installmentId > 0 {
				installmentId = &key.installmentId
			}
			aggregate = &AllocationAggregate{InstallmentId: installmentId, ComponentType: key.component}
			aggregated[key] = aggregate
		}
		nextAmount, addErr := checkedServiceAdd(aggregate.AllocatedAmount, allocation.AllocatedAmount)
		if addErr != nil {
			return nil, addErr
		}
		planned := storedAllocationPlannedAmount(revision, installmentById, allocation)
		if planned < 0 || nextAmount > planned {
			report.invalidCount++
			reasons[SERVICE_ERROR_AMOUNT_EXCEEDED] = struct{}{}
			if aggregate.AllocationCount == 0 {
				delete(aggregated, key)
			}
			continue
		}
		aggregate.AllocatedAmount = nextAmount
		aggregate.AllocationCount++
	}
	report.reasonCodes = sortedServiceErrorCodes(reasons)
	keys := make([]aggregateKey, 0, len(aggregated))
	for key := range aggregated {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].installmentId != keys[j].installmentId {
			return keys[i].installmentId < keys[j].installmentId
		}
		return keys[i].component < keys[j].component
	})
	for _, key := range keys {
		report.aggregates = append(report.aggregates, aggregated[key])
	}
	return report, nil
}

func validateStoredAllocation(contract *Contract, revision *ContractRevision, installments map[int64]*Installment, allocation *TransactionAllocation,
	bindings map[int64]*TransactionBinding, events map[int64]*LedgerEventSnapshot) ServiceErrorCode {
	if allocation == nil || allocation.Status != ALLOCATION_STATUS_ACTIVE || !isComponentType(allocation.ComponentType) ||
		!isAllocationCreationMethod(allocation.CreationMethod) || allocation.AllocatedAmount <= 0 {
		return SERVICE_ERROR_INVARIANT
	}
	if allocation.ComponentType == COMPONENT_TYPE_DISBURSEMENT {
		if allocation.InstallmentId != nil || revision.FundingType != FUNDING_TYPE_CASH_DISBURSEMENT {
			return SERVICE_ERROR_REVISION_MISMATCH
		}
	} else if allocation.ComponentType == COMPONENT_TYPE_FEE && allocation.InstallmentId == nil {
		if revision.UpfrontFeeAmount <= 0 {
			return SERVICE_ERROR_AMOUNT_EXCEEDED
		}
	} else if allocation.InstallmentId == nil || installments[*allocation.InstallmentId] == nil {
		return SERVICE_ERROR_REVISION_MISMATCH
	}
	primary := bindings[allocation.PrimaryBindingId]
	if primary == nil || primary.Uid != contract.Uid || primary.Version < 1 || primary.CurrentAllocationId == nil ||
		*primary.CurrentAllocationId != allocation.AllocationId {
		return SERVICE_ERROR_BINDING_CONFLICT
	}
	event := events[primary.TransactionId]
	if event == nil {
		return SERVICE_ERROR_LEDGER_EVENT_MISSING
	}
	if event.PrimaryTransactionId != primary.TransactionId {
		return SERVICE_ERROR_BINDING_CONFLICT
	}
	if event.Deleted || event.CounterpartDeleted {
		return SERVICE_ERROR_LEDGER_EVENT_MISSING
	}
	if event.UpdatedUnixTime != allocation.TransactionUpdatedUnixTime {
		return SERVICE_ERROR_LEDGER_EVENT_MODIFIED
	}
	if allocation.ComponentType == COMPONENT_TYPE_DISBURSEMENT || allocation.ComponentType == COMPONENT_TYPE_PRINCIPAL {
		if allocation.CounterpartBindingId == nil || *allocation.CounterpartBindingId == allocation.PrimaryBindingId ||
			allocation.CounterpartUpdatedUnixTime == nil || event.CounterpartTransactionId == nil ||
			*event.CounterpartTransactionId == event.PrimaryTransactionId {
			return SERVICE_ERROR_BINDING_CONFLICT
		}
		counterpart := bindings[valueOrZero(allocation.CounterpartBindingId)]
		if counterpart == nil || counterpart.Uid != contract.Uid || counterpart.Version < 1 ||
			event.CounterpartUpdatedUnixTime == nil || counterpart.CurrentAllocationId == nil ||
			*counterpart.CurrentAllocationId != allocation.AllocationId || counterpart.TransactionId != *event.CounterpartTransactionId {
			return SERVICE_ERROR_BINDING_CONFLICT
		}
		if *event.CounterpartUpdatedUnixTime != *allocation.CounterpartUpdatedUnixTime {
			return SERVICE_ERROR_LEDGER_EVENT_MODIFIED
		}
	} else if allocation.CounterpartBindingId != nil || allocation.CounterpartUpdatedUnixTime != nil || event.CounterpartTransactionId != nil {
		return SERVICE_ERROR_BINDING_CONFLICT
	}
	return validateLedgerEventSemantics(contract, allocation.ComponentType, allocation.AllocatedAmount, 0, 0, event)
}

func storedAllocationPlannedAmount(revision *ContractRevision, installments map[int64]*Installment, allocation *TransactionAllocation) int64 {
	if revision == nil || allocation == nil {
		return -1
	}
	if allocation.ComponentType == COMPONENT_TYPE_DISBURSEMENT {
		return revision.PrincipalAmount
	}
	if allocation.ComponentType == COMPONENT_TYPE_FEE && allocation.InstallmentId == nil {
		return revision.UpfrontFeeAmount
	}
	if allocation.InstallmentId == nil || installments[*allocation.InstallmentId] == nil {
		return -1
	}
	installment := installments[*allocation.InstallmentId]
	switch allocation.ComponentType {
	case COMPONENT_TYPE_PRINCIPAL:
		return installment.PrincipalAmount
	case COMPONENT_TYPE_INTEREST:
		return installment.InterestAmount
	case COMPONENT_TYPE_FEE:
		return installment.FeeAmount
	default:
		return -1
	}
}

func validateLedgerEventSemantics(contract *Contract, component ComponentType, amount int64, assetAccountId int64, categoryId int64, event *LedgerEventSnapshot) ServiceErrorCode {
	if contract == nil || event == nil {
		return SERVICE_ERROR_LEDGER_EVENT_MISSING
	}
	if event.Amount != amount || amount <= 0 {
		return SERVICE_ERROR_LEDGER_EVENT_AMOUNT
	}
	if categoryId > 0 && event.CategoryId != categoryId {
		return SERVICE_ERROR_LEDGER_CATEGORY
	}
	if event.CategoryDeleted || event.CategoryId < 1 {
		return SERVICE_ERROR_LEDGER_CATEGORY
	}
	if event.SourceAccount.Uid != contract.Uid || event.SourceAccount.Deleted || !event.SourceAccount.Single || event.SourceAccount.Hidden {
		return SERVICE_ERROR_LEDGER_EVENT_ACCOUNT
	}
	if event.SourceAccount.Currency != contract.Currency {
		return SERVICE_ERROR_LEDGER_EVENT_CURRENCY
	}

	switch component {
	case COMPONENT_TYPE_DISBURSEMENT:
		if event.Kind != LEDGER_EVENT_KIND_TRANSFER || event.CategoryKind != LEDGER_CATEGORY_KIND_TRANSFER {
			return SERVICE_ERROR_LEDGER_EVENT_TYPE
		}
		if !validTransferSnapshot(event) {
			return SERVICE_ERROR_TRANSFER_INCOMPLETE
		}
		if event.SourceAccount.AccountId != contract.LiabilityAccountId ||
			(event.SourceAccount.Kind != ACCOUNT_KIND_CREDIT_CARD && event.SourceAccount.Kind != ACCOUNT_KIND_DEBT) ||
			event.DestinationAccount == nil || event.DestinationAccount.Kind != ACCOUNT_KIND_ASSET ||
			(assetAccountId > 0 && event.DestinationAccount.AccountId != assetAccountId) {
			return SERVICE_ERROR_LEDGER_EVENT_ACCOUNT
		}
	case COMPONENT_TYPE_PRINCIPAL:
		if event.Kind != LEDGER_EVENT_KIND_TRANSFER || event.CategoryKind != LEDGER_CATEGORY_KIND_TRANSFER {
			return SERVICE_ERROR_LEDGER_EVENT_TYPE
		}
		if !validTransferSnapshot(event) {
			return SERVICE_ERROR_TRANSFER_INCOMPLETE
		}
		if event.SourceAccount.Kind != ACCOUNT_KIND_ASSET || (assetAccountId > 0 && event.SourceAccount.AccountId != assetAccountId) ||
			event.DestinationAccount == nil || event.DestinationAccount.AccountId != contract.LiabilityAccountId ||
			(event.DestinationAccount.Kind != ACCOUNT_KIND_CREDIT_CARD && event.DestinationAccount.Kind != ACCOUNT_KIND_DEBT) {
			return SERVICE_ERROR_LEDGER_EVENT_ACCOUNT
		}
	case COMPONENT_TYPE_INTEREST, COMPONENT_TYPE_FEE:
		if event.Kind != LEDGER_EVENT_KIND_EXPENSE || event.CategoryKind != LEDGER_CATEGORY_KIND_EXPENSE || event.CounterpartTransactionId != nil {
			return SERVICE_ERROR_LEDGER_EVENT_TYPE
		}
		if event.SourceAccount.Kind != ACCOUNT_KIND_ASSET || (assetAccountId > 0 && event.SourceAccount.AccountId != assetAccountId) {
			return SERVICE_ERROR_LEDGER_EVENT_ACCOUNT
		}
	default:
		return SERVICE_ERROR_COMPONENT_MISMATCH
	}
	if event.DestinationAccount != nil {
		if event.DestinationAccount.Uid != contract.Uid || event.DestinationAccount.Deleted || !event.DestinationAccount.Single || event.DestinationAccount.Hidden {
			return SERVICE_ERROR_LEDGER_EVENT_ACCOUNT
		}
		if event.DestinationAccount.Currency != contract.Currency {
			return SERVICE_ERROR_LEDGER_EVENT_CURRENCY
		}
	}
	return ""
}

func validTransferSnapshot(event *LedgerEventSnapshot) bool {
	return event != nil && event.TransferComplete && event.CounterpartTransactionId != nil && *event.CounterpartTransactionId > 0 &&
		event.CounterpartUpdatedUnixTime != nil && *event.CounterpartUpdatedUnixTime > 0 && !event.CounterpartDeleted && event.DestinationAccount != nil
}

func sortedServiceErrorCodes(values map[ServiceErrorCode]struct{}) []ServiceErrorCode {
	result := make([]ServiceErrorCode, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

func valueOrZero(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}
