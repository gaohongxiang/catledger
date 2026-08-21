package api

import (
	"errors"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/billflow"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/cardcycle"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/installments"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/organizer"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/reconciliation"
	"github.com/mayswind/ezbookkeeping/pkg/services"
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
		billflow.UserDataModule(),
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
