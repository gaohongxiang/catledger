package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/errs"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/dashboard"
)

func TestPersonalFinanceDashboardOverviewHandlerUsesStrictQueryAndStringAmounts(t *testing.T) {
	application := &dashboardAPITestApplication{result: validDashboardAPIResult()}
	api, err := NewPersonalFinanceDashboardApi(application)
	if err != nil {
		t.Fatalf("create dashboard api: %v", err)
	}
	response, apiErr := api.OverviewHandler(newDashboardTestContext(t, "/?start_date=2024-01-01&as_of_date=2024-06-30&months=6"))
	if apiErr != nil {
		t.Fatalf("overview handler: %v", apiErr)
	}
	if application.query.Uid != 1001 || application.query.StartDate != "2024-01-01" || application.query.AsOfDate != "2024-06-30" || application.query.Months != 6 {
		t.Fatalf("unexpected service query: %#v", application.query)
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal dashboard response: %v", err)
	}
	text := string(encoded)
	if !strings.Contains(text, `"assets":"9007199254740992"`) || strings.Contains(text, `"uid"`) || strings.Contains(text, "idempotency") {
		t.Fatalf("dashboard response lost integer precision or leaked internal fields: %s", text)
	}
}

func TestPersonalFinanceDashboardOverviewHandlerRejectsUnknownRepeatedAndMissingQuery(t *testing.T) {
	api, _ := NewPersonalFinanceDashboardApi(&dashboardAPITestApplication{result: validDashboardAPIResult()})
	for _, target := range []string{
		"/?start_date=2024-01-01&as_of_date=2024-06-30&months=6&extra=1",
		"/?start_date=2024-01-01&start_date=2024-02-01&as_of_date=2024-06-30&months=6",
		"/?start_date=2024-01-01&as_of_date=2024-06-30",
		"/?start_date=2024-01-01&as_of_date=2024-06-30&months=25",
	} {
		if response, apiErr := api.OverviewHandler(newDashboardTestContext(t, target)); response != nil || apiErr != errs.ErrParameterInvalid {
			t.Fatalf("target %s was not rejected: response=%#v err=%#v", target, response, apiErr)
		}
	}
}

type dashboardAPITestApplication struct {
	query  dashboard.Query
	result *dashboard.Overview
}

func (a *dashboardAPITestApplication) GetOverview(_ core.Context, query dashboard.Query) (*dashboard.Overview, error) {
	a.query = query
	return a.result, nil
}

func validDashboardAPIResult() *dashboard.Overview {
	return &dashboard.Overview{
		StartDate: "2024-01-01", AsOfDate: "2024-06-30", GeneratedUnixTime: 1719748800,
		AccountSnapshot: []*dashboard.AccountCurrencySnapshot{{Currency: "CNY", Assets: 9007199254740992}},
		MonthlyCashFlow: []*dashboard.MonthlyCashFlow{},
		Debt:            &dashboard.DebtSummary{Amounts: []*dashboard.DebtCurrencySummary{}, Contracts: []*dashboard.DebtContractSummary{}, FutureCurve: []*dashboard.DebtCurveMonth{}},
		Coverage:        &dashboard.CoverageSummary{UnconfirmedExcluded: true, Accounts: []*dashboard.SourceCoverage{}},
		Trust:           &dashboard.TrustSummary{AmountsGroupedByCurrency: true, HistoricalBalanceDerived: true},
	}
}

func newDashboardTestContext(t *testing.T, target string) *core.WebContext {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(recorder)
	request := httptest.NewRequest(http.MethodGet, target, nil)
	request.Header.Set(core.ClientTimezoneOffsetHeaderName, "480")
	ginContext.Request = request
	webContext := &core.WebContext{Context: ginContext}
	webContext.SetTokenClaims(&core.UserTokenClaims{Uid: 1001})
	return webContext
}
