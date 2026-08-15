package api

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

type personalFinanceRouteSpec struct {
	method      string
	path        string
	handler     string
	importGated bool
}

// frozenPersonalFinanceRoutes 是搬移前 cmd/webserver.go 的完整清单，顺序与导入开关必须保持不变。
var frozenPersonalFinanceRoutes = []personalFinanceRouteSpec{
	{method: "POST", path: "/personal_finance/import_files/upload.json", handler: "PersonalFinanceImports.ImportFileUploadHandler", importGated: true},
	{method: "POST", path: "/personal_finance/import_batches/reparse.json", handler: "PersonalFinanceImports.ImportBatchReparseHandler", importGated: true},
	{method: "POST", path: "/personal_finance/import_batches/post.json", handler: "PersonalFinanceImports.ImportBatchPostHandler", importGated: true},
	{method: "POST", path: "/personal_finance/source_accounts/save.json", handler: "PersonalFinanceImports.SourceAccountSaveHandler", importGated: true},
	{method: "POST", path: "/personal_finance/import_batches/payment_accounts/confirm.json", handler: "PersonalFinanceImports.PaymentAccountConfirmHandler", importGated: true},
	{method: "POST", path: "/personal_finance/reconciliation/candidates/generate.json", handler: "PersonalFinanceImports.ReconciliationCandidateGenerateHandler", importGated: true},
	{method: "GET", path: "/personal_finance/import_files/list.json", handler: "PersonalFinanceImports.ImportFileListHandler"},
	{method: "GET", path: "/personal_finance/import_files/get.json", handler: "PersonalFinanceImports.ImportFileGetHandler"},
	{method: "GET", path: "/personal_finance/import_batches/list.json", handler: "PersonalFinanceImports.ImportBatchListHandler"},
	{method: "GET", path: "/personal_finance/import_batches/get.json", handler: "PersonalFinanceImports.ImportBatchGetHandler"},
	{method: "GET", path: "/personal_finance/import_batches/rows.json", handler: "PersonalFinanceImports.RawImportRowListHandler"},
	{method: "POST", path: "/personal_finance/import_batches/discard.json", handler: "PersonalFinanceImports.ImportBatchDiscardHandler"},
	{method: "POST", path: "/personal_finance/import_files/delete_content.json", handler: "PersonalFinanceImports.ImportFileDeleteContentHandler"},
	{method: "GET", path: "/personal_finance/import_batches/undo_impact.json", handler: "PersonalFinanceImports.ImportBatchUndoImpactHandler"},
	{method: "GET", path: "/personal_finance/consistency.json", handler: "PersonalFinanceImports.PersonalFinanceConsistencyHandler"},
	{method: "GET", path: "/personal_finance/source_accounts/list.json", handler: "PersonalFinanceImports.SourceAccountListHandler"},
	{method: "GET", path: "/personal_finance/import_batches/payment_accounts.json", handler: "PersonalFinanceImports.PaymentAccountListHandler"},
	{method: "GET", path: "/personal_finance/transactions/evidence.json", handler: "PersonalFinanceImports.TransactionEvidenceHandler"},
	{method: "GET", path: "/personal_finance/reconciliation/cases/list.json", handler: "PersonalFinanceReconciliation.ReconciliationCaseListHandler"},
	{method: "GET", path: "/personal_finance/reconciliation/cases/get.json", handler: "PersonalFinanceReconciliation.ReconciliationCaseGetHandler"},
	{method: "POST", path: "/personal_finance/reconciliation/cases/decide.json", handler: "PersonalFinanceReconciliation.ReconciliationCaseDecideHandler"},
	{method: "GET", path: "/personal_finance/reconciliation/cases/undo_impact.json", handler: "PersonalFinanceReconciliation.ReconciliationCaseUndoImpactHandler"},
	{method: "POST", path: "/personal_finance/reconciliation/cases/undo.json", handler: "PersonalFinanceReconciliation.ReconciliationCaseUndoHandler"},
	{method: "POST", path: "/personal_finance/loans/calculate.json", handler: "PersonalFinanceLoans.LoanCalculateHandler"},
	{method: "GET", path: "/personal_finance/loans/contracts/list.json", handler: "PersonalFinanceLoans.LoanContractListHandler"},
	{method: "GET", path: "/personal_finance/loans/contracts/get.json", handler: "PersonalFinanceLoans.LoanContractGetHandler"},
	{method: "POST", path: "/personal_finance/loans/contracts/create.json", handler: "PersonalFinanceLoans.LoanContractCreateHandler"},
	{method: "POST", path: "/personal_finance/loans/contracts/revise.json", handler: "PersonalFinanceLoans.LoanContractReviseHandler"},
	{method: "POST", path: "/personal_finance/loans/contracts/close.json", handler: "PersonalFinanceLoans.LoanContractCloseHandler"},
	{method: "POST", path: "/personal_finance/loans/contracts/reopen.json", handler: "PersonalFinanceLoans.LoanContractReopenHandler"},
	{method: "POST", path: "/personal_finance/loans/contracts/cancel.json", handler: "PersonalFinanceLoans.LoanContractCancelHandler"},
	{method: "GET", path: "/personal_finance/loans/settlements/candidates.json", handler: "PersonalFinanceLoans.LoanSettlementCandidatesHandler"},
	{method: "POST", path: "/personal_finance/loans/settlements/apply.json", handler: "PersonalFinanceLoans.LoanSettlementApplyHandler"},
	{method: "GET", path: "/personal_finance/loans/settlements/undo_impact.json", handler: "PersonalFinanceLoans.LoanSettlementUndoImpactHandler"},
	{method: "POST", path: "/personal_finance/loans/settlements/undo.json", handler: "PersonalFinanceLoans.LoanSettlementUndoHandler"},
	{method: "GET", path: "/personal_finance/dashboard/overview.json", handler: "PersonalFinanceDashboard.OverviewHandler"},
	{method: "GET", path: "/personal_finance/installments/candidates/list.json", handler: "PersonalFinanceInstallments.InstallmentCandidateListHandler"},
	{method: "GET", path: "/personal_finance/installments/candidates/get.json", handler: "PersonalFinanceInstallments.InstallmentCandidateGetHandler"},
	{method: "POST", path: "/personal_finance/installments/candidates/confirm.json", handler: "PersonalFinanceInstallments.InstallmentCandidateConfirmHandler"},
	{method: "POST", path: "/personal_finance/billflow/tasks/create.json", handler: "PersonalFinanceBillflow.BillflowTaskCreateHandler"},
	{method: "GET", path: "/personal_finance/billflow/tasks/list.json", handler: "PersonalFinanceBillflow.BillflowTaskListHandler"},
	{method: "GET", path: "/personal_finance/billflow/tasks/get.json", handler: "PersonalFinanceBillflow.BillflowTaskGetHandler"},
	{method: "GET", path: "/personal_finance/billflow/tasks/accounts.json", handler: "PersonalFinanceBillflow.BillflowTaskAccountsHandler"},
	{method: "POST", path: "/personal_finance/billflow/tasks/accounts/create.json", handler: "PersonalFinanceBillflow.BillflowTaskAccountsCreateHandler"},
	{method: "POST", path: "/personal_finance/billflow/tasks/accounts/override.json", handler: "PersonalFinanceBillflow.BillflowTaskAccountsOverrideHandler"},
	{method: "POST", path: "/personal_finance/billflow/tasks/run.json", handler: "PersonalFinanceBillflow.BillflowTaskRunHandler"},
	{method: "POST", path: "/personal_finance/billflow/tasks/confirm_post.json", handler: "PersonalFinanceBillflow.BillflowTaskConfirmPostHandler"},
	{method: "GET", path: "/personal_finance/billflow/tasks/todos.json", handler: "PersonalFinanceBillflow.BillflowTaskTodosHandler"},
	{method: "POST", path: "/personal_finance/billflow/todos/resolve.json", handler: "PersonalFinanceBillflow.BillflowTodoResolveHandler"},
	{method: "GET", path: "/personal_finance/billflow/tasks/undo_impact.json", handler: "PersonalFinanceBillflow.BillflowTaskUndoImpactHandler"},
	{method: "POST", path: "/personal_finance/billflow/tasks/undo.json", handler: "PersonalFinanceBillflow.BillflowTaskUndoHandler"},
}

