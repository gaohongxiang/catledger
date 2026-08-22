package organizer

import (
	"errors"
	"fmt"
	"testing"
)

func TestBuildReviewIssueProjectionGroupsIndependentEventsByDecision(t *testing.T) {
	const uid = int64(21001)
	const updateId = int64(22001)
	accountId := int64(23001)
	events := []*EconomicEvent{
		reviewIssueTestEvent(uid, updateId, 24001, 1782662400, 1, &accountId, ECONOMIC_NATURE_UNKNOWN, FLOW_DIRECTION_INFLOW, []string{"economic_nature_required"}),
		reviewIssueTestEvent(uid, updateId, 24002, 1782748800, 2, &accountId, ECONOMIC_NATURE_UNKNOWN, FLOW_DIRECTION_INFLOW, []string{"economic_nature_required"}),
		reviewIssueTestEvent(uid, updateId, 24003, 1782835200, 3, &accountId, ECONOMIC_NATURE_UNKNOWN, FLOW_DIRECTION_INFLOW, []string{"economic_nature_required"}),
	}
	facts := make([]ReviewIssueEvidenceFact, 0, len(events))
	for _, event := range events {
		facts = append(facts, ReviewIssueEvidenceFact{
			EventId: event.EventId, SourceType: "alipay", Counterparty: "天弘基金管理有限公司", Item: "收益发放",
			PaymentMethod: "余额宝", TransactionType: "income", Currency: "CNY",
		})
	}
	projection, err := BuildReviewIssueProjection(uid, updateId, events, facts, 1783000000, reviewIssueTestIds(25000))
	if err != nil || projection == nil || len(projection.Issues) != 1 || len(projection.Members) != 3 {
		t.Fatalf("shared decision projection mismatch: projection=%+v err=%v", projection, err)
	}
	issue := projection.Issues[0]
	if issue.Type != REVIEW_ISSUE_TYPE_SHARED_DECISION || issue.Status != REVIEW_ISSUE_STATUS_OPEN || !issue.Blocking ||
		issue.MemberCount != 3 || issue.CandidateCount != 0 || issue.SummaryCode != "review_shared_decision" {
		t.Fatalf("shared decision issue mismatch: %+v", issue)
	}
	for index, member := range projection.Members {
		if member.IssueId != issue.IssueId || member.EventId == nil || member.ObjectVersion != 1 || member.SortOrder != int64(index) {
			t.Fatalf("shared decision member mismatch: %+v", member)
		}
	}

	changed := []*EconomicEvent{reviewIssueClone(events[2]), reviewIssueClone(events[1]), reviewIssueClone(events[0])}
	for index, event := range changed {
		*event.EventUnixTime += int64(index+5) * 86400
		*event.Amount += int64(index + 10)
	}
	rebuilt, err := BuildReviewIssueProjection(uid, updateId, changed, facts, 1783000100, reviewIssueTestIds(26000))
	if err != nil || len(rebuilt.Issues) != 1 || rebuilt.Issues[0].IssueKey != issue.IssueKey {
		t.Fatalf("same answer issue key was not stable: first=%+v rebuilt=%+v err=%v", issue, rebuilt, err)
	}
}

func TestBuildReviewIssueProjectionSeparatesSameEventDecisionFromBatchEditing(t *testing.T) {
	const uid = int64(21002)
	const updateId = int64(22002)
	accountId := int64(23002)
	events := []*EconomicEvent{
		reviewIssueTestEvent(uid, updateId, 24101, 1782921600, 4350, &accountId, ECONOMIC_NATURE_EXPENSE, FLOW_DIRECTION_OUTFLOW, []string{"relation_ambiguous"}),
		reviewIssueTestEvent(uid, updateId, 24102, 1782925200, 4350, &accountId, ECONOMIC_NATURE_EXPENSE, FLOW_DIRECTION_OUTFLOW, []string{"relation_ambiguous"}),
	}
	facts := []ReviewIssueEvidenceFact{
		{EventId: 24101, SourceType: "alipay", Counterparty: "1688平台商家", Item: "钱包", TransactionType: "payment", Currency: "CNY"},
		{EventId: 24102, SourceType: "credit_card", Counterparty: "1688平台商家", Item: "钱包", TransactionType: "payment", Currency: "CNY"},
	}
	projection, err := BuildReviewIssueProjection(uid, updateId, events, facts, 1783000200, reviewIssueTestIds(27000))
	if err != nil || len(projection.Issues) != 1 || len(projection.Members) != 2 {
		t.Fatalf("same-event projection mismatch: projection=%+v err=%v", projection, err)
	}
	issue := projection.Issues[0]
	if issue.Type != REVIEW_ISSUE_TYPE_SAME_EVENT || issue.CandidateCount != 2 || issue.MemberCount != 2 || issue.SummaryCode != "review_same_event" {
		t.Fatalf("same-event issue mismatch: %+v", issue)
	}
}

