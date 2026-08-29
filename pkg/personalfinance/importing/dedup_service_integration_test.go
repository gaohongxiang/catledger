//go:build pf_importing_db_integration

package importing_test

import (
	"testing"

	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/migrations"
)

func TestDedupServiceIntegrationConcurrentIdentityArbitration(t *testing.T) {
	config, err := importingIntegrationDatabaseConfig()

	if err != nil {
		t.Fatalf("invalid DEDUP-101 integration database: %v", err)
	}

	database, err := datastore.OpenDatabase(config)

	if err != nil {
		t.Fatalf("open DEDUP-101 integration database: %v", err)
	}

	t.Cleanup(func() {
		if err := cleanupImportingIntegrationTables(database); err != nil {
			t.Errorf("clean DEDUP-101 integration database: %v", err)
		}

		if err := database.Close(); err != nil {
			t.Errorf("close DEDUP-101 integration database: %v", err)
		}
	})

	if err := database.Ping(); err != nil {
		t.Fatalf("ping DEDUP-101 integration database: %v", err)
	}

	if err := cleanupImportingIntegrationTables(database); err != nil {
		t.Fatalf("prepare DEDUP-101 integration database: %v", err)
	}

	store, err := datastore.NewDataStore(database)

	if err != nil {
		t.Fatalf("create DEDUP-101 integration store: %v", err)
	}

	if err := migrations.Upgrade(nil, store, migrations.ApplicationInfo{Version: "dedup-integration", Commit: "test"}); err != nil {
		t.Fatalf("upgrade DEDUP-101 integration schema: %v", err)
	}

	repository, err := importing.NewRepository(store)

	if err != nil {
		t.Fatalf("create DEDUP-101 integration repository: %v", err)
	}

	assertDedupConcurrentIdentityArbitration(t, repository, database, 18101, 18201, 18301, "f")
	assertDedupConcurrentIdentityConflict(t, repository, database, 19101, 19201, 19301, "8")
	assertDedupIdentityPrimaryKeyCollisionRollback(t, repository, database, 20101, 20201, 20301, "4", 400000)
}
