package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/errs"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/reconciliation"
)

func TestReconciliationCaseListHandlerUsesCurrentUidAndSafeCursor(t *testing.T) {
	stub := &reconciliationAPITestService{page: &reconciliation.CasePage{
		Items:      []*reconciliation.CaseSummary{validReconciliationCaseSummary()},
		NextCursor: &reconciliation.CaseCursor{UpdatedUnixTime: 299, CaseId: 3000},
	}}
	api := newReconciliationTestAPI(t, stub)
	response, apiErr := api.ReconciliationCaseListHandler(newReconciliationTestContext(t, http.MethodGet,
		"/api/v1/personal_finance/reconciliation/cases/list.json?status=open&cursor_updated_unix_time=400&cursor_case_id=500&limit=25", ""))
	if apiErr != nil {
		t.Fatalf("list reconciliation cases: %v", apiErr)
	}
	if stub.listRequest.Uid != 1001 || stub.listRequest.Status != reconciliation.CASE_STATUS_OPEN || stub.listRequest.Limit != 25 ||
		stub.listRequest.Cursor == nil || stub.listRequest.Cursor.UpdatedUnixTime != 400 || stub.listRequest.Cursor.CaseId != 500 {
		t.Fatalf("unexpected case list request: %+v", stub.listRequest)
	}
	text := marshalReconciliationResponse(t, response)
	for _, expected := range []string{`"id":"3001"`, `"status":"open"`, `"version":4`, `"candidateRuleVersion":"reconciliation-candidate-v4"`, `"explanationVersion":"reconciliation-explanation-v4"`, `"code":"amount_currency_exact"`, `"caseId":"3000"`} {
		if !strings.Contains(text, expected) {
			t.Fatalf("case list omitted %s: %s", expected, text)
		}
	}
	assertReconciliationResponseDoesNotContain(t, text, "caseKey", "digest", "uid", "raw", "private")
}

func TestReconciliationCaseGetHandlerReturnsOnlyNormalizedMaskedEvidence(t *testing.T) {
	stub := &reconciliationAPITestService{detail: validReconciliationCaseDetail()}
	api := newReconciliationTestAPI(t, stub)
	response, apiErr := api.ReconciliationCaseGetHandler(newReconciliationTestContext(t, http.MethodGet,
		"/api/v1/personal_finance/reconciliation/cases/get.json?case_id=3001", ""))
	if apiErr != nil {
		t.Fatalf("get reconciliation case: %v", apiErr)
	}
	if stub.getUid != 1001 || stub.getCaseId != 3001 {
		t.Fatalf("case detail did not use current uid: uid=%d case=%d", stub.getUid, stub.getCaseId)
	}
	text := marshalReconciliationResponse(t, response)
	for _, expected := range []string{`"maskedSourceAccount":"Bank ••1234"`, `"normalizedAmount":"8800"`, `"currency":"CNY"`, `"relationRole":"primary"`} {
		if !strings.Contains(text, expected) {
			t.Fatalf("case detail omitted %s: %s", expected, text)
		}
	}
	assertReconciliationResponseDoesNotContain(t, text,
		"memberId", "rowId", "batchId", "transactionId", "ruleVersion", "fileExtension", "sourceLocator",
		"6222021234567890", "private-note", "rawFields", "caseKey", "digest", "uid")
}

func TestReconciliationCaseDecideHandlerBuildsSafeServiceRequest(t *testing.T) {
	stub := &reconciliationAPITestService{decision: validReconciliationDecision(reconciliation.DECISION_TYPE_SAME_EVENT)}
	api := newReconciliationTestAPI(t, stub)
	body := `{
		"caseId":"3001","expectedCaseVersion":4,"decisionType":"same_event","idempotencyKey":"decision-key-001",
		"fieldSelection":{"accountAmountMemberOrder":1,"merchantItemMemberOrder":2,"refundOriginalMemberOrder":0},
		"primaryDraft":{"type":3,"categoryId":"21","time":1700000000,"utcOffset":480,"sourceAccountId":"31",
		"destinationAccountId":"0","sourceAmount":8800,"destinationAmount":0,"hideAmount":false,"tagIds":["42"],"comment":"private-note"},
		"refundOriginalDraft":null,"refundTransactionDraft":null
	}`
	response, apiErr := api.ReconciliationCaseDecideHandler(newReconciliationTestContext(t, http.MethodPost,
		"/api/v1/personal_finance/reconciliation/cases/decide.json", body))
	if apiErr != nil {
		t.Fatalf("decide reconciliation case: %v", apiErr)
	}
	request := stub.decideRequest
	if request.Uid != 1001 || request.CaseId != 3001 || request.ExpectedCaseVersion != 4 || request.CreatedIp != "192.0.2.50" ||
		request.PrimaryDraft == nil || request.PrimaryDraft.SourceAccountId != 31 || request.PrimaryDraft.Comment != "private-note" ||
		len(request.PrimaryDraft.TagIds) != 1 || request.PrimaryDraft.TagIds[0] != 42 || stub.decideTimezone == nil || stub.decideTimezone.String() == "UTC" {
		t.Fatalf("unexpected decide request: request=%+v timezone=%v", request, stub.decideTimezone)
	}
	text := marshalReconciliationResponse(t, response)
	for _, expected := range []string{`"id":"4001"`, `"caseId":"3001"`, `"decisionType":"same_event"`, `"status":"applied"`} {
		if !strings.Contains(text, expected) {
			t.Fatalf("decision response omitted %s: %s", expected, text)
		}
	}
	assertReconciliationResponseDoesNotContain(t, text, "decision-key-001", "private-note", "sourceAccountId", "tagIds", "createdIp", "errorCode", "digest", "uid")
}

