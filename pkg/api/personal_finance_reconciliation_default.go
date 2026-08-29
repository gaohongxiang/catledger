package api

import (
	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/reconciliation"
	"github.com/gaohongxiang/catledger/pkg/services"
	"github.com/gaohongxiang/catledger/pkg/uuid"
)

// PersonalFinanceReconciliation 是 Web 路由使用的默认对账 API 实例。
// 它必须在 datastore 完成初始化后由 Web 入口显式构造。
var PersonalFinanceReconciliation *PersonalFinanceReconciliationApi

// InitializePersonalFinanceReconciliationApi 构造共享的 case 与决定服务。
func InitializePersonalFinanceReconciliationApi() error {
	caseService, err := reconciliation.NewCaseService(datastore.Container.UserDataStore)
	if err != nil {
		return err
	}

	decisionService, err := reconciliation.NewDecisionService(
		datastore.Container.UserDataStore,
		services.PersonalFinancePostingAuthorization,
		services.Transactions,
		func() int64 {
			return uuid.Container.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
		},
	)
	if err != nil {
		return err
	}

	PersonalFinanceReconciliation, err = NewPersonalFinanceReconciliationApi(caseService, decisionService)
	return err
}
