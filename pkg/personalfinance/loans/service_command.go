package loans

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans/calculation"
)

// Service 编排纯计算、合同生命周期、持久幂等和只读进度派生。
type Service struct {
	repository      *Repository
	accounts        AccountSnapshotReader
	liabilityReader LiabilityOutstandingReader
	generateId      func() int64
	now             func() time.Time
}

// NewService 创建贷款领域服务。liabilityReader 可为 nil，此时账本负债及差异返回 NULL。
func NewService(repository *Repository, accounts AccountSnapshotReader, liabilityReader LiabilityOutstandingReader, generateId func() int64) (*Service, error) {
	if repository == nil || accounts == nil || generateId == nil {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	return &Service{repository: repository, accounts: accounts, liabilityReader: liabilityReader, generateId: generateId, now: time.Now}, nil
}

// Calculate 只执行冻结纯计算，不持久化任何 action、合同或计划。
func (s *Service) Calculate(request CalculateRequest) (*CalculationResult, error) {
	if s == nil {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	_, input, err := normalizeCalculationTerms(request.Terms)
	if err != nil {
		return nil, err
	}
	result, err := calculation.Calculate(input)
	if err != nil {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	return calculationResult(result), nil
}

func calculationResult(result calculation.Result) *CalculationResult {
	installments := append([]calculation.Installment(nil), result.Installments...)
	return &CalculationResult{CalculationVersion: result.CalculationVersion, RoundingVersion: result.RoundingVersion,
		IrrVersion: result.IRRVersion, ActualDisbursementAmount: result.ActualDisbursementAmount,
		PeriodicRatePptr: result.PeriodicRatePPTR, Installments: installments,
		PreDiscountTotalPaymentAmount: result.PreDiscountTotalPaymentAmount, PreDiscountTotalCostAmount: result.PreDiscountTotalCostAmount,
		TotalPaymentAmount: result.TotalPaymentAmount, TotalInterestAmount: result.TotalInterestAmount,
		TotalFeeAmount: result.TotalFeeAmount, TotalDiscountAmount: result.TotalDiscountAmount,
		TotalCostAmount: result.TotalCostAmount, CostRatioPptr: result.CostRatioPPTR,
		IRR: calculation.IRRResult{Status: result.IRR.Status, MonthlyIRRPPTR: cloneInt64(result.IRR.MonthlyIRRPPTR),
			SimpleAPRPPTR: cloneInt64(result.IRR.SimpleAPRPPTR), EffectiveAPRPPTR: cloneInt64(result.IRR.EffectiveAPRPPTR)}}
}

// CreateContract 在单一 privacy transaction 中写入 action、合同、首个 revision 和全部逐期计划。
func (s *Service) CreateContract(c core.Context, request CreateContractRequest) (*CommandResult, error) {
	if err := s.validateWriteDependencies(request.Uid); err != nil {
		return nil, err
	}
	if err := validateIdempotencyKey(request.IdempotencyKey); err != nil {
		return nil, err
	}
	spec, input, err := normalizeContractSpec(request.Spec)
	if err != nil {
		return nil, err
	}
	calculated, err := calculation.Calculate(input)
	if err != nil {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	keyDigest := idempotencyKeyDigest(request.IdempotencyKey)
	requestDigest := createRequestDigest(spec)
	if replay, replayErr := s.preflightReplay(c, request.Uid, 0, 0, ACTION_TYPE_CREATE_CONTRACT, keyDigest, requestDigest); replay != nil || replayErr != nil {
		return replay, replayErr
	}
	if err = s.validateAccounts(c, request.Uid, spec); err != nil {
		return nil, err
	}

	now := s.now().Unix()
	contractId := s.generateId()
	actionId := s.generateId()
	revisionId := s.generateId()
	installmentIds := s.generateIds(len(calculated.Installments))
	if now < 1 || contractId < 1 || actionId < 1 || revisionId < 1 || installmentIds == nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	candidate := newReadyAction(request.Uid, contractId, 0, ACTION_TYPE_CREATE_CONTRACT, actionId, keyDigest, requestDigest, now)
	var persisted *Action
	var replayed bool

	err = s.doWriteTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
		started, created, startErr := startAction(tx, candidate, now)
		if startErr != nil {
			return startErr
		}
		persisted = started
		if !created {
			replayed = true
			return nil
		}

		contract := contractFromSpec(request.Uid, contractId, revisionId, spec, now)
		if insertErr := tx.InsertContract(contract); insertErr != nil {
			return insertErr
		}
		revision := revisionFromCalculation(request.Uid, contractId, revisionId, 1, nil, actionId, spec.Terms, input, calculated, now)
		if insertErr := tx.InsertRevision(revision); insertErr != nil {
			return insertErr
		}
		installments := installmentsFromCalculation(request.Uid, contractId, revisionId, installmentIds, calculated, now)
		if insertErr := tx.InsertInstallments(installments); insertErr != nil {
			return insertErr
		}
		persisted, startErr = completeAction(tx, started, ACTION_STATUS_APPLIED, 1, "", nil, now)
		return startErr
	})
	if err != nil {
		return nil, mapWriteError(err)
	}
	return s.commandResult(c, request.Uid, persisted, replayed, "")
}

// ReviseContract 在 active、expected version 命中且无活动分配时追加 revision，并以 CAS 切换唯一当前计划。
func (s *Service) ReviseContract(c core.Context, request ReviseContractRequest) (*CommandResult, error) {
	if err := s.validateWriteDependencies(request.Uid); err != nil || request.ContractId < 1 || request.ExpectedContractVersion < 1 {
		if err != nil {
			return nil, err
		}
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if err := validateIdempotencyKey(request.IdempotencyKey); err != nil {
		return nil, err
	}
	spec, input, err := normalizeContractSpec(request.Spec)
	if err != nil {
		return nil, err
	}
	calculated, err := calculation.Calculate(input)
	if err != nil {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	keyDigest := idempotencyKeyDigest(request.IdempotencyKey)
	requestDigest := reviseRequestDigest(request.ContractId, request.ExpectedContractVersion, spec)
	if replay, replayErr := s.preflightReplay(c, request.Uid, request.ContractId, request.ExpectedContractVersion,
		ACTION_TYPE_REVISE_CONTRACT, keyDigest, requestDigest); replay != nil || replayErr != nil {
		return replay, replayErr
	}
	if err = s.validateAccounts(c, request.Uid, spec); err != nil {
		return nil, err
	}

	now := s.now().Unix()
	actionId := s.generateId()
	revisionId := s.generateId()
	installmentIds := s.generateIds(len(calculated.Installments))
	if now < 1 || actionId < 1 || revisionId < 1 || installmentIds == nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	candidate := newReadyAction(request.Uid, request.ContractId, request.ExpectedContractVersion, ACTION_TYPE_REVISE_CONTRACT,
		actionId, keyDigest, requestDigest, now)
	var persisted *Action
	var replayed bool
	var adjudicated error

	err = s.doWriteTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
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
			persisted, startErr = completeAction(tx, started, ACTION_STATUS_ACTION_REQUIRED, 0, SERVICE_ERROR_CONTRACT_NOT_FOUND, []ServiceErrorCode{SERVICE_ERROR_CONTRACT_NOT_FOUND}, now)
			adjudicated = serviceError(ErrServiceContractNotFound, SERVICE_ERROR_CONTRACT_NOT_FOUND)
			return startErr
		}
		if contract.Version != request.ExpectedContractVersion {
			persisted, startErr = completeAction(tx, started, ACTION_STATUS_ACTION_REQUIRED, 0, SERVICE_ERROR_VERSION_CONFLICT, []ServiceErrorCode{SERVICE_ERROR_VERSION_CONFLICT}, now)
			adjudicated = serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
			return startErr
		}
		if contract.Status != CONTRACT_STATUS_ACTIVE {
			persisted, startErr = completeAction(tx, started, ACTION_STATUS_ACTION_REQUIRED, 0, SERVICE_ERROR_STATE_CONFLICT, []ServiceErrorCode{SERVICE_ERROR_STATE_CONFLICT}, now)
			adjudicated = serviceError(ErrServiceStateConflict, SERVICE_ERROR_STATE_CONFLICT)
			return startErr
		}
		active, countErr := tx.CountActiveAllocations(contract.ContractId)
		if countErr != nil {
			return countErr
		}
		if active != 0 {
			persisted, startErr = completeAction(tx, started, ACTION_STATUS_ACTION_REQUIRED, 0, SERVICE_ERROR_ACTIVE_ALLOCATION, []ServiceErrorCode{SERVICE_ERROR_ACTIVE_ALLOCATION}, now)
			adjudicated = serviceError(ErrServiceActiveAllocation, SERVICE_ERROR_ACTIVE_ALLOCATION)
			return startErr
		}
		currentRevision, findErr := tx.FindRevisionById(contract.CurrentRevisionId)
		if findErr != nil || currentRevision == nil || currentRevision.ContractId != contract.ContractId {
			if findErr != nil {
				return findErr
			}
			return serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}

		next := contractFromSpec(request.Uid, contract.ContractId, revisionId, spec, now)
		next.Version = contract.Version + 1
		next.CreatedUnixTime = contract.CreatedUnixTime
		updated, updateErr := tx.UpdateContractCAS(contract.Version, next)
		if updateErr != nil {
			return updateErr
		}
		if !updated {
			persisted, startErr = completeAction(tx, started, ACTION_STATUS_ACTION_REQUIRED, 0, SERVICE_ERROR_VERSION_CONFLICT, []ServiceErrorCode{SERVICE_ERROR_VERSION_CONFLICT}, now)
			adjudicated = serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
			return startErr
		}
		previousRevisionId := currentRevision.RevisionId
		revision := revisionFromCalculation(request.Uid, contract.ContractId, revisionId, currentRevision.RevisionNumber+1,
			&previousRevisionId, actionId, spec.Terms, input, calculated, now)
		if insertErr := tx.InsertRevision(revision); insertErr != nil {
			return insertErr
		}
		installments := installmentsFromCalculation(request.Uid, contract.ContractId, revisionId, installmentIds, calculated, now)
		if insertErr := tx.InsertInstallments(installments); insertErr != nil {
			return insertErr
		}
		persisted, startErr = completeAction(tx, started, ACTION_STATUS_APPLIED, next.Version, "", nil, now)
		return startErr
	})
	if err != nil {
		return nil, mapWriteError(err)
	}
	if adjudicated != nil {
		return nil, adjudicated
	}
	result, err := s.commandResult(c, request.Uid, persisted, replayed, "")
	if err != nil {
		return nil, err
	}
	if replayed && persisted.Status == ACTION_STATUS_ACTION_REQUIRED {
		return nil, errorFromAction(persisted)
	}
	return result, nil
}

func (s *Service) CloseContract(c core.Context, request CloseContractRequest) (*CommandResult, error) {
	if !isCloseReason(request.Reason) || request.Reason == CLOSE_REASON_NONE {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	return s.lifecycle(c, ContractCommandRequest{Uid: request.Uid, ContractId: request.ContractId,
		ExpectedContractVersion: request.ExpectedContractVersion, IdempotencyKey: request.IdempotencyKey}, ACTION_TYPE_CLOSE_CONTRACT, request.Reason)
}

func (s *Service) ReopenContract(c core.Context, request ContractCommandRequest) (*CommandResult, error) {
	return s.lifecycle(c, request, ACTION_TYPE_REOPEN_CONTRACT, CLOSE_REASON_NONE)
}

func (s *Service) CancelContract(c core.Context, request ContractCommandRequest) (*CommandResult, error) {
	return s.lifecycle(c, request, ACTION_TYPE_CANCEL_CONTRACT, CLOSE_REASON_NONE)
}

func (s *Service) lifecycle(c core.Context, request ContractCommandRequest, actionType ActionType, closeReason CloseReasonCode) (*CommandResult, error) {
	if err := s.validateWriteDependencies(request.Uid); err != nil || request.ContractId < 1 || request.ExpectedContractVersion < 1 ||
		(actionType != ACTION_TYPE_CLOSE_CONTRACT && actionType != ACTION_TYPE_REOPEN_CONTRACT && actionType != ACTION_TYPE_CANCEL_CONTRACT) {
		if err != nil {
			return nil, err
		}
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if err := validateIdempotencyKey(request.IdempotencyKey); err != nil {
		return nil, err
	}
	now := s.now().Unix()
	actionId := s.generateId()
	if now < 1 || actionId < 1 {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	candidate := newReadyAction(request.Uid, request.ContractId, request.ExpectedContractVersion, actionType, actionId,
		idempotencyKeyDigest(request.IdempotencyKey), lifecycleRequestDigest(actionType, request.ContractId, request.ExpectedContractVersion, closeReason), now)
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
			persisted, startErr = completeAction(tx, started, ACTION_STATUS_ACTION_REQUIRED, 0, SERVICE_ERROR_CONTRACT_NOT_FOUND, []ServiceErrorCode{SERVICE_ERROR_CONTRACT_NOT_FOUND}, now)
			adjudicated = serviceError(ErrServiceContractNotFound, SERVICE_ERROR_CONTRACT_NOT_FOUND)
			return startErr
		}
		if contract.Version != request.ExpectedContractVersion {
			persisted, startErr = completeAction(tx, started, ACTION_STATUS_ACTION_REQUIRED, 0, SERVICE_ERROR_VERSION_CONFLICT, []ServiceErrorCode{SERVICE_ERROR_VERSION_CONFLICT}, now)
			adjudicated = serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
			return startErr
		}

		activeCount, countErr := tx.CountActiveAllocations(contract.ContractId)
		if countErr != nil {
			return countErr
		}
		validState := (actionType == ACTION_TYPE_CLOSE_CONTRACT && contract.Status == CONTRACT_STATUS_ACTIVE) ||
			(actionType == ACTION_TYPE_REOPEN_CONTRACT && contract.Status == CONTRACT_STATUS_CLOSED) ||
			(actionType == ACTION_TYPE_CANCEL_CONTRACT && contract.Status == CONTRACT_STATUS_ACTIVE)
		if !validState {
			persisted, startErr = completeAction(tx, started, ACTION_STATUS_ACTION_REQUIRED, 0, SERVICE_ERROR_STATE_CONFLICT, []ServiceErrorCode{SERVICE_ERROR_STATE_CONFLICT}, now)
			adjudicated = serviceError(ErrServiceStateConflict, SERVICE_ERROR_STATE_CONFLICT)
			return startErr
		}
		allocationCount := activeCount
		if actionType == ACTION_TYPE_CANCEL_CONTRACT {
			allocationCount, countErr = tx.CountAllocations(contract.ContractId)
			if countErr != nil {
				return countErr
			}
		}
		if actionType == ACTION_TYPE_CANCEL_CONTRACT && allocationCount != 0 {
			persisted, startErr = completeAction(tx, started, ACTION_STATUS_ACTION_REQUIRED, 0, SERVICE_ERROR_ALLOCATION_HISTORY, []ServiceErrorCode{SERVICE_ERROR_ALLOCATION_HISTORY}, now)
			adjudicated = serviceError(ErrServiceAllocationHistory, SERVICE_ERROR_ALLOCATION_HISTORY)
			return startErr
		}
		if actionType == ACTION_TYPE_CLOSE_CONTRACT && closeReason == CLOSE_REASON_PAID_OFF {
			revision, revisionErr := tx.FindRevisionById(contract.CurrentRevisionId)
			aggregates, aggregateErr := tx.AggregateActiveAllocations(contract.ContractId)
			if revisionErr != nil {
				return revisionErr
			}
			if aggregateErr != nil {
				return aggregateErr
			}
			remaining, remainingErr := remainingFromRevision(revision, aggregates)
			if remainingErr != nil {
				return remainingErr
			}
			if remaining.PaymentAmount != 0 {
				persisted, startErr = completeAction(tx, started, ACTION_STATUS_ACTION_REQUIRED, 0, SERVICE_ERROR_PLAN_NOT_PAID_OFF, []ServiceErrorCode{SERVICE_ERROR_PLAN_NOT_PAID_OFF}, now)
				adjudicated = serviceError(ErrServicePlanNotPaidOff, SERVICE_ERROR_PLAN_NOT_PAID_OFF)
				return startErr
			}
		}

		next := *contract
		next.Version = contract.Version + 1
		next.UpdatedUnixTime = now
		switch actionType {
		case ACTION_TYPE_CLOSE_CONTRACT:
			next.Status = CONTRACT_STATUS_CLOSED
			next.CloseReasonCode = closeReason
			next.ClosedUnixTime = &now
		case ACTION_TYPE_REOPEN_CONTRACT:
			next.Status = CONTRACT_STATUS_ACTIVE
			next.CloseReasonCode = CLOSE_REASON_NONE
			next.ClosedUnixTime = nil
		case ACTION_TYPE_CANCEL_CONTRACT:
			next.Status = CONTRACT_STATUS_CANCELLED
			next.CloseReasonCode = CLOSE_REASON_NONE
			next.ClosedUnixTime = nil
		}
		updated, updateErr := tx.UpdateContractCAS(contract.Version, &next)
		if updateErr != nil {
			return updateErr
		}
		if !updated {
			persisted, startErr = completeAction(tx, started, ACTION_STATUS_ACTION_REQUIRED, 0, SERVICE_ERROR_VERSION_CONFLICT, []ServiceErrorCode{SERVICE_ERROR_VERSION_CONFLICT}, now)
			adjudicated = serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
			return startErr
		}
		persisted, startErr = completeAction(tx, started, ACTION_STATUS_APPLIED, next.Version, "", nil, now)
		return startErr
	})
	if err != nil {
		return nil, mapWriteError(err)
	}
	if adjudicated != nil {
		return nil, adjudicated
	}
	result, err := s.commandResult(c, request.Uid, persisted, replayed, time.Unix(now, 0).UTC().Format("2006-01-02"))
	if err != nil {
		return nil, err
	}
	if replayed && persisted.Status == ACTION_STATUS_ACTION_REQUIRED {
		return nil, errorFromAction(persisted)
	}
	return result, nil
}

func (s *Service) validateWriteDependencies(uid int64) error {
	if s == nil || s.repository == nil || s.accounts == nil || s.generateId == nil || s.now == nil || uid < 1 {
		return serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	return nil
}

func (s *Service) validateAccounts(c core.Context, uid int64, spec ContractSpec) error {
	ids := []int64{spec.LiabilityAccountId}
	if spec.DefaultPaymentAccountId != nil {
		ids = append(ids, *spec.DefaultPaymentAccountId)
	}
	snapshots, err := s.accounts.LoadAccountSnapshots(c, uid, ids)
	if err != nil {
		return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	byId := make(map[int64]AccountSnapshot, len(snapshots))
	for _, snapshot := range snapshots {
		if _, exists := byId[snapshot.AccountId]; exists {
			return serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}
		byId[snapshot.AccountId] = snapshot
	}
	liability, ok := byId[spec.LiabilityAccountId]
	if !ok {
		return serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_NOT_FOUND)
	}
	if err = validateAccountSnapshot(liability, uid, spec.Currency, true); err != nil {
		return err
	}
	if spec.DefaultPaymentAccountId != nil {
		payment, exists := byId[*spec.DefaultPaymentAccountId]
		if !exists {
			return serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_NOT_FOUND)
		}
		if err = validateAccountSnapshot(payment, uid, spec.Currency, false); err != nil {
			return err
		}
	}
	return nil
}

func validateAccountSnapshot(snapshot AccountSnapshot, uid int64, currency string, liability bool) error {
	if snapshot.Uid != uid {
		return serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_OWNER)
	}
	if snapshot.Deleted {
		return serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_DELETED)
	}
	if !snapshot.Single {
		return serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_NOT_SINGLE)
	}
	if snapshot.Hidden {
		return serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_HIDDEN)
	}
	if liability && snapshot.Kind != ACCOUNT_KIND_CREDIT_CARD && snapshot.Kind != ACCOUNT_KIND_DEBT {
		return serviceError(ErrServiceAccountRejected, SERVICE_ERROR_LIABILITY_REQUIRED)
	}
	if !liability && snapshot.Kind != ACCOUNT_KIND_ASSET {
		return serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ASSET_REQUIRED)
	}
	if snapshot.Currency != currency {
		return serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_CURRENCY)
	}
	return nil
}