func TestReconciliationCaseDecideHandlerRejectsNonWhitelistedOrIncompleteRequests(t *testing.T) {
	invalidBodies := []string{
		`{"caseId":"3001","expectedCaseVersion":4,"decisionType":"reopen","idempotencyKey":"decision-key-001"}`,
		`{"caseId":"3001","expectedCaseVersion":0,"decisionType":"defer","idempotencyKey":"decision-key-001"}`,
		`{"caseId":"3001","expectedCaseVersion":4,"decisionType":"defer","idempotencyKey":"short"}`,
		`{"caseId":3001,"expectedCaseVersion":4,"decisionType":"defer","idempotencyKey":"decision-key-001"}`,
		`{"caseId":"3001","expectedCaseVersion":4,"decisionType":"defer","idempotencyKey":"decision-key-001","reasonCode":"raw"}`,
		`{"caseId":"3001","expectedCaseVersion":4,"decisionType":"defer","idempotencyKey":"decision-key-001","primaryDraft":{"type":3,"categoryId":"21","time":1700000000,"utcOffset":480,"sourceAccountId":"31","destinationAccountId":"0","sourceAmount":8800,"destinationAmount":0,"hideAmount":false,"tagIds":[],"comment":""}}`,
		`{"caseId":"3001","expectedCaseVersion":4,"decisionType":"defer","idempotencyKey":"decision-key-001"}{}`,
	}
	for _, body := range invalidBodies {
		t.Run(body, func(t *testing.T) {
			stub := &reconciliationAPITestService{decision: validReconciliationDecision(reconciliation.DECISION_TYPE_DEFER)}
			api := newReconciliationTestAPI(t, stub)
			response, apiErr := api.ReconciliationCaseDecideHandler(newReconciliationTestContext(t, http.MethodPost, "/decide", body))
			if response != nil || apiErr == nil || apiErr.Code() != errs.ErrIncompleteOrIncorrectSubmission.Code() || stub.decideCalls != 0 {
				t.Fatalf("invalid decide request accepted: response=%v error=%v calls=%d", response, apiErr, stub.decideCalls)
			}
		})
	}
}

