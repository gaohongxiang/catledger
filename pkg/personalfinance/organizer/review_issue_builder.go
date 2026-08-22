package organizer

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

// ReviewIssuePlan 是由一次整理结果派生出的稳定问题投影。
type ReviewIssuePlan struct {
	Issues                 []*ReviewIssue
	Members                []*ReviewIssueMember
	OpenBlockingIssueCount int64
}

type reviewIssueSpec struct {
	issueType     ReviewIssueType
	primaryReason string
	groupable     bool
}

type reviewEvidenceContext struct {
	row    *importing.RawImportRow
	source *FinanceUpdateSource
	batch  *importing.ImportBatch
}

type reviewIssueBucket struct {
	key          string
	spec         reviewIssueSpec
	events       []*EconomicEvent
	relations    []*EconomicEventRelation
	reasonCodes  []string
	relationSeen map[int64]struct{}
}

// BuildReviewIssuePlan 把 needs_action 事件转换为“一张卡片对应一个决定”的稳定问题投影。
// 它只持久化稳定标识和原因码，不复制商户、商品等原始敏感文本。
func BuildReviewIssuePlan(uid int64, updateId int64, plan *OrganizePlan, sources []*PlanningSource, now int64, generateId func() int64) (*ReviewIssuePlan, error) {
	if uid < 1 || updateId < 1 || plan == nil || now < 1 || generateId == nil {
		return nil, fmt.Errorf("invalid review issue planning request")
	}

	rowContexts, err := buildReviewEvidenceContexts(uid, updateId, sources)
	if err != nil {
		return nil, err
	}
	evidenceByEvent, err := indexReviewEvidence(uid, updateId, plan.Evidence, rowContexts)
	if err != nil {
		return nil, err
	}
	relationsByEvent, err := indexReviewRelations(uid, updateId, plan.Relations)
	if err != nil {
		return nil, err
	}

	events := append([]*EconomicEvent(nil), plan.Events...)
	sort.Slice(events, func(i, j int) bool {
		leftTime, rightTime := pointerInt64Value(events[i].EventUnixTime), pointerInt64Value(events[j].EventUnixTime)
		if leftTime != rightTime {
			return leftTime < rightTime
		}
		return events[i].EventId < events[j].EventId
	})

	buckets := make(map[string]*reviewIssueBucket)
	bucketKeys := make([]string, 0)
	needsActionCount := int64(0)
	for _, event := range events {
		if event == nil || event.Uid != uid || event.UpdateId != updateId || event.EventId < 1 {
			return nil, fmt.Errorf("review issue event ownership mismatch")
		}
		if event.Status != EVENT_STATUS_NEEDS_ACTION {
			continue
		}
		needsActionCount++
		reasons := decodeReasonCodes(event.ReasonCodesJson)
		spec := classifyReviewIssue(event, reasons)
		signature := event.EventKey
		if spec.groupable {
			signature = sharedReviewDecisionSignature(event, spec, reasons, evidenceByEvent[event.EventId])
		}
		key := stablePlanDigest(
			"review-issue",
			string(REVIEW_ISSUE_KEY_VERSION_V1),
			strconv.FormatInt(uid, 10),
			strconv.FormatInt(updateId, 10),
			string(spec.issueType),
			signature,
		)
		bucket := buckets[key]
		if bucket == nil {
			bucket = &reviewIssueBucket{key: key, spec: spec, relationSeen: make(map[int64]struct{})}
			buckets[key] = bucket
			bucketKeys = append(bucketKeys, key)
		}
		bucket.events = append(bucket.events, event)
		bucket.reasonCodes = appendUniqueReasons(bucket.reasonCodes, reasons...)
		for _, relation := range relationsByEvent[event.EventId] {
			if !reviewIssueUsesRelation(spec.issueType, relation) {
				continue
			}
			if _, exists := bucket.relationSeen[relation.RelationId]; exists {
				continue
			}
			bucket.relationSeen[relation.RelationId] = struct{}{}
			bucket.relations = append(bucket.relations, relation)
			bucket.reasonCodes = appendUniqueReasons(bucket.reasonCodes, decodeReasonCodes(relation.ReasonCodesJson)...)
		}
	}

	sort.Strings(bucketKeys)
	ids := &checkedIdentifierGenerator{next: generateId, seen: make(map[int64]struct{})}
	result := &ReviewIssuePlan{
		Issues:                 make([]*ReviewIssue, 0, len(bucketKeys)),
		Members:                make([]*ReviewIssueMember, 0, needsActionCount),
		OpenBlockingIssueCount: int64(len(bucketKeys)),
	}
	coveredEvents := make(map[int64]struct{}, needsActionCount)
	for _, key := range bucketKeys {
		bucket := buckets[key]
		issue, members, buildErr := buildReviewIssueBucket(uid, updateId, bucket, now, ids)
		if buildErr != nil {
			return nil, buildErr
		}
		for _, event := range bucket.events {
			if _, exists := coveredEvents[event.EventId]; exists {
				return nil, fmt.Errorf("economic event belongs to multiple primary review issues")
			}
			coveredEvents[event.EventId] = struct{}{}
		}
		result.Issues = append(result.Issues, issue)
		result.Members = append(result.Members, members...)
	}
	if int64(len(coveredEvents)) != needsActionCount {
		return nil, fmt.Errorf("review issue coverage mismatch")
	}
	return result, nil
}

