package reconciliation

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/uuid"
)

const (
	candidateAnchorPageSize     = 100
	candidateMaximumAnchorPages = 10
	candidateSearchLimitPerSide = 64
	candidateMaximumPerAnchor   = 5
	candidateMaximumCases       = 200
	candidateTimeWindowSeconds  = int64(72 * time.Hour / time.Second)

	candidateMemberRoleEvidence MemberRole = "evidence"
)

const (
	candidateReasonAmountCurrencyExact = "amount_currency_exact"
	candidateReasonIdentifierMatch     = "identifier_match"
	candidateReasonLedgerAccountMatch  = "ledger_account_match"
	candidateReasonOppositeDirection   = "opposite_direction"
	candidateReasonPaymentMethodMatch  = "payment_method_match"
	candidateReasonRefundSignal        = "refund_signal"
	candidateReasonSameDirection       = "same_direction"
	candidateReasonTextSimilarity      = "text_similarity"
	candidateReasonTimeDistance        = "time_distance_seconds"
	candidateReasonTimeProximity       = "time_proximity"
	candidateReasonTransferSignal      = "transfer_signal"
)

// CandidateIdGenerator 只提供 PF 共享类型的 ID；候选服务不占用新的 UUID 类型。
type CandidateIdGenerator interface {
	GenerateUuid(uuidType uuid.UuidType) int64
}

// GenerateCandidatesRequest 以当前用户及一个不可变导入批次作为候选锚点。
// 分页、窗口和数量限制全部由服务端固定，调用方不能放大扫描范围。
type GenerateCandidatesRequest struct {
	Uid     int64
	BatchId int64
}

// GenerateCandidatesResult 返回本次有界扫描命中的稳定 case。
type GenerateCandidatesResult struct {
	Cases                []*Case
	EvaluatedAnchorCount int64
	LimitReached         bool
}

// CandidateService 只读取导入证据并持久化 case/member；它不依赖账本写入能力。
type CandidateService struct {
	repository  *candidateRepository
	idGenerator CandidateIdGenerator
	now         func() time.Time
}

// NewCandidateService 创建跨来源候选服务。
func NewCandidateService(store *datastore.DataStore, idGenerator CandidateIdGenerator) (*CandidateService, error) {
	repository, err := newCandidateRepository(store)

	if err != nil {
		return nil, err
	}

	if idGenerator == nil {
		return nil, fmt.Errorf("reconciliation candidate id generator is required")
	}

	return &CandidateService{
		repository:  repository,
		idGenerator: idGenerator,
		now:         time.Now,
	}, nil
}

