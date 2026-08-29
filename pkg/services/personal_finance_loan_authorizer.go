package services

import (
	"fmt"
	"time"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/errs"
	"github.com/gaohongxiang/catledger/pkg/models"
)

// PersonalFinanceLoanSettlementAuthorizer 复用用户存在、账户归属与可编辑时间规则，
// 但不继承仅适用于导入流程的 IMPORT_TRANSACTION 功能限制。
type PersonalFinanceLoanSettlementAuthorizer struct {
	users    personalFinancePostingUserReader
	accounts personalFinancePostingAccountReader
}

func NewPersonalFinanceLoanSettlementAuthorizer(users personalFinancePostingUserReader, accounts personalFinancePostingAccountReader) (*PersonalFinanceLoanSettlementAuthorizer, error) {
	if users == nil || accounts == nil {
		return nil, fmt.Errorf("loan settlement authorizer dependencies are required")
	}
	return &PersonalFinanceLoanSettlementAuthorizer{users: users, accounts: accounts}, nil
}

func (a *PersonalFinanceLoanSettlementAuthorizer) AuthorizeTransactionCreation(c core.Context, uid int64, clientTimezone *time.Location, transactions []*models.Transaction) error {
	if a == nil || a.users == nil || a.accounts == nil || uid < 1 || clientTimezone == nil {
		return errs.ErrParameterInvalid
	}
	user, err := a.users.GetUserById(c, uid)
	if err != nil || user == nil || user.Uid != uid {
		return errs.ErrUserNotFound
	}
	if len(transactions) == 0 {
		return nil
	}

	accountSet := make(map[int64]struct{}, len(transactions)*2)
	for _, transaction := range transactions {
		if transaction == nil || transaction.Uid != uid || transaction.AccountId < 1 {
			return errs.ErrParameterInvalid
		}
		accountSet[transaction.AccountId] = struct{}{}
		if transaction.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT {
			if transaction.RelatedAccountId < 1 {
				return errs.ErrDestinationAccountNotFound
			}
			accountSet[transaction.RelatedAccountId] = struct{}{}
		}
	}
	accountIds := make([]int64, 0, len(accountSet))
	for accountId := range accountSet {
		accountIds = append(accountIds, accountId)
	}
	accounts, err := a.accounts.GetAccountsByAccountIds(c, uid, accountIds)
	if err != nil {
		return err
	}
	for _, transaction := range transactions {
		source := accounts[transaction.AccountId]
		if source == nil || source.Uid != uid {
			return errs.ErrSourceAccountNotFound
		}
		var destination *models.Account
		if transaction.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT {
			destination = accounts[transaction.RelatedAccountId]
			if destination == nil || destination.Uid != uid {
				return errs.ErrDestinationAccountNotFound
			}
		}
		if !user.CanEditTransactionByTransactionTime(transaction.TransactionTime, clientTimezone, source, destination) {
			return errs.ErrCannotCreateTransactionWithThisTransactionTime
		}
	}
	return nil
}
