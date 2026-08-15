package api

import (
	"github.com/gin-gonic/gin"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

// PersonalFinanceApiBinder 与 cmd.bindApi 签名一致，只负责把 handler 接到 Gin。
type PersonalFinanceApiBinder func(core.ApiHandlerFunc, *settings.Config) gin.HandlerFunc

// RegisterPersonalFinanceRoutes 注册全部现有 /personal_finance/* 路径。
// 调用方必须在已鉴权的 API v1 组内只调用一次；写操作仍受 EnableDataImport 保护。
func RegisterPersonalFinanceRoutes(apiV1Route gin.IRoutes, config *settings.Config, bindApi PersonalFinanceApiBinder) {
	if config.EnableDataImport {
		apiV1Route.POST("/personal_finance/import_files/upload.json", bindApi(PersonalFinanceImports.ImportFileUploadHandler, config))
		apiV1Route.POST("/personal_finance/import_batches/reparse.json", bindApi(PersonalFinanceImports.ImportBatchReparseHandler, config))
		apiV1Route.POST("/personal_finance/import_batches/post.json", bindApi(PersonalFinanceImports.ImportBatchPostHandler, config))
		apiV1Route.POST("/personal_finance/source_accounts/save.json", bindApi(PersonalFinanceImports.SourceAccountSaveHandler, config))
		apiV1Route.POST("/personal_finance/import_batches/payment_accounts/confirm.json", bindApi(PersonalFinanceImports.PaymentAccountConfirmHandler, config))
		apiV1Route.POST("/personal_finance/reconciliation/candidates/generate.json", bindApi(PersonalFinanceImports.ReconciliationCandidateGenerateHandler, config))
	}

	apiV1Route.GET("/personal_finance/import_files/list.json", bindApi(PersonalFinanceImports.ImportFileListHandler, config))
	apiV1Route.GET("/personal_finance/import_files/get.json", bindApi(PersonalFinanceImports.ImportFileGetHandler, config))
	apiV1Route.GET("/personal_finance/import_batches/list.json", bindApi(PersonalFinanceImports.ImportBatchListHandler, config))
	apiV1Route.GET("/personal_finance/import_batches/get.json", bindApi(PersonalFinanceImports.ImportBatchGetHandler, config))
	apiV1Route.GET("/personal_finance/import_batches/rows.json", bindApi(PersonalFinanceImports.RawImportRowListHandler, config))
	apiV1Route.POST("/personal_finance/import_batches/discard.json", bindApi(PersonalFinanceImports.ImportBatchDiscardHandler, config))
	apiV1Route.POST("/personal_finance/import_files/delete_content.json", bindApi(PersonalFinanceImports.ImportFileDeleteContentHandler, config))
	apiV1Route.GET("/personal_finance/import_batches/undo_impact.json", bindApi(PersonalFinanceImports.ImportBatchUndoImpactHandler, config))
	apiV1Route.GET("/personal_finance/consistency.json", bindApi(PersonalFinanceImports.PersonalFinanceConsistencyHandler, config))
	apiV1Route.GET("/personal_finance/source_accounts/list.json", bindApi(PersonalFinanceImports.SourceAccountListHandler, config))
	apiV1Route.GET("/personal_finance/import_batches/payment_accounts.json", bindApi(PersonalFinanceImports.PaymentAccountListHandler, config))
	apiV1Route.GET("/personal_finance/transactions/evidence.json", bindApi(PersonalFinanceImports.TransactionEvidenceHandler, config))
	apiV1Route.GET("/personal_finance/reconciliation/cases/list.json", bindApi(PersonalFinanceReconciliation.ReconciliationCaseListHandler, config))
	apiV1Route.GET("/personal_finance/reconciliation/cases/get.json", bindApi(PersonalFinanceReconciliation.ReconciliationCaseGetHandler, config))
	apiV1Route.POST("/personal_finance/reconciliation/cases/decide.json", bindApi(PersonalFinanceReconciliation.ReconciliationCaseDecideHandler, config))
	apiV1Route.GET("/personal_finance/reconciliation/cases/undo_impact.json", bindApi(PersonalFinanceReconciliation.ReconciliationCaseUndoImpactHandler, config))
	apiV1Route.POST("/personal_finance/reconciliation/cases/undo.json", bindApi(PersonalFinanceReconciliation.ReconciliationCaseUndoHandler, config))

	// Personal Finance Loans
	apiV1Route.POST("/personal_finance/loans/calculate.json", bindApi(PersonalFinanceLoans.LoanCalculateHandler, config))
	apiV1Route.GET("/personal_finance/loans/contracts/list.json", bindApi(PersonalFinanceLoans.LoanContractListHandler, config))
	apiV1Route.GET("/personal_finance/loans/contracts/get.json", bindApi(PersonalFinanceLoans.LoanContractGetHandler, config))
	apiV1Route.POST("/personal_finance/loans/contracts/create.json", bindApi(PersonalFinanceLoans.LoanContractCreateHandler, config))
	apiV1Route.POST("/personal_finance/loans/contracts/revise.json", bindApi(PersonalFinanceLoans.LoanContractReviseHandler, config))
	apiV1Route.POST("/personal_finance/loans/contracts/close.json", bindApi(PersonalFinanceLoans.LoanContractCloseHandler, config))
	apiV1Route.POST("/personal_finance/loans/contracts/reopen.json", bindApi(PersonalFinanceLoans.LoanContractReopenHandler, config))
	apiV1Route.POST("/personal_finance/loans/contracts/cancel.json", bindApi(PersonalFinanceLoans.LoanContractCancelHandler, config))
	apiV1Route.GET("/personal_finance/loans/settlements/candidates.json", bindApi(PersonalFinanceLoans.LoanSettlementCandidatesHandler, config))
	apiV1Route.POST("/personal_finance/loans/settlements/apply.json", bindApi(PersonalFinanceLoans.LoanSettlementApplyHandler, config))
	apiV1Route.GET("/personal_finance/loans/settlements/undo_impact.json", bindApi(PersonalFinanceLoans.LoanSettlementUndoImpactHandler, config))
	apiV1Route.POST("/personal_finance/loans/settlements/undo.json", bindApi(PersonalFinanceLoans.LoanSettlementUndoHandler, config))

	// Personal Finance Dashboard
	apiV1Route.GET("/personal_finance/dashboard/overview.json", bindApi(PersonalFinanceDashboard.OverviewHandler, config))

	// Personal Finance Installments
	apiV1Route.GET("/personal_finance/installments/candidates/list.json", bindApi(PersonalFinanceInstallments.InstallmentCandidateListHandler, config))
	apiV1Route.GET("/personal_finance/installments/candidates/get.json", bindApi(PersonalFinanceInstallments.InstallmentCandidateGetHandler, config))
	apiV1Route.POST("/personal_finance/installments/candidates/confirm.json", bindApi(PersonalFinanceInstallments.InstallmentCandidateConfirmHandler, config))

	// Personal Finance Billflow
	apiV1Route.POST("/personal_finance/billflow/tasks/create.json", bindApi(PersonalFinanceBillflow.BillflowTaskCreateHandler, config))
	apiV1Route.GET("/personal_finance/billflow/tasks/list.json", bindApi(PersonalFinanceBillflow.BillflowTaskListHandler, config))
	apiV1Route.GET("/personal_finance/billflow/tasks/get.json", bindApi(PersonalFinanceBillflow.BillflowTaskGetHandler, config))
	apiV1Route.GET("/personal_finance/billflow/tasks/accounts.json", bindApi(PersonalFinanceBillflow.BillflowTaskAccountsHandler, config))
	apiV1Route.POST("/personal_finance/billflow/tasks/accounts/create.json", bindApi(PersonalFinanceBillflow.BillflowTaskAccountsCreateHandler, config))
	apiV1Route.POST("/personal_finance/billflow/tasks/accounts/override.json", bindApi(PersonalFinanceBillflow.BillflowTaskAccountsOverrideHandler, config))
	apiV1Route.POST("/personal_finance/billflow/tasks/accounts/exclude.json", bindApi(PersonalFinanceBillflow.BillflowTaskAccountsExcludeHandler, config))
	apiV1Route.POST("/personal_finance/billflow/tasks/accounts/restore.json", bindApi(PersonalFinanceBillflow.BillflowTaskAccountsRestoreHandler, config))
	apiV1Route.GET("/personal_finance/billflow/tasks/accounts/rows.json", bindApi(PersonalFinanceBillflow.BillflowTaskAccountsRowsHandler, config))
	apiV1Route.POST("/personal_finance/billflow/tasks/accounts/skip_rows.json", bindApi(PersonalFinanceBillflow.BillflowTaskAccountsSkipRowsHandler, config))
	apiV1Route.POST("/personal_finance/billflow/tasks/accounts/restore_rows.json", bindApi(PersonalFinanceBillflow.BillflowTaskAccountsRestoreRowsHandler, config))
	apiV1Route.POST("/personal_finance/billflow/tasks/run.json", bindApi(PersonalFinanceBillflow.BillflowTaskRunHandler, config))
	apiV1Route.POST("/personal_finance/billflow/tasks/confirm_post.json", bindApi(PersonalFinanceBillflow.BillflowTaskConfirmPostHandler, config))
	apiV1Route.GET("/personal_finance/billflow/tasks/todos.json", bindApi(PersonalFinanceBillflow.BillflowTaskTodosHandler, config))
	apiV1Route.GET("/personal_finance/billflow/tasks/categories.json", bindApi(PersonalFinanceBillflow.BillflowTaskClassifiedHandler, config))
	apiV1Route.POST("/personal_finance/billflow/todos/resolve.json", bindApi(PersonalFinanceBillflow.BillflowTodoResolveHandler, config))
	apiV1Route.POST("/personal_finance/billflow/todos/assign_category.json", bindApi(PersonalFinanceBillflow.BillflowTodoAssignCategoryHandler, config))
	apiV1Route.GET("/personal_finance/billflow/tasks/undo_impact.json", bindApi(PersonalFinanceBillflow.BillflowTaskUndoImpactHandler, config))
	apiV1Route.POST("/personal_finance/billflow/tasks/undo.json", bindApi(PersonalFinanceBillflow.BillflowTaskUndoHandler, config))

	// Personal Finance Card Cycle
	apiV1Route.GET("/personal_finance/card_cycle/accounts.json", bindApi(PersonalFinanceCardCycle.CardCycleAccountListHandler, config))
	apiV1Route.POST("/personal_finance/card_cycle/rules/save.json", bindApi(PersonalFinanceCardCycle.CardCycleRuleSaveHandler, config))
	apiV1Route.GET("/personal_finance/card_cycle/coverage.json", bindApi(PersonalFinanceCardCycle.CardCycleCoverageHandler, config))
	apiV1Route.POST("/personal_finance/accounts/balance_review.json", bindApi(PersonalFinanceCardCycle.CardCycleBalanceReviewHandler, config))
}
