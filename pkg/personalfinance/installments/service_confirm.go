package installments

import (
	"strconv"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans"
)

func (s *Service) ConfirmCandidate(c core.Context, request ConfirmRequest) (*CandidateView, error) {
	if s == nil || s.repository == nil || request.Uid < 1 || request.CandidateId < 1 || request.ExpectedVersion < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if request.TermCount != nil && *request.TermCount < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_UNKNOWN_ZERO)
	}
	if request.LiabilityAccountId != nil && *request.LiabilityAccountId < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if request.LinkedPurchaseTransactionId != nil && *request.LinkedPurchaseTransactionId < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if request.PurchaseRelation != "" && !isPurchaseRelation(request.PurchaseRelation) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}

	candidate, err := s.repository.FindCandidateById(c, request.Uid, request.CandidateId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if candidate == nil {
		return nil, serviceError(ErrServiceCandidateNotFound, SERVICE_ERROR_CANDIDATE_NOT_FOUND)
	}
	if candidate.Version != request.ExpectedVersion {
		return nil, serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
	}
	if candidate.Status == CANDIDATE_STATUS_CONVERTED || candidate.Status == CANDIDATE_STATUS_DISMISSED {
		return nil, serviceError(ErrServiceStateConflict, SERVICE_ERROR_STATE_CONFLICT)
	}

	next := cloneCandidateForUpdate(candidate)
	now := s.now().Unix()
	next.UpdatedUnixTime = now
	next.Version = candidate.Version + 1

	if !request.TreatAsInstallment {
		next.Status = CANDIDATE_STATUS_DISMISSED
		return s.commitCandidate(c, request, next)
	}

	if request.PurchaseRelation != "" {
		next.PurchaseRelation = request.PurchaseRelation
	}
	if request.LinkedPurchaseTransactionId != nil {
		next.LinkedPurchaseTransactionId = cloneInt64(request.LinkedPurchaseTransactionId)
		next.PurchaseRelation = PURCHASE_RELATION_LINK_EXISTING
	}
	if request.TermCount != nil {
		next.TermCount = cloneInt64(request.TermCount)
	}
	if request.LiabilityAccountId != nil {
		if err := s.validateLiabilityAccount(c, request.Uid, *request.LiabilityAccountId); err != nil {
			return nil, err
		}
		next.LiabilityAccountId = cloneInt64(request.LiabilityAccountId)
	}

	switch {
	case request.LinkedContractId != nil:
		if s.contracts == nil || *request.LinkedContractId < 1 {
			return nil, serviceError(ErrServiceContractRejected, SERVICE_ERROR_CONTRACT_REJECTED)
		}
		asOf := s.now().UTC().Format("2006-01-02")
		detail, err := s.contracts.GetContract(c, request.Uid, *request.LinkedContractId, asOf)
		if err != nil || detail == nil || detail.Contract == nil {
			return nil, serviceError(ErrServiceContractRejected, SERVICE_ERROR_CONTRACT_REJECTED)
		}
		if next.LiabilityAccountId != nil && detail.Contract.LiabilityAccountId != *next.LiabilityAccountId {
			return nil, serviceError(ErrServiceContractRejected, SERVICE_ERROR_CONTRACT_REJECTED)
		}
		if next.LiabilityAccountId == nil {
			liability := detail.Contract.LiabilityAccountId
			next.LiabilityAccountId = &liability
		}
		next.LinkedContractId = cloneInt64(request.LinkedContractId)
		next.Status = CANDIDATE_STATUS_LINKED
	case request.Contract != nil:
		if s.contracts == nil {
			return nil, serviceError(ErrServiceContractRejected, SERVICE_ERROR_CONTRACT_REJECTED)
		}
		if request.Contract.Terms.PrincipalAmount < 1 || request.Contract.Terms.TermCount < 1 {
			return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_UNKNOWN_ZERO)
		}
		if next.LiabilityAccountId == nil && request.Contract.LiabilityAccountId > 0 {
			liability := request.Contract.LiabilityAccountId
			next.LiabilityAccountId = &liability
		}
		result, err := s.contracts.CreateContract(c, loans.CreateContractRequest{
			Uid:            request.Uid,
			Spec:           *request.Contract,
			IdempotencyKey: "installment-candidate-" + strconv.FormatInt(request.CandidateId, 10),
		})
		if err != nil || result == nil || result.Action == nil || result.Action.ContractId < 1 {
			return nil, serviceError(ErrServiceContractRejected, SERVICE_ERROR_CONTRACT_REJECTED)
		}
		contractId := result.Action.ContractId
		next.LinkedContractId = &contractId
		term := request.Contract.Terms.TermCount
		next.TermCount = &term
		next.Status = CANDIDATE_STATUS_CONVERTED
	default:
		next.Status = CANDIDATE_STATUS_NEEDS_DETAILS
	}

	return s.commitCandidate(c, request, next)
}

func (s *Service) commitCandidate(c core.Context, request ConfirmRequest, next *Candidate) (*CandidateView, error) {
	err := s.repository.DoTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
		updated, err := tx.UpdateCandidateCAS(request.ExpectedVersion, next)
		if err != nil {
			return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		if !updated {
			return serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	members, err := s.repository.ListMembers(c, request.Uid, request.CandidateId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	return candidateView(next, members), nil
}

func (s *Service) validateLiabilityAccount(c core.Context, uid int64, accountId int64) error {
	if s.accounts == nil {
		return nil
	}
	snapshots, err := s.accounts.LoadAccountSnapshots(c, uid, []int64{accountId})
	if err != nil || len(snapshots) != 1 {
		return serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_REJECTED)
	}
	snapshot := snapshots[0]
	if snapshot.Uid != uid || snapshot.AccountId != accountId || snapshot.Deleted || snapshot.Hidden || !snapshot.Single {
		return serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_REJECTED)
	}
	if snapshot.Kind != loans.ACCOUNT_KIND_CREDIT_CARD && snapshot.Kind != loans.ACCOUNT_KIND_DEBT {
		return serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_REJECTED)
	}
	return nil
}
