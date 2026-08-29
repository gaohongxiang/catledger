package api

import (
	"errors"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/cardcycle"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/installments"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/legacydata"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/loans"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/organizer"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/reconciliation"
	"github.com/gaohongxiang/catledger/pkg/services"
)

// RegisterPersonalFinanceUserDataHooks 按模块登记 PF 用户表清理/计数钩子。
func RegisterPersonalFinanceUserDataHooks() error {
	if datastore.Container == nil || datastore.Container.UserDataStore == nil {
		return errors.New("user data store is required to register personal finance hooks")
	}
	return registerPersonalFinanceUserDataHooks(datastore.Container.UserDataStore, services.PersonalFinanceImportFilesStorage)
}

func registerPersonalFinanceUserDataHooks(store *datastore.DataStore, storage importing.ImportFileStorage) error {
	if store == nil || storage == nil {
		return errors.New("personal finance user data hook dependencies are required")
	}
	runner, err := datastore.NewUserDataStore(store)
	if err != nil {
		return err
	}
	core.SetUserDataStore(runner)

	repository, err := importing.NewRepository(store)
	if err != nil {
		return err
	}
	lifecycle, err := importing.NewLifecycleService(repository, storage, nil)
	if err != nil {
		return err
	}

	modules := []core.UserDataModule{
		organizer.UserDataModule(),
		legacydata.BillflowUserDataModule(),
		installments.UserDataModule(),
		cardcycle.UserDataModule(),
		loans.UserDataModule(),
		reconciliation.UserDataModule(),
		importing.UserDataModule(lifecycle.DeleteRegisteredObjects),
	}
	for _, module := range modules {
		if err := core.RegisterUserDataModule(module); err != nil {
			return err
		}
	}
	return nil
}
