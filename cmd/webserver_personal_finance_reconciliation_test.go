package cmd

import (
	"os"
	"strings"
	"testing"
)

func TestCandidateGenerateRouteIsRegisteredOnceInDataImportWriteGroup(t *testing.T) {
	sourceBytes, err := os.ReadFile("../pkg/api/personal_finance_routes.go")
	if err != nil {
		t.Fatalf("read personal finance routes: %v", err)
	}
	source := string(sourceBytes)
	route := `apiV1Route.POST("/personal_finance/reconciliation/candidates/generate.json"`
	if strings.Count(source, route) != 1 {
		t.Fatalf("candidate generate route must be registered exactly once")
	}

	routeIndex := strings.Index(source, route)
	groupStart := strings.LastIndex(source[:routeIndex], "if config.EnableDataImport {")
	if groupStart < 0 || !sourceBlockContainsOffset(source, groupStart, routeIndex) {
		t.Fatal("candidate generate route is not in the data-import write route group")
	}
}

func sourceBlockContainsOffset(source string, blockStart int, target int) bool {
	openBrace := strings.Index(source[blockStart:], "{")
	if openBrace < 0 {
		return false
	}
	depth := 0
	for index := blockStart + openBrace; index < len(source); index++ {
		switch source[index] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return target > blockStart+openBrace && target < index
			}
		}
	}
	return false
}
