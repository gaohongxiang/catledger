package organizer_test

import (
	"strings"
	"testing"

	"github.com/gaohongxiang/catledger/pkg/personalfinance/organizer"
)

func TestReviewIssueEngineSQLiteAppliesOneDecisionToIndependentEvents(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const uid = int64(11101)
	const updateId = int64(11201)
	first := postingEvent(uid, updateId, 11301, organizer.EVENT_STATUS_NEEDS_ACTION, organizer.ECONOMIC_NATURE_UNKNOWN)
	second := postingEvent(uid, updateId, 11302, organizer.EVENT_STATUS_NEEDS_ACTION, organizer.ECONOMIC_NATURE_UNKNOWN)
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{first, second})
	seedReviewIssue(t, repository, uid, updateId, 11401, organizer.REVIEW_ISSUE_TYPE_SHARED_FIELDS, first, second)

	engine, err := organizer.NewReviewIssueEngine(repository, &engineIdGenerator{next: 11500})
	if err != nil {
		t.Fatalf("create review issue engine: %v", err)
	}
	result, err := engine.Resolve(nil, organizer.ResolveReviewIssueRequest{
		Uid: uid, UpdateId: updateId, IssueId: 11401, ExpectedUpdateVersion: 2, ExpectedIssueVersion: 1,
		IdempotencyKey: "batch-income", Decision: organizer.REVIEW_ISSUE_DECISION_APPLY_FIELDS,
		Correction: organizer.EventCorrection{
			FieldMask:     organizer.MANUAL_FIELD_FLOW_DIRECTION | organizer.MANUAL_FIELD_ECONOMIC_NATURE,
			FlowDirection: organizer.FLOW_DIRECTION_INFLOW, EconomicNature: organizer.ECONOMIC_NATURE_INCOME,
		},
	})
	if err != nil || result == nil || result.Update.ReadyEventCount != 2 || result.Update.NeedsActionEventCount != 0 ||
		result.Issue.Status != organizer.REVIEW_ISSUE_STATUS_RESOLVED || len(result.Events) != 2 {
		t.Fatalf("batch review decision mismatch: result=%+v err=%v", result, err)
	}
	for _, event := range result.Events {
		if event.Status != organizer.EVENT_STATUS_READY || event.EconomicNature != organizer.ECONOMIC_NATURE_INCOME {
			t.Fatalf("batch decision did not preserve independent ready events: %+v", event)
		}
	}
}

func TestReviewIssueEngineSQLiteConfirmsSameEventByMovingEvidence(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const uid = int64(11102)
	const updateId = int64(11202)
	first := postingEvent(uid, updateId, 11311, organizer.EVENT_STATUS_NEEDS_ACTION, organizer.ECONOMIC_NATURE_EXPENSE)
	second := postingEvent(uid, updateId, 11312, organizer.EVENT_STATUS_NEEDS_ACTION, organizer.ECONOMIC_NATURE_EXPENSE)
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{first, second})
	seedReviewIssue(t, repository, uid, updateId, 11411, organizer.REVIEW_ISSUE_TYPE_SAME_EVENT, first, second)
	if err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		if err := tx.InsertEvidence(testReviewEvidence(uid, updateId, first.EventId, 11601, 11701)); err != nil {
			return err
		}
		return tx.InsertEvidence(testReviewEvidence(uid, updateId, second.EventId, 11602, 11702))
	}); err != nil {
		t.Fatalf("seed same-event evidence: %v", err)
	}

	engine, _ := organizer.NewReviewIssueEngine(repository, &engineIdGenerator{next: 11800})
	result, err := engine.Resolve(nil, organizer.ResolveReviewIssueRequest{
		Uid: uid, UpdateId: updateId, IssueId: 11411, ExpectedUpdateVersion: 2, ExpectedIssueVersion: 1,
		IdempotencyKey: "confirm-same", Decision: organizer.REVIEW_ISSUE_DECISION_CONFIRM_SAME, PrimaryEventId: first.EventId,
	})
	if err != nil || result == nil || result.Update.FinalEventCount != 1 || result.Update.DuplicateEvidenceCount != 1 ||
		result.Update.ReadyEventCount != 1 || result.Update.NeedsActionEventCount != 0 || len(result.Events) != 1 {
		t.Fatalf("same-event decision mismatch: result=%+v err=%v", result, err)
	}
	evidence, err := repository.ListEvidence(nil, uid, first.EventId)
	if err != nil || len(evidence) != 2 {
		t.Fatalf("same-event evidence was not consolidated: evidence=%+v err=%v", evidence, err)
	}
	removed, err := repository.FindEventById(nil, uid, second.EventId)
	if err != nil || removed != nil {
		t.Fatalf("secondary event remained after same-event decision: event=%+v err=%v", removed, err)
	}
}

