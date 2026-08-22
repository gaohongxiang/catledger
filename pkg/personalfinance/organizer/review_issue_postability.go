package organizer

import "fmt"

// ApplyReviewIssueBlockers materializes the issue projection's blocking fact on
// every affected event. Ordinary field correction must preserve this reason;
// only a dedicated issue-resolution action may remove it.
func ApplyReviewIssueBlockers(plan *OrganizePlan, reviewPlan *ReviewIssuePlan) error {
	if plan == nil || reviewPlan == nil {
		return fmt.Errorf("review issue blocker input is nil")
	}
	if err := CoalesceSameEventReviewIssues(plan, reviewPlan); err != nil {
		return err
	}
	events := make(map[int64]*EconomicEvent, len(plan.Events))
	for _, event := range plan.Events {
		if event == nil || event.EventId < 1 {
			return fmt.Errorf("review issue blocker event is invalid")
		}
		if _, exists := events[event.EventId]; exists {
			return fmt.Errorf("review issue blocker event is duplicated")
		}
		events[event.EventId] = event
	}
	openIssues := make(map[int64]*ReviewIssue, len(reviewPlan.Issues))
	for _, issue := range reviewPlan.Issues {
		if issue == nil || issue.IssueId < 1 || issue.Status != REVIEW_ISSUE_STATUS_OPEN || !issue.Blocking {
			return fmt.Errorf("review issue blocker issue is invalid")
		}
		if _, exists := openIssues[issue.IssueId]; exists {
			return fmt.Errorf("review issue blocker issue is duplicated")
		}
		openIssues[issue.IssueId] = issue
	}
	covered := make(map[int64]int)
	for _, member := range reviewPlan.Members {
		if member == nil || openIssues[member.IssueId] == nil || member.ObjectType != REVIEW_OBJECT_TYPE_EVENT {
			continue
		}
		event := events[member.ObjectId]
		if event == nil || member.ObjectVersion != event.Version {
			return fmt.Errorf("review issue blocker member snapshot mismatch")
		}
		covered[event.EventId]++
	}
	for _, event := range plan.Events {
		if event.Status == EVENT_STATUS_NEEDS_ACTION {
			if covered[event.EventId] != 1 {
				return fmt.Errorf("review issue blocker coverage mismatch")
			}
			reasons := decodeReasonCodes(event.ReasonCodesJson)
			event.ReasonCodesJson = reasonCodesJSON(appendUniqueReasons(reasons, reasonBlockingIssueOpen))
			continue
		}
		if covered[event.EventId] != 0 {
			return fmt.Errorf("non-actionable event is attached to a blocking issue")
		}
	}
	if int64(len(openIssues)) != reviewPlan.OpenBlockingIssueCount {
		return fmt.Errorf("review issue blocker count mismatch")
	}
	return nil
}
