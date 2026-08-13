package loans

import (
	"errors"
	"sort"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
)

// ApplySettlement 原子建立正式账本事件与贷款关系。账本、binding、allocation、action 和 contract CAS
// 共用仓储持有的最外层 privacy transaction；本流程不使用跨库语义不一致的保存点。
func (s *Service) ApplySettlement(c core.Context, request ApplySettlementRequest, clientTimezone *time.Location) (*SettlementResult, error) {
	if s == nil || s.repository == nil || s.settlementLedger == nil || s.generateId == nil || s.now == nil {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	normalized, authorizationDrafts, err := normalizeApplySettlementRequest(request)
	if err != nil {
		return nil, err
	}
	keyDigest := idempotencyKeyDigest(normalized.IdempotencyKey)
	requestDigest := applySettlementRequestDigest(normalized)
	if replay, replayErr := s.preflightSettlementReplay(c, normalized.Uid, normalized.ContractId,
		normalized.ExpectedContractVersion, ACTION_TYPE_APPLY_SETTLEMENT, keyDigest, requestDigest); replay != nil || replayErr != nil {
		return replay, replayErr
	}
	if len(authorizationDrafts) > 0 {
		if clientTimezone == nil {
			return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		for index := range authorizationDrafts {
			authorizationDrafts[index].Uid = normalized.Uid
			authorizationDrafts[index].CreatedIp = normalized.CreatedIp
		}
		if err = s.settlementLedger.AuthorizeSettlementCreation(c, normalized.Uid, clientTimezone, authorizationDrafts); err != nil {
			return nil, serviceError(ErrServiceSettlementRejected, SERVICE_ERROR_LEDGER_EVENT_ACCOUNT)
		}
	}

	now := s.now().Unix()
	actionId := s.generateId()
	allocationIds := s.generateIds(len(normalized.Components))
	bindingCandidateIds := s.generateIds(len(normalized.Components) * 2)
	if now < 1 || actionId < 1 || allocationIds == nil || bindingCandidateIds == nil ||
		!validPositiveUniqueIds(allocationIds) || !validPositiveUniqueIds(bindingCandidateIds) {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	candidate := newReadyAction(normalized.Uid, normalized.ContractId, normalized.ExpectedContractVersion,
		ACTION_TYPE_APPLY_SETTLEMENT, actionId, keyDigest, requestDigest, now)
	var persisted *Action
	var replayed bool
	var adjudicated error

	err = s.doWriteTransaction(c, normalized.Uid, func(tx *RepositoryTransaction) error {
		started, created, startErr := startAction(tx, candidate, now)
		if startErr != nil {
			return startErr
		}
		persisted = started
		if !created {
			replayed = true
			return nil
		}

		contractSnapshot, findErr := tx.FindContractById(normalized.ContractId)
		if findErr != nil {
			return findErr
		}
		if contractSnapshot == nil {
			persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, SERVICE_ERROR_CONTRACT_NOT_FOUND,
				[]ServiceErrorCode{SERVICE_ERROR_CONTRACT_NOT_FOUND}, now)
			return startErr
		}
		if contractSnapshot.Version != normalized.ExpectedContractVersion {
			persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, SERVICE_ERROR_VERSION_CONFLICT,
				[]ServiceErrorCode{SERVICE_ERROR_VERSION_CONFLICT}, now)
			return startErr
		}
		if contractSnapshot.Status != CONTRACT_STATUS_ACTIVE {
			persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, SERVICE_ERROR_STATE_CONFLICT,
				[]ServiceErrorCode{SERVICE_ERROR_STATE_CONFLICT}, now)
			return startErr
		}
		selection, selectionErr := s.loadSettlementPlan(c, tx, normalized.Uid, normalized.ContractId,
			normalized.InstallmentId, normalized.Components[0].ComponentType)
		if selectionErr != nil {
			if code, stable := stableSettlementAdjudicationCode(selectionErr); stable {
				persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, code, []ServiceErrorCode{code}, now)
				return startErr
			}
			return selectionErr
		}
		contract := selection.contract
		if contract.Version != contractSnapshot.Version || contract.Status != contractSnapshot.Status {
			return serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}
		if selection.validation.invalidCount > 0 {
			reasons := append([]ServiceErrorCode(nil), selection.validation.reasonCodes...)
			code := reasons[0]
			persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, code, reasons, now)
			return startErr
		}

		for _, component := range normalized.Components {
			planned, allocated, amountErr := settlementComponentAmounts(selection, normalized.InstallmentId, component.ComponentType)
			if amountErr != nil {
				code := ServiceErrorCodeOf(amountErr)
				persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, code, []ServiceErrorCode{code}, now)
				return startErr
			}
			if component.AllocatedAmount > planned-allocated {
				persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, SERVICE_ERROR_AMOUNT_EXCEEDED,
					[]ServiceErrorCode{SERVICE_ERROR_AMOUNT_EXCEEDED}, now)
				return startErr
			}
		}

		database, session, resourceErr := tx.LedgerResources()
		if resourceErr != nil {
			return resourceErr
		}
		existingIds := make([]int64, 0, len(normalized.Components))
		for _, component := range normalized.Components {
			if component.Existing != nil {
				existingIds = append(existingIds, component.Existing.ExistingTransactionId)
			}
		}
		sort.Slice(existingIds, func(i, j int) bool { return existingIds[i] < existingIds[j] })
		existingEvents := make(map[int64]*LedgerEventSnapshot)
		if len(existingIds) > 0 {
			existingEvents, startErr = s.settlementLedger.LoadSettlementEventsInSession(c, database, session, normalized.Uid, existingIds)
			if startErr != nil {
				return startErr
			}
		}

		formalIds := make([]int64, 0, len(existingIds)*2)
		formalSeen := make(map[int64]struct{}, len(existingIds)*2)
		for _, component := range normalized.Components {
			if component.Existing != nil {
				event := existingEvents[component.Existing.ExistingTransactionId]
				reason := validateExistingSettlementReference(contract, component, event)
				if reason == "" {
					reason = appendUniqueFormalEventIds(formalSeen, &formalIds, event)
				}
				if reason != "" {
					persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, reason, []ServiceErrorCode{reason}, now)
					return startErr
				}
				continue
			}
			draft := ledgerCreateDraft(normalized.Uid, normalized.CreatedIp, *component.Draft)
			if component.Draft.Currency != contract.Currency {
				persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, SERVICE_ERROR_LEDGER_EVENT_CURRENCY,
					[]ServiceErrorCode{SERVICE_ERROR_LEDGER_EVENT_CURRENCY}, now)
				return startErr
			}
			snapshot, validateErr := s.settlementLedger.ValidateSettlementDraftInSession(c, database, session, draft)
			if validateErr != nil {
				return validateErr
			}
			reason := validateLedgerEventSemantics(contract, component.ComponentType, component.AllocatedAmount,
				settlementAssetAccountId(component.ComponentType, component.Draft), component.Draft.CategoryId, snapshot)
			if reason != "" {
				persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, reason, []ServiceErrorCode{reason}, now)
				return startErr
			}
		}
		if len(formalIds) > 0 {
			sort.Slice(formalIds, func(i, j int) bool { return formalIds[i] < formalIds[j] })
			bindings, bindingErr := tx.FindTransactionBindingsByTransactionIds(formalIds)
			if bindingErr != nil {
				return bindingErr
			}
			for _, transactionId := range formalIds {
				if binding := bindings[transactionId]; binding != nil && binding.CurrentAllocationId != nil {
					persisted, adjudicated, startErr = completeSettlementAdjudication(tx, started, SERVICE_ERROR_BINDING_CONFLICT,
						[]ServiceErrorCode{SERVICE_ERROR_BINDING_CONFLICT}, now)
					return startErr
				}
			}
		}

		// 所有可稳定裁决的校验至此完成。CAS 之后任何失败都返回错误，让最外层事务整体回滚。
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

		for index, component := range normalized.Components {
			event := existingEvents[valueOrZeroExisting(component.Existing)]
			creationMethod := ALLOCATION_CREATION_METHOD_ATTACHED_EXISTING
			if component.Draft != nil {
				creationMethod = ALLOCATION_CREATION_METHOD_LOAN_CREATED
				event, startErr = s.settlementLedger.CreateSettlementEventInSession(c, database, session,
					ledgerCreateDraft(normalized.Uid, normalized.CreatedIp, *component.Draft))
				if startErr != nil {
					return startErr
				}
				reason := validateCreatedSettlementEvent(contract, component, event)
				if reason != "" {
					return serviceError(ErrServiceLedgerEventRejected, reason)
				}
			}
			bindingRows, bindingErr := createSettlementBindings(tx, normalized.Uid, event,
				bindingCandidateIds[index*2:index*2+2], now)
			if bindingErr != nil {
				return bindingErr
			}
			allocation := &TransactionAllocation{Uid: normalized.Uid, ContractId: normalized.ContractId,
				InstallmentId: cloneInt64(normalized.InstallmentId), PrimaryBindingId: bindingRows[0].BindingId,
				ComponentType: component.ComponentType, AllocatedAmount: component.AllocatedAmount, CreationMethod: creationMethod,
				Status: ALLOCATION_STATUS_ACTIVE, TransactionUpdatedUnixTime: event.UpdatedUnixTime,
				CreatedActionId: started.ActionId, LastActionId: started.ActionId, CreatedUnixTime: now, UpdatedUnixTime: now,
				AllocationId: allocationIds[index]}
			if event.CounterpartTransactionId != nil {
				allocation.CounterpartBindingId = &bindingRows[1].BindingId
				allocation.CounterpartUpdatedUnixTime = cloneInt64(event.CounterpartUpdatedUnixTime)
			}
			if insertErr := tx.InsertAllocation(allocation); insertErr != nil {
				return insertErr
			}
			sort.Slice(bindingRows, func(i, j int) bool { return bindingRows[i].BindingId < bindingRows[j].BindingId })
			for _, binding := range bindingRows {
				assigned, assignErr := tx.UpdateTransactionBindingCAS(binding.BindingId, binding.Version, nil, &allocation.AllocationId, now)
				if assignErr != nil {
					return assignErr
				}
				if !assigned {
					return serviceError(ErrServiceSettlementRejected, SERVICE_ERROR_BINDING_CONFLICT)
				}
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
					return s.settlementResultFromAction(c, normalized.Uid, persistedAction, true)
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
	return s.settlementResultFromAction(c, normalized.Uid, persisted, replayed)
}

func normalizeApplySettlementRequest(request ApplySettlementRequest) (ApplySettlementRequest, []LedgerCreateDraft, error) {
	if request.Uid < 1 || request.ContractId < 1 || request.ExpectedContractVersion < 1 || !isNilOrPositive(request.InstallmentId) ||
		len(request.Components) < 1 || len(request.Components) > maximumSettlementComponents {
		return ApplySettlementRequest{}, nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if err := validateIdempotencyKey(request.IdempotencyKey); err != nil {
		return ApplySettlementRequest{}, nil, err
	}
	request.InstallmentId = cloneInt64(request.InstallmentId)
	request.Components = canonicalSettlementComponents(request.Components)
	seenComponents := make(map[ComponentType]struct{}, len(request.Components))
	seenExisting := make(map[int64]struct{}, len(request.Components))
	drafts := make([]LedgerCreateDraft, 0, len(request.Components))
	for _, component := range request.Components {
		if !isComponentType(component.ComponentType) || component.AllocatedAmount <= 0 ||
			(component.Existing == nil) == (component.Draft == nil) {
			return ApplySettlementRequest{}, nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		if _, exists := seenComponents[component.ComponentType]; exists {
			return ApplySettlementRequest{}, nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_COMPONENT_MISMATCH)
		}
		seenComponents[component.ComponentType] = struct{}{}
		isTransfer := component.ComponentType == COMPONENT_TYPE_DISBURSEMENT || component.ComponentType == COMPONENT_TYPE_PRINCIPAL
		if component.Existing != nil {
			if component.Existing.ExistingTransactionId < 1 || component.Existing.ExpectedUpdatedUnixTime < 1 ||
				(isTransfer && (component.Existing.ExpectedCounterpartUpdatedUnixTime == nil || *component.Existing.ExpectedCounterpartUpdatedUnixTime < 1)) ||
				(!isTransfer && component.Existing.ExpectedCounterpartUpdatedUnixTime != nil) {
				return ApplySettlementRequest{}, nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
			}
			if _, exists := seenExisting[component.Existing.ExistingTransactionId]; exists {
				return ApplySettlementRequest{}, nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_COMPONENT_MISMATCH)
			}
			seenExisting[component.Existing.ExistingTransactionId] = struct{}{}
			continue
		}
		draft := component.Draft
		if draft.TransactionUnixTime < 1 || draft.CategoryId < 1 || draft.SourceAccountId < 1 || draft.Amount != component.AllocatedAmount ||
			!isCurrencyCode(draft.Currency) || draft.TimezoneUtcOffset < -720 || draft.TimezoneUtcOffset > 840 {
			return ApplySettlementRequest{}, nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		if isTransfer {
			if draft.Kind != LEDGER_EVENT_KIND_TRANSFER || draft.DestinationAccountId < 1 || draft.DestinationAccountId == draft.SourceAccountId {
				return ApplySettlementRequest{}, nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_LEDGER_EVENT_TYPE)
			}
		} else if draft.Kind != LEDGER_EVENT_KIND_EXPENSE || draft.DestinationAccountId != 0 {
			return ApplySettlementRequest{}, nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_LEDGER_EVENT_TYPE)
		}
		drafts = append(drafts, ledgerCreateDraft(request.Uid, request.CreatedIp, *draft))
	}
	for _, component := range request.Components {
		if request.InstallmentId == nil {
			if component.ComponentType != COMPONENT_TYPE_DISBURSEMENT && component.ComponentType != COMPONENT_TYPE_FEE {
				return ApplySettlementRequest{}, nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_COMPONENT_MISMATCH)
			}
		} else if component.ComponentType == COMPONENT_TYPE_DISBURSEMENT {
			return ApplySettlementRequest{}, nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_COMPONENT_MISMATCH)
		}
	}
	return request, drafts, nil
}

