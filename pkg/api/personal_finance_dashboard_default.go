package api

import (
	"errors"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/dashboard"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/services"
)

var PersonalFinanceDashboard *PersonalFinanceDashboardApi

// InitializePersonalFinanceDashboardApi 在贷款 API 完成组合后复用同一领域服务，
// 并构造导入仓储与只读核心账本窄适配器。
func InitializePersonalFinanceDashboardApi() error {
	if PersonalFinanceLoans == nil || PersonalFinanceLoans.settlements == nil {
		return errors.New("personal finance loans must be initialized before dashboard")
	}
	loanReader, ok := PersonalFinanceLoans.settlements.(dashboard.LoanReader)
	if !ok {
		return errors.New("personal finance loan service does not support dashboard reads")
	}
	importRepository, err := importing.NewRepository(datastore.Container.UserDataStore)
	if err != nil {
		return err
	}
	ledger, err := services.NewPersonalFinanceDashboardLedgerAdapter(datastore.Container.UserDataStore)
	if err != nil {
		return err
	}
	service, err := dashboard.NewService(ledger, loanReader, importRepository)
	if err != nil {
		return err
	}
	PersonalFinanceDashboard, err = NewPersonalFinanceDashboardApi(service)
	return err
}
