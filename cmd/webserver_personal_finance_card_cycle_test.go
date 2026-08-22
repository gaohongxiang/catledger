package cmd

import (
	"os"
	"strings"
	"testing"
)

func TestPersonalFinanceCardCycleRoutesAreUniqueAuthenticatedAndImportIndependent(t *testing.T) {
	sourceBytes, err := os.ReadFile("../pkg/api/personal_finance_routes.go")
	if err != nil {
		t.Fatalf("read personal finance routes: %v", err)
	}
	source := string(sourceBytes)
	routes := []struct {
		method  string
		path    string
		handler string
	}{
		{method: "GET", path: "/personal_finance/card_cycle/accounts.json", handler: "CardCycleAccountListHandler"},
		{method: "POST", path: "/personal_finance/card_cycle/rules/save.json", handler: "CardCycleRuleSaveHandler"},
		{method: "GET", path: "/personal_finance/card_cycle/coverage.json", handler: "CardCycleCoverageHandler"},
		{method: "POST", path: "/personal_finance/accounts/balance_review.json", handler: "CardCycleBalanceReviewHandler"},
	}
	for _, route := range routes {
		registration := `apiV1Route.` + route.method + `("` + route.path + `", bindApi(PersonalFinanceCardCycle.` + route.handler
		if strings.Count(source, registration) != 1 {
			t.Fatalf("%s %s must be registered exactly once with %s", route.method, route.path, route.handler)
		}
		routeIndex := strings.Index(source, registration)
		if importStart := strings.LastIndex(source[:routeIndex], "if config.EnableDataImport {"); importStart >= 0 &&
			sourceBlockContainsOffset(source, importStart, routeIndex) {
			t.Fatalf("%s %s is incorrectly controlled by EnableDataImport", route.method, route.path)
		}
	}
	if strings.Count(source, `apiV1Route.GET("/personal_finance/card_cycle/`)+
		strings.Count(source, `apiV1Route.POST("/personal_finance/card_cycle/`)+
		strings.Count(source, `apiV1Route.POST("/personal_finance/accounts/balance_review.json"`) != len(routes) {
		t.Fatal("unexpected extra or missing personal finance card cycle route")
	}

	webserverBytes, err := os.ReadFile("webserver.go")
	if err != nil {
		t.Fatalf("read webserver routes: %v", err)
	}
	webserver := string(webserverBytes)
	if strings.Count(webserver, "api.RegisterPersonalFinanceRoutes(apiV1Route, config, bindApi)") != 1 {
		t.Fatal("personal finance routes must still be registered by exactly one RegisterPersonalFinanceRoutes call")
	}
	if strings.Contains(webserver, `"/personal_finance/`) {
		t.Fatal("webserver.go must not register card cycle paths directly")
	}
}

func TestPersonalFinanceCardCycleCompositionFollowsOrganizerAndStopsStartupOnFailure(t *testing.T) {
	sourceBytes, err := os.ReadFile("webserver.go")
	if err != nil {
		t.Fatalf("read webserver startup: %v", err)
	}
	source := string(sourceBytes)
	organizerInit := strings.Index(source, "err = api.InitializePersonalFinanceOrganizerApi()")
	cardCycleInitText := "err = api.InitializePersonalFinanceCardCycleApi()"
	cardCycleInit := strings.Index(source, cardCycleInitText)
	requestId := strings.Index(source, "err = requestid.InitializeRequestIdGenerator")
	if organizerInit < 0 || cardCycleInit < 0 || requestId < 0 || organizerInit > cardCycleInit || cardCycleInit > requestId ||
		strings.Count(source, cardCycleInitText) != 1 {
		t.Fatal("card cycle composition order is invalid")
	}
	guard := source[cardCycleInit:requestId]
	if !strings.Contains(guard, "if err != nil {") || !strings.Contains(guard, "return err") {
		t.Fatal("card cycle composition failure does not stop startup")
	}
}
