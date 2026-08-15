package loans

import "github.com/mayswind/ezbookkeeping/pkg/core"

// UserDataModule 覆盖贷款用户表。
func UserDataModule() core.UserDataModule {
	return core.UserDataModule{
		Name: "loans",
		Tables: core.UserDataTables(
			"pf_loan_transaction_allocation",
			"pf_loan_transaction_binding",
			"pf_loan_installment",
			"pf_loan_action",
			"pf_loan_contract_revision",
			"pf_loan_contract",
		),
	}
}
