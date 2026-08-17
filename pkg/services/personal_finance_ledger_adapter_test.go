package services

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
	"github.com/mayswind/ezbookkeeping/pkg/utils"
	"github.com/mayswind/ezbookkeeping/pkg/uuid"
)

func TestCreateTransactionInSessionUsesCallerTransaction(t *testing.T) {
	database, err := datastore.OpenDatabase(&settings.DatabaseConfig{
		DatabaseType:          settings.Sqlite3DbType,
		DatabasePath:          filepath.Join(t.TempDir(), "ledger-adapter.db"),
		MaxIdleConnection:     1,
		MaxOpenConnection:     1,
		ConnectionMaxLifeTime: 60,
	})

	if err != nil {
		t.Fatalf("open ledger adapter database: %v", err)
	}

	t.Cleanup(func() { _ = database.Close() })

	if err = database.SyncStructs(new(models.Account), new(models.Transaction), new(models.TransactionCategory)); err != nil {
		t.Fatalf("create ledger adapter schema: %v", err)
	}

	store, err := datastore.NewDataStore(database)

	if err != nil {
		t.Fatalf("create ledger adapter store: %v", err)
	}

	if err = uuid.InitializeUuidGenerator(&settings.Config{UuidGeneratorType: settings.InternalUuidGeneratorType}); err != nil {
		t.Fatalf("initialize UUID generator: %v", err)
	}

	service := &TransactionService{
		ServiceUsingDB:   ServiceUsingDB{container: &datastore.DataStoreContainer{UserDataStore: store}},
		ServiceUsingUuid: ServiceUsingUuid{container: uuid.Container},
	}
	const uid = int64(1001)
	insertLedgerAdapterFixtures(t, database, uid)

	var created *models.Transaction
	err = database.DoPrivacyTransaction(nil, func(sess *xorm.Session) error {
		created, _, err = service.CreateTransactionInSession(nil, database, sess, ledgerAdapterDraft(uid, 200), nil)
		return err
	})

	if err != nil || created == nil || created.TransactionId < 1 {
		t.Fatalf("create transaction in caller session: %+v %v", created, err)
	}

	assertLedgerAdapterState(t, database, uid, 1, 800)
	uncategorized := ledgerAdapterDraft(uid, 50)
	uncategorized.CategoryId = 0
	err = database.DoPrivacyTransaction(nil, func(sess *xorm.Session) error {
		created, _, err = service.CreateTransactionInSession(nil, database, sess, uncategorized, nil)
		return err
	})
	if err != nil || created == nil || created.CategoryId != 0 {
		t.Fatalf("create uncategorized transaction in caller session: %+v %v", created, err)
	}
	assertLedgerAdapterState(t, database, uid, 2, 750)
	rollback := errors.New("rollback fixture")
	err = database.DoPrivacyTransaction(nil, func(sess *xorm.Session) error {
		if _, _, createErr := service.CreateTransactionInSession(nil, database, sess, ledgerAdapterDraft(uid, 100), nil); createErr != nil {
			return createErr
		}

		return rollback
	})

	if !errors.Is(err, rollback) {
		t.Fatalf("caller rollback was not preserved: %v", err)
	}

	assertLedgerAdapterState(t, database, uid, 2, 750)
	nonTransactionSession := database.NewPrivacySession(nil)
	_, _, err = service.CreateTransactionInSession(nil, database, nonTransactionSession, ledgerAdapterDraft(uid, 1), nil)
	nonTransactionSession.Close()

	if err == nil {
		t.Fatal("adapter accepted a session without an active transaction")
	}
}

