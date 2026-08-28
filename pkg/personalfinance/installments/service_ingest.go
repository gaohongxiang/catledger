package installments

import (
	"strconv"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

type ingestGroup struct {
	key     string
	rows    []*importing.RawImportRow
	periods []*int64
	terms   []*int64
	roles   []MemberRole
}

func (s *Service) IngestBatches(c core.Context, request IngestRequest) (*IngestResult, error) {
	if s == nil || s.repository == nil || s.evidence == nil || request.Uid < 1 || len(request.BatchIds) < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}

	groups := make(map[string]*ingestGroup)
	order := make([]string, 0)
	skipped := int64(0)
	for _, batchId := range request.BatchIds {
		if batchId < 1 {
			return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		rows, err := s.evidence.ListRawImportRows(c, request.Uid, batchId)
		if err != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		for _, row := range rows {
			if row == nil || row.Uid != request.Uid || row.RowId < 1 {
				skipped++
				continue
			}
			evidence := Evidence{
				RowId: row.RowId, IdentityId: row.IdentityId, SourceOrderId: row.SourceOrderId,
				SourceMerchantId: row.SourceMerchantOrderId, RawTransactionType: row.RawTransactionType,
				RawCounterparty: row.RawCounterparty, RawItem: row.RawItem, RawNote: row.RawNote,
				LedgerAccountId: row.LedgerAccountId,
			}
			detection := detectInstallment(evidence)
			if !detection.Matched {
				skipped++
				continue
			}
			key := candidateKey(evidence, detection)
			if key == "" {
				skipped++
				continue
			}
			group := groups[key]
			if group == nil {
				group = &ingestGroup{key: key}
				groups[key] = group
				order = append(order, key)
			}
			group.rows = append(group.rows, row)
			group.periods = append(group.periods, detection.PeriodNumber)
			group.terms = append(group.terms, detection.TermCount)
			group.roles = append(group.roles, memberRoleForDetection(detection))
		}
	}

	result := &IngestResult{SkippedCount: skipped}
	for _, key := range order {
		group := groups[key]
		created, members, err := s.persistGroup(c, request.Uid, group)
		if err != nil {
			return nil, err
		}
		if created {
			result.CandidateCount++
		}
		result.MemberCount += members
	}
	return result, nil
}

func (s *Service) persistGroup(c core.Context, uid int64, group *ingestGroup) (bool, int64, error) {
	now := s.now().Unix()
	var created bool
	var added int64
	err := s.repository.DoTransaction(c, uid, func(tx *RepositoryTransaction) error {
		candidate, wasCreated, err := tx.CreateOrFindCandidate(&Candidate{
			Uid: uid, CandidateKey: group.key, CandidateKeyVersion: CANDIDATE_KEY_VERSION_V1,
			Status: CANDIDATE_STATUS_PENDING, Version: 1, PurchaseRelation: PURCHASE_RELATION_UNRESOLVED,
			CreatedUnixTime: now, UpdatedUnixTime: now, CandidateId: s.generateId(),
		})
		if err != nil {
			return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		created = wasCreated
		existing, err := tx.ListMembers(candidate.CandidateId)
		if err != nil {
			return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		known := make(map[string]struct{}, len(existing))
		periodOwners := make(map[int64]int64, len(existing))
		for _, member := range existing {
			known[memberKey(member.MemberKind, member.MemberRefId)] = struct{}{}
			if member.PeriodNumber != nil {
				periodOwners[*member.PeriodNumber] = member.MemberRefId
			}
		}

		conflict := disagreedPositive(group.terms) || disagreedLiability(group.rows)
		agreedTerm := agreedPositive(group.terms)
		agreedLiability := agreedLiability(group.rows)
		if candidate.TermCount != nil {
			for _, term := range group.terms {
				if term != nil && *term != *candidate.TermCount {
					conflict = true
					break
				}
			}
		}
		if candidate.LiabilityAccountId != nil && agreedLiability != nil && *candidate.LiabilityAccountId != *agreedLiability {
			conflict = true
		}

		for index, row := range group.rows {
			period := group.periods[index]
			role := group.roles[index]
			if period != nil {
				if owner, exists := periodOwners[*period]; exists && owner != row.RowId {
					conflict = true
				} else {
					periodOwners[*period] = row.RowId
				}
			}
			if _, exists := known[memberKey(MEMBER_KIND_RAW_ROW, row.RowId)]; exists {
				continue
			}
			if err := tx.InsertMember(&CandidateMember{
				Uid: uid, CandidateId: candidate.CandidateId, MemberKind: MEMBER_KIND_RAW_ROW,
				MemberRefId: row.RowId, MemberRole: role, PeriodNumber: cloneInt64(period),
				CreatedUnixTime: now, MemberId: s.generateId(),
			}); err != nil {
				return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
			}
			known[memberKey(MEMBER_KIND_RAW_ROW, row.RowId)] = struct{}{}
			added++
			if row.IdentityId != nil && *row.IdentityId > 0 {
				if _, exists := known[memberKey(MEMBER_KIND_SOURCE_IDENTITY, *row.IdentityId)]; exists {
					continue
				}
				if err := tx.InsertMember(&CandidateMember{
					Uid: uid, CandidateId: candidate.CandidateId, MemberKind: MEMBER_KIND_SOURCE_IDENTITY,
					MemberRefId: *row.IdentityId, MemberRole: role, PeriodNumber: cloneInt64(period),
					CreatedUnixTime: now, MemberId: s.generateId(),
				}); err != nil {
					return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
				}
				known[memberKey(MEMBER_KIND_SOURCE_IDENTITY, *row.IdentityId)] = struct{}{}
				added++
			}
		}

		next := cloneCandidateForUpdate(candidate)
		changed := false
		if candidate.TermCount == nil && agreedTerm != nil {
			next.TermCount = cloneInt64(agreedTerm)
			changed = true
		}
		if candidate.LiabilityAccountId == nil && agreedLiability != nil {
			next.LiabilityAccountId = cloneInt64(agreedLiability)
			changed = true
		}
		if maxPeriod := maxPositive(group.periods); maxPeriod != nil && (candidate.CurrentPeriod == nil || *candidate.CurrentPeriod < *maxPeriod) {
			next.CurrentPeriod = cloneInt64(maxPeriod)
			changed = true
		}
		if conflict && candidate.Status != CANDIDATE_STATUS_DISMISSED && candidate.Status != CANDIDATE_STATUS_ACTION_REQUIRED {
			next.Status = CANDIDATE_STATUS_ACTION_REQUIRED
			changed = true
		}
		if !changed {
			return nil
		}
		next.Version = candidate.Version + 1
		next.UpdatedUnixTime = now
		updated, err := tx.UpdateCandidateCAS(candidate.Version, next)
		if err != nil {
			return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		if !updated {
			return serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
		}
		return nil
	})
	if err != nil {
		return false, 0, err
	}
	return created, added, nil
}

func memberRoleForDetection(detection Detection) MemberRole {
	switch detection.Component {
	case COMPONENT_TYPE_PRINCIPAL:
		return MEMBER_ROLE_PRINCIPAL
	case COMPONENT_TYPE_INTEREST:
		return MEMBER_ROLE_INTEREST
	case COMPONENT_TYPE_FEE:
		return MEMBER_ROLE_FEE
	default:
		return MEMBER_ROLE_INSTALLMENT_CHARGE
	}
}

func memberKey(kind MemberKind, refId int64) string {
	return string(kind) + ":" + strconv.FormatInt(refId, 10)
}

func agreedPositive(values []*int64) *int64 {
	var agreed *int64
	for _, value := range values {
		if value == nil {
			continue
		}
		if agreed == nil {
			copied := *value
			agreed = &copied
			continue
		}
		if *agreed != *value {
			return nil
		}
	}
	return agreed
}

func disagreedPositive(values []*int64) bool {
	var seen *int64
	for _, value := range values {
		if value == nil {
			continue
		}
		if seen == nil {
			copied := *value
			seen = &copied
			continue
		}
		if *seen != *value {
			return true
		}
	}
	return false
}

func disagreedLiability(rows []*importing.RawImportRow) bool {
	var seen *int64
	for _, row := range rows {
		if row == nil || row.LedgerAccountId == nil || *row.LedgerAccountId < 1 {
			continue
		}
		if seen == nil {
			copied := *row.LedgerAccountId
			seen = &copied
			continue
		}
		if *seen != *row.LedgerAccountId {
			return true
		}
	}
	return false
}

func agreedLiability(rows []*importing.RawImportRow) *int64 {
	var agreed *int64
	for _, row := range rows {
		if row == nil || row.LedgerAccountId == nil || *row.LedgerAccountId < 1 {
			continue
		}
		if agreed == nil {
			copied := *row.LedgerAccountId
			agreed = &copied
			continue
		}
		if *agreed != *row.LedgerAccountId {
			return nil
		}
	}
	return agreed
}

func maxPositive(values []*int64) *int64 {
	var max *int64
	for _, value := range values {
		if value == nil {
			continue
		}
		if max == nil || *value > *max {
			copied := *value
			max = &copied
		}
	}
	return max
}
