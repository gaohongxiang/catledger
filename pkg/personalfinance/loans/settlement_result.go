package loans

import (
	"sort"

	"github.com/mayswind/ezbookkeeping/pkg/core"
)

func (s *Service) preflightSettlementReplay(c core.Context, uid int64, contractId int64, expectedVersion int64, actionType ActionType,
	keyDigest string, requestDigest string) (*SettlementResult, error) {
	database, err := s.repository.database(uid)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	var persisted *Action
	for attempt := 0; attempt < maximumActionPersistenceAttempts; attempt++ {
		persisted, err = s.repository.FindActionByIdempotencyKeyDigest(c, uid, keyDigest)
		if err == nil {
			break
		}
		if attempt+1 == maximumActionPersistenceAttempts || !isRetryablePersistenceError(database.DatabaseType(), err) {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		if waitErr := waitPersistenceRetry(c, initialActionPersistenceRetryWait<<attempt); waitErr != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
	}
	if persisted == nil {
		return nil, nil
	}
	candidate := newReadyAction(uid, contractId, expectedVersion, actionType, 1, keyDigest, requestDigest, 1)
	if !sameActionRequest(persisted, candidate) {
		return nil, serviceError(ErrServiceIdempotencyConflict, SERVICE_ERROR_IDEMPOTENCY_CONFLICT)
	}
	if persisted.Status != ACTION_STATUS_APPLIED && persisted.Status != ACTION_STATUS_ACTION_REQUIRED && persisted.Status != ACTION_STATUS_FAILED {
		return nil, serviceError(ErrServiceCommandUnavailable, SERVICE_ERROR_COMMAND_UNAVAILABLE)
	}
	if persisted.Status != ACTION_STATUS_APPLIED {
		return nil, errorFromAction(persisted)
	}
	return s.settlementResultFromAction(c, uid, persisted, true)
}

func (s *Service) settlementResultFromAction(c core.Context, uid int64, action *Action, replayed bool) (*SettlementResult, error) {
	if s == nil || s.repository == nil || action == nil || action.Uid != uid ||
		(action.ActionType != ACTION_TYPE_APPLY_SETTLEMENT && action.ActionType != ACTION_TYPE_REVERSE_SETTLEMENT) {
		return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	allocationActionId := action.ActionId
	if action.ActionType == ACTION_TYPE_REVERSE_SETTLEMENT {
		if action.PreviousActionId == nil {
			return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}
		allocationActionId = *action.PreviousActionId
	}
	allocations, limitReached, err := s.repository.ListAllocationsByCreatedAction(c, uid, allocationActionId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if limitReached || (action.Status == ACTION_STATUS_APPLIED && len(allocations) == 0) {
		return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	bindingIds := make([]int64, 0, len(allocations)*2)
	for _, allocation := range allocations {
		if allocation == nil {
			return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}
		bindingIds = append(bindingIds, allocation.PrimaryBindingId)
		if allocation.CounterpartBindingId != nil {
			bindingIds = append(bindingIds, *allocation.CounterpartBindingId)
		}
	}
	bindings, err := s.repository.FindTransactionBindingsByIds(c, uid, bindingIds)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	results := make([]*SettlementAllocationResult, 0, len(allocations))
	resultReasons := make(map[ServiceErrorCode]struct{})
	reversedCount := int64(0)
	for _, allocation := range allocations {
		primary := bindings[allocation.PrimaryBindingId]
		if primary == nil {
			return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}
		result := &SettlementAllocationResult{AllocationId: allocation.AllocationId,
			InstallmentId: cloneInt64(allocation.InstallmentId), ComponentType: allocation.ComponentType,
			AllocatedAmount: allocation.AllocatedAmount, CreationMethod: allocation.CreationMethod, Status: allocation.Status,
			TransactionId: primary.TransactionId, TransactionUpdatedUnixTime: allocation.TransactionUpdatedUnixTime,
			CounterpartUpdatedUnixTime: cloneInt64(allocation.CounterpartUpdatedUnixTime), ReasonCodes: []ServiceErrorCode{},
			CreatedUnixTime: allocation.CreatedUnixTime, UpdatedUnixTime: allocation.UpdatedUnixTime}
		if allocation.CounterpartBindingId != nil {
			counterpart := bindings[*allocation.CounterpartBindingId]
			if counterpart == nil {
				return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
			}
			result.CounterpartTransactionId = &counterpart.TransactionId
		}
		if action.ActionType == ACTION_TYPE_REVERSE_SETTLEMENT && allocation.Status == ALLOCATION_STATUS_REVERSED && allocation.LastActionId == action.ActionId {
			reversedCount++
		}
		results = append(results, result)
	}
	if s.settlementLedger == nil {
		return nil, serviceError(ErrServiceLedgerValidationRequired, SERVICE_ERROR_LEDGER_VALIDATION_REQUIRED)
	}
	contract, err := s.repository.FindContractById(c, uid, action.ContractId)
	if err != nil || contract == nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	primaryIds := make([]int64, 0, len(results))
	for _, result := range results {
		primaryIds = append(primaryIds, result.TransactionId)
	}
	sort.Slice(primaryIds, func(i, j int) bool { return primaryIds[i] < primaryIds[j] })
	primaryIds = uniqueSortedIds(primaryIds)
	events, err := s.settlementLedger.LoadSettlementEvents(c, uid, primaryIds)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	for index, allocation := range allocations {
		if allocation.Status != ALLOCATION_STATUS_ACTIVE {
			continue
		}
		reason := classifyUndoLedgerDrift(contract, allocation, events[results[index].TransactionId])
		primary := bindings[allocation.PrimaryBindingId]
		if primary == nil || primary.CurrentAllocationId == nil || *primary.CurrentAllocationId != allocation.AllocationId {
			reason = SERVICE_ERROR_BINDING_CONFLICT
		}
		if allocation.CounterpartBindingId != nil {
			counterpart := bindings[*allocation.CounterpartBindingId]
			if counterpart == nil || counterpart.CurrentAllocationId == nil || *counterpart.CurrentAllocationId != allocation.AllocationId {
				reason = SERVICE_ERROR_BINDING_CONFLICT
			}
		}
		if reason != "" {
			results[index].ReasonCodes = []ServiceErrorCode{reason}
			resultReasons[reason] = struct{}{}
		}
	}
	actionResult, err := commandAction(action)
	if err != nil {
		return nil, err
	}
	for _, reason := range actionResult.ReasonCodes {
		resultReasons[reason] = struct{}{}
	}
	return &SettlementResult{Action: actionResult, Allocations: results, ReversedAllocationCount: reversedCount,
		Replayed: replayed, ReasonCodes: sortedServiceErrorCodes(resultReasons)}, nil
}
