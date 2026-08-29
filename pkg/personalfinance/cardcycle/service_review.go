package cardcycle

import (
	"github.com/gaohongxiang/catledger/pkg/core"
)

func (s *Service) SaveBalanceReview(c core.Context, request SaveBalanceReviewRequest) (*BalanceReviewView, error) {
	if s == nil || request.Uid < 1 || request.LedgerAccountId < 1 || !isValidIdempotencyKey(request.IdempotencyKey) ||
		request.ExpectedVersion < 0 || !isValidBalanceReviewState(request.Status, request.AsOfDate) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if _, err := s.loadAccount(c, request.Uid, request.LedgerAccountId); err != nil {
		return nil, err
	}

	var saved *BalanceReview
	now := s.now().Unix()
	if now < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	err := s.repository.DoTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
		existing, findErr := tx.FindBalanceReviewByAccount(request.LedgerAccountId)
		if findErr != nil {
			return persistError(findErr)
		}
		if existing == nil {
			if request.ExpectedVersion != 0 {
				return serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
			}
			review := &BalanceReview{
				Uid: request.Uid, LedgerAccountId: request.LedgerAccountId, Status: request.Status,
				AsOfDate: request.AsOfDate, Version: 1, UpdatedUnixTime: now, ReviewId: s.generateId(),
			}
			if review.ReviewId < 1 {
				return serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
			}
			if insertErr := tx.InsertBalanceReview(review); insertErr != nil {
				return persistError(insertErr)
			}
			saved = review
			return nil
		}
		if existing.Status == request.Status && existing.AsOfDate == request.AsOfDate {
			saved = existing
			return nil
		}
		if request.ExpectedVersion < 1 || request.ExpectedVersion != existing.Version {
			return serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
		}
		next := &BalanceReview{
			Uid: existing.Uid, LedgerAccountId: existing.LedgerAccountId, Status: request.Status,
			AsOfDate: request.AsOfDate, Version: existing.Version + 1, UpdatedUnixTime: now, ReviewId: existing.ReviewId,
		}
		updated, casErr := tx.UpdateBalanceReviewCAS(existing.Version, next)
		if casErr != nil {
			return persistError(casErr)
		}
		if !updated {
			return serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
		}
		saved = next
		return nil
	})
	if err != nil {
		return nil, err
	}
	return balanceReviewView(saved), nil
}