func (s *Service) generateIds(count int) []int64 {
	if count < 1 {
		return nil
	}
	ids := make([]int64, count)
	for index := range ids {
		ids[index] = s.generateId()
		if ids[index] < 1 {
			return nil
		}
	}
	return ids
}

func (s *Service) doWriteTransaction(c core.Context, uid int64, fn func(tx *RepositoryTransaction) error) error {
	database, err := s.repository.database(uid)
	if err != nil {
		return err
	}
	for attempt := 0; attempt < maximumActionPersistenceAttempts; attempt++ {
		err = s.repository.DoTransaction(c, uid, fn)
		if err == nil || attempt+1 == maximumActionPersistenceAttempts || !isRetryablePersistenceError(database.DatabaseType(), err) {
			return err
		}
		if waitErr := waitPersistenceRetry(c, initialActionPersistenceRetryWait<<attempt); waitErr != nil {
			return waitErr
		}
	}
	return err
}

func newReadyAction(uid int64, contractId int64, expectedVersion int64, actionType ActionType, actionId int64, keyDigest string, requestDigest string, now int64) *Action {
	return &Action{Uid: uid, ContractId: contractId, ExpectedContractVersion: expectedVersion, ActionType: actionType,
		IdempotencyKeyDigest: keyDigest, IdempotencyKeyVersion: IDEMPOTENCY_KEY_VERSION_V1,
		RequestDigest: requestDigest, RequestDigestVersion: ACTION_REQUEST_DIGEST_VERSION_V1,
		Status: ACTION_STATUS_READY, ReasonCodesJson: "[]", CreatedUnixTime: now, UpdatedUnixTime: now, ActionId: actionId}
}

