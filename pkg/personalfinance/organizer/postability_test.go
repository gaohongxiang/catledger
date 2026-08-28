package organizer

import "testing"

func TestEvaluatePostabilityDerivesOrdinaryAndPairedEvents(t *testing.T) {
	income := postabilityFixture(ECONOMIC_NATURE_INCOME, FLOW_DIRECTION_INFLOW)
	result, err := EvaluatePostability(PostabilityInput{Event: income})
	if err != nil || result.Status != EVENT_STATUS_READY || len(result.ReasonCodes) != 0 {
		t.Fatalf("income postability mismatch: result=%+v err=%v", result, err)
	}

	borrow := postabilityFixture(ECONOMIC_NATURE_BORROW, FLOW_DIRECTION_NEUTRAL)
	counterparty := int64(12)
	borrow.CounterpartyLedgerAccountId = &counterparty
	result, err = EvaluatePostability(PostabilityInput{Event: borrow})
	if err != nil || result.Status != EVENT_STATUS_READY {
		t.Fatalf("borrow postability mismatch: result=%+v err=%v", result, err)
	}

	borrow.CounterpartyLedgerAccountId = borrow.LedgerAccountId
	result, err = EvaluatePostability(PostabilityInput{Event: borrow})
	if err != nil || result.Status != EVENT_STATUS_NEEDS_ACTION || !containsPostabilityReason(result.ReasonCodes, reasonBorrowAccountRequired) {
		t.Fatalf("same-account borrow was accepted: result=%+v err=%v", result, err)
	}
}

func TestEvaluatePostabilityAllowsUnlinkedRefundAndValidatesPresentRelation(t *testing.T) {
	refund := postabilityFixture(ECONOMIC_NATURE_REFUND, FLOW_DIRECTION_INFLOW)
	result, err := EvaluatePostability(PostabilityInput{Event: refund})
	if err != nil || result.Status != EVENT_STATUS_READY || len(result.ReasonCodes) != 0 {
		t.Fatalf("refund without relation mismatch: result=%+v err=%v", result, err)
	}

	amount := *refund.Amount
	relation := &EconomicEventRelation{
		Uid: refund.Uid, UpdateId: refund.UpdateId, RelationType: RELATION_TYPE_REFUND_OF,
		Status: RELATION_STATUS_CONFIRMED, SourceEventId: refund.EventId, TargetEventId: refund.EventId + 1,
		Amount: &amount, Currency: refund.Currency,
	}
	result, err = EvaluatePostability(PostabilityInput{Event: refund, Relations: []*EconomicEventRelation{relation}})
	if err != nil || result.Status != EVENT_STATUS_READY || len(result.ReasonCodes) != 0 {
		t.Fatalf("confirmed refund mismatch: result=%+v err=%v", result, err)
	}

	otherAmount := amount - 1
	relation.Amount = &otherAmount
	result, err = EvaluatePostability(PostabilityInput{Event: refund, Relations: []*EconomicEventRelation{relation}})
	if err != nil || result.Status != EVENT_STATUS_NEEDS_ACTION || !containsPostabilityReason(result.ReasonCodes, reasonRefundRelationInvalid) {
		t.Fatalf("invalid refund relation was accepted: result=%+v err=%v", result, err)
	}
}

func TestEvaluatePostabilityPreservesHardBlockersAndBlocksUnsupportedAdjustment(t *testing.T) {
	event := postabilityFixture(ECONOMIC_NATURE_EXPENSE, FLOW_DIRECTION_OUTFLOW)
	result, err := EvaluatePostability(PostabilityInput{
		Event: event, ExistingBlockingReasons: []string{reasonRelationAmbiguous},
	})
	if err != nil || result.Status != EVENT_STATUS_NEEDS_ACTION || !containsPostabilityReason(result.ReasonCodes, reasonRelationAmbiguous) {
		t.Fatalf("hard blocker was cleared: result=%+v err=%v", result, err)
	}

	adjustment := postabilityFixture(ECONOMIC_NATURE_BALANCE_ADJUSTMENT, FLOW_DIRECTION_NEUTRAL)
	result, err = EvaluatePostability(PostabilityInput{Event: adjustment})
	if err != nil || result.Status != EVENT_STATUS_NEEDS_ACTION || !containsPostabilityReason(result.ReasonCodes, reasonBalanceAdjustmentMappingRequired) {
		t.Fatalf("unsupported adjustment was accepted: result=%+v err=%v", result, err)
	}
}

func postabilityFixture(nature EconomicNature, direction FlowDirection) *EconomicEvent {
	accountId := int64(11)
	eventTime := int64(1_700_000_000)
	amount := int64(100)
	return &EconomicEvent{
		Uid: 1, UpdateId: 2, EventId: 3, Status: EVENT_STATUS_NEEDS_ACTION, Version: 1,
		FlowDirection: direction, EconomicNature: nature, LedgerAccountId: &accountId,
		EventUnixTime: &eventTime, Amount: &amount, Currency: "CNY",
		FieldSourcesJson: "{}", ReasonCodesJson: "[]",
	}
}

func containsPostabilityReason(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
