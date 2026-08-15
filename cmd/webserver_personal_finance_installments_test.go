package cmd

import (
	"os"
	"strings"
	"testing"
)

func TestPersonalFinanceInstallmentRoutesAreUniqueAuthenticatedAndImportIndependent(t *testing.T) {
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
		{method: "GET", path: "/personal_finance/installments/candidates/list.json", handler: "InstallmentCandidateListHandler"},
		{method: "GET", path: "/personal_finance/installments/candidates/get.json", handler: "InstallmentCandidateGetHandler"},
		{method: "POST", path: "/personal_finance/installments/candidates/confirm.json", handler: "InstallmentCandidateConfirmHandler"},
	}
	for _, route := range routes {
		registration := `apiV1Route.` + route.method + `("` + route.path + `", bindApi(PersonalFinanceInstallments.` + route.handler
		if strings.Count(source, registration) != 1 {
			t.Fatalf("%s %s must be registered exactly once with %s", route.method, route.path, route.handler)
		}
		routeIndex := strings.Index(source, registration)
		if importStart := strings.LastIndex(source[:routeIndex], "if config.EnableDataImport {"); importStart >= 0 &&
			sourceBlockContainsOffset(source, importStart, routeIndex) {
			t.Fatalf("%s %s is incorrectly controlled by EnableDataImport", route.method, route.path)
		}
	}
	if strings.Count(source, `apiV1Route.GET("/personal_finance/installments/`)+
		strings.Count(source, `apiV1Route.POST("/personal_finance/installments/`) != len(routes) {
		t.Fatal("unexpected extra or missing personal finance installment route")
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
		t.Fatal("webserver.go must not register installment paths directly")
	}
}

func TestPersonalFinanceInstallmentCompositionFollowsLoansAndStopsStartupOnFailure(t *testing.T) {
	sourceBytes, err := os.ReadFile("webserver.go")
	if err != nil {
		t.Fatalf("read webserver startup: %v", err)
	}
	source := string(sourceBytes)
	loanInit := strings.Index(source, "err = api.InitializePersonalFinanceLoansApi()")
	installmentInitText := "err = api.InitializePersonalFinanceInstallmentsApi()"
	installmentInit := strings.Index(source, installmentInitText)
	requestId := strings.Index(source, "err = requestid.InitializeRequestIdGenerator")
	if loanInit < 0 || installmentInit < 0 || requestId < 0 || loanInit > installmentInit || installmentInit > requestId ||
		strings.Count(source, installmentInitText) != 1 {
		t.Fatal("installment composition order is invalid")
	}
	guard := source[installmentInit:requestId]
	if !strings.Contains(guard, "if err != nil {") || !strings.Contains(guard, "return err") {
		t.Fatal("installment composition failure does not stop startup")
	}
}
