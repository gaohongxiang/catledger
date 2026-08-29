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
	"github.com/gaohongxiang/catledger/pkg/personalfinance/cardcycle"
)

func TestCardCycleHandlersUseStringIdsAndOmitSecrets(t *testing.T) {
	stub := &cardCycleAPITestApplication{
		accounts: &cardcycle.AccountListResult{
			AsOfDate: "2026-08-31",
			Items: []*cardcycle.CardAccountView{{
				LedgerAccountId: 11, DisplayName: "兴业银行信用卡", Currency: "CNY",
				MonthStatus:    cardcycle.MONTH_STATUS_PROVISIONAL,
				ActiveRule:     &cardcycle.RuleView{RuleId: 101, LedgerAccountId: 11, RuleNumber: 2, StatementDay: 15, DueDay: 3, EffectiveFrom: "2026-08-01", Status: cardcycle.RULE_STATUS_ACTIVE, CreatedUnixTime: 1700000000},
				LatestCoverage: &cardcycle.CoverageIntervalView{CoverageId: 201, BatchId: 301, PeriodStart: "2026-07-16", PeriodEnd: "2026-08-15", CreatedUnixTime: 1700000000},
				UncoveredGap:   &cardcycle.DateRangeView{StartDate: "2026-08-16", EndDate: "2026-08-31"},
			}},
		},
		rule: &cardcycle.RuleView{RuleId: 102, LedgerAccountId: 11, RuleNumber: 3, StatementDay: 16, DueDay: 4, EffectiveFrom: "2026-09-01", Status: cardcycle.RULE_STATUS_ACTIVE, CreatedUnixTime: 1700000100},
		coverage: &cardcycle.CoverageView{
			LedgerAccountId: 11, AsOfDate: "2026-08-31", YearMonth: "2026-08",
			MonthStatus: cardcycle.MONTH_STATUS_PROVISIONAL,
			Coverages:   []*cardcycle.CoverageIntervalView{{CoverageId: 201, BatchId: 301, PeriodStart: "2026-07-16", PeriodEnd: "2026-08-15"}},
			Gaps:        []*cardcycle.DateRangeView{{StartDate: "2026-08-16", EndDate: "2026-08-31"}},
			Overlaps:    []*cardcycle.DateRangeView{},
			Revisions:   []*cardcycle.MonthRevisionView{{RevisionId: 401, YearMonth: "2026-08", TaskId: 501, ReasonCode: cardcycle.REASON_LATE_STATEMENT, CreatedUnixTime: 1700000200}},
		},
		review: &cardcycle.BalanceReviewView{ReviewId: 601, LedgerAccountId: 11, Status: cardcycle.BALANCE_REVIEW_UNVERIFIED, AsOfDate: "", Version: 1, UpdatedUnixTime: 1700000300},
	}
	api := newCardCycleTestAPI(t, stub)

	listResponse, apiErr := api.CardCycleAccountListHandler(newCardCycleTestContext(t, http.MethodGet, "/accounts?as_of_date=2026-08-31", ""))
	if apiErr != nil {
		t.Fatalf("list card cycle accounts: %v", apiErr)
	}
	if stub.listUID != 1001 || stub.listAsOf != "2026-08-31" {
		t.Fatalf("unexpected list request: uid=%d asOf=%s", stub.listUID, stub.listAsOf)
	}
	listText := marshalCardCycleResponse(t, listResponse)
	for _, expected := range []string{`"ledgerAccountId":"11"`, `"id":"101"`, `"batchId":"301"`, `"monthStatus":"provisional"`, `"periodStart":"2026-07-16"`} {
		if !strings.Contains(listText, expected) {
			t.Fatalf("list response omitted %s: %s", expected, listText)
		}
	}
	assertCardCycleResponseOmits(t, listText, "uid", "alias", "RawItem", "idempotencyKey")

	saveResponse, apiErr := api.CardCycleRuleSaveHandler(newCardCycleTestContext(t, http.MethodPost, "/rules/save",
		`{"ledgerAccountId":"11","statementDay":16,"dueDay":4,"effectiveFrom":"2026-09-01","idempotencyKey":"rule-save-1"}`))
	if apiErr != nil {
		t.Fatalf("save card cycle rule: %v", apiErr)
	}
	if stub.saveRule.Uid != 1001 || stub.saveRule.LedgerAccountId != 11 || stub.saveRule.StatementDay != 16 {
		t.Fatalf("unexpected save rule request: %+v", stub.saveRule)
	}
	assertCardCycleResponseOmits(t, marshalCardCycleResponse(t, saveResponse), "uid", "idempotencyKey")

	coverageResponse, apiErr := api.CardCycleCoverageHandler(newCardCycleTestContext(t, http.MethodGet,
		"/coverage?id=11&as_of_date=2026-08-31&year_month=2026-08", ""))
	if apiErr != nil {
		t.Fatalf("get card cycle coverage: %v", apiErr)
	}
	if stub.coverageUID != 1001 || stub.coverageAccountID != 11 || stub.coverageAsOf != "2026-08-31" || stub.coverageMonth != "2026-08" {
		t.Fatalf("unexpected coverage request: uid=%d account=%d asOf=%s month=%s", stub.coverageUID, stub.coverageAccountID, stub.coverageAsOf, stub.coverageMonth)
	}
	coverageText := marshalCardCycleResponse(t, coverageResponse)
	for _, expected := range []string{`"taskId":"501"`, `"reasonCode":"late_statement"`, `"startDate":"2026-08-16"`} {
		if !strings.Contains(coverageText, expected) {
			t.Fatalf("coverage response omitted %s: %s", expected, coverageText)
		}
	}
	assertCardCycleResponseOmits(t, coverageText, "uid", "RawItem")

	reviewResponse, apiErr := api.CardCycleBalanceReviewHandler(newCardCycleTestContext(t, http.MethodPost, "/balance_review",
		`{"ledgerAccountId":"11","status":"unverified","asOfDate":"","idempotencyKey":"review-skip-1"}`))
	if apiErr != nil {
		t.Fatalf("save balance review: %v", apiErr)
	}
	if stub.saveReview.Uid != 1001 || stub.saveReview.Status != cardcycle.BALANCE_REVIEW_UNVERIFIED || stub.saveReview.AsOfDate != "" {
		t.Fatalf("unexpected balance review request: %+v", stub.saveReview)
	}
	reviewText := marshalCardCycleResponse(t, reviewResponse)
	if !strings.Contains(reviewText, `"asOfDate":""`) || !strings.Contains(reviewText, `"status":"unverified"`) {
		t.Fatalf("unverified review response is wrong: %s", reviewText)
	}
}

