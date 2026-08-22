package api

import (
	"errors"
	"strconv"
	"strings"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/errs"
	"github.com/mayswind/ezbookkeeping/pkg/log"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/organizer"
	"github.com/mayswind/ezbookkeeping/pkg/uuid"
)

type personalFinanceReviewIssueApplication interface {
	ListReviewIssues(c core.Context, uid int64, updateId int64, status organizer.ReviewIssueStatus, issueType organizer.ReviewIssueType,
		cursor *organizer.ReviewIssueCursor, limit int) (*organizer.ReviewIssuePage, []*organizer.ReviewIssueMember, error)
	GetReviewIssue(c core.Context, uid int64, issueId int64) (*personalFinanceReviewIssueDetail, error)
	ResolveReviewIssue(c core.Context, request organizer.ResolveReviewIssueRequest) (*organizer.ResolveReviewIssueResult, error)
}

type personalFinanceReviewIssueDetail struct {
	Issue     *organizer.ReviewIssue
	Members   []*organizer.ReviewIssueMember
	Events    []*organizer.EconomicEvent
	Relations []*organizer.EconomicEventRelation
	Links     []*organizer.EconomicEventTransaction
}

type personalFinanceReviewIssueResolveRequest struct {
	UpdateId                    int64                         `json:"updateId,string"`
	IssueId                     int64                         `json:"issueId,string"`
	ExpectedUpdateVersion       int64                         `json:"expectedUpdateVersion"`
	ExpectedIssueVersion        int64                         `json:"expectedIssueVersion"`
	IdempotencyKey              string                        `json:"idempotencyKey"`
	Decision                    organizer.ReviewIssueDecision `json:"decision"`
	FieldMask                   int64                         `json:"fieldMask"`
	FlowDirection               organizer.FlowDirection       `json:"flowDirection"`
	EconomicNature              organizer.EconomicNature      `json:"economicNature"`
	LedgerAccountId             *int64                        `json:"ledgerAccountId,string"`
	CounterpartyLedgerAccountId *int64                        `json:"counterpartyLedgerAccountId,string"`
	EventUnixTime               *int64                        `json:"eventUnixTime"`
	TimezoneUtcOffset           *int16                        `json:"timezoneUtcOffset"`
	Amount                      *int64                        `json:"amount,string"`
	Currency                    string                        `json:"currency"`
	CategoryId                  *int64                        `json:"categoryId,string"`
	PrimaryEventId              int64                         `json:"primaryEventId,string"`
	EventIds                    []string                      `json:"eventIds"`
	EvidenceId                  int64                         `json:"evidenceId,string"`
	TargetEventId               int64                         `json:"targetEventId,string"`
	TransactionId               int64                         `json:"transactionId,string"`
}

type personalFinanceReviewIssueResponse struct {
	Id                string                      `json:"id"`
	UpdateId          string                      `json:"updateId"`
	Status            organizer.ReviewIssueStatus `json:"status"`
	Type              organizer.ReviewIssueType   `json:"type"`
	Version           int64                       `json:"version"`
	Blocking          bool                        `json:"blocking"`
	PrimaryReasonCode string                      `json:"primaryReasonCode"`
	MemberCount       int64                       `json:"memberCount"`
	CandidateCount    int64                       `json:"candidateCount"`
	ResolvedActionId  *string                     `json:"resolvedActionId"`
	ReasonCodesJson   string                      `json:"reasonCodesJson"`
	CreatedUnixTime   int64                       `json:"createdUnixTime"`
	UpdatedUnixTime   int64                       `json:"updatedUnixTime"`
}

type personalFinanceReviewIssueMemberResponse struct {
	Id              string                          `json:"id"`
	IssueId         string                          `json:"issueId"`
	Role            organizer.ReviewIssueMemberRole `json:"role"`
	ObjectType      organizer.ReviewObjectType      `json:"objectType"`
	ObjectId        string                          `json:"objectId"`
	ObjectVersion   int64                           `json:"objectVersion"`
	SortOrder       int64                           `json:"sortOrder"`
	Score           int64                           `json:"score"`
	ReasonCodesJson string                          `json:"reasonCodesJson"`
}