func buildReviewEvidenceContexts(uid int64, updateId int64, sources []*PlanningSource) (map[int64]*reviewEvidenceContext, error) {
	result := make(map[int64]*reviewEvidenceContext)
	for _, item := range sources {
		if item == nil || item.Source == nil || item.Batch == nil || item.Source.Uid != uid || item.Source.UpdateId != updateId ||
			item.Batch.Uid != uid || item.Source.BatchId != item.Batch.BatchId {
			return nil, fmt.Errorf("review issue source snapshot mismatch")
		}
		for _, row := range item.Rows {
			if row == nil || row.Uid != uid || row.BatchId != item.Batch.BatchId || row.RowId < 1 {
				return nil, fmt.Errorf("review issue evidence owner mismatch")
			}
			if _, exists := result[row.RowId]; exists {
				return nil, fmt.Errorf("duplicate review issue evidence row")
			}
			result[row.RowId] = &reviewEvidenceContext{row: row, source: item.Source, batch: item.Batch}
		}
	}
	return result, nil
}

func indexReviewEvidence(uid int64, updateId int64, evidence []*EconomicEventEvidence, rows map[int64]*reviewEvidenceContext) (map[int64][]*reviewEvidenceContext, error) {
	result := make(map[int64][]*reviewEvidenceContext)
	seenRows := make(map[int64]struct{})
	for _, link := range evidence {
		if link == nil || link.Uid != uid || link.UpdateId != updateId || link.EventId < 1 || link.RowId < 1 {
			return nil, fmt.Errorf("review issue evidence link mismatch")
		}
		if _, exists := seenRows[link.RowId]; exists {
			return nil, fmt.Errorf("review issue evidence row belongs to multiple events")
		}
		context := rows[link.RowId]
		if context == nil {
			return nil, fmt.Errorf("review issue evidence row is missing")
		}
		seenRows[link.RowId] = struct{}{}
		result[link.EventId] = append(result[link.EventId], context)
	}
	for eventId := range result {
		sort.Slice(result[eventId], func(i, j int) bool { return result[eventId][i].row.RowId < result[eventId][j].row.RowId })
	}
	return result, nil
}

func indexReviewRelations(uid int64, updateId int64, relations []*EconomicEventRelation) (map[int64][]*EconomicEventRelation, error) {
	result := make(map[int64][]*EconomicEventRelation)
	seen := make(map[int64]struct{})
	for _, relation := range relations {
		if relation == nil || relation.Uid != uid || relation.UpdateId != updateId || relation.RelationId < 1 ||
			relation.SourceEventId < 1 || relation.TargetEventId < 1 {
			return nil, fmt.Errorf("review issue relation ownership mismatch")
		}
		if _, exists := seen[relation.RelationId]; exists {
			return nil, fmt.Errorf("duplicate review issue relation")
		}
		seen[relation.RelationId] = struct{}{}
		result[relation.SourceEventId] = append(result[relation.SourceEventId], relation)
		result[relation.TargetEventId] = append(result[relation.TargetEventId], relation)
	}
	return result, nil
}