func settlementComponentAmounts(selection *settlementPlanSelection, installmentId *int64, component ComponentType) (int64, int64, error) {
	if selection == nil || selection.revision == nil || selection.validation == nil {
		return 0, 0, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	planned := int64(0)
	if component == COMPONENT_TYPE_DISBURSEMENT {
		if installmentId != nil || selection.revision.FundingType != FUNDING_TYPE_CASH_DISBURSEMENT {
			return 0, 0, serviceError(ErrServiceSettlementRejected, SERVICE_ERROR_COMPONENT_MISMATCH)
		}
		planned = selection.revision.PrincipalAmount
	} else if component == COMPONENT_TYPE_FEE && installmentId == nil {
		planned = selection.revision.UpfrontFeeAmount
	} else {
		if installmentId == nil || selection.installment == nil || selection.installment.InstallmentId != *installmentId {
			return 0, 0, serviceError(ErrServiceSettlementRejected, SERVICE_ERROR_INSTALLMENT_NOT_FOUND)
		}
		switch component {
		case COMPONENT_TYPE_PRINCIPAL:
			planned = selection.installment.PrincipalAmount
		case COMPONENT_TYPE_INTEREST:
			planned = selection.installment.InterestAmount
		case COMPONENT_TYPE_FEE:
			planned = selection.installment.FeeAmount
		default:
			return 0, 0, serviceError(ErrServiceSettlementRejected, SERVICE_ERROR_COMPONENT_MISMATCH)
		}
	}
	allocated := int64(0)
	for _, aggregate := range selection.validation.aggregates {
		if aggregate == nil || aggregate.ComponentType != component {
			continue
		}
		if component == COMPONENT_TYPE_DISBURSEMENT || (component == COMPONENT_TYPE_FEE && installmentId == nil) {
			if aggregate.InstallmentId != nil {
				continue
			}
		} else if aggregate.InstallmentId == nil || *aggregate.InstallmentId != *installmentId {
			continue
		}
		var err error
		allocated, err = checkedServiceAdd(allocated, aggregate.AllocatedAmount)
		if err != nil {
			return 0, 0, err
		}
	}
	if planned < 0 || allocated > planned {
		return 0, 0, serviceError(ErrServiceSettlementRejected, SERVICE_ERROR_AMOUNT_EXCEEDED)
	}
	return planned, allocated, nil
}

func validateExistingSettlementReference(contract *Contract, component SettlementComponentCommand, event *LedgerEventSnapshot) ServiceErrorCode {
	if component.Existing == nil || event == nil || event.PrimaryTransactionId != component.Existing.ExistingTransactionId || event.Deleted {
		return SERVICE_ERROR_LEDGER_EVENT_MISSING
	}
	if event.UpdatedUnixTime != component.Existing.ExpectedUpdatedUnixTime {
		return SERVICE_ERROR_LEDGER_EVENT_MODIFIED
	}
	if component.ComponentType == COMPONENT_TYPE_DISBURSEMENT || component.ComponentType == COMPONENT_TYPE_PRINCIPAL {
		if !validTransferSnapshot(event) {
			return SERVICE_ERROR_TRANSFER_INCOMPLETE
		}
		if component.Existing.ExpectedCounterpartUpdatedUnixTime == nil || event.CounterpartUpdatedUnixTime == nil ||
			*component.Existing.ExpectedCounterpartUpdatedUnixTime != *event.CounterpartUpdatedUnixTime {
			return SERVICE_ERROR_LEDGER_EVENT_MODIFIED
		}
	} else if component.Existing.ExpectedCounterpartUpdatedUnixTime != nil || event.CounterpartTransactionId != nil {
		return SERVICE_ERROR_LEDGER_EVENT_TYPE
	}
	return validateLedgerEventSemantics(contract, component.ComponentType, component.AllocatedAmount, 0, 0, event)
}

func validateCreatedSettlementEvent(contract *Contract, component SettlementComponentCommand, event *LedgerEventSnapshot) ServiceErrorCode {
	if component.Draft == nil || event == nil || event.PrimaryTransactionId < 1 || event.UpdatedUnixTime < 1 {
		return SERVICE_ERROR_LEDGER_EVENT_MISSING
	}
	return validateLedgerEventSemantics(contract, component.ComponentType, component.AllocatedAmount,
		settlementAssetAccountId(component.ComponentType, component.Draft), component.Draft.CategoryId, event)
}

func appendUniqueFormalEventIds(seen map[int64]struct{}, values *[]int64, event *LedgerEventSnapshot) ServiceErrorCode {
	if event == nil || event.PrimaryTransactionId < 1 {
		return SERVICE_ERROR_LEDGER_EVENT_MISSING
	}
	for _, transactionId := range []int64{event.PrimaryTransactionId, valueOrZero(event.CounterpartTransactionId)} {
		if transactionId < 1 {
			continue
		}
		if _, exists := seen[transactionId]; exists {
			return SERVICE_ERROR_COMPONENT_MISMATCH
		}
		seen[transactionId] = struct{}{}
		*values = append(*values, transactionId)
	}
	return ""
}

func createSettlementBindings(tx *RepositoryTransaction, uid int64, event *LedgerEventSnapshot, candidateIds []int64, now int64) ([]*TransactionBinding, error) {
	if tx == nil || event == nil || len(candidateIds) != 2 {
		return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	transactionIds := []int64{event.PrimaryTransactionId}
	if event.CounterpartTransactionId != nil {
		transactionIds = append(transactionIds, *event.CounterpartTransactionId)
	}
	sort.Slice(transactionIds, func(i, j int) bool { return transactionIds[i] < transactionIds[j] })
	bindings := make([]*TransactionBinding, 0, len(transactionIds))
	for index, transactionId := range transactionIds {
		candidate := &TransactionBinding{Uid: uid, TransactionId: transactionId, Version: 1,
			CreatedUnixTime: now, UpdatedUnixTime: now, BindingId: candidateIds[index]}
		binding, _, err := tx.CreateOrFindTransactionBinding(candidate)
		if err != nil {
			return nil, err
		}
		if binding == nil || binding.CurrentAllocationId != nil {
			return nil, serviceError(ErrServiceSettlementRejected, SERVICE_ERROR_BINDING_CONFLICT)
		}
		bindings = append(bindings, binding)
	}
	// Allocation 必须把规范主交易绑定放在 PrimaryBindingId，而不是按 ID 排序后的第一项。
	if len(bindings) == 2 && bindings[0].TransactionId != event.PrimaryTransactionId {
		bindings[0], bindings[1] = bindings[1], bindings[0]
	}
	return bindings, nil
}

func ledgerCreateDraft(uid int64, createdIp string, draft SettlementLedgerDraft) LedgerCreateDraft {
	return LedgerCreateDraft{Uid: uid, Kind: draft.Kind, CategoryId: draft.CategoryId, UnixTime: draft.TransactionUnixTime,
		TimezoneUtcOffset: draft.TimezoneUtcOffset, SourceAccountId: draft.SourceAccountId,
		DestinationAccountId: draft.DestinationAccountId, Amount: draft.Amount, CreatedIp: createdIp}
}

func settlementAssetAccountId(component ComponentType, draft *SettlementLedgerDraft) int64 {
	if draft == nil {
		return 0
	}
	if component == COMPONENT_TYPE_DISBURSEMENT {
		return draft.DestinationAccountId
	}
	return draft.SourceAccountId
}

func valueOrZeroExisting(reference *ExistingLedgerEventReference) int64 {
	if reference == nil {
		return 0
	}
	return reference.ExistingTransactionId
}

func completeSettlementAdjudication(tx *RepositoryTransaction, current *Action, code ServiceErrorCode, reasons []ServiceErrorCode, now int64) (*Action, error, error) {
	persisted, err := completeAction(tx, current, ACTION_STATUS_ACTION_REQUIRED, 0, code, reasons, now)
	return persisted, settlementError(code), err
}

func stableSettlementAdjudicationCode(err error) (ServiceErrorCode, bool) {
	var typed *ServiceError
	if !errors.As(err, &typed) {
		return "", false
	}
	switch typed.Code {
	case SERVICE_ERROR_CONTRACT_NOT_FOUND, SERVICE_ERROR_INSTALLMENT_NOT_FOUND, SERVICE_ERROR_COMPONENT_MISMATCH,
		SERVICE_ERROR_AMOUNT_EXCEEDED, SERVICE_ERROR_REVISION_MISMATCH, SERVICE_ERROR_LEDGER_EVENT_MISSING,
		SERVICE_ERROR_LEDGER_EVENT_MODIFIED, SERVICE_ERROR_LEDGER_EVENT_TYPE, SERVICE_ERROR_LEDGER_EVENT_ACCOUNT,
		SERVICE_ERROR_LEDGER_EVENT_CURRENCY, SERVICE_ERROR_LEDGER_EVENT_AMOUNT, SERVICE_ERROR_LEDGER_CATEGORY,
		SERVICE_ERROR_TRANSFER_INCOMPLETE, SERVICE_ERROR_BINDING_CONFLICT, SERVICE_ERROR_ALLOCATION_LIMIT:
		return typed.Code, true
	default:
		return "", false
	}
}

func settlementError(code ServiceErrorCode) error {
	switch code {
	case SERVICE_ERROR_CONTRACT_NOT_FOUND:
		return serviceError(ErrServiceContractNotFound, code)
	case SERVICE_ERROR_VERSION_CONFLICT:
		return serviceError(ErrServiceVersionConflict, code)
	case SERVICE_ERROR_STATE_CONFLICT:
		return serviceError(ErrServiceStateConflict, code)
	case SERVICE_ERROR_SETTLEMENT_NOT_FOUND:
		return serviceError(ErrServiceSettlementNotFound, code)
	default:
		return serviceError(ErrServiceSettlementRejected, code)
	}
}

// persistSettlementActionRequired 仅用于最外层事务已完整回滚后的稳定并发裁决。
// 它不尝试保留任何先前 effect，也不依赖保存点。
func (s *Service) persistSettlementActionRequired(c core.Context, candidate *Action, code ServiceErrorCode, now int64) (*Action, error) {
	var persisted *Action
	err := s.doWriteTransaction(c, candidate.Uid, func(tx *RepositoryTransaction) error {
		started, created, startErr := startAction(tx, candidate, now)
		if startErr != nil {
			return startErr
		}
		persisted = started
		if !created {
			return nil
		}
		persisted, startErr = completeAction(tx, started, ACTION_STATUS_ACTION_REQUIRED, 0, code, []ServiceErrorCode{code}, now)
		return startErr
	})
	return persisted, err
}
