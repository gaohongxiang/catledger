package loans

import (
	"sort"

	"github.com/gaohongxiang/catledger/pkg/core"
)

// GetSettlementUndoImpact 以原 apply action 为单位返回聚合影响；正式交易漂移只报告，关系撤销不会删除交易。
func (s *Service) GetSettlementUndoImpact(c core.Context, request SettlementUndoImpactRequest) (*SettlementUndoImpact, error) {
	if s == nil || s.repository == nil || s.settlementLedger == nil || request.Uid < 1 || request.ContractId < 1 || request.ApplyActionId < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	impact := &SettlementUndoImpact{ContractId: request.ContractId, ApplyActionId: request.ApplyActionId, ReasonCodes: []ServiceErrorCode{}}
	action, err := s.repository.FindActionById(c, request.Uid, request.ApplyActionId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if action == nil || action.ContractId != request.ContractId || action.ActionType != ACTION_TYPE_APPLY_SETTLEMENT || action.Status != ACTION_STATUS_APPLIED {
		impact.ReasonCodes = []ServiceErrorCode{SERVICE_ERROR_SETTLEMENT_NOT_FOUND}
		return impact, nil
	}
	contract, err := s.repository.FindContractById(c, request.Uid, request.ContractId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if contract == nil {
		impact.ReasonCodes = []ServiceErrorCode{SERVICE_ERROR_SETTLEMENT_NOT_FOUND}
		return impact, nil
	}
	allocations, limitReached, err := s.repository.ListAllocationsByCreatedAction(c, request.Uid, request.ApplyActionId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if limitReached {
		impact.ReasonCodes = []ServiceErrorCode{SERVICE_ERROR_ALLOCATION_LIMIT}
		return impact, nil
	}
	if len(allocations) == 0 {
		impact.ReasonCodes = []ServiceErrorCode{SERVICE_ERROR_SETTLEMENT_NOT_FOUND}
		return impact, nil
	}

	bindingIds := make([]int64, 0, len(allocations)*2)
	bindingSeen := make(map[int64]struct{}, len(allocations)*2)
	for _, allocation := range allocations {
		if allocation == nil || allocation.ContractId != request.ContractId {
			return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}
		for _, bindingId := range []int64{allocation.PrimaryBindingId, valueOrZero(allocation.CounterpartBindingId)} {
			if bindingId > 0 {
				if _, exists := bindingSeen[bindingId]; !exists {
					bindingSeen[bindingId] = struct{}{}
					bindingIds = append(bindingIds, bindingId)
				}
			}
		}
	}
	sort.Slice(bindingIds, func(i, j int) bool { return bindingIds[i] < bindingIds[j] })
	bindings, err := s.repository.FindTransactionBindingsByIds(c, request.Uid, bindingIds)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	reasons := make(map[ServiceErrorCode]struct{})
	transactionSeen := make(map[int64]struct{}, len(bindings))
	primaryIds := make([]int64, 0, len(allocations))
	canUndo := true
	for _, allocation := range allocations {
		if allocation.Status == ALLOCATION_STATUS_ACTIVE {
			impact.ActiveAllocationCount++
		} else {
			canUndo = false
			reasons[SERVICE_ERROR_SETTLEMENT_ALREADY_REVERSED] = struct{}{}
		}
		rowCount := int64(1)
		if allocation.CounterpartBindingId != nil {
			rowCount = 2
		}
		impact.RelationshipCount += rowCount
		if allocation.CreationMethod == ALLOCATION_CREATION_METHOD_LOAN_CREATED {
			impact.LoanCreatedTransactionCount += rowCount
		}
		primary := bindings[allocation.PrimaryBindingId]
		if primary == nil {
			canUndo = false
			reasons[SERVICE_ERROR_BINDING_CONFLICT] = struct{}{}
			continue
		}
		primaryIds = append(primaryIds, primary.TransactionId)
		for _, bindingId := range []int64{allocation.PrimaryBindingId, valueOrZero(allocation.CounterpartBindingId)} {
			if bindingId < 1 {
				continue
			}
			binding := bindings[bindingId]
			if binding == nil {
				canUndo = false
				reasons[SERVICE_ERROR_BINDING_CONFLICT] = struct{}{}
				continue
			}
			transactionSeen[binding.TransactionId] = struct{}{}
			if allocation.Status == ALLOCATION_STATUS_ACTIVE &&
				(binding.CurrentAllocationId == nil || *binding.CurrentAllocationId != allocation.AllocationId) {
				canUndo = false
				reasons[SERVICE_ERROR_BINDING_CONFLICT] = struct{}{}
			}
		}
	}
	impact.AffectedTransactionCount = int64(len(transactionSeen))
	sort.Slice(primaryIds, func(i, j int) bool { return primaryIds[i] < primaryIds[j] })
	primaryIds = uniqueSortedIds(primaryIds)
	events, err := s.settlementLedger.LoadSettlementEvents(c, request.Uid, primaryIds)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	for _, allocation := range allocations {
		primary := bindings[allocation.PrimaryBindingId]
		if primary == nil {
			continue
		}
		event := events[primary.TransactionId]
		classification := classifyUndoLedgerDrift(contract, allocation, event)
		switch classification {
		case SERVICE_ERROR_LEDGER_EVENT_MISSING:
			impact.MissingTransactionCount++
			reasons[classification] = struct{}{}
		case SERVICE_ERROR_TRANSFER_INCOMPLETE:
			impact.IncompleteTransferPairCount++
			reasons[classification] = struct{}{}
		case SERVICE_ERROR_LEDGER_EVENT_MODIFIED:
			impact.ModifiedTransactionCount++
			reasons[classification] = struct{}{}
		}
	}
	impact.CanUndoRelationships = canUndo && impact.ActiveAllocationCount == int64(len(allocations))
	impact.ReasonCodes = sortedServiceErrorCodes(reasons)
	return impact, nil
}

// ReverseSettlement 只释放原 apply action 的全部活动关系并保留账本与 allocation 历史。
func (s *Service) ReverseSettlement(c core.Context, request ReverseSettlementRequest) (*SettlementResult, error) {
	if s == nil || s.repository == nil || s.generateId == nil || s.now == nil || request.Uid < 1 || request.ContractId < 1 ||
		request.ApplyActionId < 1 || request.ExpectedContractVersion < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if s.settlementLedger == nil {
		return nil, serviceError(ErrServiceLedgerValidationRequired, SERVICE_ERROR_LEDGER_VALIDATION_REQUIRED)
	}
	if err := validateIdempotencyKey(request.IdempotencyKey); err != nil {
		return nil, err
	}
	keyDigest := idempotencyKeyDigest(request.IdempotencyKey)
	requestDigest := reverseSettlementRequestDigest(request)
	if replay, replayErr := s.preflightSettlementReplay(c, request.Uid, request.ContractId, request.ExpectedContractVersion,
		ACTION_TYPE_REVERSE_SETTLEMENT, keyDigest, requestDigest); replay != nil || replayErr != nil {
		return replay, replayErr
	}
	now := s.now().Unix()
	actionId := s.generateId()
	if now < 1 || actionId < 1 {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	candidate := newReadyAction(request.Uid, request.ContractId, request.ExpectedContractVersion,
		ACTION_TYPE_REVERSE_SETTLEMENT, actionId, keyDigest, requestDigest, now)
	candidate.PreviousActionId = &request.ApplyActionId
	var persisted *Action
	var replayed bool
	var adjudicated error

	err := s.doWriteTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
		started, created, startErr := startAction(tx, candidate, now)
		if startErr != nil {
			return startErr
		}
		persisted = started
		if !created {
			replayed = true
			return nil
		}
		contract, findErr := tx.FindContractById(request.ContractId)
		if findErr != nil {
			return findErr
		}
		if contract == nil {
			persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, SERVICE_ERROR_CONTRACT_NOT_FOUND,
				[]ServiceErrorCode{SERVICE_ERROR_CONTRACT_NOT_FOUND}, now)
			return startErr
		}
		if contract.Version != request.ExpectedContractVersion {
			persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, SERVICE_ERROR_VERSION_CONFLICT,
				[]ServiceErrorCode{SERVICE_ERROR_VERSION_CONFLICT}, now)
			return startErr
		}
		if contract.Status != CONTRACT_STATUS_ACTIVE {
			persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, SERVICE_ERROR_STATE_CONFLICT,
				[]ServiceErrorCode{SERVICE_ERROR_STATE_CONFLICT}, now)
			return startErr
		}
		applyAction, findErr := tx.FindActionById(request.ApplyActionId)
		if findErr != nil {
			return findErr
		}
		if applyAction == nil || applyAction.ContractId != request.ContractId || applyAction.ActionType != ACTION_TYPE_APPLY_SETTLEMENT ||
			applyAction.Status != ACTION_STATUS_APPLIED {
			persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, SERVICE_ERROR_SETTLEMENT_NOT_FOUND,
				[]ServiceErrorCode{SERVICE_ERROR_SETTLEMENT_NOT_FOUND}, now)
			return startErr
		}
		allocations, limitReached, listErr := tx.ListAllocationsByCreatedAction(request.ApplyActionId)
		if listErr != nil {
			return listErr
		}
		if limitReached {
			persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, SERVICE_ERROR_ALLOCATION_LIMIT,
				[]ServiceErrorCode{SERVICE_ERROR_ALLOCATION_LIMIT}, now)
			return startErr
		}
		if len(allocations) == 0 {
			persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, SERVICE_ERROR_SETTLEMENT_NOT_FOUND,
				[]ServiceErrorCode{SERVICE_ERROR_SETTLEMENT_NOT_FOUND}, now)
			return startErr
		}
		bindingIds := make([]int64, 0, len(allocations)*2)
		for _, allocation := range allocations {
			if allocation == nil || allocation.ContractId != request.ContractId {
				return serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
			}
			if allocation.Status != ALLOCATION_STATUS_ACTIVE {
				persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, SERVICE_ERROR_SETTLEMENT_ALREADY_REVERSED,
					[]ServiceErrorCode{SERVICE_ERROR_SETTLEMENT_ALREADY_REVERSED}, now)
				return startErr
			}
			bindingIds = append(bindingIds, allocation.PrimaryBindingId)
			if allocation.CounterpartBindingId != nil {
				bindingIds = append(bindingIds, *allocation.CounterpartBindingId)
			}
		}
		sort.Slice(bindingIds, func(i, j int) bool { return bindingIds[i] < bindingIds[j] })
		bindings, findErr := tx.FindTransactionBindingsByIds(bindingIds)
		if findErr != nil {
			return findErr
		}
		for _, allocation := range allocations {
			for _, bindingId := range []int64{allocation.PrimaryBindingId, valueOrZero(allocation.CounterpartBindingId)} {
				if bindingId < 1 {
					continue
				}
				binding := bindings[bindingId]
				if binding == nil || binding.CurrentAllocationId == nil || *binding.CurrentAllocationId != allocation.AllocationId {
					persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, SERVICE_ERROR_BINDING_CONFLICT,
						[]ServiceErrorCode{SERVICE_ERROR_BINDING_CONFLICT}, now)
					return startErr
				}
			}
		}

		nextContract := *contract
		nextContract.Version = contract.Version + 1
		nextContract.UpdatedUnixTime = now
		updated, updateErr := tx.UpdateContractCAS(contract.Version, &nextContract)
		if updateErr != nil {
			return updateErr
		}
		if !updated {
			persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, SERVICE_ERROR_VERSION_CONFLICT,
				[]ServiceErrorCode{SERVICE_ERROR_VERSION_CONFLICT}, now)
			return startErr
		}
		for _, bindingId := range bindingIds {
			binding := bindings[bindingId]
			released, releaseErr := tx.UpdateTransactionBindingCAS(binding.BindingId, binding.Version, binding.CurrentAllocationId, nil, now)
			if releaseErr != nil {
				return releaseErr
			}
			if !released {
				return serviceError(ErrServiceSettlementRejected, SERVICE_ERROR_BINDING_CONFLICT)
			}
		}
		sort.Slice(allocations, func(i, j int) bool { return allocations[i].AllocationId < allocations[j].AllocationId })
		for _, allocation := range allocations {
			reversed, reverseErr := tx.UpdateAllocationStatus(allocation.AllocationId, ALLOCATION_STATUS_ACTIVE,
				ALLOCATION_STATUS_REVERSED, started.ActionId, now)
			if reverseErr != nil {
				return reverseErr
			}
			if !reversed {
				return serviceError(ErrServiceSettlementRejected, SERVICE_ERROR_SETTLEMENT_ALREADY_REVERSED)
			}
		}
		persisted, startErr = completeAction(tx, started, ACTION_STATUS_APPLIED, nextContract.Version, "", nil, now)
		return startErr
	})
	if err != nil {
		if ServiceErrorCodeOf(err) == SERVICE_ERROR_BINDING_CONFLICT {
			if persistedAction, persistErr := s.persistSettlementActionRequired(c, candidate, SERVICE_ERROR_BINDING_CONFLICT, now); persistErr == nil {
				persisted = persistedAction
				if persistedAction != nil && persistedAction.Status == ACTION_STATUS_APPLIED {
					return s.settlementResultFromAction(c, request.Uid, persistedAction, true)
				}
				return nil, settlementError(SERVICE_ERROR_BINDING_CONFLICT)
			}
		}
		return nil, mapWriteError(err)
	}
	if adjudicated != nil {
		return nil, adjudicated
	}
	if persisted == nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if replayed && persisted.Status != ACTION_STATUS_APPLIED {
		return nil, errorFromAction(persisted)
	}
	return s.settlementResultFromAction(c, request.Uid, persisted, replayed)
}

