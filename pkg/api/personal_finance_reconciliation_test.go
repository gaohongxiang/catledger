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
	"github.com/gaohongxiang/catledger/pkg/models"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/reconciliation"
	"github.com/gaohongxiang/catledger/pkg/settings"
)

func TestReconciliationCandidateGenerateHandlerReturnsOnlySafeFieldsAndCurrentUid(t *testing.T) {
	application := &candidateApplicationStub{
		result: &reconciliation.GenerateCandidatesResult{
			Cases: []*reconciliation.Case{{
				Uid: 9002, CaseId: 3001, CaseKey: "private-case-key", CaseKeyVersion: "private-case-key-version",
				Status: reconciliation.CASE_STATUS_OPEN, Version: 4, MemberCount: 2,
				SuggestedRelationType: reconciliation.DECISION_TYPE_SAME_EVENT, CandidateScore: 95,
				CandidateRuleVersion: "private-candidate-version", ExplanationVersion: "private-explanation-version",
				ReasonCodesJson:   `[{"code":"amount_currency_exact","value":40},{"code":"time_distance_seconds","value":12}]`,
				CurrentDecisionId: int64Pointer(4001), CreatedUnixTime: 100, LastEvaluatedUnixTime: 200, UpdatedUnixTime: 300,
			}},
			EvaluatedAnchorCount: 17,
			LimitReached:         true,
		},
	}
	api := newCandidateTestAPI(t, application, &models.User{})

	response, apiErr := api.ReconciliationCandidateGenerateHandler(newCandidateTestContext(t, `{"batchId":"2001"}`))
	if apiErr != nil {
		t.Fatalf("generate candidate: %v", apiErr)
	}
	if application.request.Uid != 1001 || application.request.BatchId != 2001 {
		t.Fatalf("handler did not bind the current uid and requested batch: %+v", application.request)
	}

	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal candidate response: %v", err)
	}
	text := string(encoded)
	for _, forbidden := range []string{
		"private-case-key", "private-case-key-version", "private-candidate-version", "private-explanation-version",
		"caseKey", "caseKeyVersion", "currentDecisionId", "memberCount", "candidateRuleVersion", "explanationVersion",
		"reasonCodesJson", "raw", "digest", "hash", "storageObjectKey", "uid",
	} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("candidate response leaked forbidden data %q: %s", forbidden, text)
		}
	}
	for _, expected := range []string{
		`"id":"3001"`, `"status":"open"`, `"version":4`, `"suggestedRelationType":"same_event"`,
		`"candidateScore":95`, `"reasonCodes":[`, `"code":"amount_currency_exact"`, `"value":40`,
		`"evaluatedAnchorCount":17`, `"limitReached":true`,
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("candidate response omitted %s: %s", expected, text)
		}
	}
}

func TestReconciliationCandidateGenerateHandlerRejectsMalformedReasonJSONAsServiceFailure(t *testing.T) {
	for _, encodedReasons := range []string{
		`not-json`,
		`[]`,
		`[{"code":"unknown_reason","value":1}]`,
		`[{"code":"time_proximity","value":"10"}]`,
		`[{"code":"time_proximity","value":10,"raw":"secret"}]`,
		`[{"code":"time_proximity","code":"time_distance_seconds","value":10}]`,
	} {
		t.Run(encodedReasons, func(t *testing.T) {
			application := &candidateApplicationStub{result: validCandidateResult(encodedReasons)}
			api := newCandidateTestAPI(t, application, &models.User{})
			response, apiErr := api.ReconciliationCandidateGenerateHandler(newCandidateTestContext(t, `{"batchId":"2001"}`))
			if response != nil || apiErr != errs.ErrOperationFailed {
				t.Fatalf("malformed reasons were not mapped to operation failed: response=%v error=%v", response, apiErr)
			}
		})
	}
}