func classifyReviewIssue(event *EconomicEvent, reasons []string) reviewIssueSpec {
	has := func(values ...string) bool {
		for _, reason := range reasons {
			for _, wanted := range values {
				if reason == wanted {
					return true
				}
			}
		}
		return false
	}
	switch {
	case has(reasonIdentityConflict, reasonIdentityReviewRequired):
		return reviewIssueSpec{issueType: REVIEW_ISSUE_TYPE_IDENTITY_CONFLICT, primaryReason: firstReviewReason(reasons, reasonIdentityConflict, reasonIdentityReviewRequired)}
	case has(reasonCoreFieldsConflict):
		return reviewIssueSpec{issueType: REVIEW_ISSUE_TYPE_FIELD_CONFLICT, primaryReason: reasonCoreFieldsConflict}
	case event.EconomicNature == ECONOMIC_NATURE_REFUND || has(reasonRefundRelationRequired, reasonRefundRelationAmbiguous, reasonRefundAmountExceeded, reasonRefundRelationInvalid):
		return reviewIssueSpec{issueType: REVIEW_ISSUE_TYPE_REFUND_RELATION, primaryReason: firstReviewReason(reasons, reasonRefundRelationAmbiguous, reasonRefundAmountExceeded, reasonRefundRelationInvalid, reasonRefundRelationRequired)}
	case event.EconomicNature == ECONOMIC_NATURE_INTERNAL_TRANSFER || event.EconomicNature == ECONOMIC_NATURE_REPAYMENT || event.EconomicNature == ECONOMIC_NATURE_BORROW ||
		has(reasonTransferAccountRequired, reasonRepaymentAccountRequired, reasonBorrowAccountRequired):
		return reviewIssueSpec{issueType: REVIEW_ISSUE_TYPE_TRANSFER_ACCOUNTS, primaryReason: firstReviewReason(reasons, reasonRelationAmbiguous, reasonRepaymentAccountRequired, reasonBorrowAccountRequired, reasonTransferAccountRequired), groupable: true}
	case has(reasonRelationAmbiguous):
		return reviewIssueSpec{issueType: REVIEW_ISSUE_TYPE_SAME_EVENT, primaryReason: reasonRelationAmbiguous}
	case has(reasonLedgerAccountRequired):
		return reviewIssueSpec{issueType: REVIEW_ISSUE_TYPE_ACCOUNT_MAPPING, primaryReason: reasonLedgerAccountRequired, groupable: true}
	default:
		return reviewIssueSpec{issueType: REVIEW_ISSUE_TYPE_SHARED_FIELDS, primaryReason: firstReviewReason(reasons, reasonEconomicNatureRequired, reasonCoreFieldsMissing, reasonPostabilityDirectionConflict), groupable: true}
	}
}

func firstReviewReason(reasons []string, preferred ...string) string {
	for _, wanted := range preferred {
		for _, reason := range reasons {
			if reason == wanted {
				return reason
			}
		}
	}
	if len(reasons) > 0 {
		items := append([]string(nil), reasons...)
		sort.Strings(items)
		return items[0]
	}
	return reasonBlockingIssueOpen
}

func sharedReviewDecisionSignature(event *EconomicEvent, spec reviewIssueSpec, reasons []string, contexts []*reviewEvidenceContext) string {
	parts := make([]string, 0, len(contexts)+3)
	parts = append(parts, string(event.EconomicNature), string(event.FlowDirection), reviewReasonFamily(reasons))
	rowParts := make([]string, 0, len(contexts))
	for _, context := range contexts {
		if context == nil || context.row == nil || context.source == nil || context.batch == nil {
			continue
		}
		sourceAccountId := int64(0)
		if context.source.SourceAccountId != nil {
			sourceAccountId = *context.source.SourceAccountId
		} else if context.batch.SourceAccountId != nil {
			sourceAccountId = *context.batch.SourceAccountId
		}
		row := context.row
		rowParts = append(rowParts, strings.Join([]string{
			context.source.SourceTypeSnapshot,
			strconv.FormatInt(sourceAccountId, 10),
			string(row.NormalizedTransactionType),
			string(row.EconomicEffect),
			string(row.NormalizedDirection),
			row.Currency,
			canonicalEvidenceText(row.RawTransactionType),
			canonicalEvidenceText(row.RawCounterparty),
			canonicalEvidenceText(row.RawItem),
			canonicalEvidenceText(row.RawPaymentMethod),
		}, "|"))
	}
	sort.Strings(rowParts)
	rowParts = uniqueSortedStrings(rowParts)
	parts = append(parts, rowParts...)
	if len(rowParts) == 0 {
		parts = append(parts, event.EventKey)
	}
	return stablePlanDigest("review-decision-signature", string(REVIEW_ISSUE_RULE_VERSION_V1), string(spec.issueType), strings.Join(parts, "\x00"))
}

func reviewReasonFamily(reasons []string) string {
	managed := make([]string, 0, len(reasons))
	for _, reason := range reasons {
		if isManagedPostabilityReason(reason) || reason == reasonIdentityConflict || reason == reasonIdentityReviewRequired || reason == reasonCoreFieldsConflict {
			managed = append(managed, reason)
		}
	}
	sort.Strings(managed)
	return strings.Join(uniqueSortedStrings(managed), ",")
}

func uniqueSortedStrings(values []string) []string {
	if len(values) < 2 {
		return values
	}
	result := values[:0]
	for _, value := range values {
		if len(result) == 0 || result[len(result)-1] != value {
			result = append(result, value)
		}
	}
	return result
}

