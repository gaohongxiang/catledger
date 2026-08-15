package api

import (
	"errors"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/installments"
	"github.com/mayswind/ezbookkeeping/pkg/services"
	"github.com/mayswind/ezbookkeeping/pkg/uuid"
)

var PersonalFinanceInstallments *PersonalFinanceInstallmentsApi

func InitializePersonalFinanceInstallmentsApi() error {
	if PersonalFinanceLoans == nil || PersonalFinanceLoans.settlements == nil {
		return errors.New("personal finance loans must be initialized before installments")
	}
	contracts, ok := PersonalFinanceLoans.settlements.(installments.ContractGateway)
	if !ok {
		return errors.New("personal finance loan service does not support installment contract commands")
	}
	store := datastore.Container.UserDataStore
	repository, err := installments.NewRepository(store)
	if err != nil {
		return err
	}
	evidence, err := importing.NewRepository(store)
	if err != nil {
		return err
	}
	authorizer, err := services.NewPersonalFinanceLoanSettlementAuthorizer(services.Users, services.Accounts)
	if err != nil {
		return err
	}
	ledger, err := services.NewPersonalFinanceLoanLedgerAdapter(services.Transactions, authorizer)
	if err != nil {
		return err
	}
	service, err := installments.NewService(repository, evidence, contracts, ledger, func() int64 {
		return uuid.Container.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
	})
	if err != nil {
		return err
	}
	PersonalFinanceInstallments, err = NewPersonalFinanceInstallmentsApi(service)
	return err
}
