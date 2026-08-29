package services

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"xorm.io/xorm"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/models"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/loans"
	"github.com/gaohongxiang/catledger/pkg/settings"
	"github.com/gaohongxiang/catledger/pkg/uuid"
)

type loanSettlementUserReaderStub struct {
	user *models.User
}

func (s *loanSettlementUserReaderStub) GetUserById(_ core.Context, uid int64) (*models.User, error) {
	if s == nil || s.user == nil || s.user.Uid != uid {
		return nil, nil
	}
	return s.user, nil
}

type loanSettlementAccountReaderStub struct {
	accounts map[int64]*models.Account
}

func (s *loanSettlementAccountReaderStub) GetAccountsByAccountIds(_ core.Context, uid int64, accountIds []int64) (map[int64]*models.Account, error) {
	result := make(map[int64]*models.Account, len(accountIds))
	for _, accountId := range accountIds {
		if account := s.accounts[accountId]; account != nil && account.Uid == uid {
			result[accountId] = account
		}
	}
	return result, nil
}

func TestPersonalFinanceLoanLedgerAdapterPostsPrincipalAndUpfrontFee(t *testing.T) {
	database, err := datastore.OpenDatabase(&settings.DatabaseConfig{
		DatabaseType:          settings.Sqlite3DbType,
		DatabasePath:          filepath.Join(t.TempDir(), "loan-ledger-adapter.db"),
		MaxIdleConnection:     1,
		MaxOpenConnection:     1,
		ConnectionMaxLifeTime: 60,
	})
	if err != nil {
		t.Fatalf("open loan ledger adapter database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err = database.SyncStructs(new(models.Account), new(models.Transaction), new(models.TransactionCategory)); err != nil {
		t.Fatalf("create loan ledger adapter schema: %v", err)
	}
	store, err := datastore.NewDataStore(database)
	if err != nil {
		t.Fatalf("create loan ledger adapter store: %v", err)
	}
	if err = uuid.InitializeUuidGenerator(&settings.Config{UuidGeneratorType: settings.InternalUuidGeneratorType}); err != nil {
		t.Fatalf("initialize loan ledger UUID generator: %v", err)
	}
	transactions := &TransactionService{
		ServiceUsingDB:   ServiceUsingDB{container: &datastore.DataStoreContainer{UserDataStore: store}},
		ServiceUsingUuid: ServiceUsingUuid{container: uuid.Container},
	}
	const uid = int64(1001)
	accounts := insertLoanSettlementLedgerFixtures(t, database, uid)
	user := &models.User{Uid: uid, TransactionEditScope: models.TRANSACTION_EDIT_SCOPE_ALL,
		FeatureRestriction: core.UserFeatureRestrictions(0).Add(core.USER_FEATURE_RESTRICTION_TYPE_IMPORT_TRANSACTION)}
	authorizer, err := NewPersonalFinanceLoanSettlementAuthorizer(&loanSettlementUserReaderStub{user: user},
		&loanSettlementAccountReaderStub{accounts: accounts})
	if err != nil {
		t.Fatalf("create loan settlement authorizer: %v", err)
	}
	adapter, err := NewPersonalFinanceLoanLedgerAdapter(transactions, authorizer)
	if err != nil {
		t.Fatalf("create loan ledger adapter: %v", err)
	}

	const principal = int64(100_000)
	const upfrontFee = int64(1_000)
	transactionUnixTime := time.Now().Unix()
	drafts := []loans.LedgerCreateDraft{
		{Uid: uid, Kind: loans.LEDGER_EVENT_KIND_TRANSFER, CategoryId: 32, UnixTime: transactionUnixTime,
			SourceAccountId: 11, DestinationAccountId: 12, Amount: principal, CreatedIp: "192.0.2.20"},
		{Uid: uid, Kind: loans.LEDGER_EVENT_KIND_EXPENSE, CategoryId: 42, UnixTime: transactionUnixTime,
			SourceAccountId: 12, Amount: upfrontFee, CreatedIp: "192.0.2.20"},
	}
	if err = adapter.AuthorizeSettlementCreation(nil, uid, time.UTC, drafts); err != nil {
		t.Fatalf("loan posting inherited the import-only restriction: %v", err)
	}

	created := make([]*loans.LedgerEventSnapshot, 0, len(drafts))
	err = database.DoPrivacyTransaction(nil, func(sess *xorm.Session) error {
		for index, draft := range drafts {
			validated, validateErr := adapter.ValidateSettlementDraftInSession(nil, database, sess, draft)
			if validateErr != nil {
				return validateErr
			}
			expectedKind := loans.LEDGER_CATEGORY_KIND_EXPENSE
			if index == 0 {
				expectedKind = loans.LEDGER_CATEGORY_KIND_TRANSFER
			}
			if validated == nil || validated.Amount != draft.Amount || validated.CategoryId != draft.CategoryId ||
				validated.CategoryKind != expectedKind || validated.CategoryDeleted {
				return errors.New("validated loan ledger draft semantics mismatch")
			}
			event, createErr := adapter.CreateSettlementEventInSession(nil, database, sess, draft)
			if createErr != nil {
				return createErr
			}
			created = append(created, event)
		}
		return nil
	})
	if err != nil || len(created) != 2 {
		t.Fatalf("post principal and upfront fee in caller transaction: %+v %v", created, err)
	}
	if created[0] == nil || created[0].Kind != loans.LEDGER_EVENT_KIND_TRANSFER || created[0].Amount != principal ||
		!created[0].TransferComplete || created[0].CounterpartTransactionId == nil || created[0].CounterpartUpdatedUnixTime == nil ||
		created[1] == nil || created[1].Kind != loans.LEDGER_EVENT_KIND_EXPENSE || created[1].Amount != upfrontFee ||
		created[1].CounterpartTransactionId != nil || created[1].CounterpartUpdatedUnixTime != nil {
		t.Fatalf("created principal/upfront formal events mismatch: %+v", created)
	}
	assertLoanSettlementLedgerState(t, database, uid, 3, -principal, principal-upfrontFee)

	outstanding, err := adapter.ReadLiabilityOutstanding(nil, uid, 11)
	if err != nil || outstanding == nil || *outstanding != principal {
		t.Fatalf("read liability outstanding after disbursement: %v %v", outstanding, err)
	}
	transferCandidates, err := adapter.ListSettlementCandidates(nil, uid, loans.LedgerCandidateFilter{
		Kind: loans.LEDGER_EVENT_KIND_TRANSFER, SourceAccountId: 11, DestinationAccountId: 12,
		MinimumAmount: 1, MaximumAmount: principal, MinimumUnixTime: transactionUnixTime - 60,
		MaximumUnixTime: transactionUnixTime + 60, Limit: 10,
	})
	if err != nil || transferCandidates == nil || transferCandidates.LimitReached || len(transferCandidates.Items) != 1 ||
		transferCandidates.Items[0].PrimaryTransactionId != created[0].PrimaryTransactionId {
		t.Fatalf("list principal transfer candidate: %+v %v", transferCandidates, err)
	}
	expenseCandidates, err := adapter.ListSettlementCandidates(nil, uid, loans.LedgerCandidateFilter{
		Kind: loans.LEDGER_EVENT_KIND_EXPENSE, SourceAccountId: 12, MinimumAmount: 1, MaximumAmount: upfrontFee,
		MinimumUnixTime: transactionUnixTime - 60, MaximumUnixTime: transactionUnixTime + 60, Limit: 10,
	})
	if err != nil || expenseCandidates == nil || expenseCandidates.LimitReached || len(expenseCandidates.Items) != 1 ||
		expenseCandidates.Items[0].PrimaryTransactionId != created[1].PrimaryTransactionId {
		t.Fatalf("list upfront expense candidate: %+v %v", expenseCandidates, err)
	}
	tooSmall, err := adapter.ListSettlementCandidates(nil, uid, loans.LedgerCandidateFilter{
		Kind: loans.LEDGER_EVENT_KIND_TRANSFER, SourceAccountId: 11, DestinationAccountId: 12,
		MinimumAmount: 1, MaximumAmount: principal - 1, MinimumUnixTime: transactionUnixTime - 60,
		MaximumUnixTime: transactionUnixTime + 60, Limit: 10,
	})
	if err != nil || tooSmall == nil || len(tooSmall.Items) != 0 {
		t.Fatalf("candidate maximum amount was not enforced: %+v %v", tooSmall, err)
	}

	rollback := errors.New("rollback loan ledger draft")
	err = database.DoPrivacyTransaction(nil, func(sess *xorm.Session) error {
		if _, createErr := adapter.CreateSettlementEventInSession(nil, database, sess, loans.LedgerCreateDraft{
			Uid: uid, Kind: loans.LEDGER_EVENT_KIND_EXPENSE, CategoryId: 42, UnixTime: transactionUnixTime,
			SourceAccountId: 12, Amount: 500,
		}); createErr != nil {
			return createErr
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatalf("caller-owned rollback was not preserved: %v", err)
	}
	assertLoanSettlementLedgerState(t, database, uid, 3, -principal, principal-upfrontFee)

	sess := database.NewPrivacySession(nil)
	updated, updateErr := sess.Cols("balance").Where("uid=? AND account_id=?", uid, 11).Update(&models.Account{Balance: 250})
	sess.Close()
	if updateErr != nil || updated != 1 {
		t.Fatalf("set overpaid liability fixture: updated=%d err=%v", updated, updateErr)
	}
	outstanding, err = adapter.ReadLiabilityOutstanding(nil, uid, 11)
	if err != nil || outstanding == nil || *outstanding != 0 {
		t.Fatalf("positive liability balance was not clamped to zero: %v %v", outstanding, err)
	}
}

func TestCompleteLoanTransferRequiresEqualAmounts(t *testing.T) {
	out := &models.Transaction{Uid: 1001, Type: models.TRANSACTION_DB_TYPE_TRANSFER_OUT, TransactionId: 11, RelatedId: 12,
		AccountId: 21, RelatedAccountId: 22, Amount: 100, RelatedAccountAmount: 90, CategoryId: 31,
		TransactionTime: 1_700_000_000, TimezoneUtcOffset: 480}
	in := &models.Transaction{Uid: 1001, Type: models.TRANSACTION_DB_TYPE_TRANSFER_IN, TransactionId: 12, RelatedId: 11,
		AccountId: 22, RelatedAccountId: 21, Amount: 90, RelatedAccountAmount: 100, CategoryId: 31,
		TransactionTime: 1_700_000_001, TimezoneUtcOffset: 480}
	if completeLoanTransfer(out, in) {
		t.Fatal("unequal transfer sides were accepted as a full loan component")
	}
	out.RelatedAccountAmount = out.Amount
	in.Amount = out.Amount
	if !completeLoanTransfer(out, in) {
		t.Fatal("complete equal-amount transfer was rejected")
	}
}

func insertLoanSettlementLedgerFixtures(t *testing.T, database *datastore.Database, uid int64) map[int64]*models.Account {
	t.Helper()
	now := time.Now().Unix()
	accounts := map[int64]*models.Account{
		11: {AccountId: 11, Uid: uid, Category: models.ACCOUNT_CATEGORY_DEBT, Type: models.ACCOUNT_TYPE_SINGLE_ACCOUNT,
			Name: "liability", Currency: "CNY", CreatedUnixTime: now, UpdatedUnixTime: now},
		12: {AccountId: 12, Uid: uid, Category: models.ACCOUNT_CATEGORY_CASH, Type: models.ACCOUNT_TYPE_SINGLE_ACCOUNT,
			Name: "asset", Currency: "CNY", CreatedUnixTime: now, UpdatedUnixTime: now},
	}
	beans := []any{
		accounts[11], accounts[12],
		&models.TransactionCategory{CategoryId: 31, Uid: uid, Type: models.CATEGORY_TYPE_TRANSFER,
			Name: "transfer parent", CreatedUnixTime: now, UpdatedUnixTime: now},
		&models.TransactionCategory{CategoryId: 32, Uid: uid, Type: models.CATEGORY_TYPE_TRANSFER, ParentCategoryId: 31,
			Name: "transfer child", CreatedUnixTime: now, UpdatedUnixTime: now},
		&models.TransactionCategory{CategoryId: 41, Uid: uid, Type: models.CATEGORY_TYPE_EXPENSE,
			Name: "expense parent", CreatedUnixTime: now, UpdatedUnixTime: now},
		&models.TransactionCategory{CategoryId: 42, Uid: uid, Type: models.CATEGORY_TYPE_EXPENSE, ParentCategoryId: 41,
			Name: "expense child", CreatedUnixTime: now, UpdatedUnixTime: now},
	}
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	for _, bean := range beans {
		if inserted, err := sess.Insert(bean); err != nil || inserted != 1 {
			t.Fatalf("insert loan ledger fixture %T: inserted=%d err=%v", bean, inserted, err)
		}
	}
	return accounts
}

func assertLoanSettlementLedgerState(t *testing.T, database *datastore.Database, uid int64, transactionCount int64, liabilityBalance int64, assetBalance int64) {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	count, err := sess.Where("uid=?", uid).Count(new(models.Transaction))
	if err != nil {
		t.Fatalf("count loan ledger transactions: %v", err)
	}
	accounts := make([]*models.Account, 0, 2)
	if err = sess.Where("uid=?", uid).In("account_id", []int64{11, 12}).Asc("account_id").Find(&accounts); err != nil {
		t.Fatalf("load loan ledger accounts: %v", err)
	}
	if count != transactionCount || len(accounts) != 2 || accounts[0].Balance != liabilityBalance || accounts[1].Balance != assetBalance {
		t.Fatalf("unexpected loan ledger state: count=%d accounts=%+v", count, accounts)
	}
}
