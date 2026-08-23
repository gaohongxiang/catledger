package migrations

import (
	"fmt"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

// TestSchemaV010LiveDatabaseUpgrade exercises the real datastore drivers and
// the complete v001 -> v010 migration chain. Ordinary unit-test runs skip it;
// CI enables it once for MySQL and once for PostgreSQL through environment
// variables.
func TestSchemaV010LiveDatabaseUpgrade(t *testing.T) {
	databaseType := strings.TrimSpace(os.Getenv("PF_LIVE_DB_TYPE"))
	if databaseType == "" {
		t.Skip("PF_LIVE_DB_TYPE is not set")
	}

	config := new(settings.DatabaseConfig)
	setRequiredDatabaseConfigField(t, config, []string{"DatabaseType", "Type"}, databaseType)
	setRequiredDatabaseConfigField(t, config, []string{"DatabaseHost", "Host"}, envOrDefault("PF_LIVE_DB_HOST", "127.0.0.1"))
	setRequiredDatabaseConfigField(t, config, []string{"DatabasePort", "Port"}, envOrDefault("PF_LIVE_DB_PORT", defaultLiveDatabasePort(databaseType)))
	setRequiredDatabaseConfigField(t, config, []string{"DatabaseName", "Name"}, envOrDefault("PF_LIVE_DB_NAME", "ezbookkeeping_pf_test"))
	setRequiredDatabaseConfigField(t, config, []string{"DatabaseUser", "User", "Username"}, envOrDefault("PF_LIVE_DB_USER", defaultLiveDatabaseUser(databaseType)))
	setRequiredDatabaseConfigField(t, config, []string{"DatabasePassword", "Password"}, envOrDefault("PF_LIVE_DB_PASSWORD", "ezbookkeeping"))
	setOptionalDatabaseConfigField(t, config, []string{"DatabaseSSLMode", "SSLMode"}, envOrDefault("PF_LIVE_DB_SSL_MODE", "disable"))
	setOptionalDatabaseConfigField(t, config, []string{"MaxIdleConnection", "MaxIdleConnections"}, "1")
	setOptionalDatabaseConfigField(t, config, []string{"MaxOpenConnection", "MaxOpenConnections"}, "4")
	setOptionalDatabaseConfigField(t, config, []string{"ConnectionMaxLifeTime", "ConnectionMaxLifetime"}, "60")

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

func setRequiredDatabaseConfigField(t *testing.T, config *settings.DatabaseConfig, names []string, raw string) {
	t.Helper()
	if !setDatabaseConfigField(t, config, names, raw) {
		t.Fatalf("database config does not expose any required field %v; available fields: %s", names, databaseConfigFieldNames(config))
	}
}

func setOptionalDatabaseConfigField(t *testing.T, config *settings.DatabaseConfig, names []string, raw string) {
	t.Helper()
	_ = setDatabaseConfigField(t, config, names, raw)
}

func setDatabaseConfigField(t *testing.T, config *settings.DatabaseConfig, names []string, raw string) bool {
	t.Helper()
	value := reflect.ValueOf(config)
	if value.Kind() != reflect.Pointer || value.IsNil() || value.Elem().Kind() != reflect.Struct {
		t.Fatal("database config is not a writable struct pointer")
	}
	for _, name := range names {
		field := value.Elem().FieldByName(name)
		if !field.IsValid() || !field.CanSet() {
			continue
		}
		if err := assignDatabaseConfigField(field, raw); err != nil {
			t.Fatalf("set database config field %s: %v", name, err)
		}
		return true
	}
	return false
}

func assignDatabaseConfigField(field reflect.Value, raw string) error {
	switch field.Kind() {
	case reflect.String:
		field.SetString(raw)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		value, err := strconv.ParseInt(raw, 10, field.Type().Bits())
		if err != nil {
			return err
		}
		field.SetInt(value)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		value, err := strconv.ParseUint(raw, 10, field.Type().Bits())
		if err != nil {
			return err
		}
		field.SetUint(value)
	case reflect.Bool:
		value, err := strconv.ParseBool(raw)
		if err != nil {
			return err
		}
		field.SetBool(value)
	default:
		return fmt.Errorf("unsupported kind %s", field.Kind())
	}
	return nil
}

func databaseConfigFieldNames(config *settings.DatabaseConfig) string {
	typeOf := reflect.TypeOf(config)
	if typeOf.Kind() == reflect.Pointer {
		typeOf = typeOf.Elem()
	}
	names := make([]string, 0, typeOf.NumField())
	for index := 0; index < typeOf.NumField(); index++ {
		names = append(names, typeOf.Field(index).Name)
	}
	return strings.Join(names, ",")
}

func envOrDefault(name string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func defaultLiveDatabasePort(databaseType string) string {
	if strings.Contains(strings.ToLower(databaseType), "post") {
		return "5432"
	}
	return "3306"
}

func defaultLiveDatabaseUser(databaseType string) string {
	if strings.Contains(strings.ToLower(databaseType), "post") {
		return "postgres"
	}
	return "root"
}