// GenerateCandidates 先执行金额、币种和时间窗硬过滤，再计算解释和建议关系。
// 持久化只会新建 case/member，或刷新没有人工决定的 open case。
func (s *CandidateService) GenerateCandidates(c core.Context, request GenerateCandidatesRequest) (*GenerateCandidatesResult, error) {
	if s == nil || s.repository == nil || s.idGenerator == nil || s.now == nil || request.Uid < 1 || request.BatchId < 1 {
		return nil, fmt.Errorf("invalid reconciliation candidate request")
	}

	anchorBatch, err := s.repository.findAnchorBatch(c, request.Uid, request.BatchId)

	if err != nil {
		return nil, err
	}

	if anchorBatch == nil {
		return nil, fmt.Errorf("reconciliation anchor batch was not found")
	}

	if anchorBatch.SourceAccountId == nil || *anchorBatch.SourceAccountId < 1 {
		return nil, fmt.Errorf("reconciliation anchor batch has no source account")
	}

	selected := make(map[string]*candidateEvaluation)
	evaluatedAnchors := int64(0)
	limitReached := false

	for page := 0; page < candidateMaximumAnchorPages; page++ {
		anchors, findErr := s.repository.listEligibleAnchorRows(
			c,
			request.Uid,
			request.BatchId,
			page*candidateAnchorPageSize,
			candidateAnchorPageSize,
		)

		if findErr != nil {
			return nil, findErr
		}

		if len(anchors) == 0 {
			break
		}

		for _, anchor := range anchors {
			evaluatedAnchors++
			matches, matchErr := s.candidatesForAnchor(c, request.Uid, *anchorBatch.SourceAccountId, anchor)

			if matchErr != nil {
				return nil, matchErr
			}

			for _, match := range matches {
				if current := selected[match.caseKey]; current == nil || candidateEvaluationLess(match, current) {
					selected[match.caseKey] = match
				}
			}

			if len(selected) >= candidateMaximumCases {
				limitReached = true
				break
			}
		}

		if limitReached {
			break
		}

		if len(anchors) < candidateAnchorPageSize {
			break
		}

		if page+1 == candidateMaximumAnchorPages {
			limitReached = true
		}
	}

	evaluations := make([]*candidateEvaluation, 0, len(selected))

	for _, evaluation := range selected {
		evaluations = append(evaluations, evaluation)
	}

	sort.Slice(evaluations, func(i, j int) bool {
		return candidateEvaluationLess(evaluations[i], evaluations[j])
	})

	if len(evaluations) > candidateMaximumCases {
		evaluations = evaluations[:candidateMaximumCases]
		limitReached = true
	}

	now := s.now().Unix()

	if now < 1 {
		return nil, fmt.Errorf("invalid reconciliation candidate clock")
	}

	persistences := make([]*candidatePersistence, 0, len(evaluations))

	for _, evaluation := range evaluations {
		persistence, persistenceErr := s.newCandidatePersistence(request.Uid, evaluation, now)

		if persistenceErr != nil {
			return nil, persistenceErr
		}

		persistences = append(persistences, persistence)
	}

	cases, err := s.repository.persistCandidates(c, request.Uid, persistences)

	if err != nil {
		return nil, err
	}

	return &GenerateCandidatesResult{
		Cases:                cases,
		EvaluatedAnchorCount: evaluatedAnchors,
		LimitReached:         limitReached,
	}, nil
}

func (s *CandidateService) candidatesForAnchor(c core.Context, uid int64, anchorSourceAccountId int64, anchor *importing.RawImportRow) ([]*candidateEvaluation, error) {
	if !isCandidateAnchorRow(anchor) {
		return nil, fmt.Errorf("invalid reconciliation candidate anchor")
	}

	rows, err := s.repository.listHardFilteredCandidates(c, uid, anchorSourceAccountId, anchor, candidateSearchLimitPerSide)

	if err != nil {
		return nil, err
	}

	unique := make(map[string]*candidateEvaluation)

	for _, row := range rows {
		if !CrossSourceComparisonMatch(anchor, row, candidateTimeWindowSeconds) {
			continue
		}
		evaluation, evaluationErr := evaluateCandidatePair(anchor, row)

		if evaluationErr != nil {
			return nil, evaluationErr
		}

		if current := unique[evaluation.caseKey]; current == nil || candidateEvaluationLess(evaluation, current) {
			unique[evaluation.caseKey] = evaluation
		}
	}
	if anchor.EconomicEffect == importing.ECONOMIC_EFFECT_REFUND {
		refundRows, refundErr := s.repository.listExplicitRefundCandidates(c, uid, anchorSourceAccountId, anchor, candidateSearchLimitPerSide)
		if refundErr != nil {
			return nil, refundErr
		}
		for _, row := range refundRows {
			if !explicitSourceRefundMatch(anchor, row) {
				continue
			}
			evaluation, evaluationErr := evaluateSourceRefundPair(anchor, row)
			if evaluationErr != nil {
				return nil, evaluationErr
			}
			if current := unique[evaluation.caseKey]; current == nil || candidateEvaluationLess(evaluation, current) {
				unique[evaluation.caseKey] = evaluation
			}
		}
	}

	result := make([]*candidateEvaluation, 0, len(unique))

	for _, evaluation := range unique {
		result = append(result, evaluation)
	}

	sort.Slice(result, func(i, j int) bool {
		return candidateEvaluationLess(result[i], result[j])
	})

	if len(result) > candidateMaximumPerAnchor {
		result = result[:candidateMaximumPerAnchor]
	}

	return result, nil
}

