package organizer

import (
	"errors"
	"fmt"
)

var ErrPostabilityInputInvalid = errors.New("economic event postability input is invalid")

const (
	reasonBorrowAccountRequired            = "borrow_account_required"
	reasonBalanceAdjustmentMappingRequired = "balance_adjustment_mapping_required"
	reasonRefundRelationInvalid            = "refund_relation_invalid"
	reasonBlockingIssueOpen                 = "blocking_issue_open"
	reasonPostabilityDirectionConflict      = "postability_direction_conflict"
)

// PostabilityInput contains the complete semantic facts required to derive an
// unposted event's status. The caller may supply persisted hard blockers that
// cannot be resolved by ordinary field editing and the number of open issues.
type PostabilityInput struct {
	Event                   *EconomicEvent
	Relations               []*EconomicEventRelation
	ExistingBlockingReasons []string
	OpenBlockingIssueCount  int64
}

// PostabilityResult is a server-derived decision. Clients submit facts and
// explicit domain decisions; they never choose ready directly.
type PostabilityResult struct {
	Status      EventStatus
	ReasonCodes []string
}

// EvaluatePostability is the single semantic gate used before an event can be
// persisted as ready or written to the core ledger.
func EvaluatePostability(input PostabilityInput) (*PostabilityResult, error) {
	event := input.Event
	if event == nil || event.Uid < 1 || event.UpdateId < 1 || event.EventId < 1 ||
		!isEventStatus(event.Status) || !isFlowDirection(event.FlowDirection) ||
		!isEconomicNature(event.EconomicNature) || input.OpenBlockingIssueCount < 0 {
		return nil, ErrPostabilityInputInvalid
	}
	if event.Status == EVENT_STATUS_POSTED || event.Status == EVENT_STATUS_CORRECTED {
		return nil, fmt.Errorf("%w: terminal event", ErrPostabilityInputInvalid)
	}
	if event.Status == EVENT_STATUS_EXCLUDED {
		return &PostabilityResult{Status: EVENT_STATUS_EXCLUDED}, nil
	}

	reasons := appendUniqueReasons(nil, input.ExistingBlockingReasons...)
	if input.OpenBlockingIssueCount > 0 {
		reasons = appendUniqueReasons(reasons, reasonBlockingIssueOpen)
	}
	if !eventHasCorePostingFields(event) {
		reasons = appendUniqueReasons(reasons, reasonCoreFieldsMissing)
		if event.LedgerAccountId == nil || *event.LedgerAccountId < 1 {
			reasons = appendUniqueReasons(reasons, reasonLedgerAccountRequired)
		}
	}

	switch event.EconomicNature {
	case ECONOMIC_NATURE_UNKNOWN:
		reasons = appendUniqueReasons(reasons, reasonEconomicNatureRequired)
	case ECONOMIC_NATURE_INCOME:
		reasons = requirePostabilityDirection(reasons, event, FLOW_DIRECTION_INFLOW)
	case ECONOMIC_NATURE_EXPENSE, ECONOMIC_NATURE_FEE:
		reasons = requirePostabilityDirection(reasons, event, FLOW_DIRECTION_OUTFLOW)
	case ECONOMIC_NATURE_REFUND:
		reasons = requirePostabilityDirection(reasons, event, FLOW_DIRECTION_INFLOW)
		reasons = appendUniqueReasons(reasons, evaluateRefundPostability(event, input.Relations)...)
	case ECONOMIC_NATURE_INTERNAL_TRANSFER:
		reasons = requirePostabilityDirection(reasons, event, FLOW_DIRECTION_NEUTRAL)
		reasons = requireCounterpartyAccount(reasons, event, reasonTransferAccountRequired)
	case ECONOMIC_NATURE_REPAYMENT:
		reasons = requirePostabilityDirection(reasons, event, FLOW_DIRECTION_NEUTRAL)
		reasons = requireCounterpartyAccount(reasons, event, reasonRepaymentAccountRequired)
	case ECONOMIC_NATURE_BORROW:
		reasons = requirePostabilityDirection(reasons, event, FLOW_DIRECTION_NEUTRAL)
		reasons = requireCounterpartyAccount(reasons, event, reasonBorrowAccountRequired)
	case ECONOMIC_NATURE_BALANCE_ADJUSTMENT:
		// The core ledger represents balance modification with a target balance
		// and a derived delta. The organizer currently stores only one amount, so
		// this nature remains blocked until that mapping is explicit and lossless.
		reasons = appendUniqueReasons(reasons, reasonBalanceAdjustmentMappingRequired)
	default:
		return nil, ErrPostabilityInputInvalid
	}

	status := EVENT_STATUS_READY
	if len(reasons) > 0 {
		status = EVENT_STATUS_NEEDS_ACTION
	}
	return &PostabilityResult{Status: status, ReasonCodes: reasons}, nil
}

func eventHasCorePostingFields(event *EconomicEvent) bool {
	return event != nil && event.LedgerAccountId != nil && *event.LedgerAccountId > 0 &&
		event.EventUnixTime != nil && *event.EventUnixTime > 0 && event.Amount != nil && *event.Amount >= 0 &&
		len(event.Currency) == 3
}

