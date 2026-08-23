package organizer

import (
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func TestBuildReviewIssuePlanGroupsIndependentSharedDecisions(t *testing.T) {
	const uid = int64(11)
	const updateId = int64(22)
	sourceAccountId := int64(33)
	sources := []*PlanningSource{{
		Source: &FinanceUpdateSource{Uid: uid, UpdateId: updateId, SourceAccountId: &sourceAccountId, SourceTypeSnapshot: string(importing.SOURCE_TYPE_ALIPAY), BatchId: 44},
		Batch:  &importing.ImportBatch{Uid: uid, BatchId: 44, SourceAccountId: &sourceAccountId},
		Rows: []*importing.RawImportRow{
			reviewIssueRow(uid, 44, 101, "天弘基金管理有限公司", "收益发放", 1),
			reviewIssueRow(uid, 44, 102, "天弘基金管理有限公司", "收益发放", 2),
		},
	}}
	first := reviewIssueEvent(uid, updateId, 201, 101, ECONOMIC_NATURE_UNKNOWN, FLOW_DIRECTION_INFLOW, reasonEconomicNatureRequired)
	second := reviewIssueEvent(uid, updateId, 202, 102, ECONOMIC_NATURE_UNKNOWN, FLOW_DIRECTION_INFLOW, reasonEconomicNatureRequired)
	plan := &OrganizePlan{
		Events: []*EconomicEvent{first, second},
		Evidence: []*EconomicEventEvidence{
			{Uid: uid, UpdateId: updateId, EventId: first.EventId, RowId: 101},
			{Uid: uid, UpdateId: updateId, EventId: second.EventId, RowId: 102},
		},
		NeedsActionEventCount: 2,
	}

	result, err := BuildReviewIssuePlan(uid, updateId, plan, sources, 1_700_000_000, sequentialReviewIssueIds(300))
	if err != nil || result == nil || len(result.Issues) != 1 || len(result.Members) != 2 {
		t.Fatalf("shared issue plan mismatch: result=%+v err=%v", result, err)
	}
	issue := result.Issues[0]
	if issue.IssueType != REVIEW_ISSUE_TYPE_SHARED_FIELDS || issue.MemberCount != 2 || issue.CandidateCount != 0 ||
		issue.PrimaryReasonCode != reasonEconomicNatureRequired || result.OpenBlockingIssueCount != 1 {
		t.Fatalf("shared issue mismatch: %+v", issue)
	}
	for _, member := range result.Members {
		if member.IssueId != issue.IssueId || member.Role != REVIEW_ISSUE_MEMBER_ROLE_SUBJECT || member.ObjectType != REVIEW_OBJECT_TYPE_EVENT {
			t.Fatalf("shared issue member mismatch: %+v", member)
		}
	}
}

func TestBuildReviewIssuePlanDoesNotGroupDifferentSourceAccounts(t *testing.T) {
	const uid = int64(12)
	const updateId = int64(23)
	firstSourceAccountId, secondSourceAccountId := int64(34), int64(35)
	sources := []*PlanningSource{
		{
			Source: &FinanceUpdateSource{Uid: uid, UpdateId: updateId, SourceAccountId: &firstSourceAccountId, SourceTypeSnapshot: string(importing.SOURCE_TYPE_ALIPAY), BatchId: 45},
			Batch:  &importing.ImportBatch{Uid: uid, BatchId: 45, SourceAccountId: &firstSourceAccountId},
			Rows:   []*importing.RawImportRow{reviewIssueRow(uid, 45, 103, "天弘基金管理有限公司", "收益发放", 1)},
		},
		{
			Source: &FinanceUpdateSource{Uid: uid, UpdateId: updateId, SourceAccountId: &secondSourceAccountId, SourceTypeSnapshot: string(importing.SOURCE_TYPE_ALIPAY), BatchId: 46},
			Batch:  &importing.ImportBatch{Uid: uid, BatchId: 46, SourceAccountId: &secondSourceAccountId},
			Rows:   []*importing.RawImportRow{reviewIssueRow(uid, 46, 104, "天弘基金管理有限公司", "收益发放", 1)},
		},
	}
	first := reviewIssueEvent(uid, updateId, 203, 103, ECONOMIC_NATURE_UNKNOWN, FLOW_DIRECTION_INFLOW, reasonEconomicNatureRequired)
	second := reviewIssueEvent(uid, updateId, 204, 104, ECONOMIC_NATURE_UNKNOWN, FLOW_DIRECTION_INFLOW, reasonEconomicNatureRequired)
	plan := &OrganizePlan{
		Events: []*EconomicEvent{first, second},
		Evidence: []*EconomicEventEvidence{
			{Uid: uid, UpdateId: updateId, EventId: first.EventId, RowId: 103},
			{Uid: uid, UpdateId: updateId, EventId: second.EventId, RowId: 104},
		},
		NeedsActionEventCount: 2,
	}

	result, err := BuildReviewIssuePlan(uid, updateId, plan, sources, 1_700_000_001, sequentialReviewIssueIds(400))
	if err != nil || result == nil || len(result.Issues) != 2 || len(result.Members) != 2 {
		t.Fatalf("different source accounts were grouped: result=%+v err=%v", result, err)
	}
}

func TestBuildReviewIssuePlanIncludesRefundRelationCandidate(t *testing.T) {
	const uid = int64(13)
	const updateId = int64(24)
	sourceAccountId := int64(36)
	sources := []*PlanningSource{{
		Source: &FinanceUpdateSource{Uid: uid, UpdateId: updateId, SourceAccountId: &sourceAccountId, SourceTypeSnapshot: string(importing.SOURCE_TYPE_ALIPAY), BatchId: 47},
		Batch:  &importing.ImportBatch{Uid: uid, BatchId: 47, SourceAccountId: &sourceAccountId},
		Rows: []*importing.RawImportRow{
			reviewIssueRow(uid, 47, 105, "某商户", "退款", 466),
			reviewIssueRow(uid, 47, 106, "某商户", "原消费", 1000),
		},
	}}
	refund := reviewIssueEvent(uid, updateId, 205, 105, ECONOMIC_NATURE_REFUND, FLOW_DIRECTION_INFLOW, reasonRefundRelationAmbiguous)
	original := reviewIssueEvent(uid, updateId, 206, 106, ECONOMIC_NATURE_EXPENSE, FLOW_DIRECTION_OUTFLOW, reasonCategoryUnclassified)
	original.Status = EVENT_STATUS_READY
	amount := int64(466)
	relation := &EconomicEventRelation{
		Uid: uid, UpdateId: updateId, RelationId: 501, Version: 1, RelationType: RELATION_TYPE_REFUND_OF,
		Status: RELATION_STATUS_PROPOSED, SourceEventId: refund.EventId, TargetEventId: original.EventId,
		Amount: &amount, Currency: "CNY", ReasonCodesJson: reasonCodesJSON([]string{reasonRefundRelationAmbiguous}),
	}
	plan := &OrganizePlan{
		Events: []*EconomicEvent{refund, original},
		Evidence: []*EconomicEventEvidence{
			{Uid: uid, UpdateId: updateId, EventId: refund.EventId, RowId: 105},
			{Uid: uid, UpdateId: updateId, EventId: original.EventId, RowId: 106},
		},
		Relations:             []*EconomicEventRelation{relation},
		NeedsActionEventCount: 1,
		ReadyEventCount:       1,
	}

	result, err := BuildReviewIssuePlan(uid, updateId, plan, sources, 1_700_000_002, sequentialReviewIssueIds(600))
	if err != nil || result == nil || len(result.Issues) != 1 || len(result.Members) != 2 {
		t.Fatalf("refund issue plan mismatch: result=%+v err=%v", result, err)
	}
	issue := result.Issues[0]
	if issue.IssueType != REVIEW_ISSUE_TYPE_REFUND_RELATION || issue.CandidateCount != 1 || issue.MemberCount != 2 {
		t.Fatalf("refund issue mismatch: %+v", issue)
	}
	if result.Members[1].Role != REVIEW_ISSUE_MEMBER_ROLE_CANDIDATE || result.Members[1].ObjectType != REVIEW_OBJECT_TYPE_RELATION || result.Members[1].ObjectId != relation.RelationId {
		t.Fatalf("refund candidate mismatch: %+v", result.Members[1])
	}
}

func TestBuildReviewIssuePlanUsesOnlyExactSameEventCandidateGroups(t *testing.T) {
	const uid = int64(14)
	const updateId = int64(25)
	first := reviewIssueEvent(uid, updateId, 207, 107, ECONOMIC_NATURE_EXPENSE, FLOW_DIRECTION_OUTFLOW, reasonRelationAmbiguous)
	second := reviewIssueEvent(uid, updateId, 208, 108, ECONOMIC_NATURE_EXPENSE, FLOW_DIRECTION_OUTFLOW, reasonRelationAmbiguous)
	first.LedgerAccountId = cloneInt64Pointer(second.LedgerAccountId)
	first.EventUnixTime = cloneInt64Pointer(second.EventUnixTime)
	first.Amount = cloneInt64Pointer(second.Amount)
	plan := &OrganizePlan{
		Events: []*EconomicEvent{first, second},
		Evidence: []*EconomicEventEvidence{
			{Uid: uid, UpdateId: updateId, EventId: first.EventId, RowId: 107},
			{Uid: uid, UpdateId: updateId, EventId: second.EventId, RowId: 108},
		},
		NeedsActionEventCount: 2,
	}

	independent, err := BuildReviewIssuePlan(uid, updateId, plan, nil, 1_700_000_003, sequentialReviewIssueIds(700))
	if err != nil || independent == nil || len(independent.Issues) != 2 {
		t.Fatalf("same-looking events were heuristically grouped: result=%+v err=%v", independent, err)
	}

	plan.SameEventCandidateGroups = map[string][]int64{strings.Repeat("b", 64): {first.EventId, second.EventId}}
	exact, err := BuildReviewIssuePlan(uid, updateId, plan, nil, 1_700_000_004, sequentialReviewIssueIds(800))
	if err != nil || exact == nil || len(exact.Issues) != 1 || len(exact.Members) != 2 {
		t.Fatalf("exact same-event candidate group was not preserved: result=%+v err=%v", exact, err)
	}
	if exact.Issues[0].IssueType != REVIEW_ISSUE_TYPE_SAME_EVENT || exact.Issues[0].MemberCount != 2 {
		t.Fatalf("exact same-event issue mismatch: %+v", exact.Issues[0])
	}
}

func TestBuildReviewIssuePlanRejectsInvalidSameEventCandidateSnapshot(t *testing.T) {
	const uid = int64(15)
	const updateId = int64(26)
	first := reviewIssueEvent(uid, updateId, 209, 109, ECONOMIC_NATURE_EXPENSE, FLOW_DIRECTION_OUTFLOW, reasonRelationAmbiguous)
	second := reviewIssueEvent(uid, updateId, 210, 110, ECONOMIC_NATURE_EXPENSE, FLOW_DIRECTION_OUTFLOW, reasonCategoryUnclassified)
	second.Status = EVENT_STATUS_READY
	plan := &OrganizePlan{
		Events: []*EconomicEvent{first, second},
		Evidence: []*EconomicEventEvidence{
			{Uid: uid, UpdateId: updateId, EventId: first.EventId, RowId: 109},
			{Uid: uid, UpdateId: updateId, EventId: second.EventId, RowId: 110},
		},
		SameEventCandidateGroups: map[string][]int64{strings.Repeat("c", 64): {first.EventId, second.EventId}},
		NeedsActionEventCount:    1,
		ReadyEventCount:          1,
	}

	if _, err := BuildReviewIssuePlan(uid, updateId, plan, nil, 1_700_000_005, sequentialReviewIssueIds(900)); err == nil {
		t.Fatal("invalid same-event candidate snapshot was accepted")
	}
}

func reviewIssueRow(uid int64, batchId int64, rowId int64, counterparty string, item string, amount int64) *importing.RawImportRow {
	timeValue := int64(1_700_000_000 + rowId)
	return &importing.RawImportRow{
		Uid: uid, BatchId: batchId, RowId: rowId,
		RawTransactionType: "其他", RawCounterparty: counterparty, RawItem: item, RawPaymentMethod: "余额宝",
		NormalizedUnixTime: &timeValue, NormalizedAmount: &amount, Currency: "CNY",
		NormalizedDirection:       importing.NORMALIZED_DIRECTION_INCOME,
		NormalizedTransactionType: importing.SOURCE_TRANSACTION_TYPE_OTHER,
		EconomicEffect:            importing.ECONOMIC_EFFECT_NORMAL,
	}
}

func reviewIssueEvent(uid int64, updateId int64, eventId int64, rowId int64, nature EconomicNature, direction FlowDirection, reason string) *EconomicEvent {
	accountId, eventTime, amount := int64(700+eventId), int64(1_700_000_000+eventId), int64(100)
	return &EconomicEvent{
		Uid: uid, UpdateId: updateId, EventId: eventId, EventKey: strings.Repeat("a", 63) + string(rune('0'+rowId%10)),
		Status: EVENT_STATUS_NEEDS_ACTION, Version: 1, FlowDirection: direction, EconomicNature: nature,
		LedgerAccountId: &accountId, EventUnixTime: &eventTime, Amount: &amount, Currency: "CNY",
		ReasonCodesJson: reasonCodesJSON([]string{reason}), FieldSourcesJson: "{}",
	}
}

func sequentialReviewIssueIds(start int64) func() int64 {
	return func() int64 {
		start++
		return start
	}
}