func TestReconciliationUndoHandlersUseCurrentUidAndAggregateOnly(t *testing.T) {
	stub := &reconciliationAPITestService{
		impact: &reconciliation.UndoImpact{CaseId: 3001, DecisionId: 4001, AttachedExistingCount: 1, ReconciliationCreatedCount: 2,
			TransactionCount: 3, ModifiedTransactionCount: 1, LoanRelationCount: 1, CanReopen: false, CanAutomaticallyDelete: false,
			ReasonCodes: []reconciliation.UndoImpactReason{reconciliation.UNDO_REASON_TRANSACTION_MODIFIED, reconciliation.UNDO_REASON_LOAN_RELATION_PRESENT}},
		decision: validReconciliationDecision(reconciliation.DECISION_TYPE_REOPEN),
	}
	api := newReconciliationTestAPI(t, stub)
	impactResponse, apiErr := api.ReconciliationCaseUndoImpactHandler(newReconciliationTestContext(t, http.MethodGet, "/undo_impact?case_id=3001", ""))
	if apiErr != nil || stub.impactUid != 1001 || stub.impactCaseId != 3001 {
		t.Fatalf("get undo impact: response=%v error=%v uid=%d case=%d", impactResponse, apiErr, stub.impactUid, stub.impactCaseId)
	}
	impactText := marshalReconciliationResponse(t, impactResponse)
	if !strings.Contains(impactText, `"reasonCodes":["transaction_modified","loan_relation_present"]`) ||
		!strings.Contains(impactText, `"transactionCount":3`) || !strings.Contains(impactText, `"loanRelationCount":1`) {
		t.Fatalf("undo impact omitted aggregate: %s", impactText)
	}
	assertReconciliationResponseDoesNotContain(t, impactText, "transactionId", "comment", "sourceAccount", "raw", "digest", "uid")

	undoResponse, apiErr := api.ReconciliationCaseUndoHandler(newReconciliationTestContext(t, http.MethodPost, "/undo",
		`{"caseId":"3001","expectedCaseVersion":5,"idempotencyKey":"undo-key-001"}`))
	if apiErr != nil {
		t.Fatalf("undo reconciliation case: %v", apiErr)
	}
	if stub.undoRequest.Uid != 1001 || stub.undoRequest.CaseId != 3001 || stub.undoRequest.ExpectedCaseVersion != 5 || stub.undoRequest.IdempotencyKey != "undo-key-001" {
		t.Fatalf("unexpected undo request: %+v", stub.undoRequest)
	}
	if !strings.Contains(marshalReconciliationResponse(t, undoResponse), `"decisionType":"reopen"`) {
		t.Fatalf("undo response is not a reopen revision: %v", undoResponse)
	}
}

func TestReconciliationHandlersRejectUnknownQueryAndUnstableReasons(t *testing.T) {
	stub := &reconciliationAPITestService{page: &reconciliation.CasePage{Items: []*reconciliation.CaseSummary{validReconciliationCaseSummary()}}}
	api := newReconciliationTestAPI(t, stub)
	response, apiErr := api.ReconciliationCaseListHandler(newReconciliationTestContext(t, http.MethodGet, "/list?status=open&raw=true", ""))
	if response != nil || apiErr == nil || apiErr.Code() != errs.ErrIncompleteOrIncorrectSubmission.Code() || stub.listCalls != 0 {
		t.Fatalf("unknown query was accepted: response=%v error=%v calls=%d", response, apiErr, stub.listCalls)
	}

	stub.page.Items[0].ReasonCodes = []reconciliation.CaseReason{{Code: "private_dynamic_reason", Value: 1}}
	response, apiErr = api.ReconciliationCaseListHandler(newReconciliationTestContext(t, http.MethodGet, "/list?status=open", ""))
	if response != nil || apiErr != errs.ErrOperationFailed {
		t.Fatalf("unstable service reason was exposed: response=%v error=%v", response, apiErr)
	}

	stub.detail = validReconciliationCaseDetail()
	stub.detail.Members[1].MaskedSourceAccount = "6222021234567890"
	response, apiErr = api.ReconciliationCaseGetHandler(newReconciliationTestContext(t, http.MethodGet, "/get?case_id=3001", ""))
	if response != nil || apiErr != errs.ErrOperationFailed {
		t.Fatalf("unmasked source account was exposed: response=%v error=%v", response, apiErr)
	}
}

func TestReconciliationWritePermissionAndErrorMappings(t *testing.T) {
	stub := &reconciliationAPITestService{decision: validReconciliationDecision(reconciliation.DECISION_TYPE_DEFER)}
	api := newReconciliationTestAPI(t, stub)
	api.ensureWriteAllowed = func(*core.WebContext) *errs.Error { return errs.ErrNotPermittedToPerformThisAction }
	response, apiErr := api.ReconciliationCaseDecideHandler(newReconciliationTestContext(t, http.MethodPost, "/decide",
		`{"caseId":"3001","expectedCaseVersion":4,"decisionType":"defer","idempotencyKey":"decision-key-001"}`))
	if response != nil || apiErr != errs.ErrNotPermittedToPerformThisAction || stub.decideCalls != 0 {
		t.Fatalf("write permission was not enforced: response=%v error=%v calls=%d", response, apiErr, stub.decideCalls)
	}

	decisionMappings := []struct {
		err      error
		expected *errs.Error
	}{
		{reconciliation.ErrDecisionRequestInvalid, errs.ErrParameterInvalid},
		{reconciliation.ErrDecisionCaseNotFound, errs.ErrParameterInvalid},
		{reconciliation.ErrDecisionLedgerRejected, errs.ErrParameterInvalid},
		{reconciliation.ErrDecisionIdempotencyConflict, errs.ErrRepeatedRequest},
		{reconciliation.ErrDecisionCaseVersionConflict, errs.ErrRepeatedRequest},
		{reconciliation.ErrDecisionNotAvailable, errs.ErrRepeatedRequest},
		{reconciliation.ErrDecisionAuthorizationFailed, errs.ErrNotPermittedToPerformThisAction},
		{reconciliation.ErrDecisionPersistenceUnavailable, errs.ErrOperationFailed},
	}
	for _, item := range decisionMappings {
		if actual := personalFinanceReconciliationDecisionError(item.err); actual != item.expected {
			t.Fatalf("unexpected decision mapping for %v: %v", item.err, actual)
		}
	}
	if personalFinanceReconciliationCaseError(reconciliation.ErrCaseNotFound) != errs.ErrParameterInvalid ||
		personalFinanceReconciliationCaseError(reconciliation.ErrCasePersistenceUnavailable) != errs.ErrOperationFailed {
		t.Fatal("unexpected reconciliation case error mapping")
	}
}

