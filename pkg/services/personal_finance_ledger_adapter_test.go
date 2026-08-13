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

	assertLedgerAdapterState(t, database, uid, 1, 800)
	nonTransactionSession := database.NewPrivacySession(nil)
	_, _, err = service.CreateTransactionInSession(nil, database, nonTransactionSession, ledgerAdapterDraft(uid, 1), nil)
	nonTransactionSession.Close()

	if err == nil {
		t.Fatal("adapter accepted a session without an active transaction")
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
