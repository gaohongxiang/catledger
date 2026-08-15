package installments

import "github.com/mayswind/ezbookkeeping/pkg/core"

func (s *Service) ListCandidates(c core.Context, uid int64, status CandidateStatus, cursor *CandidateCursor, limit int) (*CandidateListResult, error) {
	if s == nil || s.repository == nil || uid < 1 || !isCandidateStatus(status) || !isValidPageLimit(limit) || !isValidCandidateCursor(cursor) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	page, err := s.repository.ListCandidates(c, uid, status, cursor, limit)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	result := &CandidateListResult{NextCursor: page.NextCursor, Items: make([]*CandidateView, 0, len(page.Items))}
	for _, candidate := range page.Items {
		members, memberErr := s.repository.ListMembers(c, uid, candidate.CandidateId)
		if memberErr != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		result.Items = append(result.Items, candidateView(candidate, members))
	}
	return result, nil
}

func (s *Service) GetCandidate(c core.Context, uid int64, candidateId int64) (*CandidateView, error) {
	if s == nil || s.repository == nil || uid < 1 || candidateId < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	candidate, err := s.repository.FindCandidateById(c, uid, candidateId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if candidate == nil {
		return nil, serviceError(ErrServiceCandidateNotFound, SERVICE_ERROR_CANDIDATE_NOT_FOUND)
	}
	members, err := s.repository.ListMembers(c, uid, candidateId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	return candidateView(candidate, members), nil
}
