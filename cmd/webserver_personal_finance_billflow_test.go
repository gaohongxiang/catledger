package cmd

import (
	"os"
	"strings"
	"testing"
)

func TestPersonalFinanceBillflowRoutesAreUniqueAuthenticatedAndImportIndependent(t *testing.T) {
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
		{method: "POST", path: "/personal_finance/billflow/tasks/create.json", handler: "BillflowTaskCreateHandler"},
		{method: "GET", path: "/personal_finance/billflow/tasks/list.json", handler: "BillflowTaskListHandler"},
		{method: "GET", path: "/personal_finance/billflow/tasks/get.json", handler: "BillflowTaskGetHandler"},
		{method: "GET", path: "/personal_finance/billflow/tasks/accounts.json", handler: "BillflowTaskAccountsHandler"},
		{method: "POST", path: "/personal_finance/billflow/tasks/accounts/create.json", handler: "BillflowTaskAccountsCreateHandler"},
		{method: "POST", path: "/personal_finance/billflow/tasks/accounts/override.json", handler: "BillflowTaskAccountsOverrideHandler"},
		{method: "POST", path: "/personal_finance/billflow/tasks/run.json", handler: "BillflowTaskRunHandler"},
		{method: "POST", path: "/personal_finance/billflow/tasks/confirm_post.json", handler: "BillflowTaskConfirmPostHandler"},
		{method: "GET", path: "/personal_finance/billflow/tasks/todos.json", handler: "BillflowTaskTodosHandler"},
		{method: "POST", path: "/personal_finance/billflow/todos/resolve.json", handler: "BillflowTodoResolveHandler"},
		{method: "GET", path: "/personal_finance/billflow/tasks/undo_impact.json", handler: "BillflowTaskUndoImpactHandler"},
		{method: "POST", path: "/personal_finance/billflow/tasks/undo.json", handler: "BillflowTaskUndoHandler"},
	}
	for _, route := range routes {
		registration := `apiV1Route.` + route.method + `("` + route.path + `", bindApi(PersonalFinanceBillflow.` + route.handler
		if strings.Count(source, registration) != 1 {
			t.Fatalf("%s %s must be registered exactly once with %s", route.method, route.path, route.handler)
		}
		routeIndex := strings.Index(source, registration)
		if importStart := strings.LastIndex(source[:routeIndex], "if config.EnableDataImport {"); importStart >= 0 &&
			sourceBlockContainsOffset(source, importStart, routeIndex) {
			t.Fatalf("%s %s is incorrectly controlled by EnableDataImport", route.method, route.path)
		}
	}
	if strings.Count(source, `apiV1Route.GET("/personal_finance/billflow/`)+
		strings.Count(source, `apiV1Route.POST("/personal_finance/billflow/`) != len(routes) {
		t.Fatal("unexpected extra or missing personal finance billflow route")
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
		t.Fatal("webserver.go must not register billflow paths directly")
	}
}

func TestPersonalFinanceBillflowCompositionFollowsInstallmentsAndStopsStartupOnFailure(t *testing.T) {
	sourceBytes, err := os.ReadFile("webserver.go")
	if err != nil {
		t.Fatalf("read webserver startup: %v", err)
	}
	source := string(sourceBytes)
	installmentInit := strings.Index(source, "err = api.InitializePersonalFinanceInstallmentsApi()")
	billflowInitText := "err = api.InitializePersonalFinanceBillflowApi()"
	billflowInit := strings.Index(source, billflowInitText)
	requestId := strings.Index(source, "err = requestid.InitializeRequestIdGenerator")
	if installmentInit < 0 || billflowInit < 0 || requestId < 0 || installmentInit > billflowInit || billflowInit > requestId ||
		strings.Count(source, billflowInitText) != 1 {
		t.Fatal("billflow composition order is invalid")
	}
	guard := source[billflowInit:requestId]
	if !strings.Contains(guard, "if err != nil {") || !strings.Contains(guard, "return err") {
		t.Fatal("billflow composition failure does not stop startup")
	}
}
