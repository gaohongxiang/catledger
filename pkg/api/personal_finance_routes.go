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
		apiV1Route.POST("/personal_finance/import_batches/payment_accounts/skip.json", bindApi(PersonalFinanceImports.PaymentAccountSkipHandler, config))
		apiV1Route.POST("/personal_finance/import_batches/payment_accounts/exclude.json", bindApi(PersonalFinanceImports.PaymentAccountExcludeHandler, config))
		apiV1Route.POST("/personal_finance/import_batches/payment_accounts/restore.json", bindApi(PersonalFinanceImports.PaymentAccountRestoreHandler, config))
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

	// Personal Finance Organizer v2
	apiV1Route.POST("/personal_finance/updates/create.json", bindApi(PersonalFinanceOrganizer.UpdateCreateHandler, config))
	apiV1Route.GET("/personal_finance/updates/list.json", bindApi(PersonalFinanceOrganizer.UpdateListHandler, config))
	apiV1Route.GET("/personal_finance/updates/get.json", bindApi(PersonalFinanceOrganizer.UpdateGetHandler, config))
	apiV1Route.POST("/personal_finance/updates/organize.json", bindApi(PersonalFinanceOrganizer.UpdateOrganizeHandler, config))
	apiV1Route.POST("/personal_finance/updates/abandon.json", bindApi(PersonalFinanceOrganizer.UpdateAbandonHandler, config))
	apiV1Route.GET("/personal_finance/events/list.json", bindApi(PersonalFinanceOrganizer.EventListHandler, config))
	apiV1Route.GET("/personal_finance/events/evidence.json", bindApi(PersonalFinanceOrganizer.EventEvidenceHandler, config))
	apiV1Route.GET("/personal_finance/events/correction_impact.json", bindApi(PersonalFinanceOrganizer.EventCorrectionImpactHandler, config))
	apiV1Route.POST("/personal_finance/events/correct.json", bindApi(PersonalFinanceOrganizer.EventCorrectHandler, config))
	apiV1Route.POST("/personal_finance/events/exclude.json", bindApi(PersonalFinanceOrganizer.EventExcludeHandler, config))
	apiV1Route.GET("/personal_finance/review_issues/list.json", bindApi(PersonalFinanceOrganizer.ReviewIssueListHandler, config))
	apiV1Route.GET("/personal_finance/review_issues/get.json", bindApi(PersonalFinanceOrganizer.ReviewIssueGetHandler, config))
	apiV1Route.POST("/personal_finance/review_issues/resolve.json", bindApi(PersonalFinanceOrganizer.ReviewIssueResolveHandler, config))
	apiV1Route.POST("/personal_finance/actions/post-all-ready.json", bindApi(PersonalFinanceOrganizer.ActionPostAllReadyHandler, config))
	apiV1Route.POST("/personal_finance/actions/post-ready.json", bindApi(PersonalFinanceOrganizer.ActionPostReadyHandler, config))
	apiV1Route.GET("/personal_finance/actions/undo_impact.json", bindApi(PersonalFinanceOrganizer.ActionUndoImpactHandler, config))
	apiV1Route.POST("/personal_finance/actions/undo.json", bindApi(PersonalFinanceOrganizer.ActionUndoHandler, config))

	// Personal Finance Card Cycle
	apiV1Route.GET("/personal_finance/card_cycle/accounts.json", bindApi(PersonalFinanceCardCycle.CardCycleAccountListHandler, config))
	apiV1Route.POST("/personal_finance/card_cycle/rules/save.json", bindApi(PersonalFinanceCardCycle.CardCycleRuleSaveHandler, config))
	apiV1Route.GET("/personal_finance/card_cycle/coverage.json", bindApi(PersonalFinanceCardCycle.CardCycleCoverageHandler, config))
	apiV1Route.POST("/personal_finance/accounts/balance_review.json", bindApi(PersonalFinanceCardCycle.CardCycleBalanceReviewHandler, config))
}