func TestCardCycleHandlersMapErrorsAndRejectInvalidInput(t *testing.T) {
	stub := &cardCycleAPITestApplication{
		accounts: &cardcycle.AccountListResult{Items: []*cardcycle.CardAccountView{}},
		coverage: &cardcycle.CoverageView{Coverages: []*cardcycle.CoverageIntervalView{}, Gaps: []*cardcycle.DateRangeView{}, Overlaps: []*cardcycle.DateRangeView{}, Revisions: []*cardcycle.MonthRevisionView{}},
		review:   &cardcycle.BalanceReviewView{ReviewId: 1, LedgerAccountId: 11, Status: cardcycle.BALANCE_REVIEW_UNVERIFIED},
	}
	api := newCardCycleTestAPI(t, stub)

	if response, apiErr := api.CardCycleAccountListHandler(newCardCycleTestContext(t, http.MethodGet, "/accounts?as_of_date=2026-08-31&extra=1", "")); response != nil || apiErr != errs.ErrParameterInvalid {
		t.Fatalf("unknown accounts query was accepted: response=%v err=%v", response, apiErr)
	}
	if response, apiErr := api.CardCycleCoverageHandler(newCardCycleTestContext(t, http.MethodGet, "/coverage?id=abc", "")); response != nil || apiErr != errs.ErrParameterInvalid {
		t.Fatalf("invalid coverage id was accepted: response=%v err=%v", response, apiErr)
	}
	if response, apiErr := api.CardCycleRuleSaveHandler(newCardCycleTestContext(t, http.MethodPost, "/rules/save",
		`{"ledgerAccountId":"11","statementDay":15,"dueDay":3,"effectiveFrom":"2026-08-01","idempotencyKey":"rule-save-1","uid":"999"}`)); response != nil || apiErr != errs.ErrParameterInvalid {
		t.Fatalf("unknown save rule field was accepted: response=%v err=%v", response, apiErr)
	}

	stub.err = cardcycle.ErrServiceInvalidRequest
	if response, apiErr := api.CardCycleCoverageHandler(newCardCycleTestContext(t, http.MethodGet, "/coverage?id=11&as_of_date=2026-08-31", "")); response != nil || apiErr != errs.ErrParameterInvalid {
		t.Fatalf("invalid request did not map to parameter error: response=%v err=%v", response, apiErr)
	}
	stub.err = cardcycle.ErrServiceVersionConflict
	if response, apiErr := api.CardCycleBalanceReviewHandler(newCardCycleTestContext(t, http.MethodPost, "/balance_review",
		`{"ledgerAccountId":"11","status":"verified","asOfDate":"2026-08-15","expectedVersion":1,"idempotencyKey":"review-verify-1"}`)); response != nil || apiErr != errs.ErrRepeatedRequest {
		t.Fatalf("version conflict did not map to repeated request: response=%v err=%v", response, apiErr)
	}
}

