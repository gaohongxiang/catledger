package services

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/models"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/dashboard"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/organizer"
	"github.com/gaohongxiang/catledger/pkg/settings"
)

func TestPersonalFinanceDashboardLedgerAdapterIsolatesUsersAndBoundsReads(t *testing.T) {
	database, err := datastore.OpenDatabase(&settings.DatabaseConfig{
		DatabaseType: settings.Sqlite3DbType, DatabasePath: filepath.Join(t.TempDir(), "dashboard-ledger.db"),
		MaxIdleConnection: 1, MaxOpenConnection: 1, ConnectionMaxLifeTime: 60,
	})
	if err != nil {
		t.Fatalf("open dashboard ledger database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err = database.SyncStructs(new(models.Account), new(models.Transaction), new(organizer.EconomicEvent), new(organizer.EconomicEventTransaction)); err != nil {
		t.Fatalf("create dashboard ledger schema: %v", err)
	}
	store, err := datastore.NewDataStore(database)
	if err != nil {
		t.Fatalf("create dashboard ledger store: %v", err)
	}
	now := time.Now().Unix()
	fixtures := []any{
		&models.Account{AccountId: 11, Uid: 1001, Category: models.ACCOUNT_CATEGORY_CASH, Type: models.ACCOUNT_TYPE_SINGLE_ACCOUNT, Name: "owner", Currency: "CNY", Balance: 100, CreatedUnixTime: now, UpdatedUnixTime: now},
		&models.Account{AccountId: 12, Uid: 2002, Category: models.ACCOUNT_CATEGORY_CASH, Type: models.ACCOUNT_TYPE_SINGLE_ACCOUNT, Name: "other", Currency: "USD", Balance: 999, CreatedUnixTime: now, UpdatedUnixTime: now},
		&models.Transaction{TransactionId: 21, Uid: 1001, Type: models.TRANSACTION_DB_TYPE_INCOME, AccountId: 11, TransactionTime: now * 1000, Amount: 100, CreatedUnixTime: now, UpdatedUnixTime: now},
		&models.Transaction{TransactionId: 23, Uid: 1001, Type: models.TRANSACTION_DB_TYPE_EXPENSE, AccountId: 11, TransactionTime: now*1000 + 1, Amount: 20, CreatedUnixTime: now, UpdatedUnixTime: now},
		&organizer.EconomicEvent{Uid: 1001, UpdateId: 31, EventKey: strings.Repeat("a", 64), EventKeyVersion: organizer.EVENT_KEY_VERSION_V1,
			Status: organizer.EVENT_STATUS_POSTED, Version: 1, FlowDirection: organizer.FLOW_DIRECTION_INFLOW, EconomicNature: organizer.ECONOMIC_NATURE_REFUND,
			Currency: "CNY", ManualFieldMask: 0, RuleVersion: organizer.PLAN_VERSION_V1, FieldSourcesJson: "{}", ReasonCodesJson: "[]",
			CreatedUnixTime: now, UpdatedUnixTime: now, EventId: 32},
		&organizer.EconomicEventTransaction{Uid: 1001, UpdateId: 31, EventId: 32, TransactionId: 21,
			Role: organizer.EVENT_TRANSACTION_ROLE_REFUND_TRANSACTION, RuleVersion: organizer.EVENT_TRANSACTION_VERSION_V1,
			TransactionUpdatedUnixTime: now, CreatedUnixTime: now, LinkId: 33},
		&models.Transaction{TransactionId: 22, Uid: 2002, Type: models.TRANSACTION_DB_TYPE_INCOME, AccountId: 12, TransactionTime: now * 1000, Amount: 999, CreatedUnixTime: now, UpdatedUnixTime: now},
	}
	sess := database.NewPrivacySession(nil)
	for _, fixture := range fixtures {
		if inserted, insertErr := sess.Insert(fixture); insertErr != nil || inserted != 1 {
			sess.Close()
			t.Fatalf("insert dashboard ledger fixture %T: inserted=%d err=%v", fixture, inserted, insertErr)
		}
	}
	sess.Close()

	adapter, err := NewPersonalFinanceDashboardLedgerAdapter(store)
	if err != nil {
		t.Fatalf("create dashboard ledger adapter: %v", err)
	}
	data, err := adapter.ReadLedgerData(nil, 1001, 1, 10)
	if err != nil || len(data.Accounts) != 1 || data.Accounts[0].AccountId != 11 || len(data.Transactions) != 2 || data.Transactions[0].TransactionId != 21 ||
		data.Transactions[0].EconomicNature != dashboard.LedgerTransactionEconomicNatureRefund || data.Transactions[1].TransactionId != 23 {
		t.Fatalf("dashboard ledger read crossed user boundary: data=%+v err=%v", data, err)
	}
	if _, err = adapter.ReadLedgerData(nil, 1001, 1, 0); !errors.Is(err, dashboard.ErrInvalidQuery) {
		t.Fatalf("invalid read bound was accepted: %v", err)
	}
	if _, err = adapter.ReadLedgerData(nil, 1001, 1, 1); !errors.Is(err, dashboard.ErrReadLimitReached) {
		t.Fatalf("read limit did not fail closed: %v", err)
	}
}