type personalFinanceReviewIssueCursorResponse struct {
	UpdatedUnixTime int64  `json:"updatedUnixTime"`
	IssueId         string `json:"issueId"`
}

type personalFinanceReviewIssuePageResponse struct {
	Items      []*personalFinanceReviewIssueResponse       `json:"items"`
	Members    []*personalFinanceReviewIssueMemberResponse `json:"members"`
	NextCursor *personalFinanceReviewIssueCursorResponse   `json:"nextCursor"`
}

type personalFinanceReviewIssueDetailResponse struct {
	Issue        *personalFinanceReviewIssueResponse           `json:"issue"`
	Members      []*personalFinanceReviewIssueMemberResponse   `json:"members"`
	Events       []*personalFinanceOrganizerEventResponse      `json:"events"`
	Relations    []*personalFinanceOrganizerRelationResponse   `json:"relations"`
	Transactions []*personalFinanceOrganizerTransactionResponse `json:"transactions"`
}

type personalFinanceReviewIssueMutationResponse struct {
	Update       *personalFinanceOrganizerUpdateResponse       `json:"update"`
	Issue        *personalFinanceReviewIssueResponse            `json:"issue"`
	Events       []*personalFinanceOrganizerEventResponse      `json:"events"`
	Relations    []*personalFinanceOrganizerRelationResponse   `json:"relations"`
	Transactions []*personalFinanceOrganizerTransactionResponse `json:"transactions"`
	Action       *personalFinanceOrganizerActionResponse       `json:"action"`
	Replayed     bool                                           `json:"replayed"`
}

func (a *PersonalFinanceOrganizerApi) ReviewIssueListHandler(c *core.WebContext) (any, *errs.Error) {
	application, ok := a.reviewIssueApplication()
	if !ok || c == nil || !personalFinanceInstallmentQueryAllowed(c, "update_id", "status", "type", "limit", "cursor_updated_unix_time", "cursor_issue_id") {
		return nil, errs.ErrParameterInvalid
	}
	updateId, err := strconv.ParseInt(strings.TrimSpace(c.Query("update_id")), 10, 64)
	status := organizer.ReviewIssueStatus(strings.TrimSpace(c.Query("status")))
	issueType := organizer.ReviewIssueType(strings.TrimSpace(c.Query("type")))
	limit, cursor, pageOK := parseReviewIssuePage(c)
	if err != nil || updateId < 1 || !pageOK {
		return nil, errs.ErrParameterInvalid
	}
	page, members, listErr := application.ListReviewIssues(c, c.GetCurrentUid(), updateId, status, issueType, cursor, limit)
	if listErr != nil {
		return a.reviewIssueFailed(c, "list", listErr)
	}
	return newReviewIssuePageResponse(page, members), nil
}

func (a *PersonalFinanceOrganizerApi) ReviewIssueGetHandler(c *core.WebContext) (any, *errs.Error) {
	application, ok := a.reviewIssueApplication()
	issueId, valid := parseOrganizerIDQuery(c, "id")
	if !ok || !valid {
		return nil, errs.ErrParameterInvalid
	}
	detail, err := application.GetReviewIssue(c, c.GetCurrentUid(), issueId)
	if err != nil {
		return a.reviewIssueFailed(c, "get", err)
	}
	return newReviewIssueDetailResponse(detail), nil
}

