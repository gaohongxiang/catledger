//go:build pf_organizer_db_integration

package organizer_test

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/converters"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/migrations"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/organizer"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

const organizerIntegrationDatabaseSentinel = "ezbookkeeping-pf-isolated-compose-v1"

func TestEngineDatabaseIntegration(t *testing.T) {
	config, err := organizerIntegrationDatabaseConfig()
	if err != nil {
		t.Fatalf("invalid organizer integration database: %v", err)
	}
	database, err := datastore.OpenDatabase(config)
	if err != nil {
		t.Fatalf("open organizer integration database: %v", err)
	}
	t.Cleanup(func() {
		if cleanupErr := cleanupOrganizerIntegrationTables(database); cleanupErr != nil {
			t.Errorf("clean organizer integration database: %v", cleanupErr)
		}
		if closeErr := database.Close(); closeErr != nil {
			t.Errorf("close organizer integration database: %v", closeErr)
		}
	})
	if err = cleanupOrganizerIntegrationTables(database); err != nil {
		t.Fatalf("prepare organizer integration database: %v", err)
	}
	store, err := datastore.NewDataStore(database)
	if err != nil {
		t.Fatalf("create organizer integration store: %v", err)
	}
	if err = migrations.Upgrade(nil, store, migrations.ApplicationInfo{Version: "organizer-integration", Commit: "test"}); err != nil {
		t.Fatalf("upgrade organizer integration schema: %v", err)
	}
	repository, err := organizer.NewRepository(store)
	if err != nil {
		t.Fatalf("create organizer integration repository: %v", err)
	}

	const uid = int64(8801)
	const updateId = int64(8802)
	const batchId = int64(8803)
	if err = repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		if insertErr := tx.InsertUpdate(testUpdate(uid, updateId, 10)); insertErr != nil {
			return insertErr
		}
		return tx.InsertSource(testSource(uid, updateId, 8804, 8805, batchId, 10))
	}); err != nil {
		t.Fatalf("seed organizer integration update: %v", err)
	}
	engine, err := organizer.NewEngine(repository,
		&engineEvidenceStub{
			batches: map[int64]*importing.ImportBatch{batchId: engineBatch(uid, 8805, batchId)},
			rows: map[int64][]*importing.RawImportRow{batchId: {
				plannerRow(uid, batchId, 8806, 8807, 11, 7654, 1703000000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT),
			}},
		},
		&engineAccountStub{items: map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)}},
		converters.NewSourceFundsProjector(),
		&engineIdGenerator{next: 9000},
	)
	if err != nil {
		t.Fatalf("create organizer integration engine: %v", err)
	}
	request := organizer.OrganizeRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 1, IdempotencyKey: "organizer-integration-v1"}
	result, err := engine.Organize(nil, request)
	if err != nil || result == nil || result.Update.Status != organizer.UPDATE_STATUS_REVIEW || result.Update.Version != 3 ||
		result.Action.Status != organizer.ACTION_STATUS_APPLIED || len(result.Events) != 1 {
		t.Fatalf("organizer integration result mismatch: result=%+v err=%v", result, err)
	}
	replayed, err := engine.Organize(nil, request)
	if err != nil || replayed == nil || !replayed.Replayed || replayed.Action.ActionId != result.Action.ActionId || len(replayed.Events) != 1 {
		t.Fatalf("organizer integration replay mismatch: result=%+v err=%v", replayed, err)
	}
	if err = repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		return tx.InsertSource(testSource(uid, updateId, 9900, 9901, 9902, 20))
	}); err == nil {
		t.Fatal("source membership changed after planning")
	}
}

func organizerIntegrationDatabaseConfig() (*settings.DatabaseConfig, error) {
	if os.Getenv("PF_DB_INTEGRATION") != "1" || os.Getenv("PF_DB_TEST_SENTINEL") != organizerIntegrationDatabaseSentinel {
		return nil, fmt.Errorf("isolated Compose sentinel is missing")
	}
	databaseType := os.Getenv("EBK_DATABASE_TYPE")
	config := &settings.DatabaseConfig{
		DatabaseType: databaseType, DatabaseHost: os.Getenv("EBK_DATABASE_HOST"), DatabaseName: os.Getenv("EBK_DATABASE_NAME"),
		DatabaseUser: os.Getenv("EBK_DATABASE_USER"), DatabasePassword: os.Getenv("EBK_DATABASE_PASSWD"),
		DatabaseSSLMode: os.Getenv("EBK_DATABASE_SSL_MODE"), DatabasePath: os.Getenv("EBK_DATABASE_DB_PATH"),
		MaxIdleConnection: 2, MaxOpenConnection: 8, ConnectionMaxLifeTime: 60,
	}
	switch databaseType {
	case settings.Sqlite3DbType:
		databasePath := filepath.Clean(config.DatabasePath)
		if !filepath.IsAbs(databasePath) || !strings.HasPrefix(databasePath, "/testwork/") {
			return nil, fmt.Errorf("SQLite path must be inside the isolated test directory")
		}
		config.DatabasePath = databasePath
	case settings.MySqlDbType:
		if config.DatabaseHost != "mysql:3306" || config.DatabaseName != "ezbookkeeping_pf_test" || config.DatabaseUser != "pf_test" || config.DatabasePassword != "pf_test_password" {
			return nil, fmt.Errorf("MySQL target is not the isolated Compose service")
		}
	case settings.PostgresDbType:
		if config.DatabaseHost != "postgres:5432" || config.DatabaseName != "ezbookkeeping_pf_test" || config.DatabaseUser != "pf_test" ||
			config.DatabasePassword != "pf_test_password" || config.DatabaseSSLMode != "disable" {
			return nil, fmt.Errorf("PostgreSQL target is not the isolated Compose service")
		}
	default:
		return nil, fmt.Errorf("unsupported database type")
	}
	return config, nil
}

func cleanupOrganizerIntegrationTables(database *datastore.Database) error {
	tables := migrations.UserDataTableNames()
	for left, right := 0, len(tables)-1; left < right; left, right = left+1, right-1 {
		tables[left], tables[right] = tables[right], tables[left]
	}
	tables = append(tables, "pf_schema_migration")
	for _, tableName := range tables {
		session := database.NewPrivacySession(nil)
		_, err := session.Exec("DROP TABLE IF EXISTS " + tableName)
		session.Close()
		if err != nil {
			return fmt.Errorf("drop isolated organizer table %s: %w", tableName, err)
		}
	}
	return nil
}