func evaluateSourceRefundPair(first *importing.RawImportRow, second *importing.RawImportRow) (*candidateEvaluation, error) {
	if !explicitSourceRefundMatch(first, second) {
		return nil, fmt.Errorf("reconciliation source refund pair did not pass explicit filters")
	}
	firstToken, err := candidateMemberTokenForRow(first)
	if err != nil {
		return nil, err
	}
	secondToken, err := candidateMemberTokenForRow(second)
	if err != nil {
		return nil, err
	}
	members := []candidateMemberToken{firstToken, secondToken}
	sort.Slice(members, func(i, j int) bool { return candidateMemberTokenLess(members[i], members[j]) })
	if members[0] == members[1] {
		return nil, fmt.Errorf("reconciliation source refund members must be distinct")
	}
	distance := absoluteInt64(*first.NormalizedUnixTime - *second.NormalizedUnixTime)
	reasons := []candidateReason{
		{Code: candidateReasonRefundSignal, Value: 40},
		{Code: candidateReasonTimeDistance, Value: distance},
		{Code: candidateReasonTimeProximity, Value: candidateTimeScore(distance)},
		{Code: candidateReasonTextSimilarity, Value: 10},
	}
	sort.Slice(reasons, func(i, j int) bool { return reasons[i].Code < reasons[j].Code })
	reasonCodesJSON, err := json.Marshal(reasons)
	if err != nil {
		return nil, fmt.Errorf("encode reconciliation refund reasons: %w", err)
	}
	return &candidateEvaluation{
		caseKey:               computeCandidateCaseKey(members),
		members:               members,
		suggestedRelationType: DECISION_TYPE_REFUND_REVERSAL,
		score:                 100,
		reasonCodesJSON:       string(reasonCodesJSON),
		anchorRowId:           first.RowId,
		candidateRowId:        second.RowId,
	}, nil
}

func explicitSourceRefundMatch(first *importing.RawImportRow, second *importing.RawImportRow) bool {
	if first == nil || second == nil || first.NormalizedAmount == nil || second.NormalizedAmount == nil ||
		first.NormalizedUnixTime == nil || second.NormalizedUnixTime == nil || first.Currency == "" || first.Currency != second.Currency ||
		first.EconomicEffect != importing.ECONOMIC_EFFECT_REFUND || second.EconomicEffect != importing.ECONOMIC_EFFECT_REFUND {
		return false
	}
	original, refund := first, second
	if original.NormalizedDirection != importing.NORMALIZED_DIRECTION_EXPENSE || refund.NormalizedDirection != importing.NORMALIZED_DIRECTION_INCOME {
		original, refund = second, first
	}
	if original.NormalizedDirection != importing.NORMALIZED_DIRECTION_EXPENSE || refund.NormalizedDirection != importing.NORMALIZED_DIRECTION_INCOME ||
		*refund.NormalizedUnixTime < *original.NormalizedUnixTime || *refund.NormalizedUnixTime-*original.NormalizedUnixTime > candidateTimeWindowSeconds ||
		*refund.NormalizedAmount < 1 || *refund.NormalizedAmount > *original.NormalizedAmount {
		return false
	}
	expectedRefund, ok := explicitRefundAmountFromStatus(original.RawStatus)
	if !ok || expectedRefund != *refund.NormalizedAmount {
		return false
	}
	left := normalizedEvidenceText(original.RawCounterparty)
	right := normalizedEvidenceText(refund.RawCounterparty)
	return left != "" && left == right
}

// ExplicitSourceRefundMatch 暴露给同一任务编排使用与候选生成完全一致的明确退款规则。
func ExplicitSourceRefundMatch(first *importing.RawImportRow, second *importing.RawImportRow) bool {
	return explicitSourceRefundMatch(first, second)
}

