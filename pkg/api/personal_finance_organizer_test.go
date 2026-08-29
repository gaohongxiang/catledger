package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/errs"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/installments"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/organizer"
)

func TestUniqueKnownInstallmentCandidateRequiresOneStableExistingRelation(t *testing.T) {
	linked := &installments.CandidateView{CandidateId: 41, Status: installments.CANDIDATE_STATUS_LINKED}
	converted := &installments.CandidateView{CandidateId: 42, Status: installments.CANDIDATE_STATUS_CONVERTED}
	pending := &installments.CandidateView{CandidateId: 43, Status: installments.CANDIDATE_STATUS_PENDING}

	if got := uniqueKnownInstallmentCandidate([]*installments.CandidateView{pending, linked}); got != linked {
		t.Fatalf("one stable existing relation was not reused: %+v", got)
	}
	if got := uniqueKnownInstallmentCandidate([]*installments.CandidateView{linked, converted}); got != nil {
		t.Fatalf("ambiguous existing relations were guessed: %+v", got)
	}
	if got := uniqueKnownInstallmentCandidate([]*installments.CandidateView{pending}); got != nil {
		t.Fatalf("unlinked candidate was treated as an existing relation: %+v", got)
	}
}

func TestOrganizerHandlersUseResourceContractsAndCurrentUser(t *testing.T) {
	stub := &organizerAPITestApplication{
		update: &organizer.FinanceUpdate{UpdateId: 701, Status: organizer.UPDATE_STATUS_DRAFT, Version: 1, PlanVersion: organizer.PLAN_VERSION_V1},
		event:  &organizer.EconomicEvent{UpdateId: 701, EventId: 801, Status: organizer.EVENT_STATUS_NEEDS_ACTION, Version: 2, FlowDirection: organizer.FLOW_DIRECTION_INFLOW, EconomicNature: organizer.ECONOMIC_NATURE_UNKNOWN, FieldSourcesJson: "{}", ReasonCodesJson: "[]"},
		action: &organizer.FinanceAction{UpdateId: 701, ActionId: 901, ActionType: organizer.ACTION_TYPE_CREATE_UPDATE, Status: organizer.ACTION_STATUS_APPLIED, ReasonCodesJson: "[]"},
	}
	api := newOrganizerTestAPI(t, stub)

	response, apiErr := api.UpdateCreateHandler(newOrganizerTestContext(t, http.MethodPost, "/updates/create",
		`{"batchIds":["101","102"],"idempotencyKey":"create-1"}`))
	if apiErr != nil || stub.createUID != 1001 || len(stub.createBatchIds) != 2 || stub.createBatchIds[1] != 102 {
		t.Fatalf("create request mismatch: uid=%d ids=%v response=%v err=%v", stub.createUID, stub.createBatchIds, response, apiErr)
	}
	encoded := marshalOrganizerResponse(t, response)
	if !strings.Contains(encoded, `"id":"701"`) || strings.Contains(encoded, `"Uid"`) || strings.Contains(encoded, "idempotency") {
		t.Fatalf("create response is not a safe resource: %s", encoded)
	}

	_, apiErr = api.UpdateOrganizeHandler(newOrganizerTestContext(t, http.MethodPost, "/updates/organize",
		`{"updateId":"701","expectedUpdateVersion":1,"idempotencyKey":"organize-1"}`))
	if apiErr != nil || stub.organizeRequest.Uid != 1001 || stub.organizeRequest.UpdateId != 701 || stub.organizeRequest.ExpectedUpdateVersion != 1 {
		t.Fatalf("organize request mismatch: request=%+v err=%v", stub.organizeRequest, apiErr)
	}

	_, apiErr = api.UpdateAbandonHandler(newOrganizerTestContext(t, http.MethodPost, "/updates/abandon",
		`{"updateId":"701","expectedUpdateVersion":1,"idempotencyKey":"abandon-1"}`))
	if apiErr != nil || stub.abandonRequest.Uid != 1001 || stub.abandonRequest.UpdateId != 701 || stub.abandonRequest.ExpectedUpdateVersion != 1 {
		t.Fatalf("abandon request mismatch: request=%+v err=%v", stub.abandonRequest, apiErr)
	}

	_, apiErr = api.EventCorrectHandler(newOrganizerTestContext(t, http.MethodPost, "/events/correct",
		`{"updateId":"701","eventId":"801","expectedUpdateVersion":2,"expectedEventVersion":3,"idempotencyKey":"correct-1","categoryScope":"matching_uncategorized","fieldMask":128,"categoryId":"88"}`))
	if apiErr != nil || stub.correctRequest.Uid != 1001 || stub.correctRequest.Correction.FieldMask != organizer.MANUAL_FIELD_CATEGORY ||
		stub.correctRequest.Correction.CategoryId == nil || *stub.correctRequest.Correction.CategoryId != 88 ||
		stub.correctRequest.CategoryScope != organizer.CATEGORY_CORRECTION_SCOPE_MATCHING_UNCATEGORIZED {
		t.Fatalf("correct request mismatch: request=%+v err=%v", stub.correctRequest, apiErr)
	}

	stub.categoryScope = &organizer.CategoryCorrectionScopePreview{MatchingEventCount: 6}
	response, apiErr = api.EventCategoryScopeHandler(newOrganizerTestContext(t, http.MethodGet, "/events/category-scope?update_id=701&event_id=801", ""))
	encoded = marshalOrganizerResponse(t, response)
	if apiErr != nil || !strings.Contains(encoded, `"matchingEventCount":6`) {
		t.Fatalf("category scope response mismatch: response=%s err=%v", encoded, apiErr)
	}

	_, apiErr = api.ActionPostAllReadyHandler(newOrganizerTestContext(t, http.MethodPost, "/actions/post-all-ready",
		`{"updateId":"701","expectedUpdateVersion":2,"idempotencyKey":"post-1"}`))
	if apiErr != nil || stub.postRequest.Mode != organizer.POST_MODE_ALL_READY || stub.postRequest.Uid != 1001 {
		t.Fatalf("post-all request mismatch: request=%+v err=%v", stub.postRequest, apiErr)
	}

	response, apiErr = api.EventListHandler(newOrganizerTestContext(t, http.MethodGet, "/events?update_id=701&status=needs_action&limit=20", ""))
	encoded = marshalOrganizerResponse(t, response)
	if apiErr != nil || !strings.Contains(encoded, `"counterparty":"商户"`) || !strings.Contains(encoded, `"evidenceCount":2`) {
		t.Fatalf("event summary response mismatch: response=%s err=%v", encoded, apiErr)
	}
}

