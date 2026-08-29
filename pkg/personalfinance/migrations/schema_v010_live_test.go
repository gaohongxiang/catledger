package migrations

import (
	"net"
	"os"
	"strings"
	"testing"

	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/settings"
)

// TestSchemaV010LiveDatabaseUpgrade exercises the real datastore drivers and
// the complete v001 -> v010 migration chain. Ordinary unit-test runs skip it;
// CI enables it once for MySQL and once for PostgreSQL through environment
// variables.
func TestSchemaV010LiveDatabaseUpgrade(t *testing.T) {
	rawDatabaseType := strings.TrimSpace(os.Getenv("PF_LIVE_DB_TYPE"))
	if rawDatabaseType == "" {
		t.Skip("PF_LIVE_DB_TYPE is not set")
	}

	databaseType, ok := normalizeLiveDatabaseType(rawDatabaseType)
	if !ok {
		t.Fatalf("unsupported live database type %q", rawDatabaseType)
	}

	config := &settings.DatabaseConfig{
		DatabaseType:          databaseType,
		DatabaseHost:          liveDatabaseHost(databaseType),
		DatabaseName:          envOrDefault("PF_LIVE_DB_NAME", "catledger_pf_test"),
		DatabaseUser:          envOrDefault("PF_LIVE_DB_USER", defaultLiveDatabaseUser(databaseType)),
		DatabasePassword:      envOrDefault("PF_LIVE_DB_PASSWORD", "catledger"),
		DatabaseSSLMode:       envOrDefault("PF_LIVE_DB_SSL_MODE", "disable"),
		MaxIdleConnection:     1,
		MaxOpenConnection:     4,
		ConnectionMaxLifeTime: 60,
	}

	database, err := datastore.OpenDatabase(config)
	if err != nil {
		t.Fatalf("open %s database: %v", databaseType, err)
	}
	t.Cleanup(func() {
		if closeErr := database.Close(); closeErr != nil {
			t.Errorf("close %s database: %v", databaseType, closeErr)
		}
	})

	store, err := datastore.NewDataStore(database)
	if err != nil {
		t.Fatalf("create %s datastore: %v", databaseType, err)
	}
	for index, commit := range []string{"live-v010-first", "live-v010-restart"} {
		if err = Upgrade(nil, store, ApplicationInfo{Version: "test", Commit: commit}); err != nil {
			t.Fatalf("upgrade %s database pass %d: %v", databaseType, index+1, err)
		}
	}
	if err = verifyMigrationTable(database); err != nil {
		t.Fatalf("verify %s migration ledger: %v", databaseType, err)
	}
	if err = verifySchemaV010(database); err != nil {
		t.Fatalf("verify %s v010 schema: %v", databaseType, err)
	}
}

func normalizeLiveDatabaseType(raw string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case settings.MySqlDbType:
		return settings.MySqlDbType, true
	case settings.PostgresDbType, "postgresql", "pg":
		return settings.PostgresDbType, true
	default:
		return "", false
	}
}

func liveDatabaseHost(databaseType string) string {
	host := envOrDefault("PF_LIVE_DB_HOST", "127.0.0.1")
	if strings.HasPrefix(host, "/") {
		return host
	}
	if _, _, err := net.SplitHostPort(host); err == nil {
		return host
	}
	return net.JoinHostPort(host, envOrDefault("PF_LIVE_DB_PORT", defaultLiveDatabasePort(databaseType)))
}

func envOrDefault(name string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func defaultLiveDatabasePort(databaseType string) string {
	if databaseType == settings.PostgresDbType {
		return "5432"
	}
	return "3306"
}

func defaultLiveDatabaseUser(databaseType string) string {
	if databaseType == settings.PostgresDbType {
		return "postgres"
	}
	return "root"
}