func explicitRefundAmountFromStatus(status string) (int64, bool) {
	status = strings.TrimSpace(status)
	index := strings.IndexAny(status, "¥￥")
	if index < 0 || index+1 >= len(status) {
		return 0, false
	}
	var number strings.Builder
	dotSeen := false
	for _, char := range status[index+1:] {
		if char >= '0' && char <= '9' {
			number.WriteRune(char)
			continue
		}
		if char == '.' && !dotSeen {
			dotSeen = true
			number.WriteRune(char)
			continue
		}
		if number.Len() > 0 {
			break
		}
	}
	parts := strings.Split(number.String(), ".")
	if len(parts) < 1 || len(parts) > 2 || parts[0] == "" {
		return 0, false
	}
	whole, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || whole < 0 || whole > (1<<63-1)/100 {
		return 0, false
	}
	fraction := int64(0)
	if len(parts) == 2 {
		if len(parts[1]) < 1 || len(parts[1]) > 2 {
			return 0, false
		}
		if len(parts[1]) == 1 {
			parts[1] += "0"
		}
		fraction, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			return 0, false
		}
	}
	return whole*100 + fraction, true
}

func (s *CandidateService) newCandidatePersistence(uid int64, evaluation *candidateEvaluation, now int64) (*candidatePersistence, error) {
	if evaluation == nil || len(evaluation.members) != 2 {
		return nil, fmt.Errorf("invalid reconciliation candidate evaluation")
	}

	caseId := s.idGenerator.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
	firstMemberId := s.idGenerator.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
	secondMemberId := s.idGenerator.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)

	if caseId < 1 || firstMemberId < 1 || secondMemberId < 1 {
		return nil, fmt.Errorf("could not generate reconciliation candidate ids")
	}

	caseRecord := &Case{
		Uid:                   uid,
		CaseKey:               evaluation.caseKey,
		CaseKeyVersion:        CASE_KEY_VERSION_V1,
		Status:                CASE_STATUS_OPEN,
		Version:               1,
		MemberCount:           2,
		SuggestedRelationType: evaluation.suggestedRelationType,
		CandidateScore:        evaluation.score,
		CandidateRuleVersion:  CANDIDATE_RULE_VERSION_V5,
		ExplanationVersion:    EXPLANATION_VERSION_V5,
		ReasonCodesJson:       evaluation.reasonCodesJSON,
		CreatedUnixTime:       now,
		LastEvaluatedUnixTime: now,
		UpdatedUnixTime:       now,
		CaseId:                caseId,
	}
	memberIds := []int64{firstMemberId, secondMemberId}
	members := make([]*CaseMember, 2)

	for index, token := range evaluation.members {
		members[index] = &CaseMember{
			Uid:             uid,
			CaseId:          caseId,
			MemberOrder:     int64(index + 1),
			MemberKind:      token.kind,
			MemberRefId:     token.refId,
			MemberRole:      candidateMemberRoleEvidence,
			CreatedUnixTime: now,
			MemberId:        memberIds[index],
		}
	}

	return &candidatePersistence{caseRecord: caseRecord, members: members}, nil
}

type candidateMemberToken struct {
	kind  MemberKind
	refId int64
}

type candidateReason struct {
	Code  string `json:"code"`
	Value int64  `json:"value"`
}

type candidateEvaluation struct {
	caseKey               string
	members               []candidateMemberToken
	suggestedRelationType DecisionType
	score                 int64
	reasonCodesJSON       string
	anchorRowId           int64
	candidateRowId        int64
}

type candidatePersistence struct {
	caseRecord *Case
	members    []*CaseMember
}