func (a *PersonalFinanceOrganizerApi) ReviewIssueResolveHandler(c *core.WebContext) (any, *errs.Error) {
	application, ok := a.reviewIssueApplication()
	request := new(personalFinanceReviewIssueResolveRequest)
	if !ok || decodePersonalFinanceLoanJSON(c, request) != nil {
		return nil, errs.ErrParameterInvalid
	}
	eventIds := []int64(nil)
	if len(request.EventIds) > 0 {
		var valid bool
		eventIds, valid = parseOrganizerIDs(request.EventIds)
		if !valid {
			return nil, errs.ErrParameterInvalid
		}
	}
	result, err := application.ResolveReviewIssue(c, organizer.ResolveReviewIssueRequest{
		Uid: c.GetCurrentUid(), UpdateId: request.UpdateId, IssueId: request.IssueId,
		ExpectedUpdateVersion: request.ExpectedUpdateVersion, ExpectedIssueVersion: request.ExpectedIssueVersion,
		IdempotencyKey: request.IdempotencyKey, Decision: request.Decision,
		Correction: organizer.EventCorrection{
			FieldMask: request.FieldMask, FlowDirection: request.FlowDirection, EconomicNature: request.EconomicNature,
			LedgerAccountId: request.LedgerAccountId, CounterpartyLedgerAccountId: request.CounterpartyLedgerAccountId,
			EventUnixTime: request.EventUnixTime, TimezoneUtcOffset: request.TimezoneUtcOffset,
			Amount: request.Amount, Currency: request.Currency, CategoryId: request.CategoryId,
		},
		PrimaryEventId: request.PrimaryEventId, EventIds: eventIds, EvidenceId: request.EvidenceId,
		TargetEventId: request.TargetEventId, TransactionId: request.TransactionId,
	})
	if err != nil {
		return a.reviewIssueFailed(c, "resolve", err)
	}
	return newReviewIssueMutationResponse(result), nil
}

func (a *PersonalFinanceOrganizerApi) reviewIssueApplication() (personalFinanceReviewIssueApplication, bool) {
	if a == nil || a.application == nil {
		return nil, false
	}
	application, ok := a.application.(personalFinanceReviewIssueApplication)
	return application, ok
}

func (a *PersonalFinanceOrganizerApi) reviewIssueFailed(c *core.WebContext, operation string, err error) (any, *errs.Error) {
	log.Warnf(c, "[personal_finance_review_issue.%s] failed for user \"uid:%d\"", operation, c.GetCurrentUid())
	return nil, personalFinanceReviewIssueServiceError(err)
}

func parseReviewIssuePage(c *core.WebContext) (int, *organizer.ReviewIssueCursor, bool) {
	limit := personalFinanceOrganizerDefaultListLimit
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > personalFinanceOrganizerMaximumListLimit {
			return 0, nil, false
		}
		limit = value
	}
	var cursor *organizer.ReviewIssueCursor
	rawTime, rawId := strings.TrimSpace(c.Query("cursor_updated_unix_time")), strings.TrimSpace(c.Query("cursor_issue_id"))
	if rawTime != "" || rawId != "" {
		updated, timeErr := strconv.ParseInt(rawTime, 10, 64)
		issueId, idErr := strconv.ParseInt(rawId, 10, 64)
		if timeErr != nil || idErr != nil || updated < 1 || issueId < 1 {
			return 0, nil, false
		}
		cursor = &organizer.ReviewIssueCursor{UpdatedUnixTime: updated, IssueId: issueId}
	}
	return limit, cursor, true
}

func (a *personalFinanceOrganizerApplication) ListReviewIssues(c core.Context, uid int64, updateId int64, status organizer.ReviewIssueStatus,
	issueType organizer.ReviewIssueType, cursor *organizer.ReviewIssueCursor, limit int) (*organizer.ReviewIssuePage, []*organizer.ReviewIssueMember, error) {
	if update, err := a.repository.FindUpdateById(c, uid, updateId); err != nil || update == nil {
		if err != nil {
			return nil, nil, err
		}
		return nil, nil, organizer.ErrReviewIssueNotFound
	}
	page, err := a.repository.ListReviewIssuesPage(c, uid, updateId, status, issueType, cursor, limit)
	if err != nil || len(page.Items) == 0 {
		return page, []*organizer.ReviewIssueMember{}, err
	}
	ids := make([]int64, len(page.Items))
	for index, issue := range page.Items {
		ids[index] = issue.IssueId
	}
	members, err := a.repository.ListReviewIssueMembersForIssues(c, uid, ids)
	return page, members, err
}