func requirePostabilityDirection(reasons []string, event *EconomicEvent, expected FlowDirection) []string {
	if event.FlowDirection != expected {
		return appendUniqueReasons(reasons, reasonPostabilityDirectionConflict)
	}
	return reasons
}

func requireCounterpartyAccount(reasons []string, event *EconomicEvent, reason string) []string {
	if event.CounterpartyLedgerAccountId == nil || *event.CounterpartyLedgerAccountId < 1 ||
		event.LedgerAccountId == nil || *event.LedgerAccountId < 1 ||
		*event.CounterpartyLedgerAccountId == *event.LedgerAccountId {
		return appendUniqueReasons(reasons, reason)
	}
	return reasons
}

func evaluateRefundPostability(event *EconomicEvent, relations []*EconomicEventRelation) []string {
	confirmedCount := 0
	proposedCount := 0
	invalid := false

	for _, relation := range relations {
		if relation == nil {
			invalid = true
			continue
		}
		if relation.RelationType != RELATION_TYPE_REFUND_OF || relation.SourceEventId != event.EventId {
			continue
		}
		if relation.Uid != event.Uid || relation.SourceEventId == relation.TargetEventId || relation.TargetEventId < 1 {
			invalid = true
			continue
		}
		switch relation.Status {
		case RELATION_STATUS_CONFIRMED:
			confirmedCount++
			if relation.Amount == nil || *relation.Amount <= 0 || event.Amount == nil ||
				*relation.Amount != *event.Amount || relation.Currency != event.Currency {
				invalid = true
			}
		case RELATION_STATUS_PROPOSED:
			proposedCount++
		case RELATION_STATUS_REJECTED, RELATION_STATUS_UNDONE:
		default:
			invalid = true
		}
	}

	reasons := make([]string, 0, 3)
	if confirmedCount == 0 {
		reasons = appendUniqueReasons(reasons, reasonRefundRelationRequired)
	}
	if confirmedCount > 1 || proposedCount > 0 {
		reasons = appendUniqueReasons(reasons, reasonRelationAmbiguous)
	}
	if invalid {
		reasons = appendUniqueReasons(reasons, reasonRefundRelationInvalid)
	}
	return reasons
}

// hardBlockingReasonCodes keeps decisions that ordinary field correction is
// not allowed to erase. They are removed only by a dedicated issue/relation
// action that records the user's actual decision.
func hardBlockingReasonCodes(encoded string) []string {
	result := make([]string, 0)
	for _, reason := range decodeReasonCodes(encoded) {
		switch reason {
		case reasonCoreFieldsConflict,
			reasonIdentityConflict,
			reasonIdentityReviewRequired,
			reasonRelationAmbiguous,
			reasonRefundAmountExceeded,
			reasonRefundRelationAmbiguous,
			reasonBlockingIssueOpen:
			result = appendUniqueReasons(result, reason)
		}
	}
	return result
}

// mergePostabilityReasonCodes preserves explanatory evidence reasons while
// replacing all readiness-related reasons with the result from the canonical
// evaluator.
func mergePostabilityReasonCodes(previous string, result *PostabilityResult, event *EconomicEvent, extra ...string) string {
	reasons := retainedInformationalReasonCodes(previous)
	reasons = appendUniqueReasons(reasons, extra...)
	if result != nil {
		reasons = appendUniqueReasons(reasons, result.ReasonCodes...)
	}
	if result != nil && result.Status == EVENT_STATUS_READY && event != nil &&
		event.EconomicNature == ECONOMIC_NATURE_EXPENSE && event.CategoryId == nil {
		reasons = appendUniqueReasons(reasons, reasonCategoryUnclassified)
	}
	return reasonCodesJSON(reasons)
}

func retainedInformationalReasonCodes(encoded string) []string {
	result := make([]string, 0)
	for _, reason := range decodeReasonCodes(encoded) {
		if !isManagedPostabilityReason(reason) {
			result = appendUniqueReasons(result, reason)
		}
	}
	return result
}

func isManagedPostabilityReason(reason string) bool {
	switch reason {
	case reasonCoreFieldsMissing,
		reasonLedgerAccountRequired,
		reasonEconomicNatureRequired,
		reasonTransferAccountRequired,
		reasonRepaymentAccountRequired,
		reasonRefundRelationRequired,
		reasonCategoryUnclassified,
		reasonCoreFieldsConflict,
		reasonIdentityConflict,
		reasonIdentityReviewRequired,
		reasonRelationAmbiguous,
		reasonRefundAmountExceeded,
		reasonRefundRelationAmbiguous,
		reasonBorrowAccountRequired,
		reasonBalanceAdjustmentMappingRequired,
		reasonRefundRelationInvalid,
		reasonBlockingIssueOpen,
		reasonPostabilityDirectionConflict:
		return true
	default:
		return false
	}
}

func appendUniqueReasons(current []string, values ...string) []string {
	seen := make(map[string]struct{}, len(current)+len(values))
	for _, reason := range current {
		if reason != "" {
			seen[reason] = struct{}{}
		}
	}
	for _, reason := range values {
		if reason == "" {
			continue
		}
		if _, exists := seen[reason]; exists {
			continue
		}
		seen[reason] = struct{}{}
		current = append(current, reason)
	}
	return current
}