func evaluateCandidatePair(first *importing.RawImportRow, second *importing.RawImportRow) (*candidateEvaluation, error) {
	if !hardCandidateMatch(first, second) {
		return nil, fmt.Errorf("reconciliation candidate pair did not pass hard filters")
	}

	firstToken, err := candidateMemberTokenForRow(first)

	if err != nil {
		return nil, err
	}

	secondToken, err := candidateMemberTokenForRow(second)

	if err != nil {
		return nil, err
	}

	members := []candidateMemberToken{firstToken, secondToken}
	sort.Slice(members, func(i, j int) bool {
		return candidateMemberTokenLess(members[i], members[j])
	})

	if members[0] == members[1] {
		return nil, fmt.Errorf("reconciliation candidate members must be distinct")
	}

	caseKey := computeCandidateCaseKey(members)
	distance := absoluteInt64(*first.NormalizedUnixTime - *second.NormalizedUnixTime)
	timeScore := candidateTimeScore(distance)
	score := int64(40 + timeScore)
	reasons := []candidateReason{
		{Code: candidateReasonAmountCurrencyExact, Value: 40},
		{Code: candidateReasonTimeDistance, Value: distance},
		{Code: candidateReasonTimeProximity, Value: timeScore},
	}
	suggestion := DECISION_TYPE_SAME_EVENT

	if first.NormalizedDirection == second.NormalizedDirection {
		score += 15
		reasons = append(reasons, candidateReason{Code: candidateReasonSameDirection, Value: 15})
	} else if directionsAreOpposite(first.NormalizedDirection, second.NormalizedDirection) {
		reasons = append(reasons, candidateReason{Code: candidateReasonOppositeDirection, Value: 0})

		if isExplicitRefundPair(first, second) {
			suggestion = DECISION_TYPE_REFUND_REVERSAL
			score += 25
			reasons = append(reasons, candidateReason{Code: candidateReasonRefundSignal, Value: 25})
		} else if hasTransferSignal(first) || hasTransferSignal(second) {
			suggestion = DECISION_TYPE_INTERNAL_TRANSFER
			score += 20
			reasons = append(reasons, candidateReason{Code: candidateReasonTransferSignal, Value: 20})
		}
	}

	if rowsShareIdentifier(first, second) {
		score += 25
		reasons = append(reasons, candidateReason{Code: candidateReasonIdentifierMatch, Value: 25})
	}

	if first.LedgerAccountId != nil && second.LedgerAccountId != nil && *first.LedgerAccountId == *second.LedgerAccountId {
		score += 15
		reasons = append(reasons, candidateReason{Code: candidateReasonLedgerAccountMatch, Value: 15})
	}

	if paymentMethodsComparable(first, second) {
		score += 8
		reasons = append(reasons, candidateReason{Code: candidateReasonPaymentMethodMatch, Value: 8})
	}

	if evidenceTextSimilar(first, second) {
		score += 10
		reasons = append(reasons, candidateReason{Code: candidateReasonTextSimilarity, Value: 10})
	}

	sort.Slice(reasons, func(i, j int) bool {
		return reasons[i].Code < reasons[j].Code
	})
	reasonCodesJSON, err := json.Marshal(reasons)

	if err != nil {
		return nil, fmt.Errorf("encode reconciliation candidate reasons: %w", err)
	}

	return &candidateEvaluation{
		caseKey:               caseKey,
		members:               members,
		suggestedRelationType: suggestion,
		score:                 score,
		reasonCodesJSON:       string(reasonCodesJSON),
		anchorRowId:           first.RowId,
		candidateRowId:        second.RowId,
	}, nil
}

func candidateMemberTokenForRow(row *importing.RawImportRow) (candidateMemberToken, error) {
	if row == nil || row.RowId < 1 {
		return candidateMemberToken{}, fmt.Errorf("invalid reconciliation candidate row")
	}

	if row.IdentityState == importing.IDENTITY_STATE_BATCH_LOCAL {
		return candidateMemberToken{kind: MEMBER_KIND_RAW_ROW, refId: row.RowId}, nil
	}
	if statementRowNeedsOccurrenceMember(row) {
		return candidateMemberToken{kind: MEMBER_KIND_RAW_ROW, refId: row.RowId}, nil
	}

	if row.IdentityId == nil || *row.IdentityId < 1 {
		return candidateMemberToken{}, fmt.Errorf("reconciliation candidate row has no stable source identity")
	}

	return candidateMemberToken{kind: MEMBER_KIND_SOURCE_IDENTITY, refId: *row.IdentityId}, nil
}

func statementRowNeedsOccurrenceMember(row *importing.RawImportRow) bool {
	return row != nil && rowHasDateOnlyTime(row) && row.NormalizedTransactionType == importing.SOURCE_TRANSACTION_TYPE_OTHER &&
		strings.TrimSpace(row.SourceTransactionId) == "" && strings.TrimSpace(row.SourceOrderId) == "" && strings.TrimSpace(row.SourceMerchantOrderId) == ""
}

