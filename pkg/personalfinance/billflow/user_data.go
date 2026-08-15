package billflow

import "github.com/mayswind/ezbookkeeping/pkg/core"

// UserDataModule 覆盖多账单整理用户表。
func UserDataModule() core.UserDataModule {
	return core.UserDataModule{
		Name: "billflow",
		Tables: core.UserDataTables(
			"pf_billflow_todo",
			"pf_billflow_action",
			"pf_billflow_task_member",
			"pf_billflow_task",
			"pf_category_alias_mapping",
		),
	}
}
