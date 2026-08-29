package api

import (
	"testing"

	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/services"
)

func TestNewPersonalFinanceLoansApiWiresRequiredProductionDependencies(t *testing.T) {
	store, err := datastore.NewDataStore(new(datastore.Database))
	if err != nil {
		t.Fatalf("create loan composition test store: %v", err)
	}
	application, err := newPersonalFinanceLoansApi(store, services.Users, services.Accounts, services.Transactions, func() int64 { return 1 })
	if err != nil || application == nil || application.PersonalFinanceLoansContractsApi == nil || application.settlements == nil {
		t.Fatalf("compose full loan API: application=%v error=%v", application, err)
	}

	tests := []struct {
		name         string
		store        *datastore.DataStore
		users        *services.UserService
		accounts     *services.AccountService
		transactions *services.TransactionService
		generateId   func() int64
	}{
		{name: "repository", users: services.Users, accounts: services.Accounts, transactions: services.Transactions, generateId: func() int64 { return 1 }},
		{name: "users", store: store, accounts: services.Accounts, transactions: services.Transactions, generateId: func() int64 { return 1 }},
		{name: "accounts", store: store, users: services.Users, transactions: services.Transactions, generateId: func() int64 { return 1 }},
		{name: "transactions", store: store, users: services.Users, accounts: services.Accounts, generateId: func() int64 { return 1 }},
		{name: "generator", store: store, users: services.Users, accounts: services.Accounts, transactions: services.Transactions},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			application, err := newPersonalFinanceLoansApi(test.store, test.users, test.accounts, test.transactions, test.generateId)
			if err == nil || application != nil {
				t.Fatalf("missing %s dependency was accepted: application=%v error=%v", test.name, application, err)
			}
		})
	}
}
