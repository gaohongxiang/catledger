package installments

import "github.com/mayswind/ezbookkeeping/pkg/core"

// UserDataModule 覆盖分期候选用户表。
func UserDataModule() core.UserDataModule {
	return core.UserDataModule{
		Name: "installments",
		Tables: core.UserDataTables(
			"pf_installment_candidate_member",
			"pf_installment_candidate",
		),
	}
}
