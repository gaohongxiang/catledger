//go:build pf_importing_db_integration

package importing_test

import (
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/migrations"
)

func TestPostingServiceIntegrationContract(t *testing.T) {
	config, err := importingIntegrationDatabaseConfig()

	if err != nil {
		t.Fatalf("invalid POST-101 integration database: %v", err)
	}

	database, err := datastore.OpenDatabase(config)

	if err != nil {
		t.Fatalf("open POST-101 integration database: %v", err)
	}

	t.Cleanup(func() {
		if err := cleanupImportingIntegrationTables(database); err != nil {
			t.Errorf("clean POST-101 integration database: %v", err)
		}

		if err := database.Close(); err != nil {
			t.Errorf("close POST-101 integration database: %v", err)
		}
	})

	if err := database.Ping(); err != nil {
		t.Fatalf("ping POST-101 integration database: %v", err)
	}

	if err := cleanupImportingIntegrationTables(database); err != nil {
		t.Fatalf("prepare POST-101 integration database: %v", err)
	}

	store, err := datastore.NewDataStore(database)

	if err != nil {
		t.Fatalf("create POST-101 integration store: %v", err)
	}

	if err := migrations.Upgrade(nil, store, migrations.ApplicationInfo{Version: "posting-integration", Commit: "test"}); err != nil {
		t.Fatalf("upgrade POST-101 integration schema: %v", err)
	}

	if err := database.SyncStructs(new(models.Transaction)); err != nil {
		t.Fatalf("create POST-101 ledger table: %v", err)
	}

	repository, err := importing.NewRepository(store)

	if err != nil {
		t.Fatalf("create POST-101 integration repository: %v", err)
	}

	assertPostingServiceDatabaseContract(t, repository, database)
}