func TestReviewIssueEngineSQLiteLinksRefundAndDerivesReady(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const uid = int64(11103)
	const updateId = int64(11203)
	original := postingEvent(uid, updateId, 11321, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_EXPENSE)
	refund := postingEvent(uid, updateId, 11322, organizer.EVENT_STATUS_NEEDS_ACTION, organizer.ECONOMIC_NATURE_REFUND)
	refund.FlowDirection = organizer.FLOW_DIRECTION_INFLOW
	*refund.EventUnixTime = *original.EventUnixTime + 100
	*refund.Amount = *original.Amount / 2
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{original, refund})
	seedReviewIssue(t, repository, uid, updateId, 11421, organizer.REVIEW_ISSUE_TYPE_REFUND_RELATION, refund)

	engine, _ := organizer.NewReviewIssueEngine(repository, &engineIdGenerator{next: 11900})
	result, err := engine.Resolve(nil, organizer.ResolveReviewIssueRequest{
		Uid: uid, UpdateId: updateId, IssueId: 11421, ExpectedUpdateVersion: 2, ExpectedIssueVersion: 1,
		IdempotencyKey: "link-refund", Decision: organizer.REVIEW_ISSUE_DECISION_LINK_REFUND, TargetEventId: original.EventId,
	})
	if err != nil || result == nil || result.Update.ReadyEventCount != 2 || result.Update.NeedsActionEventCount != 0 ||
		len(result.Events) != 1 || result.Events[0].Status != organizer.EVENT_STATUS_READY {
		t.Fatalf("refund review decision mismatch: result=%+v err=%v", result, err)
	}
	relations, err := repository.ListRelations(nil, uid, refund.EventId)
	if err != nil || len(relations) != 1 || relations[0].Status != organizer.RELATION_STATUS_CONFIRMED || !relations[0].Manual {
		t.Fatalf("refund relation mismatch: relations=%+v err=%v", relations, err)
	}
}

func TestReviewIssueEngineSQLiteConfirmsInstallmentPrincipalWithoutCreatingLedgerEvent(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const uid = int64(11104)
	const updateId = int64(11204)
	principal := postingEvent(uid, updateId, 11331, organizer.EVENT_STATUS_NEEDS_ACTION, organizer.ECONOMIC_NATURE_EXPENSE)
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{principal})
	seedReviewIssue(t, repository, uid, updateId, 11431, organizer.REVIEW_ISSUE_TYPE_INSTALLMENT_ORIGIN, principal)

	engine, _ := organizer.NewReviewIssueEngine(repository, &engineIdGenerator{next: 12000})
	result, err := engine.Resolve(nil, organizer.ResolveReviewIssueRequest{
		Uid: uid, UpdateId: updateId, IssueId: 11431, ExpectedUpdateVersion: 2, ExpectedIssueVersion: 1,
		IdempotencyKey: "installment-principal", Decision: organizer.REVIEW_ISSUE_DECISION_CONFIRM_INSTALLMENT_PRINCIPAL,
		InstallmentCandidateId: 88101,
	})
	if err != nil || result == nil || result.Update.ReadyEventCount != 0 || result.Update.NeedsActionEventCount != 0 ||
		result.Update.ExcludedEventCount != 1 || len(result.Events) != 1 || result.Events[0].Status != organizer.EVENT_STATUS_EXCLUDED {
		t.Fatalf("installment principal decision mismatch: result=%+v err=%v", result, err)
	}
	if !strings.Contains(result.Action.ReasonCodesJson, "installment_candidate:88101") ||
		!strings.Contains(result.Events[0].ReasonCodesJson, "installment_principal_confirmed") {
		t.Fatalf("installment decision did not retain durable projection intent: action=%s event=%s", result.Action.ReasonCodesJson, result.Events[0].ReasonCodesJson)
	}
}

func seedReviewIssue(t *testing.T, repository *organizer.Repository, uid int64, updateId int64, issueId int64,
	issueType organizer.ReviewIssueType, events ...*organizer.EconomicEvent) {
	t.Helper()
	err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		issue := &organizer.ReviewIssue{
			Uid: uid, UpdateId: updateId, Status: organizer.REVIEW_ISSUE_STATUS_OPEN, IssueType: issueType,
			IssueKey: strings.Repeat("a", 63) + string(rune('a'+issueId%6)), IssueKeyVersion: organizer.REVIEW_ISSUE_KEY_VERSION_V1,
			Version: 1, Blocking: true, PrimaryReasonCode: "test_review_issue", MemberCount: int64(len(events)),
			RuleVersion: organizer.REVIEW_ISSUE_RULE_VERSION_V1, ReasonCodesJson: "[]",
			CreatedUnixTime: 101, UpdatedUnixTime: 101, IssueId: issueId,
		}
		if err := tx.InsertReviewIssue(issue); err != nil {
			return err
		}
		for index, event := range events {
			member := &organizer.ReviewIssueMember{
				Uid: uid, UpdateId: updateId, IssueId: issueId,
				MemberKey: strings.Repeat(string(rune('b'+index)), 64), MemberKeyVersion: organizer.REVIEW_ISSUE_MEMBER_KEY_VERSION_V1,
				Role: organizer.REVIEW_ISSUE_MEMBER_ROLE_SUBJECT, ObjectType: organizer.REVIEW_OBJECT_TYPE_EVENT,
				ObjectId: event.EventId, ObjectVersion: event.Version, SortOrder: int64(index),
				ReasonCodesJson: "[]", CreatedUnixTime: 101, MemberId: issueId + int64(index) + 100,
			}
			if err := tx.InsertReviewIssueMember(member); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("seed review issue: %v", err)
	}
}

func testReviewEvidence(uid int64, updateId int64, eventId int64, rowId int64, evidenceId int64) *organizer.EconomicEventEvidence {
	return &organizer.EconomicEventEvidence{
		Uid: uid, UpdateId: updateId, EventId: eventId, RowId: rowId,
		EvidenceRole: organizer.EVIDENCE_ROLE_PRIMARY, CreatedUnixTime: 101, EvidenceId: evidenceId,
	}
}
