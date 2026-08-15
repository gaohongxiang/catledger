package cardcycle

import "github.com/mayswind/ezbookkeeping/pkg/core"

// UserDataModule 覆盖信用卡周期与余额核对用户表。
func UserDataModule() core.UserDataModule {
	return core.UserDataModule{
		Name: "cardcycle",
		Tables: core.UserDataTables(
			"pf_month_report_revision",
			"pf_card_statement_coverage",
			"pf_card_cycle_rule",
			"pf_account_balance_review",
		),
	}
}