func startAction(tx *RepositoryTransaction, candidate *Action, now int64) (*Action, bool, error) {
	persisted, created, err := tx.CreateOrFindAction(candidate)
	if err != nil {
		return nil, false, err
	}
	if !sameActionRequest(persisted, candidate) {
		return nil, false, serviceError(ErrServiceIdempotencyConflict, SERVICE_ERROR_IDEMPOTENCY_CONFLICT)
	}
	if !created {
		if persisted.Status == ACTION_STATUS_APPLIED || persisted.Status == ACTION_STATUS_ACTION_REQUIRED || persisted.Status == ACTION_STATUS_FAILED {
			return persisted, false, nil
		}
		return nil, false, serviceError(ErrServiceCommandUnavailable, SERVICE_ERROR_COMMAND_UNAVAILABLE)
	}
	started := now
	next := cloneAction(candidate)
	next.Status = ACTION_STATUS_APPLYING
	next.StartedUnixTime = &started
	next.UpdatedUnixTime = now
	updated, err := tx.UpdateActionStatus(candidate.ActionId, ACTION_STATUS_READY, next)
	if err != nil {
		return nil, false, err
	}
	if !updated {
		return nil, false, serviceError(ErrServiceCommandUnavailable, SERVICE_ERROR_COMMAND_UNAVAILABLE)
	}
	return next, true, nil
}