func computeCandidateCaseKey(members []candidateMemberToken) string {
	hash := sha256.New()
	writeCandidateKeyPart(hash, []byte(CASE_KEY_VERSION_V1))

	for _, member := range members {
		writeCandidateKeyPart(hash, []byte(member.kind))
		var encodedRef [8]byte
		binary.BigEndian.PutUint64(encodedRef[:], uint64(member.refId))
		writeCandidateKeyPart(hash, encodedRef[:])
	}

	return hex.EncodeToString(hash.Sum(nil))
}

type candidateHashWriter interface {
	Write(data []byte) (int, error)
}

func writeCandidateKeyPart(writer candidateHashWriter, value []byte) {
	var length [8]byte
	binary.BigEndian.PutUint64(length[:], uint64(len(value)))
	_, _ = writer.Write(length[:])
	_, _ = writer.Write(value)
}

func candidateMemberTokenLess(first candidateMemberToken, second candidateMemberToken) bool {
	if first.kind != second.kind {
		return first.kind < second.kind
	}

	return first.refId < second.refId
}

func candidateEvaluationLess(first *candidateEvaluation, second *candidateEvaluation) bool {
	if first.score != second.score {
		return first.score > second.score
	}

	if first.caseKey != second.caseKey {
		return first.caseKey < second.caseKey
	}

	if first.anchorRowId != second.anchorRowId {
		return first.anchorRowId < second.anchorRowId
	}

	return first.candidateRowId < second.candidateRowId
}

func hardCandidateMatch(first *importing.RawImportRow, second *importing.RawImportRow) bool {
	if !isCandidateAnchorRow(first) || !isCandidateCounterpartRow(second) || first.RowId == second.RowId {
		return false
	}

	return *first.NormalizedAmount == *second.NormalizedAmount &&
		first.Currency == second.Currency &&
		absoluteInt64(*first.NormalizedUnixTime-*second.NormalizedUnixTime) <= candidateTimeWindowSeconds
}

func isCandidateAnchorRow(row *importing.RawImportRow) bool {
	return isCandidatePendingRow(row)
}

func isCandidateCounterpartRow(row *importing.RawImportRow) bool {
	return isCandidatePendingRow(row) || isCandidateLinkedRow(row)
}

func isCandidatePendingRow(row *importing.RawImportRow) bool {
	if row == nil || row.Uid < 1 || row.BatchId < 1 || row.RowId < 1 ||
		row.ParseState != importing.PARSE_STATE_VALID ||
		row.ProcessingState != importing.PROCESSING_STATE_PENDING ||
		row.NormalizedAmount == nil || *row.NormalizedAmount < 0 ||
		row.NormalizedUnixTime == nil || len(row.Currency) != 3 {
		return false
	}

	if row.SemanticEligibility != importing.SEMANTIC_ELIGIBILITY_POSTABLE &&
		row.SemanticEligibility != importing.SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED {
		return false
	}

	if row.Disposition != importing.IMPORT_DISPOSITION_POSTABLE &&
		row.Disposition != importing.IMPORT_DISPOSITION_REVIEW_REQUIRED {
		return false
	}

	return row.IdentityState == importing.IDENTITY_STATE_NEW ||
		row.IdentityState == importing.IDENTITY_STATE_EXACT_DUPLICATE ||
		row.IdentityState == importing.IDENTITY_STATE_BATCH_LOCAL
}

func isCandidateLinkedRow(row *importing.RawImportRow) bool {
	return row != nil && row.Uid > 0 && row.BatchId > 0 && row.RowId > 0 &&
		row.ParseState == importing.PARSE_STATE_VALID &&
		row.ProcessingState == importing.PROCESSING_STATE_LINKED &&
		row.NormalizedAmount != nil && *row.NormalizedAmount >= 0 &&
		row.NormalizedUnixTime != nil && len(row.Currency) == 3 &&
		row.IdentityId != nil && *row.IdentityId > 0 &&
		(row.IdentityState == importing.IDENTITY_STATE_NEW || row.IdentityState == importing.IDENTITY_STATE_EXACT_DUPLICATE)
}

func candidateTimeScore(distance int64) int64 {
	switch {
	case distance <= 5*60:
		return 30
	case distance <= 60*60:
		return 20
	default:
		return 10
	}
}