func TestOrganizerHandlersRejectCompatibilityFieldsAndMapConflicts(t *testing.T) {
	stub := &organizerAPITestApplication{update: &organizer.FinanceUpdate{UpdateId: 701}, event: &organizer.EconomicEvent{EventId: 801}, action: &organizer.FinanceAction{ActionId: 901}}
	api := newOrganizerTestAPI(t, stub)
	response, apiErr := api.UpdateCreateHandler(newOrganizerTestContext(t, http.MethodPost, "/updates/create",
		`{"batchIds":["101"],"fileIds":["201"],"idempotencyKey":"old-field"}`))
	if response != nil || apiErr != errs.ErrParameterInvalid {
		t.Fatalf("old compatibility field was accepted: response=%v err=%v", response, apiErr)
	}
	stub.err = organizer.ErrPostVersionConflict
	response, apiErr = api.ActionPostAllReadyHandler(newOrganizerTestContext(t, http.MethodPost, "/actions/post-all-ready",
		`{"updateId":"701","expectedUpdateVersion":2,"idempotencyKey":"post-conflict"}`))
	if response != nil || apiErr != errs.ErrRepeatedRequest {
		t.Fatalf("version conflict mapping mismatch: response=%v err=%v", response, apiErr)
	}
}

func TestOrganizerEvidenceResponseIncludesOriginalSourceFields(t *testing.T) {
	response := newOrganizerEventEvidenceResponse(&organizerEventEvidenceDetail{
		Event:    &organizer.EconomicEvent{EventId: 801, UpdateId: 701, Status: organizer.EVENT_STATUS_NEEDS_ACTION, Version: 1, FieldSourcesJson: "{}", ReasonCodesJson: "[]"},
		Evidence: []*organizer.EconomicEventEvidence{{EvidenceId: 901, EventId: 801, RowId: 1001, EvidenceRole: organizer.EVIDENCE_ROLE_PRIMARY}},
		Rows: []*importing.RawImportRow{{
			RowId: 1001, BatchId: 2001, RowNumber: 17, SourceLocator: "v1:csv:18:18",
			RawFieldsJson: `[{"name":"交易号","value":"source-id-canary"},{"name":"备注","value":"第一条"},{"name":"备注","value":"第二条"}]`,
		}},
		Relations: []*organizer.EconomicEventRelation{}, Links: []*organizer.EconomicEventTransaction{},
	})
	encoded := marshalOrganizerResponse(t, response)

	if !strings.Contains(encoded, `"sourceLocator":"v1:csv:18:18"`) ||
		!strings.Contains(encoded, `"rawFields":[{"name":"交易号","value":"source-id-canary"}`) ||
		strings.Count(encoded, `"name":"备注"`) != 2 {
		t.Fatalf("original source fields were not preserved: %s", encoded)
	}
}

type organizerAPITestApplication struct {
	update          *organizer.FinanceUpdate
	event           *organizer.EconomicEvent
	action          *organizer.FinanceAction
	err             error
	createUID       int64
	createBatchIds  []int64
	organizeRequest organizer.OrganizeRequest
	abandonRequest  organizer.AbandonRequest
	correctRequest  organizer.CorrectEventRequest
	postRequest     organizer.PostRequest
	categoryScope   *organizer.CategoryCorrectionScopePreview
}