func (a *personalFinanceOrganizerApplication) GetReviewIssue(c core.Context, uid int64, issueId int64) (*personalFinanceReviewIssueDetail, error) {
	issue, err := a.repository.FindReviewIssueById(c, uid, issueId)
	if err != nil || issue == nil {
		if err != nil {
			return nil, err
		}
		return nil, organizer.ErrReviewIssueNotFound
	}
	members, err := a.repository.ListReviewIssueMembers(c, uid, issueId)
	if err != nil {
		return nil, err
	}
	detail := &personalFinanceReviewIssueDetail{Issue: issue, Members: members, Events: []*organizer.EconomicEvent{}, Relations: []*organizer.EconomicEventRelation{}, Links: []*organizer.EconomicEventTransaction{}}
	seenEvents, seenRelations, seenLinks := map[int64]struct{}{}, map[int64]struct{}{}, map[int64]struct{}{}
	for _, member := range members {
		if member.ObjectType != organizer.REVIEW_OBJECT_TYPE_EVENT {
			continue
		}
		event, findErr := a.repository.FindEventById(c, uid, member.ObjectId)
		if findErr != nil {
			return nil, findErr
		}
		if event == nil {
			continue
		}
		if _, exists := seenEvents[event.EventId]; !exists {
			seenEvents[event.EventId] = struct{}{}
			detail.Events = append(detail.Events, event)
		}
		relations, findErr := a.repository.ListRelations(c, uid, event.EventId)
		if findErr != nil {
			return nil, findErr
		}
		for _, relation := range relations {
			if _, exists := seenRelations[relation.RelationId]; !exists {
				seenRelations[relation.RelationId] = struct{}{}
				detail.Relations = append(detail.Relations, relation)
			}
		}
		links, findErr := a.repository.ListEventTransactions(c, uid, event.EventId)
		if findErr != nil {
			return nil, findErr
		}
		for _, link := range links {
			if _, exists := seenLinks[link.LinkId]; !exists {
				seenLinks[link.LinkId] = struct{}{}
				detail.Links = append(detail.Links, link)
			}
		}
	}
	return detail, nil
}

func (a *personalFinanceOrganizerApplication) ResolveReviewIssue(c core.Context, request organizer.ResolveReviewIssueRequest) (*organizer.ResolveReviewIssueResult, error) {
	engine, err := organizer.NewReviewIssueEngine(a.repository, uuid.Container)
	if err != nil {
		return nil, err
	}
	return engine.Resolve(c, request)
}

func newReviewIssueResponse(value *organizer.ReviewIssue) *personalFinanceReviewIssueResponse {
	if value == nil {
		return nil
	}
	return &personalFinanceReviewIssueResponse{
		Id: strconv.FormatInt(value.IssueId, 10), UpdateId: strconv.FormatInt(value.UpdateId, 10),
		Status: value.Status, Type: value.IssueType, Version: value.Version, Blocking: value.Blocking,
		PrimaryReasonCode: value.PrimaryReasonCode, MemberCount: value.MemberCount, CandidateCount: value.CandidateCount,
		ResolvedActionId: organizerStringId(value.ResolvedActionId), ReasonCodesJson: value.ReasonCodesJson,
		CreatedUnixTime: value.CreatedUnixTime, UpdatedUnixTime: value.UpdatedUnixTime,
	}
}

func newReviewIssueMemberResponse(value *organizer.ReviewIssueMember) *personalFinanceReviewIssueMemberResponse {
	if value == nil {
		return nil
	}
	return &personalFinanceReviewIssueMemberResponse{
		Id: strconv.FormatInt(value.MemberId, 10), IssueId: strconv.FormatInt(value.IssueId, 10), Role: value.Role,
		ObjectType: value.ObjectType, ObjectId: strconv.FormatInt(value.ObjectId, 10), ObjectVersion: value.ObjectVersion,
		SortOrder: value.SortOrder, Score: value.Score, ReasonCodesJson: value.ReasonCodesJson,
	}
}

