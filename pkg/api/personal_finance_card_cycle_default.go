package api

import (
	"errors"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/errs"
	"github.com/gaohongxiang/catledger/pkg/models"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/cardcycle"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/services"
	"github.com/gaohongxiang/catledger/pkg/uuid"
)

var PersonalFinanceCardCycle *PersonalFinanceCardCycleApi

func InitializePersonalFinanceCardCycleApi() error {
	store := datastore.Container.UserDataStore
	repository, err := cardcycle.NewRepository(store)
	if err != nil {
		return err
	}
	evidence, err := importing.NewRepository(store)
	if err != nil {
		return err
	}
	service, err := cardcycle.NewService(repository, evidence, &cardCycleAccountReader{accounts: services.Accounts}, func() int64 {
		return uuid.Container.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
	})
	if err != nil {
		return err
	}
	PersonalFinanceCardCycle, err = NewPersonalFinanceCardCycleApi(service)
	return err
}

type cardCycleAccountReader struct {
	accounts *services.AccountService
}

func (r *cardCycleAccountReader) ListCreditCardAccounts(c core.Context, uid int64) ([]cardcycle.AccountSnapshot, error) {
	if r == nil || r.accounts == nil {
		return nil, errors.New("card cycle account reader is unavailable")
	}
	accounts, err := r.accounts.GetAllAccountsByUid(c, uid)
	if err != nil {
		return nil, err
	}
	items := make([]cardcycle.AccountSnapshot, 0)
	for _, account := range accounts {
		snapshot := cardCycleAccountSnapshot(account)
		if snapshot == nil || !snapshot.CreditCard {
			continue
		}
		items = append(items, *snapshot)
	}
	return items, nil
}

func (r *cardCycleAccountReader) GetAccount(c core.Context, uid int64, accountId int64) (*cardcycle.AccountSnapshot, error) {
	if r == nil || r.accounts == nil {
		return nil, errors.New("card cycle account reader is unavailable")
	}
	account, err := r.accounts.GetAccountByAccountId(c, uid, accountId)
	if err != nil {
		if errors.Is(err, errs.ErrAccountNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return cardCycleAccountSnapshot(account), nil
}

func cardCycleAccountSnapshot(account *models.Account) *cardcycle.AccountSnapshot {
	if account == nil || account.AccountId < 1 || account.Name == "" {
		return nil
	}
	return &cardcycle.AccountSnapshot{
		AccountId: account.AccountId, DisplayName: account.Name, Currency: account.Currency,
		Hidden: account.Hidden, CreditCard: account.ParentAccountId == models.LevelOneAccountParentId &&
			account.Category == models.ACCOUNT_CATEGORY_CREDIT_CARD,
	}
}
