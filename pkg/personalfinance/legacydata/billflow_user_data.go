package legacydata

import "github.com/mayswind/ezbookkeeping/pkg/core"

// BillflowUserDataModule 只登记历史表，保证用户数据计数与删除不会遗漏。
func BillflowUserDataModule() core.UserDataModule {
	return core.UserDataModule{
		Name: "legacy_billflow",
		Tables: core.UserDataTables(
			"pf_billflow_todo",
			"pf_billflow_action",
			"pf_billflow_task_member",
			"pf_billflow_task",
		),
	}
}
