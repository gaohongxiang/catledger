//go:build pf_store_db_integration || pf_importing_db_integration

package importing_test

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/models"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/migrations"
	"github.com/gaohongxiang/catledger/pkg/settings"
)

const importingIntegrationDatabaseSentinel = "catledger-pf-isolated-compose-v1"

func TestRepositoryIntegrationContract(t *testing.T) {
	config, err := importingIntegrationDatabaseConfig()

	if err != nil {
		t.Fatalf("invalid STORE-101 integration database: %v", err)
	}

	database, err := datastore.OpenDatabase(config)

	if err != nil {
		t.Fatalf("open STORE-101 integration database: %v", err)
	}

	t.Cleanup(func() {
		if err := cleanupImportingIntegrationTables(database); err != nil {
			t.Errorf("clean STORE-101 integration database: %v", err)
		}

		if err := database.Close(); err != nil {
			t.Errorf("close STORE-101 integration database: %v", err)
		}
	})

	if err := database.Ping(); err != nil {
		t.Fatalf("ping STORE-101 integration database: %v", err)
	}

	if err := cleanupImportingIntegrationTables(database); err != nil {
		t.Fatalf("prepare STORE-101 integration database: %v", err)
	}

	store, err := datastore.NewDataStore(database)

	if err != nil {
		t.Fatalf("create STORE-101 integration store: %v", err)
	}

	if err := migrations.Upgrade(nil, store, migrations.ApplicationInfo{Version: "store-integration", Commit: "test"}); err != nil {
		t.Fatalf("upgrade STORE-101 integration schema: %v", err)
	}

	repository, err := importing.NewRepository(store)

	if err != nil {
		t.Fatalf("create STORE-101 integration repository: %v", err)
	}

	assertRepositoryContract(t, repository, database)
}

func importingIntegrationDatabaseConfig() (*settings.DatabaseConfig, error) {
	if os.Getenv("PF_DB_INTEGRATION") != "1" || os.Getenv("PF_DB_TEST_SENTINEL") != importingIntegrationDatabaseSentinel {
		return nil, fmt.Errorf("isolated Compose sentinel is missing")
	}

	databaseType := os.Getenv("CATLEDGER_DATABASE_TYPE")
	config := &settings.DatabaseConfig{
		DatabaseType:          databaseType,
		DatabaseHost:          os.Getenv("CATLEDGER_DATABASE_HOST"),
		DatabaseName:          os.Getenv("CATLEDGER_DATABASE_NAME"),
		DatabaseUser:          os.Getenv("CATLEDGER_DATABASE_USER"),
		DatabasePassword:      os.Getenv("CATLEDGER_DATABASE_PASSWD"),
		DatabaseSSLMode:       os.Getenv("CATLEDGER_DATABASE_SSL_MODE"),
		DatabasePath:          os.Getenv("CATLEDGER_DATABASE_DB_PATH"),
		MaxIdleConnection:     2,
		MaxOpenConnection:     8,
		ConnectionMaxLifeTime: 60,
	}

	switch databaseType {
	case settings.Sqlite3DbType:
		databasePath := filepath.Clean(config.DatabasePath)

		if !filepath.IsAbs(databasePath) || !strings.HasPrefix(databasePath, "/testwork/") {
			return nil, fmt.Errorf("SQLite path must be inside the isolated test directory")
		}

		config.DatabasePath = databasePath
	case settings.MySqlDbType:
		if config.DatabaseHost != "mysql:3306" || config.DatabaseName != "catledger_pf_test" ||
			config.DatabaseUser != "pf_test" || config.DatabasePassword != "pf_test_password" {
			return nil, fmt.Errorf("MySQL target is not the isolated Compose service")
		}
	case settings.PostgresDbType:
		if config.DatabaseHost != "postgres:5432" || config.DatabaseName != "catledger_pf_test" ||
			config.DatabaseUser != "pf_test" || config.DatabasePassword != "pf_test_password" || config.DatabaseSSLMode != "disable" {
			return nil, fmt.Errorf("PostgreSQL target is not the isolated Compose service")
		}
	default:
		return nil, fmt.Errorf("unsupported database type")
	}

	return config, nil
}

func cleanupImportingIntegrationTables(database *datastore.Database) error {
	coreSession := database.NewPrivacySession(nil)
	err := coreSession.DropTable(new(models.Transaction))
	coreSession.Close()

	if err != nil {
		return fmt.Errorf("drop isolated transaction table: %w", err)
	}

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
			return fmt.Errorf("drop isolated table %s: %w", tableName, err)
		}
	}

	return nil
}