func classifyUndoLedgerDrift(contract *Contract, allocation *TransactionAllocation, event *LedgerEventSnapshot) ServiceErrorCode {
	if allocation == nil || event == nil || event.Deleted {
		return SERVICE_ERROR_LEDGER_EVENT_MISSING
	}
	if allocation.ComponentType == COMPONENT_TYPE_DISBURSEMENT || allocation.ComponentType == COMPONENT_TYPE_PRINCIPAL {
		if !validTransferSnapshot(event) || event.CounterpartDeleted {
			return SERVICE_ERROR_TRANSFER_INCOMPLETE
		}
	}
	if event.UpdatedUnixTime != allocation.TransactionUpdatedUnixTime ||
		!equalOptionalInt64(event.CounterpartUpdatedUnixTime, allocation.CounterpartUpdatedUnixTime) ||
		validateLedgerEventSemantics(contract, allocation.ComponentType, allocation.AllocatedAmount, 0, 0, event) != "" {
		return SERVICE_ERROR_LEDGER_EVENT_MODIFIED
	}
	return ""
}

func equalOptionalInt64(left *int64, right *int64) bool {
	return (left == nil && right == nil) || (left != nil && right != nil && *left == *right)
}

func uniqueSortedIds(values []int64) []int64 {
	if len(values) < 2 {
		return values
	}
	result := values[:1]
	for _, value := range values[1:] {
		if value != result[len(result)-1] {
			result = append(result, value)
		}
	}
	return result
}