func TestReconciliationDecisionResponseUsesFinalStableReasonCodes(t *testing.T) {
	result := validReconciliationDecision(reconciliation.DECISION_TYPE_SAME_EVENT)
	result.Status = reconciliation.DECISION_STATUS_ACTION_REQUIRED
	result.ReasonCodes = []string{"ledger_draft_required"}
	result.ErrorCode = "ledger_draft_required"

	response, err := newPersonalFinanceReconciliationDecisionResponse(result)
	if err != nil {
		t.Fatalf("convert final reconciliation reason: %v", err)
	}
	text := marshalReconciliationResponse(t, response)
	if !strings.Contains(text, `"reasonCodes":["ledger_draft_required"]`) || !strings.Contains(text, `"errorCode":"ledger_draft_required"`) {
		t.Fatalf("final reconciliation reason was omitted: %s", text)
	}

	result.ReasonCodes = []string{"private_dynamic_reason"}
	if response, err = newPersonalFinanceReconciliationDecisionResponse(result); err == nil || response != nil {
		t.Fatalf("unstable reconciliation reason was accepted: response=%v error=%v", response, err)
	}
}

type reconciliationAPITestService struct {
	page                                       *reconciliation.CasePage
	detail                                     *reconciliation.CaseDetail
	decision                                   *reconciliation.DecisionResult
	impact                                     *reconciliation.UndoImpact
	caseErr                                    error
	decisionErr                                error
	impactErr                                  error
	listRequest                                reconciliation.ListCasesRequest
	decideRequest                              reconciliation.DecideCaseRequest
	undoRequest                                reconciliation.UndoCaseRequest
	decideTimezone                             *time.Location
	getUid, getCaseId, impactUid, impactCaseId int64
	listCalls, decideCalls                     int
}

func (s *reconciliationAPITestService) ListCases(_ core.Context, request reconciliation.ListCasesRequest) (*reconciliation.CasePage, error) {
	s.listCalls++
	s.listRequest = request
	return s.page, s.caseErr
}

func (s *reconciliationAPITestService) GetCase(_ core.Context, uid int64, caseId int64) (*reconciliation.CaseDetail, error) {
	s.getUid, s.getCaseId = uid, caseId
	return s.detail, s.caseErr
}

func (s *reconciliationAPITestService) DecideCase(_ core.Context, request reconciliation.DecideCaseRequest, timezone *time.Location) (*reconciliation.DecisionResult, error) {
	s.decideCalls++
	s.decideRequest, s.decideTimezone = request, timezone
	return s.decision, s.decisionErr
}

func (s *reconciliationAPITestService) GetUndoImpact(_ core.Context, uid int64, caseId int64) (*reconciliation.UndoImpact, error) {
	s.impactUid, s.impactCaseId = uid, caseId
	return s.impact, s.impactErr
}

func (s *reconciliationAPITestService) UndoCase(_ core.Context, request reconciliation.UndoCaseRequest, _ *time.Location) (*reconciliation.DecisionResult, error) {
	s.undoRequest = request
	return s.decision, s.decisionErr
}

func newReconciliationTestAPI(t *testing.T, service *reconciliationAPITestService) *PersonalFinanceReconciliationApi {
	t.Helper()
	api, err := NewPersonalFinanceReconciliationApi(service, service)
	if err != nil {
		t.Fatalf("create reconciliation api: %v", err)
	}
	api.ensureWriteAllowed = func(*core.WebContext) *errs.Error { return nil }
	return api
}

