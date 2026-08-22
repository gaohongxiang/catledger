package organizer

import (
	"fmt"
	"sort"
	"strconv"
	"time"
)

// CoalesceSameEventReviewIssues groups only already-ambiguous events into one
// comparison issue. It never merges events or changes their ledger effect.
func CoalesceSameEventReviewIssues(plan *OrganizePlan, reviewPlan *ReviewIssuePlan) error {
	if plan == nil || reviewPlan == nil {
		return fmt.Errorf("invalid same-event review issue projection")
	}
	events := make(map[int64]*EconomicEvent, len(plan.Events))
	for _, event := range plan.Events {
		if event == nil || event.EventId < 1 {
			return fmt.Errorf("invalid same-event review event")
		}
		events[event.EventId] = event
	}
	membersByIssue := make(map[int64][]*ReviewIssueMember)
	for _, member := range reviewPlan.Members {
		if member == nil || member.IssueId < 1 {
			return fmt.Errorf("invalid same-event review member")
		}
		membersByIssue[member.IssueId] = append(membersByIssue[member.IssueId], member)
	}

	buckets := make(map[string][]*ReviewIssue)
	for _, issue := range reviewPlan.Issues {
		if issue == nil || issue.IssueId < 1 {
			return fmt.Errorf("invalid same-event review issue")
		}
		if issue.IssueType != REVIEW_ISSUE_TYPE_SAME_EVENT || issue.Status != REVIEW_ISSUE_STATUS_OPEN {
			continue
		}
		subjects := make([]*EconomicEvent, 0)
		for _, member := range membersByIssue[issue.IssueId] {
			if member.ObjectType == REVIEW_OBJECT_TYPE_EVENT && member.Role == REVIEW_ISSUE_MEMBER_ROLE_SUBJECT {
				if event := events[member.ObjectId]; event != nil {
					subjects = append(subjects, event)
				}
			}
		}
		if len(subjects) != 1 {
			continue
		}
		buckets[sameEventIssueSignature(subjects[0], issue.PrimaryReasonCode)] = append(buckets[sameEventIssueSignature(subjects[0], issue.PrimaryReasonCode)], issue)
	}

	removed := make(map[int64]struct{})
	for _, issues := range buckets {
		if len(issues) < 2 {
			continue
		}
		sort.Slice(issues, func(i, j int) bool { return issues[i].IssueId < issues[j].IssueId })
		primary := issues[0]
		combinedReasons := decodeReasonCodes(primary.ReasonCodesJson)
		combinedMembers := append([]*ReviewIssueMember(nil), membersByIssue[primary.IssueId]...)
		for _, issue := range issues[1:] {
			removed[issue.IssueId] = struct{}{}
			combinedReasons = appendUniqueReasons(combinedReasons, decodeReasonCodes(issue.ReasonCodesJson)...)
			combinedMembers = append(combinedMembers, membersByIssue[issue.IssueId]...)
		}
		sort.Slice(combinedMembers, func(i, j int) bool {
			if combinedMembers[i].Role != combinedMembers[j].Role {
				return combinedMembers[i].Role < combinedMembers[j].Role
			}
			if combinedMembers[i].ObjectType != combinedMembers[j].ObjectType {
				return combinedMembers[i].ObjectType < combinedMembers[j].ObjectType
			}
			return combinedMembers[i].ObjectId < combinedMembers[j].ObjectId
		})
		seen := make(map[string]struct{})
		unique := combinedMembers[:0]
		for _, member := range combinedMembers {
			identity := string(member.ObjectType) + ":" + strconv.FormatInt(member.ObjectId, 10) + ":" + string(member.Role)
			if _, exists := seen[identity]; exists {
				continue
			}
			seen[identity] = struct{}{}
			member.IssueId = primary.IssueId
			member.SortOrder = int64(len(unique))
			member.MemberKey = stablePlanDigest("review-issue-member", string(REVIEW_ISSUE_MEMBER_KEY_VERSION_V1), primary.IssueKey,
				string(member.Role), string(member.ObjectType), strconv.FormatInt(member.ObjectId, 10))
			unique = append(unique, member)
		}
		membersByIssue[primary.IssueId] = unique
		primary.MemberCount = int64(len(unique))
		primary.CandidateCount = 0
		primary.ReasonCodesJson = reasonCodesJSON(combinedReasons)
	}

	if len(removed) == 0 {
		return nil
	}
	issues := reviewPlan.Issues[:0]
	members := reviewPlan.Members[:0]
	for _, issue := range reviewPlan.Issues {
		if _, deleted := removed[issue.IssueId]; !deleted {
			issues = append(issues, issue)
		}
	}
	for _, issue := range issues {
		members = append(members, membersByIssue[issue.IssueId]...)
	}
	reviewPlan.Issues = issues
	reviewPlan.Members = members
	reviewPlan.OpenBlockingIssueCount = int64(len(issues))
	return nil
}

func sameEventIssueSignature(event *EconomicEvent, reason string) string {
	date := ""
	if event.EventUnixTime != nil && *event.EventUnixTime > 0 {
		offset := int16(0)
		if event.TimezoneUtcOffset != nil {
			offset = *event.TimezoneUtcOffset
		}
		date = time.Unix(*event.EventUnixTime, 0).In(time.FixedZone("review-event", int(offset)*60)).Format(time.DateOnly)
	}
	return stablePlanDigest("same-event-review", string(REVIEW_ISSUE_RULE_VERSION_V1),
		strconv.FormatInt(pointerInt64Value(event.LedgerAccountId), 10),
		strconv.FormatInt(pointerInt64Value(event.Amount), 10), event.Currency, date,
		string(event.FlowDirection), string(event.EconomicNature), reason)
}
