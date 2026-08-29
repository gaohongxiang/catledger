package organizer

import "github.com/gaohongxiang/catledger/pkg/core"

// UserDataModule 覆盖新整理工作流的全部用户表。
func UserDataModule() core.UserDataModule {
	return core.UserDataModule{
		Name: "organizer",
		Tables: core.UserDataTables(
			"pf_category_alias_mapping",
			"pf_review_issue_member",
			"pf_review_issue",
			"pf_finance_action",
			"pf_economic_event_transaction",
			"pf_economic_event_relation",
			"pf_economic_event_evidence",
			"pf_economic_event",
			"pf_finance_update_source",
			"pf_finance_update",
		),
	}
}