func TestDeleteTransactionInSessionSnapshotsPairsAndCallerRollback(t *testing.T) {
	database, err := datastore.OpenDatabase(&settings.DatabaseConfig{
		DatabaseType:          settings.Sqlite3DbType,
		DatabasePath:          filepath.Join(t.TempDir(), "ledger-delete-adapter.db"),
		MaxIdleConnection:     1,
		MaxOpenConnection:     1,
		ConnectionMaxLifeTime: 60,
	})
	if err != nil {
		t.Fatalf("open ledger deletion adapter database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err = database.SyncStructs(new(models.Account), new(models.Transaction), new(models.TransactionCategory), new(models.TransactionTagIndex), new(models.TransactionPictureInfo)); err != nil {
		t.Fatalf("create ledger deletion adapter schema: %v", err)
	}
	store, err := datastore.NewDataStore(database)
	if err != nil {
		t.Fatalf("create ledger deletion adapter store: %v", err)
	}
	if err = uuid.InitializeUuidGenerator(&settings.Config{UuidGeneratorType: settings.InternalUuidGeneratorType}); err != nil {
		t.Fatalf("initialize UUID generator: %v", err)
	}
	service := &TransactionService{
		ServiceUsingDB:   ServiceUsingDB{container: &datastore.DataStoreContainer{UserDataStore: store}},
		ServiceUsingUuid: ServiceUsingUuid{container: uuid.Container},
	}
	const uid = int64(3001)
	insertLedgerAdapterFixtures(t, database, uid)
	insertLedgerDeleteTransferFixtures(t, database, uid)

	var ordinary *models.Transaction
	err = database.DoPrivacyTransaction(nil, func(sess *xorm.Session) error {
		ordinary, _, err = service.CreateTransactionInSession(nil, database, sess, ledgerAdapterDraft(uid, 200), nil)
		return err
	})
	if err != nil || ordinary == nil {
		t.Fatalf("create ordinary deletion fixture: %+v %v", ordinary, err)
	}
	insertLedgerDeleteRelations(t, database, uid, ordinary.TransactionId, ordinary.TransactionTime)

	err = database.DoPrivacyTransaction(nil, func(sess *xorm.Session) error {
		_, _, deleteErr := service.DeleteTransactionInSession(nil, database, sess, uid, ordinary.TransactionId, ordinary.UpdatedUnixTime+1, 0, 0, ordinary.UpdatedUnixTime+10)
		return deleteErr
	})
	if err == nil {
		t.Fatal("ordinary deletion accepted a changed snapshot")
	}
	assertLedgerDeletionState(t, database, uid, ordinary.TransactionId, false, 800, false)

	rollback := errors.New("rollback deletion fixture")
	err = database.DoPrivacyTransaction(nil, func(sess *xorm.Session) error {
		before, related, deleteErr := service.DeleteTransactionInSession(nil, database, sess, uid, ordinary.TransactionId, ordinary.UpdatedUnixTime, 0, 0, ordinary.UpdatedUnixTime+10)
		if deleteErr != nil || before == nil || related != nil {
			return errors.New("delete ordinary transaction in caller session")
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatalf("caller rollback was not preserved for deletion: %v", err)
	}
	assertLedgerDeletionState(t, database, uid, ordinary.TransactionId, false, 800, false)

	err = database.DoPrivacyTransaction(nil, func(sess *xorm.Session) error {
		_, _, deleteErr := service.DeleteTransactionInSession(nil, database, sess, uid, ordinary.TransactionId, ordinary.UpdatedUnixTime, 0, 0, ordinary.UpdatedUnixTime+10)
		return deleteErr
	})
	if err != nil {
		t.Fatalf("delete ordinary transaction: %v", err)
	}
	assertLedgerDeletionState(t, database, uid, ordinary.TransactionId, true, 1000, true)

	transferDraft := &models.Transaction{
		Uid: uid, Type: models.TRANSACTION_DB_TYPE_TRANSFER_OUT, CategoryId: 32, AccountId: 11,
		RelatedAccountId: 12, TransactionTime: utils.GetMinTransactionTimeFromUnixTime(time.Now().Unix() + 60),
		Amount: 100, RelatedAccountAmount: 150, CreatedIp: "192.0.2.2",
	}
	var transferOut *models.Transaction
	var transferIn *models.Transaction
	err = database.DoPrivacyTransaction(nil, func(sess *xorm.Session) error {
		transferOut, transferIn, err = service.CreateTransactionInSession(nil, database, sess, transferDraft, nil)
		return err
	})
	if err != nil || transferOut == nil || transferIn == nil {
		t.Fatalf("create transfer deletion fixture: %+v %+v %v", transferOut, transferIn, err)
	}
	err = database.DoPrivacyTransaction(nil, func(sess *xorm.Session) error {
		_, _, deleteErr := service.DeleteTransactionInSession(nil, database, sess, uid, transferOut.TransactionId, transferOut.UpdatedUnixTime, 0, 0, transferOut.UpdatedUnixTime+10)
		return deleteErr
	})
	if err == nil {
		t.Fatal("transfer deletion accepted a missing reciprocal snapshot")
	}
	err = database.DoPrivacyTransaction(nil, func(sess *xorm.Session) error {
		before, related, deleteErr := service.DeleteTransactionInSession(nil, database, sess, uid, transferOut.TransactionId, transferOut.UpdatedUnixTime, transferIn.TransactionId, transferIn.UpdatedUnixTime, transferOut.UpdatedUnixTime+10)
		if deleteErr != nil || before == nil || related == nil {
			return errors.New("delete complete transfer in caller session")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("delete complete transfer: %v", err)
	}
	assertTransferDeletionState(t, database, uid, transferOut.TransactionId, transferIn.TransactionId, 1000, 500)
}

func insertLedgerDeleteTransferFixtures(t *testing.T, database *datastore.Database, uid int64) {
	t.Helper()
	now := time.Now().Unix()
	beans := []any{
		&models.Account{AccountId: 12, Uid: uid, Category: models.ACCOUNT_CATEGORY_CASH, Type: models.ACCOUNT_TYPE_SINGLE_ACCOUNT, Name: "destination", Currency: "USD", Balance: 500, CreatedUnixTime: now, UpdatedUnixTime: now},
		&models.TransactionCategory{CategoryId: 31, Uid: uid, Type: models.CATEGORY_TYPE_TRANSFER, Name: "transfer parent", CreatedUnixTime: now, UpdatedUnixTime: now},
		&models.TransactionCategory{CategoryId: 32, Uid: uid, Type: models.CATEGORY_TYPE_TRANSFER, ParentCategoryId: 31, Name: "transfer child", CreatedUnixTime: now, UpdatedUnixTime: now},
	}
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	for _, bean := range beans {
		if inserted, err := sess.Insert(bean); err != nil || inserted != 1 {
			t.Fatalf("insert ledger deletion fixture %T: %v", bean, err)
		}
	}
}

func insertLedgerDeleteRelations(t *testing.T, database *datastore.Database, uid int64, transactionId int64, transactionTime int64) {
	t.Helper()
	now := time.Now().Unix()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	beans := []any{
		&models.TransactionTagIndex{TagIndexId: 41, Uid: uid, TransactionTime: transactionTime, TagId: 42, TransactionId: transactionId, CreatedUnixTime: now, UpdatedUnixTime: now},
		&models.TransactionPictureInfo{Uid: uid, TransactionId: transactionId, PictureId: 43, PictureExtension: "jpg", CreatedUnixTime: now, UpdatedUnixTime: now},
	}
	for _, bean := range beans {
		if inserted, err := sess.Insert(bean); err != nil || inserted != 1 {
			t.Fatalf("insert ledger deletion relation %T: %v", bean, err)
		}
	}
}

func assertLedgerDeletionState(t *testing.T, database *datastore.Database, uid int64, transactionId int64, deleted bool, balance int64, relationsDeleted bool) {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	transaction := new(models.Transaction)
	account := new(models.Account)
	tag := new(models.TransactionTagIndex)
	picture := new(models.TransactionPictureInfo)
	transactionFound, transactionErr := sess.Where("uid=? AND transaction_id=?", uid, transactionId).Get(transaction)
	accountFound, accountErr := sess.Where("uid=? AND account_id=?", uid, 11).Get(account)
	tagFound, tagErr := sess.Where("uid=? AND transaction_id=?", uid, transactionId).Get(tag)
	pictureFound, pictureErr := sess.Where("uid=? AND transaction_id=?", uid, transactionId).Get(picture)
	if transactionErr != nil || accountErr != nil || tagErr != nil || pictureErr != nil || !transactionFound || !accountFound || !tagFound || !pictureFound ||
		transaction.Deleted != deleted || account.Balance != balance || tag.Deleted != relationsDeleted || picture.Deleted != relationsDeleted {
		t.Fatalf("unexpected ledger deletion state: tx=%+v account=%+v tag=%+v picture=%+v errors=%v/%v/%v/%v", transaction, account, tag, picture, transactionErr, accountErr, tagErr, pictureErr)
	}
}

func assertTransferDeletionState(t *testing.T, database *datastore.Database, uid int64, primaryId int64, relatedId int64, sourceBalance int64, destinationBalance int64) {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	transactions := make([]*models.Transaction, 0, 2)
	accounts := make([]*models.Account, 0, 2)
	if err := sess.Where("uid=?", uid).In("transaction_id", []int64{primaryId, relatedId}).Find(&transactions); err != nil {
		t.Fatalf("load deleted transfer: %v", err)
	}
	if err := sess.Where("uid=?", uid).In("account_id", []int64{11, 12}).Asc("account_id").Find(&accounts); err != nil {
		t.Fatalf("load transfer accounts: %v", err)
	}
	if len(transactions) != 2 || !transactions[0].Deleted || !transactions[1].Deleted || len(accounts) != 2 || accounts[0].Balance != sourceBalance || accounts[1].Balance != destinationBalance {
		t.Fatalf("unexpected transfer deletion state: transactions=%+v accounts=%+v", transactions, accounts)
	}
}

func insertLedgerAdapterFixtures(t *testing.T, database *datastore.Database, uid int64) {
	t.Helper()
	now := time.Now().Unix()
	beans := []any{
		&models.Account{
			AccountId:       11,
			Uid:             uid,
			Category:        models.ACCOUNT_CATEGORY_CASH,
			Type:            models.ACCOUNT_TYPE_SINGLE_ACCOUNT,
			Name:            "fixture",
			Currency:        "CNY",
			Balance:         1000,
			CreatedUnixTime: now,
			UpdatedUnixTime: now,
		},
		&models.TransactionCategory{
			CategoryId:      21,
			Uid:             uid,
			Type:            models.CATEGORY_TYPE_EXPENSE,
			Name:            "parent",
			CreatedUnixTime: now,
			UpdatedUnixTime: now,
		},
		&models.TransactionCategory{
			CategoryId:       22,
			Uid:              uid,
			Type:             models.CATEGORY_TYPE_EXPENSE,
			ParentCategoryId: 21,
			Name:             "child",
			CreatedUnixTime:  now,
			UpdatedUnixTime:  now,
		},
	}
	sess := database.NewPrivacySession(nil)
	defer sess.Close()

	for _, bean := range beans {
		inserted, err := sess.Insert(bean)

		if err != nil || inserted != 1 {
			t.Fatalf("insert ledger adapter fixture %T: %v", bean, err)
		}
	}
}

func ledgerAdapterDraft(uid int64, amount int64) *models.Transaction {
	return &models.Transaction{
		Uid:               uid,
		Type:              models.TRANSACTION_DB_TYPE_EXPENSE,
		CategoryId:        22,
		AccountId:         11,
		TransactionTime:   utils.GetMinTransactionTimeFromUnixTime(time.Now().Unix()),
		TimezoneUtcOffset: 0,
		Amount:            amount,
		CreatedIp:         "192.0.2.1",
	}
}

func assertLedgerAdapterState(t *testing.T, database *datastore.Database, uid int64, transactionCount int64, balance int64) {
	t.Helper()
	sess := database.NewPrivacySession(nil)
	count, err := sess.Where("uid=?", uid).Count(new(models.Transaction))

	if err != nil {
		sess.Close()
		t.Fatalf("count ledger adapter transactions: %v", err)
	}

	account := new(models.Account)
	found, err := sess.Where("uid=? AND account_id=?", uid, 11).Get(account)
	sess.Close()

	if err != nil || !found || count != transactionCount || account.Balance != balance {
		t.Fatalf("unexpected ledger adapter state: count=%d account=%+v err=%v", count, account, err)
	}
}
