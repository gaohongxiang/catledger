package api

import (
	"errors"

	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/loans"
	"github.com/gaohongxiang/catledger/pkg/services"
	"github.com/gaohongxiang/catledger/pkg/uuid"
)

// PersonalFinanceLoans 是 Web 路由使用的完整默认贷款 API；只允许在 Web 启动期构造一次。
var PersonalFinanceLoans *PersonalFinanceLoansApi

// InitializePersonalFinanceLoansApi 按冻结依赖方向构造仓储、授权器、窄账本适配器、服务与 HTTP API。
func InitializePersonalFinanceLoansApi() error {
	application, err := newPersonalFinanceLoansApi(datastore.Container.UserDataStore, services.Users, services.Accounts,
		services.Transactions, func() int64 {
			return uuid.Container.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
		})
	if err != nil {
		return err
	}
	PersonalFinanceLoans = application
	return nil
}

func newPersonalFinanceLoansApi(store *datastore.DataStore, users *services.UserService, accounts *services.AccountService,
	transactions *services.TransactionService, generateId func() int64) (*PersonalFinanceLoansApi, error) {
	if users == nil || accounts == nil || transactions == nil || generateId == nil {
		return nil, errors.New("personal finance loans composition dependencies are required")
	}
	repository, err := loans.NewRepository(store)
	if err != nil {
		return nil, err
	}
	authorizer, err := services.NewPersonalFinanceLoanSettlementAuthorizer(users, accounts)
	if err != nil {
		return nil, err
	}
	ledger, err := services.NewPersonalFinanceLoanLedgerAdapter(transactions, authorizer)
	if err != nil {
		return nil, err
	}
	service, err := loans.NewServiceWithSettlementLedger(repository, ledger, generateId)
	if err != nil {
		return nil, err
	}
	return NewPersonalFinanceLoansApi(service)
}
