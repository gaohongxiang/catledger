package cmd

import (
	"os"
	"strings"
	"testing"
)

func TestPersonalFinanceDashboardRouteIsUniqueAuthenticatedAndImportIndependent(t *testing.T) {
	sourceBytes, err := os.ReadFile("webserver.go")
	if err != nil {
		t.Fatalf("read webserver routes: %v", err)
	}
	source := string(sourceBytes)
	registration := `apiV1Route.GET("/personal_finance/dashboard/overview.json", bindApi(api.PersonalFinanceDashboard.OverviewHandler`
	if strings.Count(source, registration) != 1 {
		t.Fatal("dashboard overview route must be registered exactly once")
	}
	authStart := strings.Index(source, "apiV1Route.Use(bindMiddleware(middlewares.JWTAuthorizationByHeader(config), config))")
	routeIndex := strings.Index(source, registration)
	if authStart < 0 || routeIndex < 0 || !sourceBlockContainsOffset(source, authStart, routeIndex) {
		t.Fatal("dashboard overview route is not inside the authenticated API v1 block")
	}
	if importStart := strings.LastIndex(source[:routeIndex], "if config.EnableDataImport {"); importStart >= 0 && sourceBlockContainsOffset(source, importStart, routeIndex) {
		t.Fatal("dashboard overview route is incorrectly controlled by EnableDataImport")
	}
}

func TestPersonalFinanceDashboardCompositionFollowsLoansAndStopsStartupOnFailure(t *testing.T) {
	sourceBytes, err := os.ReadFile("webserver.go")
	if err != nil {
		t.Fatalf("read webserver startup: %v", err)
	}
	source := string(sourceBytes)
	loanInit := strings.Index(source, "err = api.InitializePersonalFinanceLoansApi()")
	dashboardInitText := "err = api.InitializePersonalFinanceDashboardApi()"
	dashboardInit := strings.Index(source, dashboardInitText)
	requestId := strings.Index(source, "err = requestid.InitializeRequestIdGenerator")
	if loanInit < 0 || dashboardInit < 0 || requestId < 0 || loanInit > dashboardInit || dashboardInit > requestId || strings.Count(source, dashboardInitText) != 1 {
		t.Fatal("dashboard composition order is invalid")
	}
	guard := source[dashboardInit:requestId]
	if !strings.Contains(guard, "if err != nil {") || !strings.Contains(guard, "return err") {
		t.Fatal("dashboard composition failure does not stop startup")
	}
}