func (a *organizerAPITestApplication) CreateUpdate(_ core.Context, uid int64, batchIds []int64, _ string) (*organizerUpdateDetail, error) {
	a.createUID, a.createBatchIds = uid, batchIds
	return &organizerUpdateDetail{Update: a.update, Sources: []*organizer.FinanceUpdateSource{}}, a.err
}

func (a *organizerAPITestApplication) ListUpdates(_ core.Context, _ int64, _ organizer.UpdateStatus, _ *organizer.UpdateCursor, _ int) (*organizer.UpdatePage, error) {
	return &organizer.UpdatePage{Items: []*organizer.FinanceUpdate{a.update}}, a.err
}

func (a *organizerAPITestApplication) GetUpdate(_ core.Context, _ int64, _ int64) (*organizerUpdateDetail, error) {
	return &organizerUpdateDetail{Update: a.update, Sources: []*organizer.FinanceUpdateSource{}}, a.err
}

func (a *organizerAPITestApplication) Organize(_ core.Context, request organizer.OrganizeRequest) (*organizer.OrganizeResult, error) {
	a.organizeRequest = request
	return &organizer.OrganizeResult{Update: a.update, Action: a.action, Events: []*organizer.EconomicEvent{a.event}}, a.err
}

func (a *organizerAPITestApplication) Abandon(_ core.Context, request organizer.AbandonRequest) (*organizer.AbandonResult, error) {
	a.abandonRequest = request
	return &organizer.AbandonResult{Update: a.update, Action: a.action}, a.err
}

func (a *organizerAPITestApplication) ListEvents(_ core.Context, _ int64, _ int64, _ organizer.EventStatus, _ *organizer.EventCursor, _ int) (*organizerEventPage, error) {
	return &organizerEventPage{Items: []*organizerEventListItem{{Event: a.event, Summary: organizerEventSummary{Counterparty: "商户", Item: "商品", PaymentMethod: "支付方式", Note: "备注", EvidenceCount: 2}}}}, a.err
}

func (a *organizerAPITestApplication) GetEventEvidence(_ core.Context, _ int64, _ int64) (*organizerEventEvidenceDetail, error) {
	return &organizerEventEvidenceDetail{Event: a.event, Evidence: []*organizer.EconomicEventEvidence{}, Relations: []*organizer.EconomicEventRelation{}, Links: []*organizer.EconomicEventTransaction{}}, a.err
}

func (a *organizerAPITestApplication) InspectEventCorrection(_ core.Context, _ int64, _ int64, _ int64) (*organizer.UndoImpact, error) {
	return &organizer.UndoImpact{CanUndo: true, ReasonCodes: []string{}}, a.err
}

func (a *organizerAPITestApplication) InspectCategoryCorrectionScope(_ core.Context, _ int64, _ int64, _ int64) (*organizer.CategoryCorrectionScopePreview, error) {
	return a.categoryScope, a.err
}

func (a *organizerAPITestApplication) CorrectEvent(_ core.Context, request organizer.CorrectEventRequest) (*organizerMutationResult, error) {
	a.correctRequest = request
	return &organizerMutationResult{Update: a.update, Event: a.event, Action: a.action}, a.err
}

func (a *organizerAPITestApplication) Post(_ core.Context, request organizer.PostRequest) (*organizer.PostResult, error) {
	a.postRequest = request
	return &organizer.PostResult{Update: a.update, Action: a.action, Events: []*organizer.EconomicEvent{a.event}}, a.err
}

func (a *organizerAPITestApplication) InspectUndo(_ core.Context, _ int64, _ int64) (*organizer.UndoImpact, error) {
	return &organizer.UndoImpact{CanUndo: true, ReasonCodes: []string{}}, a.err
}

func (a *organizerAPITestApplication) Undo(_ core.Context, _ organizer.UndoRequest) (*organizer.UndoResult, error) {
	return &organizer.UndoResult{Update: a.update, Action: a.action, Impact: &organizer.UndoImpact{CanUndo: true}}, a.err
}

func newOrganizerTestAPI(t *testing.T, application PersonalFinanceOrganizerApplication) *PersonalFinanceOrganizerApi {
	t.Helper()
	api, err := NewPersonalFinanceOrganizerApi(application)
	if err != nil {
		t.Fatalf("create organizer api: %v", err)
	}
	return api
}

func newOrganizerTestContext(t *testing.T, method string, target string, body string) *core.WebContext {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(recorder)
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	ginContext.Request = request
	webContext := &core.WebContext{Context: ginContext}
	webContext.SetTokenClaims(&core.UserTokenClaims{Uid: 1001})
	return webContext
}

func marshalOrganizerResponse(t *testing.T, response any) string {
	t.Helper()
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal organizer response: %v", err)
	}
	return string(encoded)
}