func TestBuildReviewIssueProjectionRequiresRefundRelation(t *testing.T) {
	const uid = int64(21003)
	const updateId = int64(22003)
	accountId := int64(23003)
	event := reviewIssueTestEvent(uid, updateId, 24201, 1783000000, 466, &accountId, ECONOMIC_NATURE_REFUND, FLOW_DIRECTION_INFLOW, []string{"refund_relation_required"})
	projection, err := BuildReviewIssueProjection(uid, updateId, []*EconomicEvent{event}, []ReviewIssueEvidenceFact{{EventId: event.EventId, Counterparty: "义乌市千单日用品有限公司", Currency: "CNY"}}, 1783000300, reviewIssueTestIds(28000))
	if err != nil || len(projection.Issues) != 1 || projection.Issues[0].Type != REVIEW_ISSUE_TYPE_REFUND_RELATION || projection.Issues[0].MemberCount != 1 {
		t.Fatalf("refund issue mismatch: projection=%+v err=%v", projection, err)
	}
}

func TestBuildReviewIssueProjectionUsesDependencyPriority(t *testing.T) {
	const uid = int64(21004)
	const updateId = int64(22004)
	event := reviewIssueTestEvent(uid, updateId, 24301, 1783000000, 100, nil, ECONOMIC_NATURE_UNKNOWN, FLOW_DIRECTION_INFLOW, []string{"ledger_account_required", "economic_nature_required"})
	projection, err := BuildReviewIssueProjection(uid, updateId, []*EconomicEvent{event}, []ReviewIssueEvidenceFact{{EventId: event.EventId, SourceType: "alipay", PaymentMethod: "余额宝", Currency: "CNY"}}, 1783000400, reviewIssueTestIds(29000))
	if err != nil || len(projection.Issues) != 1 || projection.Issues[0].Type != REVIEW_ISSUE_TYPE_ACCOUNT_MAPPING {
		t.Fatalf("account dependency was not prioritized: projection=%+v err=%v", projection, err)
	}
}

func TestBuildReviewIssueProjectionRejectsDuplicateGeneratedIds(t *testing.T) {
	const uid = int64(21005)
	const updateId = int64(22005)
	accountId := int64(23005)
	event := reviewIssueTestEvent(uid, updateId, 24401, 1783000000, 100, &accountId, ECONOMIC_NATURE_UNKNOWN, FLOW_DIRECTION_INFLOW, []string{"economic_nature_required"})
	_, err := BuildReviewIssueProjection(uid, updateId, []*EconomicEvent{event}, []ReviewIssueEvidenceFact{{EventId: event.EventId, SourceType: "alipay", Currency: "CNY"}}, 1783000500, func() int64 { return 30001 })
	if !errors.Is(err, ErrReviewIssueProjectionInvalid) {
		t.Fatalf("duplicate generated ids were accepted: %v", err)
	}
}

func reviewIssueTestEvent(uid int64, updateId int64, eventId int64, unixTime int64, amount int64, accountId *int64, nature EconomicNature, direction FlowDirection, reasons []string) *EconomicEvent {
	offset := int16(480)
	return &EconomicEvent{
		Uid: uid, UpdateId: updateId, EventId: eventId, EventKey: fmt.Sprintf("%064x", eventId), EventKeyVersion: EVENT_KEY_VERSION_V1,
		Status: EVENT_STATUS_NEEDS_ACTION, Version: 1, FlowDirection: direction, EconomicNature: nature,
		LedgerAccountId: cloneInt64Pointer(accountId), EventUnixTime: &unixTime, TimezoneUtcOffset: &offset, Amount: &amount, Currency: "CNY",
		RuleVersion: PLAN_VERSION_V1, FieldSourcesJson: "{}", ReasonCodesJson: reasonCodesJSON(reasons), CreatedUnixTime: unixTime, UpdatedUnixTime: unixTime,
	}
}

func reviewIssueClone(event *EconomicEvent) *EconomicEvent {
	cloned := *event
	cloned.LedgerAccountId = cloneInt64Pointer(event.LedgerAccountId)
	cloned.CounterpartyLedgerAccountId = cloneInt64Pointer(event.CounterpartyLedgerAccountId)
	cloned.EventUnixTime = cloneInt64Pointer(event.EventUnixTime)
	cloned.TimezoneUtcOffset = cloneInt16Pointer(event.TimezoneUtcOffset)
	cloned.Amount = cloneInt64Pointer(event.Amount)
	cloned.CategoryId = cloneInt64Pointer(event.CategoryId)
	return &cloned
}

func reviewIssueTestIds(start int64) func() int64 {
	current := start
	return func() int64 {
		current++
		return current
	}
}
