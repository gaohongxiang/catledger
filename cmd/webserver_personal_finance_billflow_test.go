package cmd

import (
	"os"
	"strings"
	"testing"
)

func TestPersonalFinanceOrganizerRoutesReplaceBillflowAndRemainImportIndependent(t *testing.T) {
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
		{method: "POST", path: "/personal_finance/updates/create.json", handler: "UpdateCreateHandler"},
		{method: "GET", path: "/personal_finance/updates/list.json", handler: "UpdateListHandler"},
		{method: "GET", path: "/personal_finance/updates/get.json", handler: "UpdateGetHandler"},
		{method: "POST", path: "/personal_finance/updates/organize.json", handler: "UpdateOrganizeHandler"},
		{method: "GET", path: "/personal_finance/events/list.json", handler: "EventListHandler"},
		{method: "GET", path: "/personal_finance/events/evidence.json", handler: "EventEvidenceHandler"},
		{method: "GET", path: "/personal_finance/events/correction_impact.json", handler: "EventCorrectionImpactHandler"},
		{method: "POST", path: "/personal_finance/events/correct.json", handler: "EventCorrectHandler"},
		{method: "POST", path: "/personal_finance/events/exclude.json", handler: "EventExcludeHandler"},
		{method: "POST", path: "/personal_finance/actions/post-all-ready.json", handler: "ActionPostAllReadyHandler"},
		{method: "GET", path: "/personal_finance/actions/undo_impact.json", handler: "ActionUndoImpactHandler"},
		{method: "POST", path: "/personal_finance/actions/undo.json", handler: "ActionUndoHandler"},
	}
	for _, route := range routes {
		registration := `apiV1Route.` + route.method + `("` + route.path + `", bindApi(PersonalFinanceOrganizer.` + route.handler
		if strings.Count(source, registration) != 1 {
			t.Fatalf("%s %s must be registered exactly once with %s", route.method, route.path, route.handler)
		}
		routeIndex := strings.Index(source, registration)
		if importStart := strings.LastIndex(source[:routeIndex], "if config.EnableDataImport {"); importStart >= 0 &&
			sourceBlockContainsOffset(source, importStart, routeIndex) {
			t.Fatalf("%s %s is incorrectly controlled by EnableDataImport", route.method, route.path)
		}
	}
	if strings.Contains(source, "/personal_finance/billflow/") {
		t.Fatal("old personal finance billflow routes still exist")
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
		t.Fatal("webserver.go must not register organizer paths directly")
	}
}

func TestPersonalFinanceOrganizerCompositionFollowsInstallmentsAndStopsStartupOnFailure(t *testing.T) {
	sourceBytes, err := os.ReadFile("webserver.go")
	if err != nil {
		t.Fatalf("read webserver startup: %v", err)
	}
	source := string(sourceBytes)
	installmentInit := strings.Index(source, "err = api.InitializePersonalFinanceInstallmentsApi()")
	organizerInitText := "err = api.InitializePersonalFinanceOrganizerApi()"
	organizerInit := strings.Index(source, organizerInitText)
	requestId := strings.Index(source, "err = requestid.InitializeRequestIdGenerator")
	if installmentInit < 0 || organizerInit < 0 || requestId < 0 || installmentInit > organizerInit || organizerInit > requestId ||
		strings.Count(source, organizerInitText) != 1 || strings.Contains(source, "InitializePersonalFinanceBillflowApi()") {
		t.Fatal("organizer composition order is invalid or billflow is still initialized")
	}
	guard := source[organizerInit:requestId]
	if !strings.Contains(guard, "if err != nil {") || !strings.Contains(guard, "return err") {
		t.Fatal("organizer composition failure does not stop startup")
	}
}