func newReviewIssuePageResponse(page *organizer.ReviewIssuePage, members []*organizer.ReviewIssueMember) *personalFinanceReviewIssuePageResponse {
	response := &personalFinanceReviewIssuePageResponse{Items: []*personalFinanceReviewIssueResponse{}, Members: []*personalFinanceReviewIssueMemberResponse{}}
	if page != nil {
		for _, issue := range page.Items {
			response.Items = append(response.Items, newReviewIssueResponse(issue))
		}
		if page.NextCursor != nil {
			response.NextCursor = &personalFinanceReviewIssueCursorResponse{UpdatedUnixTime: page.NextCursor.UpdatedUnixTime, IssueId: strconv.FormatInt(page.NextCursor.IssueId, 10)}
		}
	}
	for _, member := range members {
		response.Members = append(response.Members, newReviewIssueMemberResponse(member))
	}
	return response
}

func newReviewIssueDetailResponse(value *personalFinanceReviewIssueDetail) *personalFinanceReviewIssueDetailResponse {
	if value == nil {
		return nil
	}
	response := &personalFinanceReviewIssueDetailResponse{Issue: newReviewIssueResponse(value.Issue), Members: []*personalFinanceReviewIssueMemberResponse{}, Events: newOrganizerEventResponses(value.Events), Relations: []*personalFinanceOrganizerRelationResponse{}, Transactions: []*personalFinanceOrganizerTransactionResponse{}}
	for _, member := range value.Members {
		response.Members = append(response.Members, newReviewIssueMemberResponse(member))
	}
	for _, relation := range value.Relations {
		response.Relations = append(response.Relations, &personalFinanceOrganizerRelationResponse{Id: strconv.FormatInt(relation.RelationId, 10), Type: relation.RelationType, Status: relation.Status, Version: relation.Version, SourceEventId: strconv.FormatInt(relation.SourceEventId, 10), TargetEventId: strconv.FormatInt(relation.TargetEventId, 10), Amount: organizerStringId(relation.Amount), Currency: relation.Currency, Manual: relation.Manual, ReasonCodesJson: relation.ReasonCodesJson})
	}
	for _, link := range value.Links {
		response.Transactions = append(response.Transactions, &personalFinanceOrganizerTransactionResponse{Id: strconv.FormatInt(link.LinkId, 10), TransactionId: strconv.FormatInt(link.TransactionId, 10), Role: link.Role, TransactionUpdatedUnixTime: link.TransactionUpdatedUnixTime})
	}
	return response
}

func newReviewIssueMutationResponse(value *organizer.ResolveReviewIssueResult) *personalFinanceReviewIssueMutationResponse {
	if value == nil {
		return nil
	}
	detail := &personalFinanceReviewIssueDetail{Issue: value.Issue, Events: value.Events, Relations: value.Relations, Links: value.Links}
	response := newReviewIssueDetailResponse(detail)
	return &personalFinanceReviewIssueMutationResponse{Update: newOrganizerUpdateResponse(value.Update), Issue: response.Issue, Events: response.Events, Relations: response.Relations, Transactions: response.Transactions, Action: newOrganizerActionResponse(value.Action), Replayed: value.Replayed}
}

func personalFinanceReviewIssueServiceError(err error) *errs.Error {
	switch {
	case errors.Is(err, organizer.ErrReviewIssueRequestInvalid), errors.Is(err, organizer.ErrReviewIssueNotFound), errors.Is(err, organizer.ErrReviewIssueDecisionInvalid):
		return errs.ErrParameterInvalid
	case errors.Is(err, organizer.ErrReviewIssueVersionConflict), errors.Is(err, organizer.ErrReviewIssueStateConflict), errors.Is(err, organizer.ErrActionRequestConflict):
		return errs.ErrRepeatedRequest
	default:
		return errs.ErrOperationFailed
	}
}
