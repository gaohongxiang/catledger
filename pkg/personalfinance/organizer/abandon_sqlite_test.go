package organizer_test

import (
	"errors"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/organizer"
)

func TestAbandonEngineSQLitePreservesAuditAndReleasesSources(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	const uid = int64(18101)
	const updateId = int64(18201)
	const eventId = int64(18301)
	const issueId = int64(18401)
	event := postingEvent(uid, updateId, eventId, organizer.EVENT_STATUS_NEEDS_ACTION, organizer.ECONOMIC_NATURE_UNKNOWN)
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{event})
	seedReviewIssue(t, repository, uid, updateId, issueId, organizer.REVIEW_ISSUE_TYPE_SHARED_FIELDS, event)

	engine, err := organizer.NewAbandonEngine(repository, &engineIdGenerator{next: 18500})
	if err != nil {
		t.Fatalf("create abandon engine: %v", err)
	}
	request := organizer.AbandonRequest{
		Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 2, IdempotencyKey: "abandon-review-round",
	}
	result, err := engine.Abandon(nil, request)
	if err != nil || result == nil || result.Replayed || result.Update == nil ||
		result.Update.Status != organizer.UPDATE_STATUS_ABANDONED || result.Update.Version != 3 ||
		result.Update.PostedEventCount != 0 || result.Update.NeedsActionEventCount != 1 ||
		result.Action == nil || result.Action.Status != organizer.ACTION_STATUS_APPLIED ||
		result.Action.ActionType != organizer.ACTION_TYPE_ABANDON_UPDATE || result.Action.AppliedUpdateVersion != 3 {
		t.Fatalf("abandon result mismatch: result=%+v err=%v", result, err)
	}

	sources, err := repository.ListSources(nil, uid, updateId)
	if err != nil || len(sources) != 1 {
		t.Fatalf("abandon removed immutable sources: sources=%+v err=%v", sources, err)
	}
	events, err := repository.ListEvents(nil, uid, updateId)
	if err != nil || len(events) != 1 || events[0].EventId != eventId || events[0].Status != organizer.EVENT_STATUS_NEEDS_ACTION {
		t.Fatalf("abandon removed event audit history: events=%+v err=%v", events, err)
	}
	issues, err := repository.ListReviewIssues(nil, uid, updateId)
	if err != nil || len(issues) != 1 || issues[0].IssueId != issueId || issues[0].Status != organizer.REVIEW_ISSUE_STATUS_OPEN {
		t.Fatalf("abandon removed issue audit history: issues=%+v err=%v", issues, err)
	}

	replayed, err := engine.Abandon(nil, request)
	if err != nil || replayed == nil || !replayed.Replayed || replayed.Action.ActionId != result.Action.ActionId {
		t.Fatalf("abandon replay mismatch: result=%+v err=%v", replayed, err)
	}

	batchId := sources[0].BatchId
	create, err := organizer.NewCreateEngine(repository, &engineEvidenceStub{batches: map[int64]*importing.ImportBatch{
		batchId: organizerCreateBatch(uid, batchId, sources[0].FileId),
	}}, &engineIdGenerator{next: 18600})
	if err != nil {
		t.Fatalf("create replacement update engine: %v", err)
	}
	replacement, err := create.Create(nil, organizer.CreateUpdateRequest{
		Uid: uid, BatchIds: []int64{batchId}, IdempotencyKey: "replacement-round",
	})
	if err != nil || replacement == nil || replacement.Update.Status != organizer.UPDATE_STATUS_DRAFT ||
		replacement.Update.UpdateId == updateId {
		t.Fatalf("abandoned source was not reusable: result=%+v err=%v", replacement, err)
	}

	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	links, linkErr := sess.Where("uid=? AND update_id=?", uid, updateId).Count(new(organizer.EconomicEventTransaction))
	if linkErr != nil || links != 0 {
		t.Fatalf("abandoned update unexpectedly has ledger links: links=%d err=%v", links, linkErr)
	}
}

func TestAbandonEngineSQLiteRejectsVersionAndPostedRounds(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	if err := database.SyncStructs(new(models.Transaction)); err != nil {
		t.Fatalf("create abandon rejection ledger table: %v", err)
	}
	const uid = int64(18102)
	const reviewUpdateId = int64(18202)
	seedPostingUpdate(t, repository, uid, reviewUpdateId, []*organizer.EconomicEvent{
		postingEvent(uid, reviewUpdateId, 18302, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_EXPENSE),
	})
	engine, _ := organizer.NewAbandonEngine(repository, &engineIdGenerator{next: 18700})

	_, err := engine.Abandon(nil, organizer.AbandonRequest{
		Uid: uid, UpdateId: reviewUpdateId, ExpectedUpdateVersion: 1, IdempotencyKey: "stale-abandon",
	})
	if !errors.Is(err, organizer.ErrAbandonVersionConflict) {
		t.Fatalf("stale abandon version was accepted: %v", err)
	}

	ledger := &postingLedgerStub{next: 18800}
	posting, err := organizer.NewPostingEngine(repository, ledger, &engineIdGenerator{next: 18900})
	if err != nil {
		t.Fatalf("create posting engine: %v", err)
	}
	posted, err := posting.Post(nil, organizer.PostRequest{
		Uid: uid, UpdateId: reviewUpdateId, ExpectedUpdateVersion: 2,
		IdempotencyKey: "post-before-abandon", Mode: organizer.POST_MODE_ALL_READY,
	})
	if err != nil {
		t.Fatalf("post abandon rejection fixture: %v", err)
	}
	_, err = engine.Abandon(nil, organizer.AbandonRequest{
		Uid: uid, UpdateId: reviewUpdateId, ExpectedUpdateVersion: posted.Update.Version,
		IdempotencyKey: "reject-posted-abandon",
	})
	if !errors.Is(err, organizer.ErrAbandonStateConflict) {
		t.Fatalf("posted round was abandoned: %v", err)
	}
}

func TestAbandonEngineSQLiteAllowsDraftRound(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const uid = int64(18103)
	const batchId = int64(18203)
	create, _ := organizer.NewCreateEngine(repository, &engineEvidenceStub{batches: map[int64]*importing.ImportBatch{
		batchId: organizerCreateBatch(uid, batchId, 18303),
	}}, &engineIdGenerator{next: 19000})
	created, err := create.Create(nil, organizer.CreateUpdateRequest{Uid: uid, BatchIds: []int64{batchId}, IdempotencyKey: "draft-round"})
	if err != nil {
		t.Fatalf("create draft abandon fixture: %v", err)
	}
	engine, _ := organizer.NewAbandonEngine(repository, &engineIdGenerator{next: 19100})
	result, err := engine.Abandon(nil, organizer.AbandonRequest{
		Uid: uid, UpdateId: created.Update.UpdateId, ExpectedUpdateVersion: created.Update.Version,
		IdempotencyKey: "abandon-draft-round",
	})
	if err != nil || result == nil || result.Update.Status != organizer.UPDATE_STATUS_ABANDONED {
		t.Fatalf("draft round was not abandoned: result=%+v err=%v", result, err)
	}
}