func TestRegisterPersonalFinanceRoutesMatchesFrozenInventory(t *testing.T) {
	sourceBytes, err := os.ReadFile("personal_finance_routes.go")
	if err != nil {
		t.Fatalf("read personal finance routes: %v", err)
	}
	source := string(sourceBytes)
	pattern := regexp.MustCompile(`apiV1Route\.(GET|POST)\("(/personal_finance/[^"]+)", bindApi\(([A-Za-z0-9_.]+)`)
	matches := pattern.FindAllStringSubmatchIndex(source, -1)
	if len(matches) != len(frozenPersonalFinanceRoutes) {
		t.Fatalf("registered %d personal finance routes, frozen inventory has %d", len(matches), len(frozenPersonalFinanceRoutes))
	}
	seen := make(map[string]struct{}, len(matches))
	for index, loc := range matches {
		method := source[loc[2]:loc[3]]
		path := source[loc[4]:loc[5]]
		handler := source[loc[6]:loc[7]]
		importGated := personalFinanceSourceBlockContains(source, strings.LastIndex(source[:loc[0]], "if config.EnableDataImport {"), loc[0])
		expected := frozenPersonalFinanceRoutes[index]
		if method != expected.method || path != expected.path || handler != expected.handler || importGated != expected.importGated {
			t.Fatalf("route %d = %s %s %s gated=%t, expected %s %s %s gated=%t",
				index, method, path, handler, importGated, expected.method, expected.path, expected.handler, expected.importGated)
		}
		key := method + " " + path
		if _, exists := seen[key]; exists {
			t.Fatalf("duplicate personal finance route %s", key)
		}
		seen[key] = struct{}{}
	}
}

func personalFinanceSourceBlockContains(source string, blockStart int, target int) bool {
	if blockStart < 0 {
		return false
	}
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