func TestReconciliationCandidateGenerateHandlerValidatesOnlyBatchId(t *testing.T) {
	for _, body := range []string{
		`{}`,
		`{"batchId":"0"}`,
		`{"batchId":"-1"}`,
		`{"batchId":2001}`,
		`{"batchId":"2001","limit":999999}`,
		`{"batchId":"2001"}{"batchId":"2002"}`,
	} {
		t.Run(body, func(t *testing.T) {
			application := &candidateApplicationStub{result: validCandidateResult(`[{"code":"time_proximity","value":10}]`)}
			api := newCandidateTestAPI(t, application, &models.User{})
			response, apiErr := api.ReconciliationCandidateGenerateHandler(newCandidateTestContext(t, body))
			if response != nil || apiErr == nil || apiErr.Code() != errs.ErrIncompleteOrIncorrectSubmission.Code() {
				t.Fatalf("invalid candidate request was accepted: response=%v error=%v", response, apiErr)
			}
			if application.calls != 0 {
				t.Fatal("candidate service was called for an invalid request")
			}
		})
	}
}

func TestReconciliationCandidateGenerateHandlerUsesImportWritePermission(t *testing.T) {
	restricted := &models.User{FeatureRestriction: core.UserFeatureRestrictions(0).Add(core.USER_FEATURE_RESTRICTION_TYPE_IMPORT_TRANSACTION)}
	application := &candidateApplicationStub{result: validCandidateResult(`[{"code":"time_proximity","value":10}]`)}
	api := newCandidateTestAPI(t, application, restricted)

	response, apiErr := api.ReconciliationCandidateGenerateHandler(newCandidateTestContext(t, `{"batchId":"2001"}`))
	if response != nil || apiErr != errs.ErrNotPermittedToPerformThisAction || application.calls != 0 {
		t.Fatalf("candidate generation did not reuse import write permission: response=%v error=%v calls=%d", response, apiErr, application.calls)
	}
}

type candidateApplicationStub struct {
	result  *reconciliation.GenerateCandidatesResult
	err     error
	request reconciliation.GenerateCandidatesRequest
	calls   int
}

func (a *candidateApplicationStub) GenerateCandidates(_ core.Context, request reconciliation.GenerateCandidatesRequest) (*reconciliation.GenerateCandidatesResult, error) {
	a.calls++
	a.request = request
	return a.result, a.err
}

type candidateUserReaderStub struct {
	user *models.User
	err  error
}

func (r *candidateUserReaderStub) GetUserById(_ core.Context, _ int64) (*models.User, error) {
	return r.user, r.err
}

func newCandidateTestAPI(t *testing.T, application personalFinanceCandidateApplication, user *models.User) *PersonalFinanceImportsApi {
	t.Helper()
	previousConfig := settings.Container.GetCurrentConfig()
	settings.SetCurrentConfig(&settings.Config{EnableDataImport: true})
	t.Cleanup(func() {
		settings.SetCurrentConfig(previousConfig)
	})

	return &PersonalFinanceImportsApi{
		config: settings.Container,
		users:  &candidateUserReaderStub{user: user},
		candidateServiceFactory: func() (personalFinanceCandidateApplication, error) {
			return application, nil
		},
	}
}

func newCandidateTestContext(t *testing.T, body string) *core.WebContext {
	t.Helper()
	gin.SetMode(gin.TestMode)
	response := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(response)
	ginContext.Request = httptest.NewRequest(http.MethodPost, "/api/v1/personal_finance/reconciliation/candidates/generate.json", strings.NewReader(body))
	ginContext.Request.Header.Set("Content-Type", "application/json")
	webContext := &core.WebContext{Context: ginContext}
	webContext.SetTokenClaims(&core.UserTokenClaims{Uid: 1001})
	return webContext
}

func validCandidateResult(encodedReasons string) *reconciliation.GenerateCandidatesResult {
	return &reconciliation.GenerateCandidatesResult{Cases: []*reconciliation.Case{{
		CaseId: 1, Status: reconciliation.CASE_STATUS_OPEN, Version: 1,
		SuggestedRelationType: reconciliation.DECISION_TYPE_SAME_EVENT, CandidateScore: 50,
		ReasonCodesJson: encodedReasons, CreatedUnixTime: 1, LastEvaluatedUnixTime: 1, UpdatedUnixTime: 1,
	}}}
}

func int64Pointer(value int64) *int64 {
	return &value
}
