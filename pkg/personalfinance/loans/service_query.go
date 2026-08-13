package loans

import (
	"math"

	"github.com/mayswind/ezbookkeeping/pkg/core"
)

// ListDashboardAllocations 返回可信总览分类所需的最小活动分配事实。
func (s *Service) ListDashboardAllocations(c core.Context, uid int64) ([]*DashboardAllocation, error) {
	if s == nil || s.repository == nil || uid < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	values, err := s.repository.ListDashboardAllocations(c, uid)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	return values, nil
}

// ListContracts 复用仓储稳定游标，并为每个合同派生当前计划的有界进度摘要。
func (s *Service) ListContracts(c core.Context, uid int64, status ContractStatus, cursor *ContractCursor, limit int, asOfDate string) (*ContractListResult, error) {
	if s == nil || s.repository == nil || uid < 1 || !isContractStatus(status) || !isCivilDate(asOfDate) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	page, err := s.repository.ListContracts(c, uid, status, cursor, limit)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	result := &ContractListResult{Items: make([]*ContractSummary, 0, len(page.Items)), NextCursor: page.NextCursor}
	for _, contract := range page.Items {
		detail, detailErr := s.getContractFromSelector(c, uid, contract, asOfDate, false)
		if detailErr != nil {
			return nil, detailErr
		}
		nextInstallment, nextErr := contractNextInstallment(detail)
		if nextErr != nil {
			return nil, nextErr
		}
		result.Items = append(result.Items, &ContractSummary{Contract: contractResult(contract), CurrentRevision: detail.CurrentRevision,
			Progress: detail.Progress, NextInstallment: nextInstallment, ActionRequired: detail.ActionRequired,
			ReasonCodes: append([]ServiceErrorCode(nil), detail.ReasonCodes...)})
	}
	return result, nil
}

