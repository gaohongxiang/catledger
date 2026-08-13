package services

import (
	"fmt"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/dashboard"
)

// PersonalFinanceDashboardLedgerAdapter 通过 caller uid 所在分片的 privacy session
// 读取总览所需的最小核心账本事实，核心账本不依赖 PF 模型。
type PersonalFinanceDashboardLedgerAdapter struct {
	store *datastore.DataStore
}

func NewPersonalFinanceDashboardLedgerAdapter(store *datastore.DataStore) (*PersonalFinanceDashboardLedgerAdapter, error) {
	if store == nil || store.Count() < 1 {
		return nil, fmt.Errorf("personal finance dashboard ledger adapter requires a user data store")
	}
	return &PersonalFinanceDashboardLedgerAdapter{store: store}, nil
}

func (a *PersonalFinanceDashboardLedgerAdapter) ReadLedgerData(c core.Context, uid int64, minimumTransactionTime int64, maximumTransactions int) (*dashboard.LedgerData, error) {
	if a == nil || a.store == nil || uid < 1 || minimumTransactionTime < 1 || maximumTransactions < 1 {
		return nil, dashboard.ErrInvalidQuery
	}
	database := a.store.Choose(uid)
	accountSession := database.NewPrivacySession(c)
	accounts := make([]*models.Account, 0)
	err := accountSession.Where("uid=? AND deleted=?", uid, false).
		Asc("parent_account_id", "display_order", "account_id").Find(&accounts)
	accountSession.Close()
	if err != nil {
		return nil, fmt.Errorf("read dashboard ledger accounts: %w", err)
	}

	transactionSession := database.NewPrivacySession(c)
	transactions := make([]*models.Transaction, 0, maximumTransactions+1)
	err = transactionSession.Where("uid=? AND deleted=? AND transaction_time>=?", uid, false, minimumTransactionTime).
		Asc("transaction_time", "transaction_id").Limit(maximumTransactions + 1).Find(&transactions)
	transactionSession.Close()
	if err != nil {
		return nil, fmt.Errorf("read dashboard ledger transactions: %w", err)
	}
	if len(transactions) > maximumTransactions {
		return nil, dashboard.ErrReadLimitReached
	}

	result := &dashboard.LedgerData{
		Accounts:     make([]*dashboard.LedgerAccount, 0, len(accounts)),
		Transactions: make([]*dashboard.LedgerTransaction, 0, len(transactions)),
	}
	for _, account := range accounts {
		kind, mapErr := dashboardLedgerAccountKind(account.Category)
		if mapErr != nil {
			return nil, mapErr
		}
		result.Accounts = append(result.Accounts, &dashboard.LedgerAccount{
			AccountId: account.AccountId, Kind: kind, Currency: account.Currency,
			CurrentBalance: account.Balance, Liquid: dashboardLedgerAccountIsLiquid(account.Category),
			Hidden: account.Hidden, Single: account.Type == models.ACCOUNT_TYPE_SINGLE_ACCOUNT,
		})
	}
	for _, transaction := range transactions {
		transactionType, mapErr := dashboardLedgerTransactionType(transaction.Type)
		if mapErr != nil {
			return nil, mapErr
		}
		result.Transactions = append(result.Transactions, &dashboard.LedgerTransaction{
			TransactionId: transaction.TransactionId, Type: transactionType, AccountId: transaction.AccountId,
			TransactionTime: transaction.TransactionTime, Amount: transaction.Amount,
			Adjustment: transaction.RelatedAccountAmount,
		})
	}
	return result, nil
}

func dashboardLedgerAccountKind(category models.AccountCategory) (dashboard.LedgerAccountKind, error) {
	if category.IsAsset() {
		return dashboard.LedgerAccountKindAsset, nil
	}
	if category == models.ACCOUNT_CATEGORY_CREDIT_CARD {
		return dashboard.LedgerAccountKindCreditCard, nil
	}
	if category == models.ACCOUNT_CATEGORY_DEBT {
		return dashboard.LedgerAccountKindDebt, nil
	}
	return "", dashboard.ErrInvariantViolation
}

func dashboardLedgerAccountIsLiquid(category models.AccountCategory) bool {
	return category == models.ACCOUNT_CATEGORY_CASH ||
		category == models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT ||
		category == models.ACCOUNT_CATEGORY_VIRTUAL ||
		category == models.ACCOUNT_CATEGORY_SAVINGS_ACCOUNT
}

func dashboardLedgerTransactionType(value models.TransactionDbType) (dashboard.LedgerTransactionType, error) {
	switch value {
	case models.TRANSACTION_DB_TYPE_MODIFY_BALANCE:
		return dashboard.LedgerTransactionModifyBalance, nil
	case models.TRANSACTION_DB_TYPE_INCOME:
		return dashboard.LedgerTransactionIncome, nil
	case models.TRANSACTION_DB_TYPE_EXPENSE:
		return dashboard.LedgerTransactionExpense, nil
	case models.TRANSACTION_DB_TYPE_TRANSFER_OUT:
		return dashboard.LedgerTransactionTransferOut, nil
	case models.TRANSACTION_DB_TYPE_TRANSFER_IN:
		return dashboard.LedgerTransactionTransferIn, nil
	default:
		return "", dashboard.ErrInvariantViolation
	}
}

var _ dashboard.LedgerReader = (*PersonalFinanceDashboardLedgerAdapter)(nil)