func newReconciliationTestContext(t *testing.T, method string, target string, body string) *core.WebContext {
	t.Helper()
	gin.SetMode(gin.TestMode)
	response := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(response)
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.RemoteAddr = "192.0.2.50:3210"
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(core.ClientTimezoneOffsetHeaderName, "480")
	ginContext.Request = request
	webContext := &core.WebContext{Context: ginContext}
	webContext.SetTokenClaims(&core.UserTokenClaims{Uid: 1001})
	return webContext
}

func validReconciliationCaseSummary() *reconciliation.CaseSummary {
	return &reconciliation.CaseSummary{CaseId: 3001, Status: reconciliation.CASE_STATUS_OPEN, Version: 4, MemberCount: 2,
		SuggestedRelationType: reconciliation.DECISION_TYPE_SAME_EVENT, CandidateScore: 91,
		CandidateRuleVersion: reconciliation.CANDIDATE_RULE_VERSION_V4, ExplanationVersion: reconciliation.EXPLANATION_VERSION_V4,
		ReasonCodes:     []reconciliation.CaseReason{{Code: "amount_currency_exact", Value: 40}},
		CreatedUnixTime: 100, LastEvaluatedUnixTime: 200, UpdatedUnixTime: 300}
}

func validReconciliationCaseDetail() *reconciliation.CaseDetail {
	unixTime, offset, amount := int64(1700000000), int16(480), int64(8800)
	members := make([]*reconciliation.CaseMemberDetail, 0, 2)
	for order, sourceType := range []importing.SourceType{importing.SOURCE_TYPE_ALIPAY, importing.SOURCE_TYPE_BANK} {
		members = append(members, &reconciliation.CaseMemberDetail{MemberId: int64(700 + order), MemberOrder: int64(order + 1),
			MemberKind: reconciliation.MEMBER_KIND_SOURCE_IDENTITY, MemberRole: reconciliation.MemberRole("evidence"), SourceType: sourceType,
			MaskedSourceAccount: []string{"Alipay user", "Bank ••1234"}[order], Evidence: []*reconciliation.CaseEvidenceSummary{{
				RowId: int64(800 + order), BatchId: int64(900 + order), RowNumber: 3, SourceType: sourceType, FileExtension: ".csv",
				NormalizedUnixTime: &unixTime, NormalizedTimezoneUtcOffset: &offset, NormalizedAmount: &amount, Currency: "CNY",
				NormalizedDirection: importing.NORMALIZED_DIRECTION_EXPENSE, NormalizedTransactionType: importing.SOURCE_TRANSACTION_TYPE_PAYMENT,
				EconomicEffect: importing.ECONOMIC_EFFECT_NORMAL, ParseState: importing.PARSE_STATE_VALID, IdentityState: importing.IDENTITY_STATE_NEW,
				Disposition: importing.IMPORT_DISPOSITION_POSTABLE, ProcessingState: importing.PROCESSING_STATE_LINKED,
				Transactions: []*reconciliation.CaseTransactionReference{{TransactionId: 9999, RelationRole: "primary", CreationMethod: "attached_existing", RuleVersion: "private-rule", TransactionUpdatedUnixTime: 1700000001}},
			}}})
	}
	return &reconciliation.CaseDetail{CaseSummary: validReconciliationCaseSummary(), Members: members}
}

func validReconciliationDecision(decisionType reconciliation.DecisionType) *reconciliation.DecisionResult {
	completed := int64(501)
	return &reconciliation.DecisionResult{DecisionId: 4001, CaseId: 3001, ExpectedCaseVersion: 4, AppliedCaseVersion: 5,
		DecisionType: decisionType, Status: reconciliation.DECISION_STATUS_APPLIED, ReasonCodes: []string{}, ErrorCode: "",
		CreatedUnixTime: 500, StartedUnixTime: &completed, CompletedUnixTime: &completed, UpdatedUnixTime: 501}
}

func marshalReconciliationResponse(t *testing.T, response any) string {
	t.Helper()
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal reconciliation response: %v", err)
	}
	return string(encoded)
}

func assertReconciliationResponseDoesNotContain(t *testing.T, text string, values ...string) {
	t.Helper()
	for _, value := range values {
		if strings.Contains(text, value) {
			t.Fatalf("reconciliation response leaked %q: %s", value, text)
		}
	}
}

var _ PersonalFinanceReconciliationCaseService = (*reconciliationAPITestService)(nil)
var _ PersonalFinanceReconciliationDecisionService = (*reconciliationAPITestService)(nil)
