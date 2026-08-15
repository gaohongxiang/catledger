package importing

import "github.com/mayswind/ezbookkeeping/pkg/core"

// UserDataModule 覆盖 importing 用户表；对象删除由装配点注入。
func UserDataModule(deleteObjects func(c core.Context, uid int64) error) core.UserDataModule {
	return core.UserDataModule{
		Name: "importing",
		Tables: core.UserDataTables(
			"pf_raw_row_transaction_link",
			"pf_import_posting",
			"pf_import_batch_issue",
			"pf_raw_import_row",
			"pf_source_identity",
			"pf_import_batch",
			"pf_payment_account_exclusion",
			"pf_payment_account_mapping",
			"pf_source_account",
			"pf_import_file",
		),
		DeleteObjects: deleteObjects,
	}
}
