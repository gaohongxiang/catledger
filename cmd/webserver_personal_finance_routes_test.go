package cmd

import (
	"os"
	"strings"
	"testing"
)

func TestPersonalFinanceRoutesRegisterOnceInsideAuthenticatedAPI(t *testing.T) {
	sourceBytes, err := os.ReadFile("webserver.go")
	if err != nil {
		t.Fatalf("read webserver routes: %v", err)
	}
	source := string(sourceBytes)
	registration := "api.RegisterPersonalFinanceRoutes(apiV1Route, config, bindApi)"
	if strings.Count(source, registration) != 1 {
		t.Fatal("personal finance routes must be registered by exactly one RegisterPersonalFinanceRoutes call")
	}
	if strings.Contains(source, `"/personal_finance/`) {
		t.Fatal("webserver.go must not register /personal_finance/* paths directly")
	}
	authStart := strings.Index(source, "apiV1Route.Use(bindMiddleware(middlewares.JWTAuthorizationByHeader(config), config))")
	routeIndex := strings.Index(source, registration)
	if authStart < 0 || routeIndex < 0 || !sourceBlockContainsOffset(source, authStart, routeIndex) {
		t.Fatal("RegisterPersonalFinanceRoutes is not inside the authenticated API v1 route block")
	}
	if importStart := strings.LastIndex(source[:routeIndex], "if config.EnableDataImport {"); importStart >= 0 &&
		sourceBlockContainsOffset(source, importStart, routeIndex) {
		t.Fatal("RegisterPersonalFinanceRoutes is incorrectly nested inside EnableDataImport")
	}
}
