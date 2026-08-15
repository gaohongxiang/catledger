package reconciliation

import "github.com/mayswind/ezbookkeeping/pkg/core"

// UserDataModule 覆盖对账用户表。
func UserDataModule() core.UserDataModule {
	return core.UserDataModule{
		Name: "reconciliation",
		Tables: core.UserDataTables(
			"pf_reconciliation_ledger_effect",
			"pf_reconciliation_transaction_link",
			"pf_reconciliation_decision",
			"pf_reconciliation_case_member",
			"pf_reconciliation_case",
		),
	}
}