func sameActionRequest(persisted *Action, candidate *Action) bool {
	if persisted == nil || candidate == nil || persisted.Uid != candidate.Uid ||
		persisted.IdempotencyKeyDigest != candidate.IdempotencyKeyDigest || persisted.IdempotencyKeyVersion != IDEMPOTENCY_KEY_VERSION_V1 ||
		persisted.RequestDigestVersion != ACTION_REQUEST_DIGEST_VERSION_V1 || persisted.RequestDigest != candidate.RequestDigest ||
		persisted.ExpectedContractVersion != candidate.ExpectedContractVersion || persisted.ActionType != candidate.ActionType {
		return false
	}
	return candidate.ActionType == ACTION_TYPE_CREATE_CONTRACT || persisted.ContractId == candidate.ContractId
}

func (s *Service) preflightReplay(c core.Context, uid int64, contractId int64, expectedVersion int64, actionType ActionType, keyDigest string, requestDigest string) (*CommandResult, error) {
	database, err := s.repository.database(uid)
	if err != nil {
		return nil, &ServiceError{Code: SERVICE_ERROR_PERSISTENCE, kind: ErrServicePersistenceFailed, cause: err}
	}
	var persisted *Action
	for attempt := 0; attempt < maximumActionPersistenceAttempts; attempt++ {
		persisted, err = s.repository.FindActionByIdempotencyKeyDigest(c, uid, keyDigest)
		if err == nil {
			break
		}
		if attempt+1 == maximumActionPersistenceAttempts || !isRetryablePersistenceError(database.DatabaseType(), err) {
			return nil, &ServiceError{Code: SERVICE_ERROR_PERSISTENCE, kind: ErrServicePersistenceFailed, cause: err}
		}
		if waitErr := waitPersistenceRetry(c, initialActionPersistenceRetryWait<<attempt); waitErr != nil {
			return nil, &ServiceError{Code: SERVICE_ERROR_PERSISTENCE, kind: ErrServicePersistenceFailed, cause: waitErr}
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
	if persisted.Status == ACTION_STATUS_ACTION_REQUIRED || persisted.Status == ACTION_STATUS_FAILED {
		return nil, errorFromAction(persisted)
	}
	return s.commandResult(c, uid, persisted, true, "")
}

func completeAction(tx *RepositoryTransaction, current *Action, status ActionStatus, appliedVersion int64, errorCode ServiceErrorCode, reasons []ServiceErrorCode, now int64) (*Action, error) {
	if reasons == nil {
		reasons = []ServiceErrorCode{}
	}
	encoded, err := json.Marshal(reasons)
	if err != nil {
		return nil, err
	}
	completed := now
	next := cloneAction(current)
	next.AppliedContractVersion = appliedVersion
	next.Status = status
	next.ReasonCodesJson = string(encoded)
	next.ErrorCode = string(errorCode)
	next.CompletedUnixTime = &completed
	next.UpdatedUnixTime = now
	updated, err := tx.UpdateActionStatus(current.ActionId, ACTION_STATUS_APPLYING, next)
	if err != nil {
		return nil, err
	}
	if !updated {
		return nil, serviceError(ErrServiceCommandUnavailable, SERVICE_ERROR_COMMAND_UNAVAILABLE)
	}
	return next, nil
}

func contractFromSpec(uid int64, contractId int64, revisionId int64, spec ContractSpec, now int64) *Contract {
	return &Contract{Uid: uid, Name: spec.Name, LenderName: spec.LenderName, ContractType: spec.ContractType,
		LiabilityAccountId: spec.LiabilityAccountId, Status: CONTRACT_STATUS_ACTIVE, CloseReasonCode: CLOSE_REASON_NONE,
		DefaultPaymentAccountId: cloneInt64(spec.DefaultPaymentAccountId), Currency: spec.Currency, Note: spec.Note,
		Version: 1, CurrentRevisionId: revisionId, CreatedUnixTime: now, UpdatedUnixTime: now, ContractId: contractId}
}

func revisionFromCalculation(uid int64, contractId int64, revisionId int64, revisionNumber int64, previousRevisionId *int64,
	actionId int64, terms CalculationTerms, input calculation.Input, result calculation.Result, now int64) *ContractRevision {
	return &ContractRevision{Uid: uid, ContractId: contractId, RevisionNumber: revisionNumber, PreviousRevisionId: cloneInt64(previousRevisionId),
		ActionId: actionId, EffectiveDate: terms.EffectiveDate, ContractDate: terms.ContractDate, FirstDueDate: terms.FirstDueDate,
		FundingType: terms.FundingType, InputMode: terms.InputMode, RepaymentMethod: terms.RepaymentMethod, RateQuoteType: terms.RateQuoteType,
		FrequencyType: FREQUENCY_TYPE_MONTHLY, FrequencyInterval: 1, PrincipalAmount: input.PrincipalAmount,
		ActualDisbursementAmount: result.ActualDisbursementAmount, UpfrontFeeAmount: input.UpfrontFeeAmount,
		PerPeriodFeeAmount: input.PerPeriodFeeAmount, PaymentBasisAmount: cloneInt64(input.PaymentBasisAmount), TermCount: input.TermCount,
		QuotedRatePptr: cloneInt64(input.QuotedRatePPTR), DiscountType: terms.DiscountType,
		DiscountRatePptr: cloneInt64(input.DiscountRatePPTR), DiscountAmount: input.DiscountAmount,
		CalculationVersion: RuleVersion(result.CalculationVersion), RoundingVersion: RuleVersion(result.RoundingVersion), IrrVersion: RuleVersion(result.IRRVersion),
		ScheduleDigest: result.ScheduleDigest, PreDiscountTotalPaymentAmount: result.PreDiscountTotalPaymentAmount,
		PreDiscountTotalCostAmount: result.PreDiscountTotalCostAmount, TotalPaymentAmount: result.TotalPaymentAmount,
		TotalInterestAmount: result.TotalInterestAmount, TotalFeeAmount: result.TotalFeeAmount, TotalDiscountAmount: result.TotalDiscountAmount,
		TotalCostAmount: result.TotalCostAmount, CostRatioPptr: result.CostRatioPPTR, IrrStatus: IRRStatus(result.IRR.Status),
		MonthlyIrrPptr: cloneInt64(result.IRR.MonthlyIRRPPTR), SimpleAprPptr: cloneInt64(result.IRR.SimpleAPRPPTR),
		EffectiveAprPptr: cloneInt64(result.IRR.EffectiveAPRPPTR), CreatedUnixTime: now, RevisionId: revisionId}
}

func installmentsFromCalculation(uid int64, contractId int64, revisionId int64, ids []int64, result calculation.Result, now int64) []*Installment {
	items := make([]*Installment, len(result.Installments))
	for index, row := range result.Installments {
		items[index] = &Installment{Uid: uid, ContractId: contractId, RevisionId: revisionId, InstallmentNumber: row.InstallmentNumber,
			DueDate: row.DueDate, BeginningPrincipalAmount: row.BeginningPrincipalAmount, PrincipalAmount: row.PrincipalAmount,
			InterestAmount: row.InterestAmount, FeeAmount: row.FeeAmount, DiscountAmount: row.DiscountAmount,
			PaymentAmount: row.PaymentAmount, EndingPrincipalAmount: row.EndingPrincipalAmount,
			PreDiscountInterestAmount: row.PreDiscountInterestAmount, PreDiscountFeeAmount: row.PreDiscountFeeAmount,
			PreDiscountPaymentAmount: row.PreDiscountPaymentAmount, CreatedUnixTime: now, InstallmentId: ids[index]}
	}
	return items
}

func mapWriteError(err error) error {
	var typed *ServiceError
	if errors.As(err, &typed) {
		return typed
	}
	return &ServiceError{Code: SERVICE_ERROR_PERSISTENCE, kind: ErrServicePersistenceFailed, cause: err}
}

func errorFromAction(action *Action) error {
	if action == nil {
		return serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	code := ServiceErrorCode(action.ErrorCode)
	switch code {
	case SERVICE_ERROR_CONTRACT_NOT_FOUND:
		return serviceError(ErrServiceContractNotFound, code)
	case SERVICE_ERROR_VERSION_CONFLICT:
		return serviceError(ErrServiceVersionConflict, code)
	case SERVICE_ERROR_STATE_CONFLICT:
		return serviceError(ErrServiceStateConflict, code)
	case SERVICE_ERROR_ACTIVE_ALLOCATION:
		return serviceError(ErrServiceActiveAllocation, code)
	case SERVICE_ERROR_ALLOCATION_HISTORY:
		return serviceError(ErrServiceAllocationHistory, code)
	case SERVICE_ERROR_PLAN_NOT_PAID_OFF:
		return serviceError(ErrServicePlanNotPaidOff, code)
	default:
		return serviceError(ErrServiceCommandUnavailable, SERVICE_ERROR_COMMAND_UNAVAILABLE)
	}
}

func commandAction(action *Action) (*CommandAction, error) {
	if action == nil {
		return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	var reasons []ServiceErrorCode
	if err := json.Unmarshal([]byte(action.ReasonCodesJson), &reasons); err != nil {
		return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	return &CommandAction{ActionId: action.ActionId, ContractId: action.ContractId,
		ExpectedContractVersion: action.ExpectedContractVersion, AppliedContractVersion: action.AppliedContractVersion,
		ActionType: action.ActionType, Status: action.Status, ReasonCodes: reasons, ErrorCode: ServiceErrorCode(action.ErrorCode),
		CreatedUnixTime: action.CreatedUnixTime, StartedUnixTime: cloneInt64(action.StartedUnixTime),
		CompletedUnixTime: cloneInt64(action.CompletedUnixTime), FailedUnixTime: cloneInt64(action.FailedUnixTime), UpdatedUnixTime: action.UpdatedUnixTime}, nil
}

func (s *Service) commandResult(c core.Context, uid int64, action *Action, replayed bool, asOfDate string) (*CommandResult, error) {
	for attempt := 0; attempt < maximumActionPersistenceAttempts; attempt++ {
		result, err := s.commandResultOnce(c, uid, action, replayed, asOfDate)
		if err == nil || attempt+1 == maximumActionPersistenceAttempts || !errors.Is(err, ErrServicePersistenceFailed) {
			return result, err
		}
		if waitErr := waitPersistenceRetry(c, initialActionPersistenceRetryWait<<attempt); waitErr != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
	}
	return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
}

func (s *Service) commandResultOnce(c core.Context, uid int64, action *Action, replayed bool, asOfDate string) (*CommandResult, error) {
	view, err := commandAction(action)
	if err != nil {
		return nil, err
	}
	result := &CommandResult{Action: view, Replayed: replayed}
	if action.ActionType == ACTION_TYPE_CREATE_CONTRACT || action.ActionType == ACTION_TYPE_REVISE_CONTRACT {
		revision, findErr := s.repository.FindRevisionByActionId(c, uid, action.ActionId)
		if findErr != nil || (action.Status == ACTION_STATUS_APPLIED && revision == nil) {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		result.Revision = revisionResult(revision)
		if revision != nil {
			rows, loadErr := s.loadAllInstallments(c, uid, revision.ContractId, revision.RevisionId)
			if loadErr != nil {
				return nil, loadErr
			}
			result.Installments = installmentResults(rows)
		}
	}
	if asOfDate != "" && action.Status == ACTION_STATUS_APPLIED {
		detail, detailErr := s.GetContract(c, uid, action.ContractId, asOfDate)
		if detailErr != nil {
			return nil, detailErr
		}
		remaining := detail.Remaining
		result.Remaining = &remaining
		result.LedgerOutstandingAmount = cloneInt64(detail.LedgerOutstandingAmount)
		result.LedgerPlanDifferenceAmount = cloneInt64(detail.LedgerPlanDifferenceAmount)
	}
	return result, nil
}

func remainingFromRevision(revision *ContractRevision, aggregates []*AllocationAggregate) (PlanRemaining, error) {
	if revision == nil || revision.PrincipalAmount < 0 || revision.TotalInterestAmount < 0 || revision.TotalFeeAmount < revision.UpfrontFeeAmount {
		return PlanRemaining{}, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	remaining := PlanRemaining{PrincipalAmount: revision.PrincipalAmount, InterestAmount: revision.TotalInterestAmount,
		FeeAmount: revision.TotalFeeAmount - revision.UpfrontFeeAmount}
	for _, aggregate := range aggregates {
		if aggregate == nil || aggregate.AllocatedAmount < 0 {
			return PlanRemaining{}, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}
		switch aggregate.ComponentType {
		case COMPONENT_TYPE_DISBURSEMENT:
			continue
		case COMPONENT_TYPE_PRINCIPAL:
			remaining.PrincipalAmount -= aggregate.AllocatedAmount
		case COMPONENT_TYPE_INTEREST:
			remaining.InterestAmount -= aggregate.AllocatedAmount
		case COMPONENT_TYPE_FEE:
			remaining.FeeAmount -= aggregate.AllocatedAmount
		default:
			return PlanRemaining{}, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}
	}
	if remaining.PrincipalAmount < 0 || remaining.InterestAmount < 0 || remaining.FeeAmount < 0 {
		return PlanRemaining{}, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	remaining.PaymentAmount = remaining.PrincipalAmount + remaining.InterestAmount + remaining.FeeAmount
	if remaining.PaymentAmount < 0 {
		return PlanRemaining{}, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	return remaining, nil
}
