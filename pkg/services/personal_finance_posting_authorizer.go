package services

import (
	"time"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/errs"
	"github.com/gaohongxiang/catledger/pkg/models"
)

type personalFinancePostingUserReader interface {
	GetUserById(c core.Context, uid int64) (*models.User, error)
}

type personalFinancePostingAccountReader interface {
	GetAccountsByAccountIds(c core.Context, uid int64, accountIds []int64) (map[int64]*models.Account, error)
}

// PersonalFinancePostingAuthorizer 在账本事务前复用现有用户限制与交易时间范围规则。
type PersonalFinancePostingAuthorizer struct {
	users    personalFinancePostingUserReader
	accounts personalFinancePostingAccountReader
}

// PersonalFinancePostingAuthorization 是个人财务确认入账使用的权限适配器。
var PersonalFinancePostingAuthorization = &PersonalFinancePostingAuthorizer{
	users:    Users,
	accounts: Accounts,
}

// AuthorizeTransactionCreation 校验用户、导入权限、账户归属和可编辑时间范围。
func (a *PersonalFinancePostingAuthorizer) AuthorizeTransactionCreation(c core.Context, uid int64, clientTimezone *time.Location, transactions []*models.Transaction) error {
	if a == nil || a.users == nil || a.accounts == nil || uid < 1 || clientTimezone == nil {
		return errs.ErrParameterInvalid
	}

	user, err := a.users.GetUserById(c, uid)

	if err != nil || user == nil || user.Uid != uid {
		return errs.ErrUserNotFound
	}

	if user.FeatureRestriction.Contains(core.USER_FEATURE_RESTRICTION_TYPE_IMPORT_TRANSACTION) {
		return errs.ErrNotPermittedToPerformThisAction
	}

	if len(transactions) < 1 {
		return nil
	}

	accountIdSet := make(map[int64]struct{}, len(transactions)*2)

	for _, transaction := range transactions {
		if transaction == nil || transaction.Uid != uid || transaction.AccountId < 1 {
			return errs.ErrParameterInvalid
		}

		accountIdSet[transaction.AccountId] = struct{}{}

		if transaction.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT {
			if transaction.RelatedAccountId < 1 {
				return errs.ErrDestinationAccountNotFound
			}

			accountIdSet[transaction.RelatedAccountId] = struct{}{}
		}
	}

	accountIds := make([]int64, 0, len(accountIdSet))

	for accountId := range accountIdSet {
		accountIds = append(accountIds, accountId)
	}

	accounts, err := a.accounts.GetAccountsByAccountIds(c, uid, accountIds)

	if err != nil {
		return err
	}

	for _, transaction := range transactions {
		sourceAccount := accounts[transaction.AccountId]

		if sourceAccount == nil {
			return errs.ErrSourceAccountNotFound
		}

		var destinationAccount *models.Account

		if transaction.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT {
			destinationAccount = accounts[transaction.RelatedAccountId]

			if destinationAccount == nil {
				return errs.ErrDestinationAccountNotFound
			}
		}

		if !user.CanEditTransactionByTransactionTime(transaction.TransactionTime, clientTimezone, sourceAccount, destinationAccount) {
			return errs.ErrCannotCreateTransactionWithThisTransactionTime
		}
	}

	return nil
}
