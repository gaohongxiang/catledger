package installments

import (
	"encoding/json"
	"sort"
	"strconv"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/loans"
)

// DiscardContractDrafts 清理由被放弃整理轮次暂存、但从未生效的合同表单。
// 它不删除候选、原始证据或任何正式合同。
func (s *Service) DiscardContractDrafts(c core.Context, uid int64, candidateIds []int64) error {
	if s == nil || s.repository == nil || uid < 1 || len(candidateIds) < 1 {
		return serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	ids := append([]int64(nil), candidateIds...)
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for index, candidateId := range ids {
		if candidateId < 1 || (index > 0 && candidateId == ids[index-1]) {
			return serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
	}
	if err := s.repository.DeleteContractDrafts(c, uid, ids); err != nil {
		return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	return nil
}

// PromoteAfterPosting 只在所属账单整批入账成功后调用。
// 已暂存完整合同信息时创建正式合同；没有草稿时才退回 needs_details。
func (s *Service) PromoteAfterPosting(c core.Context, request PromoteRequest) error {
	if s == nil || s.repository == nil || request.Uid < 1 || len(request.CandidateIds) < 1 {
		return serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	ids := append([]int64(nil), request.CandidateIds...)
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for index, candidateId := range ids {
		if candidateId < 1 || (index > 0 && candidateId == ids[index-1]) {
			return serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
	}
	for _, candidateId := range ids {
		candidate, err := s.repository.FindCandidateById(c, request.Uid, candidateId)
		if err != nil {
			return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		if candidate == nil {
			return serviceError(ErrServiceCandidateNotFound, SERVICE_ERROR_CANDIDATE_NOT_FOUND)
		}
		switch candidate.Status {
		case CANDIDATE_STATUS_PENDING:
			draft, draftErr := s.repository.FindContractDraft(c, request.Uid, candidateId)
			if draftErr != nil {
				return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
			}
			if draft != nil {
				if s.contracts == nil {
					return serviceError(ErrServiceContractRejected, SERVICE_ERROR_CONTRACT_REJECTED)
				}
				var spec loans.ContractSpec
				if json.Unmarshal([]byte(draft.ContractSpecJson), &spec) != nil {
					return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
				}
				result, createErr := s.contracts.CreateContract(c, loans.CreateContractRequest{
					Uid: request.Uid, Spec: spec,
					IdempotencyKey: "installment-candidate-" + strconv.FormatInt(candidateId, 10),
				})
				if createErr != nil || result == nil || result.Action == nil || result.Action.ContractId < 1 {
					return serviceError(ErrServiceContractRejected, SERVICE_ERROR_CONTRACT_REJECTED)
				}
				next := cloneCandidateForUpdate(candidate)
				contractId := result.Action.ContractId
				next.LinkedContractId = &contractId
				termCount := spec.Terms.TermCount
				next.TermCount = &termCount
				liability := spec.LiabilityAccountId
				next.LiabilityAccountId = &liability
				next.Status = CANDIDATE_STATUS_CONVERTED
				next.Version = candidate.Version + 1
				next.UpdatedUnixTime = s.now().Unix()
				if _, err = s.commitCandidate(c, ConfirmRequest{Uid: request.Uid, CandidateId: candidateId, ExpectedVersion: candidate.Version}, next); err != nil {
					return err
				}
				if err = s.repository.DeleteContractDraft(c, request.Uid, candidateId); err != nil {
					return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
				}
				continue
			}
			next := cloneCandidateForUpdate(candidate)
			next.Status = CANDIDATE_STATUS_NEEDS_DETAILS
			next.Version = candidate.Version + 1
			next.UpdatedUnixTime = s.now().Unix()
			if _, err = s.commitCandidate(c, ConfirmRequest{Uid: request.Uid, CandidateId: candidateId, ExpectedVersion: candidate.Version}, next); err != nil {
				return err
			}
		case CANDIDATE_STATUS_CONVERTED:
			if err = s.repository.DeleteContractDraft(c, request.Uid, candidateId); err != nil {
				return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
			}
		case CANDIDATE_STATUS_NEEDS_DETAILS, CANDIDATE_STATUS_LINKED, CANDIDATE_STATUS_DISMISSED:
			// 已执行或用户已明确处理的状态均不反向覆盖。
		case CANDIDATE_STATUS_ACTION_REQUIRED:
			return serviceError(ErrServiceStateConflict, SERVICE_ERROR_STATE_CONFLICT)
		default:
			return serviceError(ErrServiceStateConflict, SERVICE_ERROR_STATE_CONFLICT)
		}
	}
	return nil
}

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
	if request.Contract != nil && candidate.Status == CANDIDATE_STATUS_PENDING {
		if !request.TreatAsInstallment || s.contracts == nil || request.Contract.Terms.PrincipalAmount < 1 || request.Contract.Terms.TermCount < 1 {
			return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_UNKNOWN_ZERO)
		}
		if candidate.LiabilityAccountId != nil && request.Contract.LiabilityAccountId != *candidate.LiabilityAccountId {
			return nil, serviceError(ErrServiceContractRejected, SERVICE_ERROR_CONTRACT_REJECTED)
		}
		if err := s.validateLiabilityAccount(c, request.Uid, request.Contract.LiabilityAccountId); err != nil {
			return nil, err
		}
		if _, err := s.contracts.Calculate(loans.CalculateRequest{Terms: request.Contract.Terms}); err != nil {
			return nil, serviceError(ErrServiceContractRejected, SERVICE_ERROR_CONTRACT_REJECTED)
		}
		encoded, err := json.Marshal(request.Contract)
		if err != nil {
			return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		now := s.now().Unix()
		err = s.repository.DoTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
			current, findErr := tx.FindCandidateById(request.CandidateId)
			if findErr != nil || current == nil || current.Version != request.ExpectedVersion || current.Status != CANDIDATE_STATUS_PENDING {
				return serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
			}
			return tx.SaveContractDraft(&ContractDraft{
				Uid: request.Uid, CandidateId: request.CandidateId, Version: 1,
				ContractSpecJson: string(encoded), CreatedUnixTime: now, UpdatedUnixTime: now, DraftId: s.generateId(),
			})
		})
		if err != nil {
			return nil, err
		}
		members, listErr := s.repository.ListMembers(c, request.Uid, request.CandidateId)
		if listErr != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		return candidateView(candidate, members), nil
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