type cardCycleAPITestApplication struct {
	accounts          *cardcycle.AccountListResult
	rule              *cardcycle.RuleView
	coverage          *cardcycle.CoverageView
	review            *cardcycle.BalanceReviewView
	err               error
	listUID           int64
	listAsOf          string
	saveRule          cardcycle.SaveRuleRequest
	coverageUID       int64
	coverageAccountID int64
	coverageAsOf      string
	coverageMonth     string
	saveReview        cardcycle.SaveBalanceReviewRequest
}

func (a *cardCycleAPITestApplication) ListAccounts(_ core.Context, uid int64, asOfDate string) (*cardcycle.AccountListResult, error) {
	a.listUID, a.listAsOf = uid, asOfDate
	return a.accounts, a.err
}

func (a *cardCycleAPITestApplication) SaveRule(_ core.Context, request cardcycle.SaveRuleRequest) (*cardcycle.RuleView, error) {
	a.saveRule = request
	return a.rule, a.err
}

func (a *cardCycleAPITestApplication) GetCoverage(_ core.Context, uid int64, ledgerAccountId int64, asOfDate string, yearMonth string) (*cardcycle.CoverageView, error) {
	a.coverageUID, a.coverageAccountID, a.coverageAsOf, a.coverageMonth = uid, ledgerAccountId, asOfDate, yearMonth
	return a.coverage, a.err
}

func (a *cardCycleAPITestApplication) SaveBalanceReview(_ core.Context, request cardcycle.SaveBalanceReviewRequest) (*cardcycle.BalanceReviewView, error) {
	a.saveReview = request
	return a.review, a.err
}

func newCardCycleTestAPI(t *testing.T, application *cardCycleAPITestApplication) *PersonalFinanceCardCycleApi {
	t.Helper()
	api, err := NewPersonalFinanceCardCycleApi(application)
	if err != nil {
		t.Fatalf("create card cycle api: %v", err)
	}
	return api
}

func newCardCycleTestContext(t *testing.T, method, target, body string) *core.WebContext {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(recorder)
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(core.ClientTimezoneOffsetHeaderName, "480")
	ginContext.Request = request
	webContext := &core.WebContext{Context: ginContext}
	webContext.SetTokenClaims(&core.UserTokenClaims{Uid: 1001})
	return webContext
}

func marshalCardCycleResponse(t *testing.T, response any) string {
	t.Helper()
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal card cycle response: %v", err)
	}
	return string(encoded)
}

func assertCardCycleResponseOmits(t *testing.T, text string, forbidden ...string) {
	t.Helper()
	for _, value := range forbidden {
		if strings.Contains(text, value) {
			t.Fatalf("card cycle response leaked %q: %s", value, text)
		}
	}
}