func contractNextInstallment(detail *ContractDetail) (*ContractNextInstallment, error) {
	if detail == nil || len(detail.Installments) != len(detail.InstallmentProgress) {
		return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	for index, progress := range detail.InstallmentProgress {
		installment := detail.Installments[index]
		if installment == nil || progress == nil || installment.InstallmentId != progress.InstallmentId ||
			installment.InstallmentNumber != progress.InstallmentNumber || installment.DueDate != progress.DueDate {
			return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}
		if progress.OutstandingPayment > 0 {
			if detail.Progress.NextDueDate == nil || *detail.Progress.NextDueDate != progress.DueDate {
				return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
			}
			return &ContractNextInstallment{Installment: installment, Progress: progress}, nil
		}
	}
	if detail.Progress.NextDueDate != nil {
		return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	return nil, nil
}

// GetContract 按 uid 读取合同、唯一当前 revision、完整当前计划与活动 allocation 聚合。
func (s *Service) GetContract(c core.Context, uid int64, contractId int64, asOfDate string) (*ContractDetail, error) {
	if s == nil || s.repository == nil || uid < 1 || contractId < 1 || !isCivilDate(asOfDate) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	contract, err := s.repository.FindContractById(c, uid, contractId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if contract == nil {
		return nil, serviceError(ErrServiceContractNotFound, SERVICE_ERROR_CONTRACT_NOT_FOUND)
	}
	return s.getContractFromSelector(c, uid, contract, asOfDate, true)
}

func (s *Service) getContractFromSelector(c core.Context, uid int64, contract *Contract, asOfDate string, includeLedger bool) (*ContractDetail, error) {
	revision, err := s.repository.FindRevisionById(c, uid, contract.CurrentRevisionId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if revision == nil || revision.ContractId != contract.ContractId {
		return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	installments, err := s.loadAllInstallments(c, uid, contract.ContractId, revision.RevisionId)
	if err != nil {
		return nil, err
	}
	if int64(len(installments)) != revision.TermCount {
		return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	validation, err := s.validateActiveAllocations(c, nil, contract, revision, installments)
	if err != nil {
		return nil, err
	}
	rows, progress, remaining, err := derivePlanProgress(installments, validation.aggregates, asOfDate)
	if err != nil {
		return nil, err
	}
	detail := &ContractDetail{Contract: contractResult(contract), CurrentRevision: revisionResult(revision), Installments: installmentResults(installments),
		ActiveAllocationAggregates: validation.aggregates, InstallmentProgress: rows, Progress: progress, Remaining: remaining,
		InvalidAllocationCount: validation.invalidCount, ActionRequired: validation.invalidCount > 0,
		ReasonCodes: append([]ServiceErrorCode(nil), validation.reasonCodes...)}
	if includeLedger {
		latestActionId, latestErr := s.latestSettlementActionId(c, contract.Uid, contract.ContractId, validation)
		if latestErr != nil {
			return nil, latestErr
		}
		detail.LatestSettlementActionId = latestActionId
	}
	if includeLedger && s.liabilityReader != nil {
		outstanding, readErr := s.liabilityReader.ReadLiabilityOutstanding(c, uid, contract.LiabilityAccountId)
		if readErr != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		if outstanding != nil {
			if *outstanding < 0 {
				return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
			}
			detail.LedgerOutstandingAmount = cloneInt64(outstanding)
			difference, subtractErr := checkedServiceSubtract(*outstanding, remaining.PrincipalAmount)
			if subtractErr != nil {
				return nil, subtractErr
			}
			detail.LedgerPlanDifferenceAmount = &difference
		}
	}
	return detail, nil
}

func (s *Service) latestSettlementActionId(c core.Context, uid int64, contractId int64, validation *allocationValidationReport) (*int64, error) {
	if s == nil || s.repository == nil || uid < 1 || contractId < 1 || validation == nil {
		return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	limitReached := false
	for _, reason := range validation.reasonCodes {
		if reason == SERVICE_ERROR_ALLOCATION_LIMIT {
			limitReached = true
			break
		}
	}
	if !limitReached {
		return latestSettlementActionIdFromAllocations(uid, contractId, validation.allocations)
	}

	var latest *TransactionAllocation
	var cursor *AllocationCursor
	for {
		page, err := s.repository.ListAllocations(c, uid, contractId, ALLOCATION_STATUS_ACTIVE, cursor, maximumRepositoryPageSize)
		if err != nil || page == nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		for _, allocation := range page.Items {
			if err := validateLatestSettlementAllocation(uid, contractId, allocation); err != nil {
				return nil, err
			}
			if latest == nil || allocation.CreatedUnixTime > latest.CreatedUnixTime ||
				(allocation.CreatedUnixTime == latest.CreatedUnixTime && allocation.AllocationId > latest.AllocationId) {
				latest = allocation
			}
		}
		if page.NextCursor == nil {
			break
		}
		if cursor != nil && (page.NextCursor.UpdatedUnixTime > cursor.UpdatedUnixTime ||
			(page.NextCursor.UpdatedUnixTime == cursor.UpdatedUnixTime && page.NextCursor.AllocationId >= cursor.AllocationId)) {
			return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}
		cursor = page.NextCursor
	}
	if latest == nil {
		return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	actionId := latest.CreatedActionId
	return &actionId, nil
}

func latestSettlementActionIdFromAllocations(uid int64, contractId int64, allocations []*TransactionAllocation) (*int64, error) {
	var latest *TransactionAllocation
	for _, allocation := range allocations {
		if err := validateLatestSettlementAllocation(uid, contractId, allocation); err != nil {
			return nil, err
		}
		if latest == nil || allocation.CreatedUnixTime > latest.CreatedUnixTime ||
			(allocation.CreatedUnixTime == latest.CreatedUnixTime && allocation.AllocationId > latest.AllocationId) {
			latest = allocation
		}
	}
	if latest == nil {
		return nil, nil
	}
	actionId := latest.CreatedActionId
	return &actionId, nil
}

func validateLatestSettlementAllocation(uid int64, contractId int64, allocation *TransactionAllocation) error {
	if allocation == nil || allocation.Uid != uid || allocation.ContractId != contractId || allocation.Status != ALLOCATION_STATUS_ACTIVE ||
		allocation.AllocationId < 1 || allocation.CreatedActionId < 1 || allocation.CreatedUnixTime < 1 {
		return serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	return nil
}

func contractResult(contract *Contract) *ContractResult {
	if contract == nil {
		return nil
	}
	return &ContractResult{ContractId: contract.ContractId, Name: contract.Name, LenderName: contract.LenderName,
		ContractType: contract.ContractType, LiabilityAccountId: contract.LiabilityAccountId, Status: contract.Status,
		CloseReasonCode: contract.CloseReasonCode, DefaultPaymentAccountId: cloneInt64(contract.DefaultPaymentAccountId),
		Currency: contract.Currency, Note: contract.Note, Version: contract.Version, CurrentRevisionId: contract.CurrentRevisionId,
		CreatedUnixTime: contract.CreatedUnixTime, UpdatedUnixTime: contract.UpdatedUnixTime, ClosedUnixTime: cloneInt64(contract.ClosedUnixTime)}
}

func revisionResult(revision *ContractRevision) *RevisionResult {
	if revision == nil {
		return nil
	}
	return &RevisionResult{RevisionId: revision.RevisionId, ContractId: revision.ContractId, RevisionNumber: revision.RevisionNumber,
		PreviousRevisionId: cloneInt64(revision.PreviousRevisionId), EffectiveDate: revision.EffectiveDate, ContractDate: revision.ContractDate,
		FirstDueDate: revision.FirstDueDate, FundingType: revision.FundingType, InputMode: revision.InputMode,
		RepaymentMethod: revision.RepaymentMethod, RateQuoteType: revision.RateQuoteType, FrequencyType: revision.FrequencyType,
		FrequencyInterval: revision.FrequencyInterval, PrincipalAmount: revision.PrincipalAmount,
		ActualDisbursementAmount: revision.ActualDisbursementAmount, UpfrontFeeAmount: revision.UpfrontFeeAmount,
		PerPeriodFeeAmount: revision.PerPeriodFeeAmount, PaymentBasisAmount: cloneInt64(revision.PaymentBasisAmount),
		TermCount: revision.TermCount, QuotedRatePptr: cloneInt64(revision.QuotedRatePptr), DiscountType: revision.DiscountType,
		DiscountRatePptr: cloneInt64(revision.DiscountRatePptr), DiscountAmount: revision.DiscountAmount,
		CalculationVersion: revision.CalculationVersion, RoundingVersion: revision.RoundingVersion, IrrVersion: revision.IrrVersion,
		PreDiscountTotalPaymentAmount: revision.PreDiscountTotalPaymentAmount, PreDiscountTotalCostAmount: revision.PreDiscountTotalCostAmount,
		TotalPaymentAmount: revision.TotalPaymentAmount, TotalInterestAmount: revision.TotalInterestAmount,
		TotalFeeAmount: revision.TotalFeeAmount, TotalDiscountAmount: revision.TotalDiscountAmount,
		TotalCostAmount: revision.TotalCostAmount, CostRatioPptr: revision.CostRatioPptr, IrrStatus: revision.IrrStatus,
		MonthlyIrrPptr: cloneInt64(revision.MonthlyIrrPptr), SimpleAprPptr: cloneInt64(revision.SimpleAprPptr),
		EffectiveAprPptr: cloneInt64(revision.EffectiveAprPptr), CreatedUnixTime: revision.CreatedUnixTime}
}

func installmentResults(installments []*Installment) []*InstallmentResult {
	results := make([]*InstallmentResult, len(installments))
	for index, installment := range installments {
		if installment == nil {
			continue
		}
		results[index] = &InstallmentResult{InstallmentId: installment.InstallmentId, InstallmentNumber: installment.InstallmentNumber,
			DueDate: installment.DueDate, BeginningPrincipalAmount: installment.BeginningPrincipalAmount,
			PrincipalAmount: installment.PrincipalAmount, InterestAmount: installment.InterestAmount, FeeAmount: installment.FeeAmount,
			DiscountAmount: installment.DiscountAmount, PaymentAmount: installment.PaymentAmount,
			EndingPrincipalAmount: installment.EndingPrincipalAmount, PreDiscountInterestAmount: installment.PreDiscountInterestAmount,
			PreDiscountFeeAmount: installment.PreDiscountFeeAmount, PreDiscountPaymentAmount: installment.PreDiscountPaymentAmount}
	}
	return results
}

func (s *Service) loadAllInstallments(c core.Context, uid int64, contractId int64, revisionId int64) ([]*Installment, error) {
	items := make([]*Installment, 0)
	var cursor *InstallmentCursor
	for {
		page, err := s.repository.ListInstallmentsByRevision(c, uid, contractId, revisionId, cursor, maximumRepositoryPageSize)
		if err != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		items = append(items, page.Items...)
		if page.NextCursor == nil {
			return items, nil
		}
		if cursor != nil && (page.NextCursor.InstallmentNumber < cursor.InstallmentNumber ||
			(page.NextCursor.InstallmentNumber == cursor.InstallmentNumber && page.NextCursor.InstallmentId <= cursor.InstallmentId)) {
			return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}
		cursor = page.NextCursor
	}
}

type allocatedComponents struct {
	principal int64
	interest  int64
	fee       int64
	count     int64
}

func derivePlanProgress(installments []*Installment, aggregates []*AllocationAggregate, asOfDate string) ([]*InstallmentProgress, PlanProgress, PlanRemaining, error) {
	allocated := make(map[int64]*allocatedComponents, len(installments))
	for _, installment := range installments {
		if installment == nil || installment.InstallmentId < 1 || !isCivilDate(installment.DueDate) || allocated[installment.InstallmentId] != nil {
			return nil, PlanProgress{}, PlanRemaining{}, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}
		allocated[installment.InstallmentId] = &allocatedComponents{}
	}
	for _, aggregate := range aggregates {
		if aggregate == nil || aggregate.AllocatedAmount < 0 || aggregate.AllocationCount < 1 {
			return nil, PlanProgress{}, PlanRemaining{}, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}
		if aggregate.ComponentType == COMPONENT_TYPE_DISBURSEMENT || (aggregate.ComponentType == COMPONENT_TYPE_FEE && aggregate.InstallmentId == nil) {
			if aggregate.InstallmentId != nil {
				return nil, PlanProgress{}, PlanRemaining{}, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
			}
			continue
		}
		if aggregate.InstallmentId == nil || allocated[*aggregate.InstallmentId] == nil {
			return nil, PlanProgress{}, PlanRemaining{}, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}
		entry := allocated[*aggregate.InstallmentId]
		var addErr error
		switch aggregate.ComponentType {
		case COMPONENT_TYPE_PRINCIPAL:
			entry.principal, addErr = checkedServiceAdd(entry.principal, aggregate.AllocatedAmount)
		case COMPONENT_TYPE_INTEREST:
			entry.interest, addErr = checkedServiceAdd(entry.interest, aggregate.AllocatedAmount)
		case COMPONENT_TYPE_FEE:
			entry.fee, addErr = checkedServiceAdd(entry.fee, aggregate.AllocatedAmount)
		default:
			return nil, PlanProgress{}, PlanRemaining{}, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}
		if addErr != nil {
			return nil, PlanProgress{}, PlanRemaining{}, addErr
		}
		entry.count, addErr = checkedServiceAdd(entry.count, aggregate.AllocationCount)
		if addErr != nil {
			return nil, PlanProgress{}, PlanRemaining{}, addErr
		}
	}

	rows := make([]*InstallmentProgress, len(installments))
	progress := PlanProgress{InstallmentCount: int64(len(installments))}
	remaining := PlanRemaining{}
	for index, installment := range installments {
		entry := allocated[installment.InstallmentId]
		if entry.principal > installment.PrincipalAmount || entry.interest > installment.InterestAmount || entry.fee > installment.FeeAmount {
			return nil, PlanProgress{}, PlanRemaining{}, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
		}
		components := ComponentProgress{PlannedPrincipalAmount: installment.PrincipalAmount,
			PlannedInterestAmount: installment.InterestAmount, PlannedFeeAmount: installment.FeeAmount,
			AllocatedPrincipalAmount: entry.principal, AllocatedInterestAmount: entry.interest, AllocatedFeeAmount: entry.fee,
			OutstandingPrincipal: installment.PrincipalAmount - entry.principal,
			OutstandingInterest:  installment.InterestAmount - entry.interest, OutstandingFee: installment.FeeAmount - entry.fee}
		outstanding, err := checkedServiceAdd(components.OutstandingPrincipal, components.OutstandingInterest)
		if err != nil {
			return nil, PlanProgress{}, PlanRemaining{}, err
		}
		outstanding, err = checkedServiceAdd(outstanding, components.OutstandingFee)
		if err != nil {
			return nil, PlanProgress{}, PlanRemaining{}, err
		}
		allocatedPayment, err := checkedServiceAdd(entry.principal, entry.interest)
		if err != nil {
			return nil, PlanProgress{}, PlanRemaining{}, err
		}
		allocatedPayment, err = checkedServiceAdd(allocatedPayment, entry.fee)
		if err != nil {
			return nil, PlanProgress{}, PlanRemaining{}, err
		}
		status := INSTALLMENT_PROGRESS_UNPAID
		if entry.count == 0 {
			progress.UnpaidInstallmentCount++
		} else if outstanding == 0 {
			status = INSTALLMENT_PROGRESS_PAID
			progress.PaidInstallmentCount++
		} else {
			status = INSTALLMENT_PROGRESS_PARTIAL
			progress.PartialInstallmentCount++
		}
		overdue := installment.DueDate < asOfDate && outstanding > 0
		if overdue {
			progress.OverdueInstallmentCount++
		}
		if outstanding > 0 && (progress.NextDueDate == nil || installment.DueDate < *progress.NextDueDate) {
			dueDate := installment.DueDate
			progress.NextDueDate = &dueDate
		}
		rows[index] = &InstallmentProgress{InstallmentId: installment.InstallmentId, InstallmentNumber: installment.InstallmentNumber,
			DueDate: installment.DueDate, Status: status, Overdue: overdue, AllocationCount: entry.count,
			Components: components, OutstandingPayment: outstanding}
		progress.AllocatedPaymentAmount, err = checkedServiceAdd(progress.AllocatedPaymentAmount, allocatedPayment)
		if err != nil {
			return nil, PlanProgress{}, PlanRemaining{}, err
		}
		progress.OutstandingPayment, err = checkedServiceAdd(progress.OutstandingPayment, outstanding)
		if err != nil {
			return nil, PlanProgress{}, PlanRemaining{}, err
		}
		progress.OutstandingPrincipal, err = checkedServiceAdd(progress.OutstandingPrincipal, components.OutstandingPrincipal)
		if err != nil {
			return nil, PlanProgress{}, PlanRemaining{}, err
		}
		progress.OutstandingInterest, err = checkedServiceAdd(progress.OutstandingInterest, components.OutstandingInterest)
		if err != nil {
			return nil, PlanProgress{}, PlanRemaining{}, err
		}
		progress.OutstandingFee, err = checkedServiceAdd(progress.OutstandingFee, components.OutstandingFee)
		if err != nil {
			return nil, PlanProgress{}, PlanRemaining{}, err
		}
	}
	remaining = PlanRemaining{PaymentAmount: progress.OutstandingPayment, PrincipalAmount: progress.OutstandingPrincipal,
		InterestAmount: progress.OutstandingInterest, FeeAmount: progress.OutstandingFee}
	return rows, progress, remaining, nil
}

func checkedServiceAdd(left int64, right int64) (int64, error) {
	if left < 0 || right < 0 || left > math.MaxInt64-right {
		return 0, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	return left + right, nil
}

func checkedServiceSubtract(left int64, right int64) (int64, error) {
	if right > 0 && left < math.MinInt64+right {
		return 0, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	return left - right, nil
}