func reviewIssueUsesRelation(issueType ReviewIssueType, relation *EconomicEventRelation) bool {
	if relation == nil {
		return false
	}
	switch issueType {
	case REVIEW_ISSUE_TYPE_REFUND_RELATION:
		return relation.RelationType == RELATION_TYPE_REFUND_OF && relation.Status != RELATION_STATUS_REJECTED && relation.Status != RELATION_STATUS_UNDONE
	case REVIEW_ISSUE_TYPE_SAME_EVENT, REVIEW_ISSUE_TYPE_TRANSFER_ACCOUNTS:
		return relation.Status == RELATION_STATUS_PROPOSED
	default:
		return false
	}
}

func buildReviewIssueBucket(uid int64, updateId int64, bucket *reviewIssueBucket, now int64, ids *checkedIdentifierGenerator) (*ReviewIssue, []*ReviewIssueMember, error) {
	if bucket == nil || len(bucket.events) < 1 || bucket.key == "" || ids == nil {
		return nil, nil, fmt.Errorf("invalid review issue bucket")
	}
	issueId, err := ids.generate()
	if err != nil {
		return nil, nil, err
	}
	sort.Slice(bucket.events, func(i, j int) bool {
		leftTime, rightTime := pointerInt64Value(bucket.events[i].EventUnixTime), pointerInt64Value(bucket.events[j].EventUnixTime)
		if leftTime != rightTime {
			return leftTime < rightTime
		}
		return bucket.events[i].EventId < bucket.events[j].EventId
	})
	sort.Slice(bucket.relations, func(i, j int) bool { return bucket.relations[i].RelationId < bucket.relations[j].RelationId })
	members := make([]*ReviewIssueMember, 0, len(bucket.events)+len(bucket.relations))
	for _, event := range bucket.events {
		member, buildErr := newReviewIssueMember(uid, updateId, issueId, bucket.key, REVIEW_ISSUE_MEMBER_ROLE_SUBJECT,
			REVIEW_OBJECT_TYPE_EVENT, event.EventId, event.Version, int64(len(members)), 0, event.ReasonCodesJson, now, ids)
		if buildErr != nil {
			return nil, nil, buildErr
		}
		members = append(members, member)
	}
	candidateCount := int64(0)
	for _, relation := range bucket.relations {
		role := REVIEW_ISSUE_MEMBER_ROLE_SUPPORTING
		if relation.Status == RELATION_STATUS_PROPOSED {
			role = REVIEW_ISSUE_MEMBER_ROLE_CANDIDATE
			candidateCount++
		}
		member, buildErr := newReviewIssueMember(uid, updateId, issueId, bucket.key, role,
			REVIEW_OBJECT_TYPE_RELATION, relation.RelationId, relation.Version, int64(len(members)), 0, relation.ReasonCodesJson, now, ids)
		if buildErr != nil {
			return nil, nil, buildErr
		}
		members = append(members, member)
	}
	issue := &ReviewIssue{
		Uid: uid, UpdateId: updateId, Status: REVIEW_ISSUE_STATUS_OPEN, IssueType: bucket.spec.issueType,
		IssueKey: bucket.key, IssueKeyVersion: REVIEW_ISSUE_KEY_VERSION_V1, Version: 1, Blocking: true,
		PrimaryReasonCode: bucket.spec.primaryReason, MemberCount: int64(len(members)), CandidateCount: candidateCount,
		RuleVersion: REVIEW_ISSUE_RULE_VERSION_V1, ReasonCodesJson: reasonCodesJSON(bucket.reasonCodes),
		CreatedUnixTime: now, UpdatedUnixTime: now, IssueId: issueId,
	}
	return issue, members, nil
}

func newReviewIssueMember(uid int64, updateId int64, issueId int64, issueKey string, role ReviewIssueMemberRole,
	objectType ReviewObjectType, objectId int64, objectVersion int64, sortOrder int64, score int64, reasonsJson string,
	now int64, ids *checkedIdentifierGenerator) (*ReviewIssueMember, error) {
	memberId, err := ids.generate()
	if err != nil {
		return nil, err
	}
	return &ReviewIssueMember{
		Uid: uid, UpdateId: updateId, IssueId: issueId,
		MemberKey:        stablePlanDigest("review-issue-member", string(REVIEW_ISSUE_MEMBER_KEY_VERSION_V1), issueKey, string(role), string(objectType), strconv.FormatInt(objectId, 10)),
		MemberKeyVersion: REVIEW_ISSUE_MEMBER_KEY_VERSION_V1, Role: role, ObjectType: objectType,
		ObjectId: objectId, ObjectVersion: objectVersion, SortOrder: sortOrder, Score: score,
		ReasonCodesJson: reasonsJson, CreatedUnixTime: now, MemberId: memberId,
	}, nil
}