func directionsAreOpposite(first importing.NormalizedDirection, second importing.NormalizedDirection) bool {
	return (first == importing.NORMALIZED_DIRECTION_INCOME && second == importing.NORMALIZED_DIRECTION_EXPENSE) ||
		(first == importing.NORMALIZED_DIRECTION_EXPENSE && second == importing.NORMALIZED_DIRECTION_INCOME)
}

func isExplicitRefundPair(first *importing.RawImportRow, second *importing.RawImportRow) bool {
	return directionsAreOpposite(first.NormalizedDirection, second.NormalizedDirection) &&
		((first.EconomicEffect == importing.ECONOMIC_EFFECT_REFUND && second.EconomicEffect == importing.ECONOMIC_EFFECT_NORMAL) ||
			(first.EconomicEffect == importing.ECONOMIC_EFFECT_NORMAL && second.EconomicEffect == importing.ECONOMIC_EFFECT_REFUND))
}

func hasTransferSignal(row *importing.RawImportRow) bool {
	if row == nil {
		return false
	}

	return row.NormalizedTransactionType == importing.SOURCE_TRANSACTION_TYPE_TRANSFER ||
		row.NormalizedTransactionType == importing.SOURCE_TRANSACTION_TYPE_TOP_UP ||
		row.NormalizedTransactionType == importing.SOURCE_TRANSACTION_TYPE_WITHDRAWAL
}

func rowsShareIdentifier(first *importing.RawImportRow, second *importing.RawImportRow) bool {
	firstIds := normalizedEvidenceIdentifiers(first)
	secondIds := normalizedEvidenceIdentifiers(second)

	for identifier := range firstIds {
		if _, exists := secondIds[identifier]; exists {
			return true
		}
	}

	return false
}

func normalizedEvidenceIdentifiers(row *importing.RawImportRow) map[string]struct{} {
	result := make(map[string]struct{})

	if row == nil {
		return result
	}

	for _, identifier := range []string{row.SourceTransactionId, row.SourceOrderId, row.SourceMerchantOrderId} {
		normalized := normalizedEvidenceText(identifier)

		if normalized != "" {
			result[normalized] = struct{}{}
		}
	}

	return result
}

func paymentMethodsComparable(first *importing.RawImportRow, second *importing.RawImportRow) bool {
	if first == nil || second == nil {
		return false
	}
	left := importing.ComparablePaymentAccountText(first.RawPaymentMethod)
	right := importing.ComparablePaymentAccountText(second.RawPaymentMethod)
	return left != "" && left == right
}

// CrossSourceSameCard 组成后的付款方式相同，或两边已经沿用到同一个正式账户，都算同一张卡。
func CrossSourceSameCard(first *importing.RawImportRow, second *importing.RawImportRow) bool {
	if paymentMethodsComparable(first, second) {
		return true
	}
	return first != nil && second != nil &&
		first.LedgerAccountId != nil && second.LedgerAccountId != nil &&
		*first.LedgerAccountId > 0 && *first.LedgerAccountId == *second.LedgerAccountId
}

// CrossSourceTimeMatch 两边都有时分时看时间窗；普通消费遇到月结单日期行时只对同一天。
// 退款可能在渠道完成后的下一记账日才出现在信用卡月结单，允许沿用明确的时间窗。
func CrossSourceTimeMatch(first *importing.RawImportRow, second *importing.RawImportRow, maxDelta int64) bool {
	if first == nil || second == nil || first.NormalizedUnixTime == nil || second.NormalizedUnixTime == nil || maxDelta < 0 {
		return false
	}
	if rowHasDateOnlyTime(first) || rowHasDateOnlyTime(second) {
		left := rowCivilDate(first)
		right := rowCivilDate(second)
		if left != "" && left == right {
			return true
		}
		if first.EconomicEffect != importing.ECONOMIC_EFFECT_REFUND && second.EconomicEffect != importing.ECONOMIC_EFFECT_REFUND {
			return false
		}
		return absoluteInt64(*first.NormalizedUnixTime-*second.NormalizedUnixTime) <= maxDelta
	}
	return absoluteInt64(*first.NormalizedUnixTime-*second.NormalizedUnixTime) <= maxDelta
}

