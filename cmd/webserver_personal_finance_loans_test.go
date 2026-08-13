package cmd

import (
	"os"
	"strings"
	"testing"
)

func TestPersonalFinanceLoanRoutesAreUniqueAuthenticatedAndImportIndependent(t *testing.T) {
	sourceBytes, err := os.ReadFile("webserver.go")
	if err != nil {
		t.Fatalf("read webserver routes: %v", err)
	}
	source := string(sourceBytes)
	routes := []struct {
		method  string
		path    string
		handler string
	}{
		{method: "POST", path: "/personal_finance/loans/calculate.json", handler: "LoanCalculateHandler"},
		{method: "GET", path: "/personal_finance/loans/contracts/list.json", handler: "LoanContractListHandler"},
		{method: "GET", path: "/personal_finance/loans/contracts/get.json", handler: "LoanContractGetHandler"},
		{method: "POST", path: "/personal_finance/loans/contracts/create.json", handler: "LoanContractCreateHandler"},
		{method: "POST", path: "/personal_finance/loans/contracts/revise.json", handler: "LoanContractReviseHandler"},
		{method: "POST", path: "/personal_finance/loans/contracts/close.json", handler: "LoanContractCloseHandler"},
		{method: "POST", path: "/personal_finance/loans/contracts/reopen.json", handler: "LoanContractReopenHandler"},
		{method: "POST", path: "/personal_finance/loans/contracts/cancel.json", handler: "LoanContractCancelHandler"},
		{method: "GET", path: "/personal_finance/loans/settlements/candidates.json", handler: "LoanSettlementCandidatesHandler"},
		{method: "POST", path: "/personal_finance/loans/settlements/apply.json", handler: "LoanSettlementApplyHandler"},
		{method: "GET", path: "/personal_finance/loans/settlements/undo_impact.json", handler: "LoanSettlementUndoImpactHandler"},
		{method: "POST", path: "/personal_finance/loans/settlements/undo.json", handler: "LoanSettlementUndoHandler"},
	}
	authStart := strings.Index(source, "apiV1Route.Use(bindMiddleware(middlewares.JWTAuthorizationByHeader(config), config))")
	if authStart < 0 {
		t.Fatal("authenticated API v1 middleware is missing")
	}
	for _, route := range routes {
		registration := `apiV1Route.` + route.method + `("` + route.path + `", bindApi(api.PersonalFinanceLoans.` + route.handler
		if strings.Count(source, registration) != 1 {
			t.Fatalf("%s %s must be registered exactly once with %s", route.method, route.path, route.handler)
		}
		routeIndex := strings.Index(source, registration)
		if !sourceBlockContainsOffset(source, authStart, routeIndex) {
			t.Fatalf("%s %s is not inside the authenticated API v1 route block", route.method, route.path)
		}
		if importStart := strings.LastIndex(source[:routeIndex], "if config.EnableDataImport {"); importStart >= 0 &&
			sourceBlockContainsOffset(source, importStart, routeIndex) {
			t.Fatalf("%s %s is incorrectly controlled by EnableDataImport", route.method, route.path)
		}
	}
	if strings.Count(source, `apiV1Route.GET("/personal_finance/loans/`)+
		strings.Count(source, `apiV1Route.POST("/personal_finance/loans/`) != len(routes) {
		t.Fatal("unexpected extra or missing personal finance loan route")
	}
}

func TestPersonalFinanceLoanCompositionFailureStopsWebserverStartup(t *testing.T) {
	sourceBytes, err := os.ReadFile("webserver.go")
	if err != nil {
		t.Fatalf("read webserver startup: %v", err)
	}
	source := string(sourceBytes)
	initialize := "err = api.InitializePersonalFinanceLoansApi()"
	if strings.Count(source, initialize) != 1 {
		t.Fatal("personal finance loans API must be initialized exactly once")
	}
	start := strings.Index(source, initialize)
	requestId := strings.Index(source, "err = requestid.InitializeRequestIdGenerator")
	if start < 0 || requestId < 0 || start > requestId {
		t.Fatal("personal finance loans API is not initialized during startup before route dependencies")
	}
	guard := source[start:requestId]
	if !strings.Contains(guard, "if err != nil {") || !strings.Contains(guard, "return err") {
		t.Fatal("personal finance loans composition failure does not stop webserver startup")
	}
}
