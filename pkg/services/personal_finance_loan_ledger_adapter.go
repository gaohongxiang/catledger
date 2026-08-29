package services

import (
	"fmt"
	"math"
	"sort"
	"time"

	"xorm.io/xorm"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/models"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/loans"
	"github.com/gaohongxiang/catledger/pkg/utils"
)

// PersonalFinanceLoanLedgerAdapter 把贷款域的窄 DTO 适配到现有核心账本。
// 它不保存贷款状态，也不提交或回滚调用方事务。
type PersonalFinanceLoanLedgerAdapter struct {
	transactions *TransactionService
	authorizer   *PersonalFinanceLoanSettlementAuthorizer
}

func NewPersonalFinanceLoanLedgerAdapter(transactions *TransactionService, authorizer *PersonalFinanceLoanSettlementAuthorizer) (*PersonalFinanceLoanLedgerAdapter, error) {
	if transactions == nil || authorizer == nil {
		return nil, fmt.Errorf("loan ledger adapter dependencies are required")
	}
	return &PersonalFinanceLoanLedgerAdapter{transactions: transactions, authorizer: authorizer}, nil
}

func (a *PersonalFinanceLoanLedgerAdapter) LoadAccountSnapshots(c core.Context, uid int64, accountIds []int64) ([]loans.AccountSnapshot, error) {
	if a == nil || a.transactions == nil || uid < 1 || !positiveUniqueLoanIds(accountIds) {
		return nil, fmt.Errorf("invalid loan account snapshot request")
	}
	database := a.transactions.UserDataDB(uid)
	if database == nil {
		return nil, fmt.Errorf("loan account database is unavailable")
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	accounts, err := loadLoanAccounts(sess, uid, accountIds)
	if err != nil {
		return nil, err
	}
	result := make([]loans.AccountSnapshot, 0, len(accounts))
	for _, accountId := range accountIds {
		if account := accounts[accountId]; account != nil {
			result = append(result, loanAccountSnapshot(account))
		}
	}
	return result, nil
}

func (a *PersonalFinanceLoanLedgerAdapter) ReadLiabilityOutstanding(c core.Context, uid int64, liabilityAccountId int64) (*int64, error) {
	if a == nil || a.transactions == nil || uid < 1 || liabilityAccountId < 1 {
		return nil, fmt.Errorf("invalid loan liability request")
	}
	database := a.transactions.UserDataDB(uid)
	if database == nil {
		return nil, fmt.Errorf("loan liability database is unavailable")
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	account := new(models.Account)
	found, err := sess.Where("uid=? AND account_id=?", uid, liabilityAccountId).Get(account)
	if err != nil {
		return nil, fmt.Errorf("load loan liability account: %w", err)
	}
	if !found || account.Deleted || !account.Category.IsLiability() || account.Balance == math.MinInt64 {
		return nil, fmt.Errorf("loan liability account is unavailable")
	}
	outstanding := int64(0)
	if account.Balance < 0 {
		outstanding = -account.Balance
	}
	return &outstanding, nil
}

func (a *PersonalFinanceLoanLedgerAdapter) AuthorizeSettlementCreation(c core.Context, uid int64, clientTimezone *time.Location, drafts []loans.LedgerCreateDraft) error {
	if a == nil || a.authorizer == nil || uid < 1 || clientTimezone == nil {
		return fmt.Errorf("invalid loan settlement authorization")
	}
	transactions := make([]*models.Transaction, 0, len(drafts))
	for _, draft := range drafts {
		transaction, err := loanLedgerModelDraft(draft)
		if err != nil || transaction.Uid != uid {
			return fmt.Errorf("invalid loan settlement draft")
		}
		transactions = append(transactions, transaction)
	}
	return a.authorizer.AuthorizeTransactionCreation(c, uid, clientTimezone, transactions)
}

func (a *PersonalFinanceLoanLedgerAdapter) ListSettlementCandidates(c core.Context, uid int64, filter loans.LedgerCandidateFilter) (*loans.LedgerCandidatePage, error) {
	if a == nil || a.transactions == nil || uid < 1 || !validLoanCandidateFilter(filter) {
		return nil, fmt.Errorf("invalid loan settlement candidate filter")
	}
	database := a.transactions.UserDataDB(uid)
	if database == nil {
		return nil, fmt.Errorf("loan candidate database is unavailable")
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	transactionType := models.TRANSACTION_DB_TYPE_EXPENSE
	if filter.Kind == loans.LEDGER_EVENT_KIND_TRANSFER {
		transactionType = models.TRANSACTION_DB_TYPE_TRANSFER_OUT
	}
	values := make([]*models.Transaction, 0, filter.Limit+1)
	categoryType := models.CATEGORY_TYPE_EXPENSE
	if filter.Kind == loans.LEDGER_EVENT_KIND_TRANSFER {
		categoryType = models.CATEGORY_TYPE_TRANSFER
	}
	query := sess.Table(new(models.Transaction)).Alias("t").Join("INNER", []any{new(models.TransactionCategory), "c"},
		"c.uid=t.uid AND c.category_id=t.category_id AND c.deleted=? AND c.type=?").
		Where("t.uid=? AND t.deleted=? AND t.type=? AND t.account_id=? AND t.amount>=? AND t.amount<=? AND t.transaction_time>=? AND t.transaction_time<=?",
			false, categoryType, uid, false, transactionType, filter.SourceAccountId, filter.MinimumAmount, filter.MaximumAmount,
			utils.GetMinTransactionTimeFromUnixTime(filter.MinimumUnixTime), utils.GetMaxTransactionTimeFromUnixTime(filter.MaximumUnixTime))
	if filter.Kind == loans.LEDGER_EVENT_KIND_TRANSFER && filter.DestinationAccountId > 0 {
		query = query.And("t.related_account_id=?", filter.DestinationAccountId)
	}
	if filter.Kind == loans.LEDGER_EVENT_KIND_TRANSFER {
		query = query.And("t.related_account_amount=t.amount")
	}
	if err := query.Desc("t.transaction_time", "t.transaction_id").Limit(filter.Limit + 1).Find(&values); err != nil {
		return nil, fmt.Errorf("list loan settlement candidates: %w", err)
	}
	limitReached := len(values) > filter.Limit
	if limitReached {
		values = values[:filter.Limit]
	}
	result := make([]*loans.LedgerEventSnapshot, 0, len(values))
	for _, value := range values {
		snapshot, err := loadLoanLedgerEvent(sess, uid, value.TransactionId)
		if err != nil {
			return nil, err
		}
		if snapshot != nil {
			result = append(result, snapshot)
		}
	}
	return &loans.LedgerCandidatePage{Items: result, LimitReached: limitReached}, nil
}

func (a *PersonalFinanceLoanLedgerAdapter) LoadSettlementEvents(c core.Context, uid int64, transactionIds []int64) (map[int64]*loans.LedgerEventSnapshot, error) {
	if a == nil || a.transactions == nil || uid < 1 || !positiveUniqueLoanIds(transactionIds) {
		return nil, fmt.Errorf("invalid loan settlement event lookup")
	}
	database := a.transactions.UserDataDB(uid)
	if database == nil {
		return nil, fmt.Errorf("loan event database is unavailable")
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return loadLoanLedgerEvents(sess, uid, transactionIds)
}

func (a *PersonalFinanceLoanLedgerAdapter) LoadSettlementEventsInSession(c core.Context, database *datastore.Database, sess *xorm.Session, uid int64, transactionIds []int64) (map[int64]*loans.LedgerEventSnapshot, error) {
	if a == nil || a.transactions == nil || uid < 1 || database == nil || database != a.transactions.UserDataDB(uid) ||
		database.ValidateTransactionSession(sess) != nil || !positiveUniqueLoanIds(transactionIds) {
		return nil, fmt.Errorf("invalid caller-owned loan event lookup")
	}
	return loadLoanLedgerEvents(sess, uid, transactionIds)
}

func (a *PersonalFinanceLoanLedgerAdapter) ValidateSettlementDraftInSession(_ core.Context, database *datastore.Database, sess *xorm.Session, draft loans.LedgerCreateDraft) (*loans.LedgerEventSnapshot, error) {
	if a == nil || a.transactions == nil || database == nil || database != a.transactions.UserDataDB(draft.Uid) ||
		database.ValidateTransactionSession(sess) != nil {
		return nil, fmt.Errorf("invalid caller-owned loan draft validation")
	}
	if _, err := loanLedgerModelDraft(draft); err != nil {
		return nil, err
	}
	accountIds := []int64{draft.SourceAccountId}
	if draft.DestinationAccountId > 0 {
		accountIds = append(accountIds, draft.DestinationAccountId)
	}
	accounts, err := loadLoanAccounts(sess, draft.Uid, accountIds)
	if err != nil {
		return nil, err
	}
	category, categoryUnavailable, err := loadLoanCategoryState(sess, draft.Uid, draft.CategoryId)
	if err != nil {
		return nil, err
	}
	snapshot := &loans.LedgerEventSnapshot{Kind: draft.Kind, CategoryId: draft.CategoryId, Amount: draft.Amount,
		SourceAccount:   loanAccountSnapshot(accounts[draft.SourceAccountId]),
		CategoryDeleted: categoryUnavailable}
	if draft.Kind == loans.LEDGER_EVENT_KIND_TRANSFER {
		snapshot.CategoryKind = loans.LEDGER_CATEGORY_KIND_TRANSFER
		destination := loanAccountSnapshot(accounts[draft.DestinationAccountId])
		snapshot.DestinationAccount = &destination
		counterpartId := int64(1)
		counterpartUpdated := int64(1)
		snapshot.CounterpartTransactionId = &counterpartId
		snapshot.CounterpartUpdatedUnixTime = &counterpartUpdated
		snapshot.TransferComplete = true
	} else {
		snapshot.CategoryKind = loans.LEDGER_CATEGORY_KIND_EXPENSE
	}
	if category != nil {
		if category.Type == models.CATEGORY_TYPE_TRANSFER {
			snapshot.CategoryKind = loans.LEDGER_CATEGORY_KIND_TRANSFER
		} else if category.Type == models.CATEGORY_TYPE_EXPENSE {
			snapshot.CategoryKind = loans.LEDGER_CATEGORY_KIND_EXPENSE
		} else {
			snapshot.CategoryKind = ""
		}
	}
	return snapshot, nil
}

func (a *PersonalFinanceLoanLedgerAdapter) CreateSettlementEventInSession(c core.Context, database *datastore.Database, sess *xorm.Session, draft loans.LedgerCreateDraft) (*loans.LedgerEventSnapshot, error) {
	if a == nil || a.transactions == nil || database == nil || database != a.transactions.UserDataDB(draft.Uid) || database.ValidateTransactionSession(sess) != nil {
		return nil, fmt.Errorf("invalid caller-owned loan event creation")
	}
	transaction, err := loanLedgerModelDraft(draft)
	if err != nil {
		return nil, err
	}
	primary, counterpart, err := a.transactions.CreateTransactionInSession(c, database, sess, transaction, nil)
	if err != nil {
		return nil, fmt.Errorf("create loan ledger event: %w", err)
	}
	if primary == nil || (draft.Kind == loans.LEDGER_EVENT_KIND_TRANSFER && counterpart == nil) {
		return nil, fmt.Errorf("created loan ledger event is incomplete")
	}
	return loadLoanLedgerEvent(sess, draft.Uid, primary.TransactionId)
}

func loadLoanLedgerEvents(sess *xorm.Session, uid int64, transactionIds []int64) (map[int64]*loans.LedgerEventSnapshot, error) {
	result := make(map[int64]*loans.LedgerEventSnapshot, len(transactionIds))
	for _, transactionId := range transactionIds {
		snapshot, err := loadLoanLedgerEvent(sess, uid, transactionId)
		if err != nil {
			return nil, err
		}
		if snapshot != nil {
			result[transactionId] = snapshot
		}
	}
	return result, nil
}

func loadLoanLedgerEvent(sess *xorm.Session, uid int64, transactionId int64) (*loans.LedgerEventSnapshot, error) {
	row := new(models.Transaction)
	found, err := sess.Where("uid=? AND transaction_id=?", uid, transactionId).Get(row)
	if err != nil {
		return nil, fmt.Errorf("load loan ledger event: %w", err)
	}
	if !found {
		return nil, nil
	}
	primary := row
	var counterpart *models.Transaction
	if row.Type == models.TRANSACTION_DB_TYPE_TRANSFER_IN || row.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT {
		counterpart = new(models.Transaction)
		found, err = sess.Where("uid=? AND transaction_id=?", uid, row.RelatedId).Get(counterpart)
		if err != nil {
			return nil, fmt.Errorf("load loan ledger transfer counterpart: %w", err)
		}
		if row.Type == models.TRANSACTION_DB_TYPE_TRANSFER_IN {
			primary, counterpart = counterpart, row
		}
		if !found {
			counterpart = nil
		}
	}
	accountIds := []int64{primary.AccountId}
	if primary.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT {
		accountIds = append(accountIds, primary.RelatedAccountId)
	}
	accounts, err := loadLoanAccounts(sess, uid, accountIds)
	if err != nil {
		return nil, err
	}
	category, categoryUnavailable, err := loadLoanCategoryState(sess, uid, primary.CategoryId)
	if err != nil {
		return nil, err
	}
	snapshot := &loans.LedgerEventSnapshot{
		PrimaryTransactionId: primary.TransactionId, CategoryId: primary.CategoryId, Amount: primary.Amount,
		TransactionUnixTime: utils.GetUnixTimeFromTransactionTime(primary.TransactionTime), Deleted: primary.Deleted,
		UpdatedUnixTime: primary.UpdatedUnixTime, CategoryDeleted: categoryUnavailable,
	}
	if source := accounts[primary.AccountId]; source != nil {
		snapshot.SourceAccount = loanAccountSnapshot(source)
	}
	if category != nil {
		switch category.Type {
		case models.CATEGORY_TYPE_TRANSFER:
			snapshot.CategoryKind = loans.LEDGER_CATEGORY_KIND_TRANSFER
		case models.CATEGORY_TYPE_EXPENSE:
			snapshot.CategoryKind = loans.LEDGER_CATEGORY_KIND_EXPENSE
		}
	}
	if primary.Type == models.TRANSACTION_DB_TYPE_EXPENSE {
		snapshot.Kind = loans.LEDGER_EVENT_KIND_EXPENSE
		return snapshot, nil
	}
	if primary.Type != models.TRANSACTION_DB_TYPE_TRANSFER_OUT {
		return snapshot, nil
	}
	snapshot.Kind = loans.LEDGER_EVENT_KIND_TRANSFER
	if destination := accounts[primary.RelatedAccountId]; destination != nil {
		value := loanAccountSnapshot(destination)
		snapshot.DestinationAccount = &value
	}
	if counterpart != nil {
		counterpartId := counterpart.TransactionId
		counterpartUpdated := counterpart.UpdatedUnixTime
		snapshot.CounterpartTransactionId = &counterpartId
		snapshot.CounterpartUpdatedUnixTime = &counterpartUpdated
		snapshot.CounterpartDeleted = counterpart.Deleted
		snapshot.TransferComplete = completeLoanTransfer(primary, counterpart)
	}
	return snapshot, nil
}

func completeLoanTransfer(out *models.Transaction, in *models.Transaction) bool {
	return out != nil && in != nil && out.Uid == in.Uid && out.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT &&
		in.Type == models.TRANSACTION_DB_TYPE_TRANSFER_IN && !out.Deleted && !in.Deleted && out.RelatedId == in.TransactionId && in.RelatedId == out.TransactionId &&
		out.AccountId == in.RelatedAccountId && out.RelatedAccountId == in.AccountId && out.Amount == in.RelatedAccountAmount &&
		out.RelatedAccountAmount == in.Amount && out.Amount == out.RelatedAccountAmount && out.CategoryId == in.CategoryId && out.TimezoneUtcOffset == in.TimezoneUtcOffset &&
		out.TransactionTime+1 == in.TransactionTime
}

func loadLoanAccounts(sess *xorm.Session, uid int64, accountIds []int64) (map[int64]*models.Account, error) {
	result := make(map[int64]*models.Account, len(accountIds))
	if len(accountIds) == 0 {
		return result, nil
	}
	values := make([]*models.Account, 0, len(accountIds))
	if err := sess.Where("uid=?", uid).In("account_id", accountIds).Find(&values); err != nil {
		return nil, fmt.Errorf("load loan ledger accounts: %w", err)
	}
	for _, value := range values {
		result[value.AccountId] = value
	}
	return result, nil
}

func loadLoanCategoryState(sess *xorm.Session, uid int64, categoryId int64) (*models.TransactionCategory, bool, error) {
	category := new(models.TransactionCategory)
	found, err := sess.Where("uid=? AND category_id=?", uid, categoryId).Get(category)
	if err != nil {
		return nil, false, fmt.Errorf("load loan ledger category: %w", err)
	}
	if !found {
		return nil, true, nil
	}
	if category.Deleted || category.Hidden || category.ParentCategoryId == models.LevelOneTransactionCategoryParentId {
		return category, true, nil
	}
	parent := new(models.TransactionCategory)
	parentFound, err := sess.Where("uid=? AND category_id=?", uid, category.ParentCategoryId).Get(parent)
	if err != nil {
		return nil, false, fmt.Errorf("load loan ledger parent category: %w", err)
	}
	return category, !parentFound || parent.Deleted || parent.Hidden, nil
}

func loanAccountSnapshot(account *models.Account) loans.AccountSnapshot {
	kind := loans.AccountKind("")
	if account != nil {
		switch {
		case account.Category.IsAsset():
			kind = loans.ACCOUNT_KIND_ASSET
		case account.Category == models.ACCOUNT_CATEGORY_CREDIT_CARD:
			kind = loans.ACCOUNT_KIND_CREDIT_CARD
		case account.Category == models.ACCOUNT_CATEGORY_DEBT:
			kind = loans.ACCOUNT_KIND_DEBT
		}
	}
	if account == nil {
		return loans.AccountSnapshot{}
	}
	return loans.AccountSnapshot{AccountId: account.AccountId, Uid: account.Uid, Deleted: account.Deleted, Kind: kind,
		Single: account.Type == models.ACCOUNT_TYPE_SINGLE_ACCOUNT, Hidden: account.Hidden, Currency: account.Currency}
}

func loanLedgerModelDraft(draft loans.LedgerCreateDraft) (*models.Transaction, error) {
	if draft.Uid < 1 || draft.CategoryId < 1 || draft.UnixTime < 1 || draft.SourceAccountId < 1 || draft.Amount <= 0 ||
		draft.TimezoneUtcOffset < -720 || draft.TimezoneUtcOffset > 840 {
		return nil, fmt.Errorf("invalid loan ledger draft")
	}
	transactionType := models.TRANSACTION_DB_TYPE_EXPENSE
	if draft.Kind == loans.LEDGER_EVENT_KIND_TRANSFER {
		if draft.DestinationAccountId < 1 || draft.DestinationAccountId == draft.SourceAccountId {
			return nil, fmt.Errorf("invalid loan transfer draft")
		}
		transactionType = models.TRANSACTION_DB_TYPE_TRANSFER_OUT
	} else if draft.Kind != loans.LEDGER_EVENT_KIND_EXPENSE || draft.DestinationAccountId != 0 {
		return nil, fmt.Errorf("invalid loan expense draft")
	}
	return &models.Transaction{Uid: draft.Uid, Type: transactionType, CategoryId: draft.CategoryId, AccountId: draft.SourceAccountId,
		RelatedAccountId: draft.DestinationAccountId, TransactionTime: utils.GetMinTransactionTimeFromUnixTime(draft.UnixTime),
		TimezoneUtcOffset: draft.TimezoneUtcOffset, Amount: draft.Amount, RelatedAccountAmount: func() int64 {
			if transactionType == models.TRANSACTION_DB_TYPE_TRANSFER_OUT {
				return draft.Amount
			}
			return 0
		}(), HideAmount: false, Comment: "", CreatedIp: draft.CreatedIp}, nil
}

func validLoanCandidateFilter(filter loans.LedgerCandidateFilter) bool {
	if (filter.Kind != loans.LEDGER_EVENT_KIND_TRANSFER && filter.Kind != loans.LEDGER_EVENT_KIND_EXPENSE) ||
		filter.SourceAccountId < 1 || filter.MinimumAmount < 1 || filter.MaximumAmount < filter.MinimumAmount || filter.MinimumUnixTime < 1 ||
		filter.MaximumUnixTime < filter.MinimumUnixTime || filter.MaximumUnixTime-filter.MinimumUnixTime > 91*24*60*60 ||
		filter.Limit < 1 || filter.Limit > 50 {
		return false
	}
	return (filter.Kind == loans.LEDGER_EVENT_KIND_TRANSFER && filter.DestinationAccountId >= 0) ||
		(filter.Kind == loans.LEDGER_EVENT_KIND_EXPENSE && filter.DestinationAccountId == 0)
}

func positiveUniqueLoanIds(values []int64) bool {
	copyValues := append([]int64(nil), values...)
	sort.Slice(copyValues, func(i, j int) bool { return copyValues[i] < copyValues[j] })
	for index, value := range copyValues {
		if value < 1 || (index > 0 && value == copyValues[index-1]) {
			return false
		}
	}
	return true
}

var _ loans.SettlementLedgerGateway = (*PersonalFinanceLoanLedgerAdapter)(nil)
