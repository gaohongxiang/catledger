package loans

import (
	"time"

	"github.com/gaohongxiang/catledger/pkg/core"
)

type settlementPlanSelection struct {
	contract    *Contract
	revision    *ContractRevision
	installment *Installment
	validation  *allocationValidationReport
	planned     int64
	allocated   int64
	outstanding int64
}

func (s *Service) loadSettlementPlan(c core.Context, tx *RepositoryTransaction, uid int64, contractId int64, installmentId *int64, component ComponentType) (*settlementPlanSelection, error) {
	if s == nil || s.repository == nil || uid < 1 || contractId < 1 || !isComponentType(component) || !isNilOrPositive(installmentId) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	var contract *Contract
	var err error
	if tx == nil {
		contract, err = s.repository.FindContractById(c, uid, contractId)
	} else {
		contract, err = tx.FindContractById(contractId)
	}
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if contract == nil {
		return nil, serviceError(ErrServiceContractNotFound, SERVICE_ERROR_CONTRACT_NOT_FOUND)
	}
	var revision *ContractRevision
	if tx == nil {
		revision, err = s.repository.FindRevisionById(c, uid, contract.CurrentRevisionId)
	} else {
		revision, err = tx.FindRevisionById(contract.CurrentRevisionId)
	}
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if revision == nil || revision.Uid != uid || revision.ContractId != contractId || revision.RevisionId != contract.CurrentRevisionId {
		return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	var baseline *ProgressBaseline
	if tx == nil {
		baseline, err = s.repository.FindProgressBaselineByRevisionId(c, uid, revision.RevisionId)
	} else {
		baseline, err = tx.FindProgressBaselineByRevisionId(revision.RevisionId)
	}
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	openingCompleted := completedInstallmentCount(baseline)
	if openingCompleted < 0 || openingCompleted >= revision.TermCount {
		return nil, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}

	selection := &settlementPlanSelection{contract: contract, revision: revision}
	installments := make([]*Installment, 0, 1)
	if component == COMPONENT_TYPE_DISBURSEMENT {
		if installmentId != nil || revision.FundingType != FUNDING_TYPE_CASH_DISBURSEMENT {
			return nil, serviceError(ErrServiceSettlementRejected, SERVICE_ERROR_COMPONENT_MISMATCH)
		}
		selection.planned = revision.PrincipalAmount
	} else if component == COMPONENT_TYPE_FEE && installmentId == nil {
		selection.planned = revision.UpfrontFeeAmount
	} else {
		if installmentId == nil {
			return nil, serviceError(ErrServiceSettlementRejected, SERVICE_ERROR_INSTALLMENT_NOT_FOUND)
		}
		if tx == nil {
			selection.installment, err = s.repository.FindInstallmentById(c, uid, *installmentId)
		} else {
			selection.installment, err = tx.FindInstallmentById(*installmentId)
		}
		if err != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		if selection.installment == nil || selection.installment.ContractId != contractId || selection.installment.RevisionId != revision.RevisionId {
			return nil, serviceError(ErrServiceSettlementRejected, SERVICE_ERROR_INSTALLMENT_NOT_FOUND)
		}
		if selection.installment.InstallmentNumber <= openingCompleted {
			return nil, serviceError(ErrServiceSettlementRejected, SERVICE_ERROR_COMPONENT_MISMATCH)
		}
		installments = append(installments, selection.installment)
		switch component {
		case COMPONENT_TYPE_PRINCIPAL:
			selection.planned = selection.installment.PrincipalAmount
		case COMPONENT_TYPE_INTEREST:
			selection.planned = selection.installment.InterestAmount
		case COMPONENT_TYPE_FEE:
			selection.planned = selection.installment.FeeAmount
		}
	}
	selection.validation, err = s.validateActiveAllocations(c, tx, contract, revision, installments)
	if err != nil {
		return nil, err
	}
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
		var addErr error
		selection.allocated, addErr = checkedServiceAdd(selection.allocated, aggregate.AllocatedAmount)
		if addErr != nil {
			return nil, addErr
		}
	}
	if selection.planned < 0 || selection.allocated > selection.planned {
		return nil, serviceError(ErrServiceSettlementRejected, SERVICE_ERROR_AMOUNT_EXCEEDED)
	}
	selection.outstanding = selection.planned - selection.allocated
	return selection, nil
}

func settlementReferenceDate(selection *settlementPlanSelection, component ComponentType) (time.Time, error) {
	date := ""
	if selection != nil && selection.revision != nil {
		if component == COMPONENT_TYPE_DISBURSEMENT || (component == COMPONENT_TYPE_FEE && selection.installment == nil) {
			date = selection.revision.EffectiveDate
		} else if selection.installment != nil {
			date = selection.installment.DueDate
		}
	}
	value, err := time.Parse("2006-01-02", date)
	if err != nil {
		return time.Time{}, serviceError(ErrServiceInvariantViolation, SERVICE_ERROR_INVARIANT)
	}
	return value.UTC(), nil
}