// CrossSourceComparisonMatch 金额币种已在硬过滤里。明细两边仍要求对方/说明相似；
// 一边是只有日期的月结单、另一边有准确时间时，同一资金账户已经提供了更强的网关证据，
// 商户全文不再是硬条件，避免“支付宝 持卡人”等通用说明漏掉真实重复。
func CrossSourceComparisonMatch(first *importing.RawImportRow, second *importing.RawImportRow, maxDelta int64) bool {
	if !CrossSourceSameCard(first, second) || !CrossSourceTimeMatch(first, second, maxDelta) {
		return false
	}
	return evidenceTextSimilar(first, second) || rowHasDateOnlyTime(first) != rowHasDateOnlyTime(second)
}

func rowTimezoneSeconds(row *importing.RawImportRow) int {
	if row != nil && row.NormalizedTimezoneUtcOffset != nil {
		return int(*row.NormalizedTimezoneUtcOffset) * 60
	}
	return 0
}

func rowCivilDate(row *importing.RawImportRow) string {
	if row == nil || row.NormalizedUnixTime == nil {
		return ""
	}
	return time.Unix(*row.NormalizedUnixTime, 0).In(time.FixedZone("pf-row", rowTimezoneSeconds(row))).Format(time.DateOnly)
}

func rowHasDateOnlyTime(row *importing.RawImportRow) bool {
	if row == nil || row.NormalizedUnixTime == nil {
		return false
	}
	local := time.Unix(*row.NormalizedUnixTime, 0).In(time.FixedZone("pf-row", rowTimezoneSeconds(row)))
	return local.Hour() == 0 && local.Minute() == 0 && local.Second() == 0
}

func evidenceTextSimilar(first *importing.RawImportRow, second *importing.RawImportRow) bool {
	firstText := comparableEvidenceText(first)
	secondText := comparableEvidenceText(second)

	if len([]rune(firstText)) < 3 || len([]rune(secondText)) < 3 {
		return false
	}

	return firstText == secondText || strings.Contains(firstText, secondText) || strings.Contains(secondText, firstText)
}

func comparableEvidenceText(row *importing.RawImportRow) string {
	if row == nil {
		return ""
	}
	counterparty := strings.TrimSpace(row.RawCounterparty)
	item := strings.TrimSpace(row.RawItem)
	text := counterparty
	if item != "" && item != counterparty && !evidenceItemLooksLikeOrderId(row, item) {
		if text == "" {
			text = item
		} else {
			text += " " + item
		}
	}
	normalized := normalizedEvidenceText(text)
	if stripped := stripPaymentChannelPrefix(normalized); stripped != "" {
		return stripped
	}
	return normalized
}

func evidenceItemLooksLikeOrderId(row *importing.RawImportRow, item string) bool {
	compactItem := normalizedEvidenceText(item)
	if compactItem == "" {
		return false
	}
	for _, identifier := range []string{row.SourceMerchantOrderId, row.SourceOrderId, row.SourceTransactionId} {
		compactId := normalizedEvidenceText(identifier)
		if compactId == "" {
			continue
		}
		if compactItem == compactId {
			return true
		}
		for _, prefix := range []string{"商户单号", "商家订单号", "订单号"} {
			if strings.HasPrefix(item, prefix) && normalizedEvidenceText(strings.TrimPrefix(item, prefix)) == compactId {
				return true
			}
		}
	}
	return false
}

func stripPaymentChannelPrefix(normalized string) string {
	for _, prefix := range []string{"微信支付", "支付宝", "财付通", "微信"} {
		prefixText := normalizedEvidenceText(prefix)
		if prefixText == "" || !strings.HasPrefix(normalized, prefixText) {
			continue
		}
		remainder := strings.TrimPrefix(normalized, prefixText)
		if len([]rune(remainder)) >= 3 {
			return remainder
		}
	}
	return normalized
}

func normalizedEvidenceText(value string) string {
	var builder strings.Builder

	for _, character := range strings.ToLower(strings.TrimSpace(value)) {
		if unicode.IsLetter(character) || unicode.IsDigit(character) {
			builder.WriteRune(character)
		}
	}

	return builder.String()
}

func absoluteInt64(value int64) int64 {
	if value < 0 {
		return -value
	}

	return value
}
