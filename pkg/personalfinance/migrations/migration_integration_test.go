//go:build pf_db_integration

package migrations

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/billflow"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/cardcycle"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/installments"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/reconciliation"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

var (
	integrationDatabase *datastore.Database
	integrationConfig   *settings.DatabaseConfig
)

const integrationDatabaseSentinel = "ezbookkeeping-pf-isolated-compose-v1"

func TestMain(m *testing.M) {
	if os.Getenv("PF_DB_INTEGRATION") != "1" {
		fmt.Fprintln(os.Stderr, "pf_db_integration requires PF_DB_INTEGRATION=1")
		os.Exit(2)
	}

	config, err := integrationDatabaseConfig()

	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid personal finance integration database: %v\n", err)
		os.Exit(2)
	}

	integrationConfig = config
	integrationDatabase, err = datastore.OpenDatabase(config)

	if err != nil {
		fmt.Fprintf(os.Stderr, "open personal finance integration database: %v\n", err)
		os.Exit(2)
	}

	if err = integrationDatabase.Ping(); err != nil {
		fmt.Fprintf(os.Stderr, "ping personal finance integration database: %v\n", err)
		_ = integrationDatabase.Close()
		os.Exit(2)
	}

	if err = cleanupPersonalFinanceTables(integrationDatabase); err != nil {
		fmt.Fprintf(os.Stderr, "prepare personal finance integration database: %v\n", err)
		_ = integrationDatabase.Close()
		os.Exit(2)
	}

	result := m.Run()

	if err = cleanupPersonalFinanceTables(integrationDatabase); err != nil {
		fmt.Fprintf(os.Stderr, "clean personal finance integration database: %v\n", err)
		result = 1
	}

	if err = integrationDatabase.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "close personal finance integration database: %v\n", err)
		result = 1
	}

	os.Exit(result)
}

func TestMigrationProtocol(t *testing.T) {
	t.Run("schema operations honor cancellation", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		c, cancel := context.WithCancel(context.Background())
		cancel()

		if _, err := integrationDatabase.SchemaTablesWithContext(c); !errors.Is(err, context.Canceled) {
			t.Fatalf("schema metadata query ignored cancellation: %v", err)
		}

		if err := integrationDatabase.SyncStructsWithStoreEngineContext(c, "InnoDB", schemaBeansV001()[0]); !errors.Is(err, context.Canceled) {
			t.Fatalf("schema sync ignored cancellation: %v", err)
		}
	})

	t.Run("fresh upgrade and repeat are exact", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		store := integrationDataStore(t, integrationDatabase)

		if err := Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "fresh"}); err != nil {
			t.Fatalf("first upgrade failed: %v", err)
		}

		if err := Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "repeat"}); err != nil {
			t.Fatalf("repeat upgrade failed: %v", err)
		}

		if err := verifyMigrationTable(integrationDatabase); err != nil {
			t.Fatalf("migration table is not exact: %v", err)
		}

		if err := verifySchemaV006(integrationDatabase); err != nil {
			t.Fatalf("v006 schema is not exact: %v", err)
		}

		record := requireMigrationRecord(t, integrationDatabase, 6)

		if !record.Success || record.AppliedUnixTime == nil || record.FailureCode != "" {
			t.Fatalf("unexpected successful migration record: %+v", record)
		}
	})

	t.Run("v002 advances continuously to v006", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		runner := newIntegrationRunner(t, "through-v002")
		runner.migrations = runner.migrations[:2]

		if err := runner.upgradeDatabase(integrationDatabase); err != nil {
			t.Fatalf("upgrade through v002: %v", err)
		}

		if err := verifySchemaV002(integrationDatabase); err != nil {
			t.Fatalf("v002 baseline is not exact: %v", err)
		}

		store := integrationDataStore(t, integrationDatabase)

		if err := Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "to-v006"}); err != nil {
			t.Fatalf("advance to v006: %v", err)
		}

		if err := verifySchemaV006(integrationDatabase); err != nil {
			t.Fatalf("advanced v006 schema is not exact: %v", err)
		}

		record := requireMigrationRecord(t, integrationDatabase, 6)

		if !record.Success || record.AppliedUnixTime == nil || record.FailureCode != "" {
			t.Fatalf("unexpected v006 migration record: %+v", record)
		}
	})

	t.Run("v003 advances continuously to v006", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		runner := newIntegrationRunner(t, "through-v003")
		runner.migrations = runner.migrations[:3]

		if err := runner.upgradeDatabase(integrationDatabase); err != nil {
			t.Fatalf("upgrade through v003: %v", err)
		}

		if err := verifySchemaV003(integrationDatabase); err != nil {
			t.Fatalf("v003 baseline is not exact: %v", err)
		}

		store := integrationDataStore(t, integrationDatabase)

		if err := Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "v003-to-v006"}); err != nil {
			t.Fatalf("advance v003 to v006: %v", err)
		}

		if err := verifySchemaV006(integrationDatabase); err != nil {
			t.Fatalf("v003 to v006 schema is not exact: %v", err)
		}

		record := requireMigrationRecord(t, integrationDatabase, 6)

		if !record.Success || record.AppliedUnixTime == nil || record.FailureCode != "" {
			t.Fatalf("unexpected v006 migration record: %+v", record)
		}
	})

	t.Run("v004 advances continuously to v006", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		runner := newIntegrationRunner(t, "through-v004")
		runner.migrations = runner.migrations[:4]

		if err := runner.upgradeDatabase(integrationDatabase); err != nil {
			t.Fatalf("upgrade through v004: %v", err)
		}
		if err := verifySchemaV004(integrationDatabase); err != nil {
			t.Fatalf("v004 baseline is not exact: %v", err)
		}

		store := integrationDataStore(t, integrationDatabase)
		if err := Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "v004-to-v006"}); err != nil {
			t.Fatalf("advance v004 to v006: %v", err)
		}
		if err := verifySchemaV006(integrationDatabase); err != nil {
			t.Fatalf("v004 to v006 schema is not exact: %v", err)
		}

		record := requireMigrationRecord(t, integrationDatabase, 6)
		if !record.Success || record.AppliedUnixTime == nil || record.FailureCode != "" {
			t.Fatalf("unexpected v006 migration record: %+v", record)
		}
	})

	t.Run("checksum mismatch is refused", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		store := integrationDataStore(t, integrationDatabase)
		requireUpgrade(t, store)

		sess := integrationDatabase.NewSession(nil)
		updated, err := sess.Table(new(SchemaMigration)).ID(int64(1)).Cols("checksum").Update(&SchemaMigration{Checksum: strings.Repeat("0", 64)})
		sess.Close()

		if err != nil || updated != 1 {
			t.Fatalf("corrupt checksum: updated=%d err=%v", updated, err)
		}

		err = Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "checksum"})

		if !errors.Is(err, ErrMigrationChecksumMismatch) {
			t.Fatalf("expected checksum mismatch, got %v", err)
		}
	})

	t.Run("schema drift after success is refused", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		store := integrationDataStore(t, integrationDatabase)
		requireUpgrade(t, store)

		sess := integrationDatabase.NewSession(nil)
		_, err := sess.Exec("CREATE INDEX IDX_pf_import_file_unexpected ON pf_import_file(uid)")
		sess.Close()

		if err != nil {
			t.Fatalf("create unexpected index: %v", err)
		}

		err = Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "drift"})

		if !errors.Is(err, ErrMigrationSchemaInvalid) {
			t.Fatalf("expected schema drift error, got %v", err)
		}
	})

	t.Run("weakened identity unique index is refused", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		store := integrationDataStore(t, integrationDatabase)
		requireUpgrade(t, store)
		weakenIdentityUniqueIndex(t)

		err := Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "weak-index"})

		if !errors.Is(err, ErrMigrationSchemaInvalid) {
			t.Fatalf("expected weakened unique index to be rejected, got %v", err)
		}
	})

	t.Run("forbidden trigger is refused", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		store := integrationDataStore(t, integrationDatabase)
		requireUpgrade(t, store)
		createForbiddenTrigger(t)

		err := Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "trigger"})

		if !errors.Is(err, ErrMigrationSchemaInvalid) {
			t.Fatalf("expected trigger to be rejected, got %v", err)
		}
	})

	t.Run("non-transactional MySQL table engine is refused", func(t *testing.T) {
		if integrationDatabase.DatabaseType() != settings.MySqlDbType {
			t.Skip("MySQL-specific table engine contract")
		}

		resetPersonalFinanceTables(t)
		store := integrationDataStore(t, integrationDatabase)
		requireUpgrade(t, store)
		sess := integrationDatabase.NewSession(nil)
		_, err := sess.Exec("ALTER TABLE pf_raw_import_row ENGINE=MyISAM")
		sess.Close()

		if err != nil {
			t.Fatalf("weaken MySQL table engine: %v", err)
		}

		err = Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "engine-drift"})

		if !errors.Is(err, ErrMigrationSchemaInvalid) {
			t.Fatalf("expected non-transactional table engine to be rejected, got %v", err)
		}
	})

	t.Run("unknown higher version is refused", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		store := integrationDataStore(t, integrationDatabase)
		requireUpgrade(t, store)
		now := requireDatabaseUnixTime(t, integrationDatabase)
		applied := now
		insertMigrationRecord(t, integrationDatabase, &SchemaMigration{
			Version:              6,
			Name:                 "future_migration",
			Checksum:             strings.Repeat("f", 64),
			ApplicationVersion:   "future",
			ApplicationCommit:    "future",
			RunnerId:             strings.Repeat("a", 32),
			ClaimToken:           strings.Repeat("b", 32),
			FirstStartedUnixTime: now,
			StartedUnixTime:      now,
			UpdatedUnixTime:      now,
			LeaseExpiresUnixTime: now,
			AppliedUnixTime:      &applied,
			Success:              true,
			FailureCode:          "",
		})

		err := Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "future"})

		if !errors.Is(err, ErrMigrationVersionTooNew) {
			t.Fatalf("expected version-too-new error, got %v", err)
		}
	})

	t.Run("active claim is not stolen", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		runner := newIntegrationRunner(t, "active")

		if err := runner.bootstrapMigrationTable(integrationDatabase); err != nil {
			t.Fatalf("bootstrap migration table: %v", err)
		}

		now := requireDatabaseUnixTime(t, integrationDatabase)
		item := registeredMigrations()[0]
		insertMigrationRecord(t, integrationDatabase, failedOrActiveRecord(item, now, "", now+migrationLeaseSeconds))
		store := integrationDataStore(t, integrationDatabase)
		err := Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "active"})

		if !errors.Is(err, ErrMigrationInProgress) {
			t.Fatalf("expected migration-in-progress error, got %v", err)
		}
	})

	t.Run("partial DDL failure resumes safely", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		injectedFailure := errors.New("injected migration failure")
		runner := newIntegrationRunner(t, "partial")
		item := runner.migrations[0]
		item.steps = []migrationStep{
			{
				name: "create_first_table",
				run: func(c context.Context, db *datastore.Database) error {
					return db.SyncStructsWithContext(c, schemaBeansV001()[0])
				},
			},
			{
				name: "inject_failure",
				run: func(context.Context, *datastore.Database) error {
					return injectedFailure
				},
			},
		}
		runner.migrations = []migration{item}

		err := runner.upgradeDatabase(integrationDatabase)

		if !errors.Is(err, injectedFailure) {
			t.Fatalf("expected injected migration failure, got %v", err)
		}

		failed := requireMigrationRecord(t, integrationDatabase, 1)

		if failed.Success || failed.FailureCode != "migration_up_failed" {
			t.Fatalf("unexpected failed migration record: %+v", failed)
		}

		store := integrationDataStore(t, integrationDatabase)
		requireUpgrade(t, store)

		if err = verifySchemaV006(integrationDatabase); err != nil {
			t.Fatalf("recovered schema is not exact: %v", err)
		}

		recovered := requireMigrationRecord(t, integrationDatabase, 1)

		if !recovered.Success || recovered.FirstStartedUnixTime != failed.FirstStartedUnixTime || recovered.ClaimToken == failed.ClaimToken {
			t.Fatalf("unexpected recovered migration record: %+v", recovered)
		}
	})

	t.Run("partial v003 table is refused before Sync2 mutates it", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		runner := newIntegrationRunner(t, "v003-partial-baseline")
		runner.migrations = runner.migrations[:2]

		if err := runner.upgradeDatabase(integrationDatabase); err != nil {
			t.Fatalf("prepare v002 baseline: %v", err)
		}

		sess := integrationDatabase.NewSession(nil)
		_, err := sess.Exec("CREATE TABLE pf_reconciliation_case (uid BIGINT NOT NULL)")
		sess.Close()

		if err != nil {
			t.Fatalf("create partial v003 table: %v", err)
		}

		store := integrationDataStore(t, integrationDatabase)
		err = Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "v003-partial"})

		if !errors.Is(err, ErrMigrationSchemaInvalid) {
			t.Fatalf("expected partial v003 schema error, got %v", err)
		}

		record := requireMigrationRecord(t, integrationDatabase, 3)

		if record.Success || record.FailureCode != "schema_preflight_failed" {
			t.Fatalf("unexpected v003 preflight record: %+v", record)
		}

		tables, readErr := readSchemaTables(integrationDatabase)

		if readErr != nil {
			t.Fatalf("read partial v003 schema after refusal: %v", readErr)
		}

		partialTable := findTable(tables, "pf_reconciliation_case")

		if partialTable == nil || len(partialTable.Columns()) != 1 || normalizeIdentifier(partialTable.Columns()[0].Name) != "uid" {
			t.Fatalf("v003 preflight refusal mutated partial table: %+v", partialTable)
		}
	})

	t.Run("partial v003 DDL failure resumes safely", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		baselineRunner := newIntegrationRunner(t, "v003-resume-baseline")
		baselineRunner.migrations = baselineRunner.migrations[:2]

		if err := baselineRunner.upgradeDatabase(integrationDatabase); err != nil {
			t.Fatalf("prepare v002 baseline: %v", err)
		}

		injectedFailure := errors.New("injected v003 migration failure")
		failingRunner := newIntegrationRunner(t, "v003-resume-failure")
		v003 := failingRunner.migrations[2]
		v003.steps = []migrationStep{
			v003.steps[0],
			{
				name: "inject_v003_failure",
				run: func(context.Context, *datastore.Database) error {
					return injectedFailure
				},
			},
		}
		failingRunner.migrations[2] = v003

		err := failingRunner.upgradeDatabase(integrationDatabase)

		if !errors.Is(err, injectedFailure) {
			t.Fatalf("expected injected v003 failure, got %v", err)
		}

		failed := requireMigrationRecord(t, integrationDatabase, 3)

		if failed.Success || failed.FailureCode != "migration_up_failed" {
			t.Fatalf("unexpected failed v003 record: %+v", failed)
		}

		store := integrationDataStore(t, integrationDatabase)
		requireUpgrade(t, store)

		if err = verifySchemaV006(integrationDatabase); err != nil {
			t.Fatalf("resumed through v006 schema is not exact: %v", err)
		}

		recovered := requireMigrationRecord(t, integrationDatabase, 3)

		if !recovered.Success || recovered.FirstStartedUnixTime != failed.FirstStartedUnixTime || recovered.ClaimToken == failed.ClaimToken {
			t.Fatalf("unexpected recovered v003 migration record: %+v", recovered)
		}
	})

	t.Run("partial v004 table is refused before Sync2 mutates it", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		runner := newIntegrationRunner(t, "v004-partial-baseline")
		runner.migrations = runner.migrations[:3]

		if err := runner.upgradeDatabase(integrationDatabase); err != nil {
			t.Fatalf("prepare v003 baseline: %v", err)
		}

		sess := integrationDatabase.NewSession(nil)
		_, err := sess.Exec("CREATE TABLE pf_loan_contract (uid BIGINT NOT NULL)")
		sess.Close()

		if err != nil {
			t.Fatalf("create partial v004 table: %v", err)
		}

		store := integrationDataStore(t, integrationDatabase)
		err = Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "v004-partial"})

		if !errors.Is(err, ErrMigrationSchemaInvalid) {
			t.Fatalf("expected partial v004 schema error, got %v", err)
		}

		record := requireMigrationRecord(t, integrationDatabase, 4)

		if record.Success || record.FailureCode != "schema_preflight_failed" {
			t.Fatalf("unexpected v004 preflight record: %+v", record)
		}

		tables, readErr := readSchemaTables(integrationDatabase)

		if readErr != nil {
			t.Fatalf("read partial v004 schema after refusal: %v", readErr)
		}

		partialTable := findTable(tables, "pf_loan_contract")

		if partialTable == nil || len(partialTable.Columns()) != 1 || normalizeIdentifier(partialTable.Columns()[0].Name) != "uid" {
			t.Fatalf("v004 preflight refusal mutated partial table: %+v", partialTable)
		}
	})

	t.Run("partial v004 DDL failure resumes safely", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		baselineRunner := newIntegrationRunner(t, "v004-resume-baseline")
		baselineRunner.migrations = baselineRunner.migrations[:3]

		if err := baselineRunner.upgradeDatabase(integrationDatabase); err != nil {
			t.Fatalf("prepare v003 baseline: %v", err)
		}

		injectedFailure := errors.New("injected v004 migration failure")
		failingRunner := newIntegrationRunner(t, "v004-resume-failure")
		v004 := failingRunner.migrations[3]
		v004.steps = []migrationStep{
			v004.steps[0],
			{
				name: "inject_v004_failure",
				run: func(context.Context, *datastore.Database) error {
					return injectedFailure
				},
			},
		}
		failingRunner.migrations[3] = v004

		err := failingRunner.upgradeDatabase(integrationDatabase)

		if !errors.Is(err, injectedFailure) {
			t.Fatalf("expected injected v004 failure, got %v", err)
		}

		failed := requireMigrationRecord(t, integrationDatabase, 4)

		if failed.Success || failed.FailureCode != "migration_up_failed" {
			t.Fatalf("unexpected failed v004 record: %+v", failed)
		}

		store := integrationDataStore(t, integrationDatabase)
		requireUpgrade(t, store)

		if err = verifySchemaV006(integrationDatabase); err != nil {
			t.Fatalf("resumed through v006 schema is not exact: %v", err)
		}

		recovered := requireMigrationRecord(t, integrationDatabase, 4)

		if !recovered.Success || recovered.FirstStartedUnixTime != failed.FirstStartedUnixTime || recovered.ClaimToken == failed.ClaimToken {
			t.Fatalf("unexpected recovered v004 migration record: %+v", recovered)
		}
	})

	t.Run("partial v005 table is refused before Sync2 mutates it", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		runner := newIntegrationRunner(t, "v005-partial-baseline")
		runner.migrations = runner.migrations[:4]

		if err := runner.upgradeDatabase(integrationDatabase); err != nil {
			t.Fatalf("prepare v004 baseline: %v", err)
		}

		sess := integrationDatabase.NewSession(nil)
		_, err := sess.Exec("CREATE TABLE pf_payment_account_mapping (uid BIGINT NOT NULL)")
		sess.Close()
		if err != nil {
			t.Fatalf("create partial v005 table: %v", err)
		}

		store := integrationDataStore(t, integrationDatabase)
		err = Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "v005-partial"})
		if !errors.Is(err, ErrMigrationSchemaInvalid) {
			t.Fatalf("expected partial v005 schema error, got %v", err)
		}

		record := requireMigrationRecord(t, integrationDatabase, 5)
		if record.Success || record.FailureCode != "schema_preflight_failed" {
			t.Fatalf("unexpected v005 preflight record: %+v", record)
		}

		tables, readErr := readSchemaTables(integrationDatabase)
		if readErr != nil {
			t.Fatalf("read partial v005 schema after refusal: %v", readErr)
		}
		partialTable := findTable(tables, "pf_payment_account_mapping")
		if partialTable == nil || len(partialTable.Columns()) != 1 || normalizeIdentifier(partialTable.Columns()[0].Name) != "uid" {
			t.Fatalf("v005 preflight refusal mutated partial table: %+v", partialTable)
		}
	})

	t.Run("partial v005 DDL failure resumes safely", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		baselineRunner := newIntegrationRunner(t, "v005-resume-baseline")
		baselineRunner.migrations = baselineRunner.migrations[:4]

		if err := baselineRunner.upgradeDatabase(integrationDatabase); err != nil {
			t.Fatalf("prepare v004 baseline: %v", err)
		}

		injectedFailure := errors.New("injected v005 migration failure")
		failingRunner := newIntegrationRunner(t, "v005-resume-failure")
		v005 := failingRunner.migrations[4]
		v005.steps = []migrationStep{
			v005.steps[0],
			{
				name: "inject_v005_failure",
				run: func(context.Context, *datastore.Database) error {
					return injectedFailure
				},
			},
		}
		failingRunner.migrations[4] = v005

		err := failingRunner.upgradeDatabase(integrationDatabase)
		if !errors.Is(err, injectedFailure) {
			t.Fatalf("expected injected v005 failure, got %v", err)
		}

		failed := requireMigrationRecord(t, integrationDatabase, 5)
		if failed.Success || failed.FailureCode != "migration_up_failed" {
			t.Fatalf("unexpected failed v005 record: %+v", failed)
		}

		store := integrationDataStore(t, integrationDatabase)
		requireUpgrade(t, store)
		if err = verifySchemaV006(integrationDatabase); err != nil {
			t.Fatalf("resumed v005 through v006 schema is not exact: %v", err)
		}

		recovered := requireMigrationRecord(t, integrationDatabase, 5)
		if !recovered.Success || recovered.FirstStartedUnixTime != failed.FirstStartedUnixTime || recovered.ClaimToken == failed.ClaimToken {
			t.Fatalf("unexpected recovered v005 migration record: %+v", recovered)
		}
	})

	t.Run("v005 advances continuously to v006", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		runner := newIntegrationRunner(t, "through-v005")
		runner.migrations = runner.migrations[:5]

		if err := runner.upgradeDatabase(integrationDatabase); err != nil {
			t.Fatalf("upgrade through v005: %v", err)
		}
		if err := verifySchemaV005(integrationDatabase); err != nil {
			t.Fatalf("v005 baseline is not exact: %v", err)
		}

		store := integrationDataStore(t, integrationDatabase)
		if err := Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "v005-to-v006"}); err != nil {
			t.Fatalf("advance v005 to v006: %v", err)
		}
		if err := verifySchemaV006(integrationDatabase); err != nil {
			t.Fatalf("v005 to v006 schema is not exact: %v", err)
		}

		record := requireMigrationRecord(t, integrationDatabase, 6)
		if !record.Success || record.AppliedUnixTime == nil || record.FailureCode != "" {
			t.Fatalf("unexpected v006 migration record: %+v", record)
		}
	})

	t.Run("partial v006 table is refused before Sync2 mutates it", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		runner := newIntegrationRunner(t, "v006-partial-baseline")
		runner.migrations = runner.migrations[:5]

		if err := runner.upgradeDatabase(integrationDatabase); err != nil {
			t.Fatalf("prepare v005 baseline: %v", err)
		}

		sess := integrationDatabase.NewSession(nil)
		_, err := sess.Exec("CREATE TABLE pf_billflow_task (uid BIGINT NOT NULL)")
		sess.Close()
		if err != nil {
			t.Fatalf("create partial v006 table: %v", err)
		}

		store := integrationDataStore(t, integrationDatabase)
		err = Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "v006-partial"})
		if !errors.Is(err, ErrMigrationSchemaInvalid) {
			t.Fatalf("expected partial v006 schema error, got %v", err)
		}

		record := requireMigrationRecord(t, integrationDatabase, 6)
		if record.Success || record.FailureCode != "schema_preflight_failed" {
			t.Fatalf("unexpected v006 preflight record: %+v", record)
		}

		tables, readErr := readSchemaTables(integrationDatabase)
		if readErr != nil {
			t.Fatalf("read partial v006 schema after refusal: %v", readErr)
		}
		partialTable := findTable(tables, "pf_billflow_task")
		if partialTable == nil || len(partialTable.Columns()) != 1 || normalizeIdentifier(partialTable.Columns()[0].Name) != "uid" {
			t.Fatalf("v006 preflight refusal mutated partial table: %+v", partialTable)
		}
	})

	t.Run("partial v006 DDL failure resumes safely", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		baselineRunner := newIntegrationRunner(t, "v006-resume-baseline")
		baselineRunner.migrations = baselineRunner.migrations[:5]

		if err := baselineRunner.upgradeDatabase(integrationDatabase); err != nil {
			t.Fatalf("prepare v005 baseline: %v", err)
		}

		injectedFailure := errors.New("injected v006 migration failure")
		failingRunner := newIntegrationRunner(t, "v006-resume-failure")
		v006 := failingRunner.migrations[5]
		v006.steps = []migrationStep{
			v006.steps[0],
			{
				name: "inject_v006_failure",
				run: func(context.Context, *datastore.Database) error {
					return injectedFailure
				},
			},
		}
		failingRunner.migrations[5] = v006

		err := failingRunner.upgradeDatabase(integrationDatabase)
		if !errors.Is(err, injectedFailure) {
			t.Fatalf("expected injected v006 failure, got %v", err)
		}

		failed := requireMigrationRecord(t, integrationDatabase, 6)
		if failed.Success || failed.FailureCode != "migration_up_failed" {
			t.Fatalf("unexpected failed v006 record: %+v", failed)
		}

		store := integrationDataStore(t, integrationDatabase)
		requireUpgrade(t, store)
		if err = verifySchemaV006(integrationDatabase); err != nil {
			t.Fatalf("resumed v006 schema is not exact: %v", err)
		}

		recovered := requireMigrationRecord(t, integrationDatabase, 6)
		if !recovered.Success || recovered.FirstStartedUnixTime != failed.FirstStartedUnixTime || recovered.ClaimToken == failed.ClaimToken {
			t.Fatalf("unexpected recovered v006 migration record: %+v", recovered)
		}
	})

	t.Run("v003 unique scopes match the frozen contract", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		store := integrationDataStore(t, integrationDatabase)
		requireUpgrade(t, store)
		now := requireDatabaseUnixTime(t, integrationDatabase)
		firstCase := reconciliationFixtureCase(1001, 101, strings.Repeat("1", 64), now)
		requireInsertBean(t, firstCase)

		duplicateCaseKey := *firstCase
		duplicateCaseKey.CaseId = 102
		requireInsertBeanFailure(t, &duplicateCaseKey)

		secondUserCase := *firstCase
		secondUserCase.Uid = 2002
		secondUserCase.CaseId = 201
		requireInsertBean(t, &secondUserCase)

		firstMember := &reconciliation.CaseMember{
			Uid:             firstCase.Uid,
			CaseId:          firstCase.CaseId,
			MemberOrder:     0,
			MemberKind:      reconciliation.MEMBER_KIND_SOURCE_IDENTITY,
			MemberRefId:     301,
			MemberRole:      reconciliation.MemberRole("anchor"),
			CreatedUnixTime: now,
			MemberId:        401,
		}
		requireInsertBean(t, firstMember)

		duplicateMemberOrder := *firstMember
		duplicateMemberOrder.MemberId = 402
		duplicateMemberOrder.MemberRefId = 302
		requireInsertBeanFailure(t, &duplicateMemberOrder)

		duplicateMemberReference := *firstMember
		duplicateMemberReference.MemberId = 403
		duplicateMemberReference.MemberOrder = 1
		requireInsertBeanFailure(t, &duplicateMemberReference)

		firstDecision := reconciliationFixtureDecision(firstCase.Uid, firstCase.CaseId, 501, strings.Repeat("2", 64), now)
		requireInsertBean(t, firstDecision)

		sameRevisionDifferentKey := *firstDecision
		sameRevisionDifferentKey.DecisionId = 502
		sameRevisionDifferentKey.IdempotencyKeyDigest = strings.Repeat("3", 64)
		sameRevisionDifferentKey.RequestDigest = strings.Repeat("4", 64)
		requireInsertBean(t, &sameRevisionDifferentKey)

		duplicateIdempotencyKey := *firstDecision
		duplicateIdempotencyKey.DecisionId = 503
		duplicateIdempotencyKey.RequestDigest = strings.Repeat("5", 64)
		requireInsertBeanFailure(t, &duplicateIdempotencyKey)

		firstLink := &reconciliation.TransactionLink{
			Uid:                        firstCase.Uid,
			DecisionId:                 firstDecision.DecisionId,
			RowId:                      601,
			TransactionId:              701,
			RelationRole:               reconciliation.TRANSACTION_RELATION_ROLE_PRIMARY,
			CreationMethod:             reconciliation.TRANSACTION_CREATION_METHOD_ATTACHED_EXISTING,
			RuleVersion:                reconciliation.TRANSACTION_LINK_VERSION_V1,
			TransactionUpdatedUnixTime: now,
			CreatedUnixTime:            now,
			LinkId:                     801,
		}
		requireInsertBean(t, firstLink)

		duplicateLink := *firstLink
		duplicateLink.LinkId = 802
		requireInsertBean(t, &duplicateLink)

		firstEffect := &reconciliation.LedgerEffect{
			Uid:                        firstCase.Uid,
			DecisionId:                 firstDecision.DecisionId,
			TransactionId:              firstLink.TransactionId,
			EffectType:                 reconciliation.LEDGER_EFFECT_TYPE_CREATED,
			TransactionUpdatedUnixTime: now,
			CreatedUnixTime:            now,
			EffectId:                   901,
		}
		requireInsertBean(t, firstEffect)

		duplicateEffect := *firstEffect
		duplicateEffect.EffectId = 902
		requireInsertBeanFailure(t, &duplicateEffect)

		differentEffectType := *firstEffect
		differentEffectType.EffectId = 903
		differentEffectType.EffectType = reconciliation.LEDGER_EFFECT_TYPE_SOFT_DELETED
		differentEffectType.TransactionDeletedUnixTime = &now
		requireInsertBean(t, &differentEffectType)
	})

	t.Run("v005 payment account mapping scope matches the frozen contract", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		store := integrationDataStore(t, integrationDatabase)
		requireUpgrade(t, store)
		now := requireDatabaseUnixTime(t, integrationDatabase)
		first := &importing.PaymentAccountMapping{
			Uid: 1001, SourceType: importing.SOURCE_TYPE_ALIPAY, Currency: "CNY",
			AliasKey: strings.Repeat("a", 64), AliasKeyVersion: importing.PAYMENT_ACCOUNT_ALIAS_VERSION_V1,
			LedgerAccountId: 101, MaskedDisplayName: "兴业银行信用卡(6106)",
			CreatedUnixTime: now, UpdatedUnixTime: now, MappingId: 201,
		}
		requireInsertBean(t, first)

		duplicateAlias := *first
		duplicateAlias.MappingId = 202
		duplicateAlias.LedgerAccountId = 102
		requireInsertBeanFailure(t, &duplicateAlias)

		differentCurrency := *first
		differentCurrency.MappingId = 203
		differentCurrency.Currency = "USD"
		requireInsertBean(t, &differentCurrency)

		differentSource := *first
		differentSource.MappingId = 204
		differentSource.SourceType = importing.SOURCE_TYPE_WECHAT
		requireInsertBean(t, &differentSource)

		differentUser := *first
		differentUser.MappingId = 205
		differentUser.Uid = 2002
		requireInsertBean(t, &differentUser)
	})

	t.Run("v006 unique scopes match the frozen contract", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		store := integrationDataStore(t, integrationDatabase)
		requireUpgrade(t, store)
		now := requireDatabaseUnixTime(t, integrationDatabase)

		firstTask := &billflow.Task{
			Uid: 1001, Status: billflow.TASK_STATUS_RECEIVING, ConfirmPolicy: billflow.CONFIRM_POLICY_AUTO_POST,
			Version: 1, CreatedUnixTime: now, UpdatedUnixTime: now, TaskId: 101,
		}
		requireInsertBean(t, firstTask)
		secondTask := *firstTask
		secondTask.TaskId = 102
		requireInsertBean(t, &secondTask)

		firstMember := &billflow.TaskMember{
			Uid: 1001, TaskId: 101, MemberOrder: 0, FileId: 201, BatchId: 301, CreatedUnixTime: now, MemberId: 401,
		}
		requireInsertBean(t, firstMember)
		duplicateFile := *firstMember
		duplicateFile.MemberId = 402
		duplicateFile.BatchId = 302
		requireInsertBeanFailure(t, &duplicateFile)
		duplicateBatch := *firstMember
		duplicateBatch.MemberId = 403
		duplicateBatch.TaskId = 102
		duplicateBatch.FileId = 202
		requireInsertBeanFailure(t, &duplicateBatch)
		secondUserMember := *firstMember
		secondUserMember.Uid = 2002
		secondUserMember.MemberId = 404
		requireInsertBean(t, &secondUserMember)

		firstAction := &billflow.Action{
			Uid: 1001, TaskId: 101, ExpectedTaskVersion: 1, ActionType: billflow.ACTION_TYPE_CREATE_TASK,
			IdempotencyKeyDigest: strings.Repeat("a", 64), IdempotencyKeyVersion: billflow.IDEMPOTENCY_KEY_VERSION_V1,
			RequestDigest: strings.Repeat("b", 64), RequestDigestVersion: billflow.ACTION_REQUEST_DIGEST_VERSION_V1,
			Status: billflow.ACTION_STATUS_READY, ReasonCodesJson: "[]", CreatedUnixTime: now, UpdatedUnixTime: now, ActionId: 501,
		}
		requireInsertBean(t, firstAction)
		duplicateAction := *firstAction
		duplicateAction.ActionId = 502
		duplicateAction.RequestDigest = strings.Repeat("c", 64)
		requireInsertBeanFailure(t, &duplicateAction)

		firstTodo := &billflow.Todo{
			Uid: 1001, TaskId: 101, TodoKind: billflow.TODO_KIND_UNCATEGORIZED, Status: billflow.TODO_STATUS_OPEN,
			SubjectKind: billflow.SUBJECT_KIND_TRANSACTION, SubjectId: 701, ReasonCodesJson: "[]",
			Version: 1, CreatedUnixTime: now, UpdatedUnixTime: now, TodoId: 601,
		}
		requireInsertBean(t, firstTodo)
		duplicateTodo := *firstTodo
		duplicateTodo.TodoId = 602
		requireInsertBeanFailure(t, &duplicateTodo)

		firstAlias := &billflow.CategoryAliasMapping{
			Uid: 1001, SourceType: importing.SOURCE_TYPE_ALIPAY, AliasKey: strings.Repeat("d", 64),
			AliasKeyVersion: billflow.CATEGORY_ALIAS_VERSION_V1, LedgerCategoryId: 11, MaskedDisplayName: "餐饮",
			CreatedUnixTime: now, UpdatedUnixTime: now, MappingId: 801,
		}
		requireInsertBean(t, firstAlias)
		duplicateAlias := *firstAlias
		duplicateAlias.MappingId = 802
		requireInsertBeanFailure(t, &duplicateAlias)

		firstCandidate := &installments.Candidate{
			Uid: 1001, CandidateKey: strings.Repeat("e", 64), CandidateKeyVersion: installments.CANDIDATE_KEY_VERSION_V1,
			Status: installments.CANDIDATE_STATUS_PENDING, Version: 1, PurchaseRelation: installments.PURCHASE_RELATION_UNRESOLVED,
			CreatedUnixTime: now, UpdatedUnixTime: now, CandidateId: 901,
		}
		requireInsertBean(t, firstCandidate)
		duplicateCandidate := *firstCandidate
		duplicateCandidate.CandidateId = 902
		requireInsertBeanFailure(t, &duplicateCandidate)

		firstCandidateMember := &installments.CandidateMember{
			Uid: 1001, CandidateId: 901, MemberKind: installments.MEMBER_KIND_RAW_ROW, MemberRefId: 1001,
			MemberRole: installments.MEMBER_ROLE_INSTALLMENT_CHARGE, CreatedUnixTime: now, MemberId: 1001,
		}
		requireInsertBean(t, firstCandidateMember)
		duplicateCandidateMember := *firstCandidateMember
		duplicateCandidateMember.MemberId = 1002
		requireInsertBeanFailure(t, &duplicateCandidateMember)

		firstReview := &cardcycle.BalanceReview{
			Uid: 1001, LedgerAccountId: 11, Status: cardcycle.BALANCE_REVIEW_UNVERIFIED,
			Version: 1, UpdatedUnixTime: now, ReviewId: 1101,
		}
		requireInsertBean(t, firstReview)
		duplicateReview := *firstReview
		duplicateReview.ReviewId = 1102
		requireInsertBeanFailure(t, &duplicateReview)

		firstRule := &cardcycle.CycleRule{
			Uid: 1001, LedgerAccountId: 11, RuleNumber: 1, StatementDay: 15, DueDay: 3,
			EffectiveFrom: "2026-08-01", Status: cardcycle.RULE_STATUS_ACTIVE, CreatedUnixTime: now, RuleId: 1201,
		}
		requireInsertBean(t, firstRule)
		duplicateRule := *firstRule
		duplicateRule.RuleId = 1202
		requireInsertBeanFailure(t, &duplicateRule)

		firstCoverage := &cardcycle.StatementCoverage{
			Uid: 1001, LedgerAccountId: 11, BatchId: 301, PeriodStart: "2026-07-16", PeriodEnd: "2026-08-15",
			CreatedUnixTime: now, CoverageId: 1301,
		}
		requireInsertBean(t, firstCoverage)
		duplicateCoverage := *firstCoverage
		duplicateCoverage.CoverageId = 1302
		requireInsertBeanFailure(t, &duplicateCoverage)

		firstRevision := &cardcycle.MonthReportRevision{
			Uid: 1001, YearMonth: "2026-07", TaskId: 101, ReasonCode: "late_statement", CreatedUnixTime: now, RevisionId: 1401,
		}
		requireInsertBean(t, firstRevision)
		secondRevision := *firstRevision
		secondRevision.RevisionId = 1402
		requireInsertBean(t, &secondRevision)
	})

	t.Run("incompatible existing schema is preserved and refused", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		sess := integrationDatabase.NewSession(nil)
		_, err := sess.Exec("CREATE TABLE pf_import_file (uid TEXT NOT NULL, file_id BIGINT NOT NULL PRIMARY KEY)")
		sess.Close()

		if err != nil {
			t.Fatalf("create incompatible schema: %v", err)
		}

		store := integrationDataStore(t, integrationDatabase)
		err = Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "incompatible"})

		if !errors.Is(err, ErrMigrationSchemaInvalid) {
			t.Fatalf("expected incompatible-schema error, got %v", err)
		}

		record := requireMigrationRecord(t, integrationDatabase, 1)

		if record.Success || record.FailureCode != "schema_preflight_failed" {
			t.Fatalf("unexpected incompatible-schema record: %+v", record)
		}
	})

	t.Run("partial existing table is refused before Sync2 mutates it", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		sess := integrationDatabase.NewSession(nil)
		_, err := sess.Exec("CREATE TABLE pf_import_file (uid BIGINT NOT NULL)")
		sess.Close()

		if err != nil {
			t.Fatalf("create partial schema: %v", err)
		}

		store := integrationDataStore(t, integrationDatabase)
		err = Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "partial-preflight"})

		if !errors.Is(err, ErrMigrationSchemaInvalid) {
			t.Fatalf("expected partial schema error, got %v", err)
		}

		tables, readErr := readSchemaTables(integrationDatabase)

		if readErr != nil {
			t.Fatalf("read partial schema after refusal: %v", readErr)
		}

		partialTable := findTable(tables, "pf_import_file")

		if partialTable == nil || len(partialTable.Columns()) != 1 || normalizeIdentifier(partialTable.Columns()[0].Name) != "uid" {
			t.Fatalf("preflight refusal mutated partial table: %+v", partialTable)
		}
	})

	t.Run("migration ledger itself is verified", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		sess := integrationDatabase.NewSession(nil)
		_, err := sess.Exec("CREATE TABLE pf_schema_migration (version BIGINT NOT NULL PRIMARY KEY)")
		sess.Close()

		if err != nil {
			t.Fatalf("create incompatible migration ledger: %v", err)
		}

		store := integrationDataStore(t, integrationDatabase)
		err = Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "ledger"})

		if !errors.Is(err, ErrMigrationSchemaInvalid) {
			t.Fatalf("expected migration-ledger schema error, got %v", err)
		}
	})

	t.Run("stale claim token is fenced", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		firstRunner := newIntegrationRunner(t, "first")
		secondRunner := newIntegrationRunner(t, "second")

		if err := firstRunner.bootstrapMigrationTable(integrationDatabase); err != nil {
			t.Fatalf("bootstrap migration table: %v", err)
		}

		item := registeredMigrations()[0]
		now := requireDatabaseUnixTime(t, integrationDatabase)
		firstClaim, alreadyApplied, err := firstRunner.claimMigration(integrationDatabase, item, nil, now)

		if err != nil || alreadyApplied {
			t.Fatalf("first claim failed: already=%t err=%v", alreadyApplied, err)
		}

		existing := requireMigrationRecord(t, integrationDatabase, 1)
		takeoverTime := existing.LeaseExpiresUnixTime + 1
		secondClaim, alreadyApplied, err := secondRunner.claimMigration(integrationDatabase, item, existing, takeoverTime)

		if err != nil || alreadyApplied {
			t.Fatalf("second claim takeover failed: already=%t err=%v", alreadyApplied, err)
		}

		assertClaimLost(t, firstRunner.renewMigrationLease(integrationDatabase, firstClaim))
		assertClaimLost(t, firstRunner.markMigrationFailed(integrationDatabase, firstClaim, "stale"))
		assertClaimLost(t, firstRunner.markMigrationSucceeded(integrationDatabase, firstClaim))

		if err = secondRunner.markMigrationFailed(integrationDatabase, secondClaim, "test_complete"); err != nil {
			t.Fatalf("release second claim: %v", err)
		}
	})

	t.Run("MySQL lock wait cannot renew an expired lease", func(t *testing.T) {
		if integrationDatabase.DatabaseType() != settings.MySqlDbType {
			t.Skip("MySQL statement time has the lock-wait edge case")
		}

		resetPersonalFinanceTables(t)
		runner := newIntegrationRunner(t, "mysql-lock-wait")
		runner.leaseSeconds = 2

		if err := runner.bootstrapMigrationTable(integrationDatabase); err != nil {
			t.Fatalf("bootstrap migration table: %v", err)
		}

		item := registeredMigrations()[0]
		now := requireDatabaseUnixTime(t, integrationDatabase)
		claim, alreadyApplied, err := runner.claimMigration(integrationDatabase, item, nil, now)

		if err != nil || alreadyApplied {
			t.Fatalf("claim migration: already=%t err=%v", alreadyApplied, err)
		}

		record := requireMigrationRecord(t, integrationDatabase, item.version)
		lockingDatabase := openIntegrationDatabase(t)
		lockingSession := lockingDatabase.NewSessionWithContext(context.Background())
		defer lockingSession.Close()

		if err = lockingSession.Begin(); err != nil {
			t.Fatalf("begin locking transaction: %v", err)
		}

		lockCommitted := false
		defer func() {
			if !lockCommitted {
				_ = lockingSession.Rollback()
			}
		}()

		lockedRecord := new(SchemaMigration)
		found, err := lockingSession.ForUpdate().Where("version=?", item.version).Get(lockedRecord)

		if err != nil || !found {
			t.Fatalf("lock migration row: found=%t err=%v", found, err)
		}

		renewDatabase := openIntegrationDatabase(t)
		renewResult := make(chan error, 1)
		go func() {
			renewResult <- runner.renewMigrationLease(renewDatabase, claim)
		}()

		select {
		case renewErr := <-renewResult:
			t.Fatalf("renewal did not wait for the ledger row lock: %v", renewErr)
		case <-time.After(100 * time.Millisecond):
		}

		deadline := time.Now().Add(10 * time.Second)

		for requireDatabaseUnixTime(t, integrationDatabase) <= record.LeaseExpiresUnixTime {
			if time.Now().After(deadline) {
				t.Fatal("database clock did not pass the test lease expiry")
			}

			time.Sleep(100 * time.Millisecond)
		}

		if err = lockingSession.Commit(); err != nil {
			t.Fatalf("release migration row lock: %v", err)
		}

		lockCommitted = true

		select {
		case renewErr := <-renewResult:
			assertClaimLost(t, renewErr)
		case <-time.After(5 * time.Second):
			t.Fatal("renewal did not finish after the ledger row lock was released")
		}
	})

	t.Run("takeover between time read and renewal fences old step", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		firstRunner := newIntegrationRunner(t, "checkpoint-first")
		secondRunner := newIntegrationRunner(t, "checkpoint-second")

		if err := firstRunner.bootstrapMigrationTable(integrationDatabase); err != nil {
			t.Fatalf("bootstrap migration table: %v", err)
		}

		item := registeredMigrations()[0]
		now := requireDatabaseUnixTime(t, integrationDatabase)
		firstClaim, alreadyApplied, err := firstRunner.claimMigration(integrationDatabase, item, nil, now)

		if err != nil || alreadyApplied {
			t.Fatalf("first claim failed: already=%t err=%v", alreadyApplied, err)
		}

		existing := requireMigrationRecord(t, integrationDatabase, 1)
		takeoverTime := existing.LeaseExpiresUnixTime + 1
		secondClaim, alreadyApplied, err := secondRunner.claimMigration(integrationDatabase, item, existing, takeoverTime)

		if err != nil || alreadyApplied {
			t.Fatalf("second claim during checkpoint: already=%t err=%v", alreadyApplied, err)
		}

		preflightRan := false
		item.preflight = func(context.Context, *datastore.Database) error {
			preflightRan = true
			return nil
		}
		heartbeat := &migrationHeartbeat{lost: make(chan struct{})}
		_, err = firstRunner.runClaimedMigration(integrationDatabase, item, firstClaim, heartbeat)

		if !errors.Is(err, ErrMigrationClaimLost) || preflightRan {
			t.Fatalf("stale runner entered a migration step: preflight=%t err=%v", preflightRan, err)
		}

		if err = secondRunner.markMigrationFailed(integrationDatabase, secondClaim, "test_complete"); err != nil {
			t.Fatalf("release takeover claim: %v", err)
		}
	})

	t.Run("concurrent runners acquire exactly one claim", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		firstDatabase := openIntegrationDatabase(t)
		secondDatabase := openIntegrationDatabase(t)
		firstRunner := newIntegrationRunner(t, "concurrent-first")
		secondRunner := newIntegrationRunner(t, "concurrent-second")

		if err := firstRunner.bootstrapMigrationTable(firstDatabase); err != nil {
			t.Fatalf("bootstrap migration table: %v", err)
		}

		item := registeredMigrations()[0]
		now := requireDatabaseUnixTime(t, firstDatabase)
		start := make(chan struct{})
		results := make(chan concurrentClaimResult, 2)

		go claimConcurrently(start, results, firstRunner, firstDatabase, item, now)
		go claimConcurrently(start, results, secondRunner, secondDatabase, item, now)
		close(start)

		firstResult := <-results
		secondResult := <-results
		claimResults := []concurrentClaimResult{firstResult, secondResult}
		winnerCount := 0
		var winner concurrentClaimResult

		for _, result := range claimResults {
			if result.err == nil && !result.alreadyApplied {
				winnerCount++
				winner = result
			}
		}

		if winnerCount != 1 {
			t.Fatalf("expected exactly one claim winner, got %+v", claimResults)
		}

		if firstResult.err == nil && secondResult.err == nil {
			t.Fatalf("both concurrent runners reported success: %+v", claimResults)
		}

		for _, result := range claimResults {
			if result.err != nil && !errors.Is(result.err, ErrMigrationInProgress) && !errors.Is(result.err, ErrMigrationClaimLost) {
				t.Fatalf("concurrent loser failed for an unexpected reason: %v", result.err)
			}
		}

		if err := winner.runner.markMigrationFailed(winner.database, winner.claim, "test_complete"); err != nil {
			t.Fatalf("release concurrent winner: %v", err)
		}

		records := readMigrationRecords(t, integrationDatabase)

		if len(records) != 1 {
			t.Fatalf("expected one durable claim record, got %d", len(records))
		}
	})

	t.Run("repository queries are isolated by uid", func(t *testing.T) {
		resetPersonalFinanceTables(t)
		store := integrationDataStore(t, integrationDatabase)
		requireUpgrade(t, store)
		repository, err := importing.NewRepository(store)

		if err != nil {
			t.Fatalf("create personal finance repository: %v", err)
		}

		const firstUid = int64(1001)
		const secondUid = int64(2002)
		const firstBaseId = int64(1100)
		const secondBaseId = int64(2100)
		fileSHA256 := strings.Repeat("1", 64)
		sourceAccountKey := strings.Repeat("2", 64)
		identityKey := strings.Repeat("3", 64)
		coreDigest := strings.Repeat("4", 64)
		insertRepositoryFixture(t, firstUid, firstBaseId, fileSHA256, sourceAccountKey, identityKey, coreDigest)
		insertRepositoryFixture(t, secondUid, secondBaseId, fileSHA256, sourceAccountKey, identityKey, coreDigest)

		if record, findErr := repository.FindImportFileById(nil, firstUid, secondBaseId+1); findErr != nil || record != nil {
			t.Fatalf("cross-user import file was visible: record=%+v err=%v", record, findErr)
		}

		if record, findErr := repository.FindImportFileBySHA256(nil, firstUid, fileSHA256); findErr != nil || record == nil || record.Uid != firstUid || record.FileId != firstBaseId+1 {
			t.Fatalf("file hash lookup escaped uid: record=%+v err=%v", record, findErr)
		}

		if record, findErr := repository.FindImportFileBySHA256(nil, secondUid, fileSHA256); findErr != nil || record == nil || record.Uid != secondUid || record.FileId != secondBaseId+1 {
			t.Fatalf("second user's file hash lookup escaped uid: record=%+v err=%v", record, findErr)
		}

		if record, findErr := repository.FindSourceAccountById(nil, firstUid, secondBaseId+2); findErr != nil || record != nil {
			t.Fatalf("cross-user source account was visible: record=%+v err=%v", record, findErr)
		}

		if record, findErr := repository.FindSourceAccountByKey(nil, firstUid, importing.SOURCE_TYPE_ALIPAY, sourceAccountKey); findErr != nil || record == nil || record.Uid != firstUid || record.SourceAccountId != firstBaseId+2 {
			t.Fatalf("source account key lookup escaped uid: record=%+v err=%v", record, findErr)
		}

		if record, findErr := repository.FindSourceAccountByKey(nil, secondUid, importing.SOURCE_TYPE_ALIPAY, sourceAccountKey); findErr != nil || record == nil || record.Uid != secondUid || record.SourceAccountId != secondBaseId+2 {
			t.Fatalf("second user's source account key lookup escaped uid: record=%+v err=%v", record, findErr)
		}

		if record, findErr := repository.FindImportBatchById(nil, firstUid, secondBaseId+3); findErr != nil || record != nil {
			t.Fatalf("cross-user import batch was visible: record=%+v err=%v", record, findErr)
		}

		if record, findErr := repository.FindSourceIdentityByKey(nil, firstUid, identityKey); findErr != nil || record == nil || record.Uid != firstUid || record.IdentityId != firstBaseId+4 {
			t.Fatalf("source identity lookup escaped uid: record=%+v err=%v", record, findErr)
		}

		if record, findErr := repository.FindSourceIdentityByKey(nil, secondUid, identityKey); findErr != nil || record == nil || record.Uid != secondUid || record.IdentityId != secondBaseId+4 {
			t.Fatalf("second user's source identity lookup escaped uid: record=%+v err=%v", record, findErr)
		}

		if record, findErr := repository.FindRawImportRowById(nil, firstUid, secondBaseId+5); findErr != nil || record != nil {
			t.Fatalf("cross-user raw row was visible: record=%+v err=%v", record, findErr)
		}

		if record, findErr := repository.FindRawImportRowById(nil, secondUid, secondBaseId+5); findErr != nil || record == nil ||
			record.Currency != "" || record.ObservedSourceIdentityKey != "" || record.ObservedSourceCoreDigest != "" {
			t.Fatalf("empty raw-row sentinels did not round-trip exactly: record=%+v err=%v", record, findErr)
		}

		rows, listErr := repository.ListRawImportRows(nil, firstUid, secondBaseId+3)

		if listErr != nil || len(rows) != 0 {
			t.Fatalf("cross-user batch rows were visible: rows=%+v err=%v", rows, listErr)
		}

		rows, listErr = repository.ListRawImportRows(nil, firstUid, firstBaseId+3)

		if listErr != nil || len(rows) != 1 || rows[0].Uid != firstUid || rows[0].RowId != firstBaseId+5 {
			t.Fatalf("own batch rows lookup failed: rows=%+v err=%v", rows, listErr)
		}
	})
}

type concurrentClaimResult struct {
	runner         *migrationRunner
	database       *datastore.Database
	claim          *migrationClaim
	alreadyApplied bool
	err            error
}

func claimConcurrently(start <-chan struct{}, results chan<- concurrentClaimResult, runner *migrationRunner, db *datastore.Database, item migration, now int64) {
	<-start
	claim, alreadyApplied, err := runner.claimMigration(db, item, nil, now)
	results <- concurrentClaimResult{
		runner:         runner,
		database:       db,
		claim:          claim,
		alreadyApplied: alreadyApplied,
		err:            err,
	}
}

func integrationDatabaseConfig() (*settings.DatabaseConfig, error) {
	if os.Getenv("PF_DB_TEST_SENTINEL") != integrationDatabaseSentinel {
		return nil, fmt.Errorf("isolated Compose sentinel is missing")
	}

	databaseType := os.Getenv("EBK_DATABASE_TYPE")
	config := &settings.DatabaseConfig{
		DatabaseType:          databaseType,
		DatabaseHost:          os.Getenv("EBK_DATABASE_HOST"),
		DatabaseName:          os.Getenv("EBK_DATABASE_NAME"),
		DatabaseUser:          os.Getenv("EBK_DATABASE_USER"),
		DatabasePassword:      os.Getenv("EBK_DATABASE_PASSWD"),
		DatabaseSSLMode:       os.Getenv("EBK_DATABASE_SSL_MODE"),
		DatabasePath:          os.Getenv("EBK_DATABASE_DB_PATH"),
		MaxIdleConnection:     2,
		MaxOpenConnection:     8,
		ConnectionMaxLifeTime: 60,
	}

	switch databaseType {
	case settings.Sqlite3DbType:
		path := filepath.Clean(config.DatabasePath)

		if !filepath.IsAbs(path) || !strings.HasPrefix(path, "/testwork/") {
			return nil, fmt.Errorf("SQLite path must be inside /testwork")
		}

		config.DatabasePath = path
	case settings.MySqlDbType:
		if config.DatabaseName != "ezbookkeeping_pf_test" {
			return nil, fmt.Errorf("database name must be ezbookkeeping_pf_test")
		}

		if config.DatabaseHost != "mysql:3306" || config.DatabaseUser != "pf_test" || config.DatabasePassword != "pf_test_password" {
			return nil, fmt.Errorf("MySQL must use the isolated Compose service and synthetic credentials")
		}
	case settings.PostgresDbType:
		if config.DatabaseName != "ezbookkeeping_pf_test" {
			return nil, fmt.Errorf("database name must be ezbookkeeping_pf_test")
		}

		if config.DatabaseHost != "postgres:5432" || config.DatabaseUser != "pf_test" ||
			config.DatabasePassword != "pf_test_password" || config.DatabaseSSLMode != "disable" {
			return nil, fmt.Errorf("PostgreSQL must use the isolated Compose service and synthetic credentials")
		}
	default:
		return nil, fmt.Errorf("unsupported database type %q", databaseType)
	}

	return config, nil
}

func resetPersonalFinanceTables(t *testing.T) {
	t.Helper()

	if err := cleanupPersonalFinanceTables(integrationDatabase); err != nil {
		t.Fatalf("reset personal finance tables: %v", err)
	}

	t.Cleanup(func() {
		if err := cleanupPersonalFinanceTables(integrationDatabase); err != nil {
			t.Errorf("clean personal finance tables: %v", err)
		}
	})
}

func cleanupPersonalFinanceTables(db *datastore.Database) error {
	tables := []string{
		"pf_month_report_revision",
		"pf_card_statement_coverage",
		"pf_card_cycle_rule",
		"pf_account_balance_review",
		"pf_installment_candidate_member",
		"pf_installment_candidate",
		"pf_category_alias_mapping",
		"pf_billflow_todo",
		"pf_billflow_action",
		"pf_billflow_task_member",
		"pf_billflow_task",
		"pf_payment_account_mapping",
		"pf_loan_transaction_allocation",
		"pf_loan_transaction_binding",
		"pf_loan_action",
		"pf_loan_installment",
		"pf_loan_contract_revision",
		"pf_loan_contract",
		"pf_reconciliation_ledger_effect",
		"pf_reconciliation_transaction_link",
		"pf_reconciliation_decision",
		"pf_reconciliation_case_member",
		"pf_reconciliation_case",
		"pf_raw_row_transaction_link",
		"pf_import_batch_issue",
		"pf_import_posting",
		"pf_raw_import_row",
		"pf_source_identity",
		"pf_import_batch",
		"pf_source_account",
		"pf_import_file",
		"pf_schema_migration",
	}

	for _, tableName := range tables {
		sess := db.NewSession(nil)
		_, err := sess.Exec("DROP TABLE IF EXISTS " + tableName)
		sess.Close()

		if err != nil {
			return fmt.Errorf("drop test table %s: %w", tableName, err)
		}
	}

	if db.DatabaseType() == settings.PostgresDbType {
		sess := db.NewSession(nil)
		_, err := sess.Exec("DROP FUNCTION IF EXISTS pf_test_trigger_function()")
		sess.Close()

		if err != nil {
			return fmt.Errorf("drop PostgreSQL test trigger function: %w", err)
		}
	}

	return nil
}

func createForbiddenTrigger(t *testing.T) {
	t.Helper()
	statements := []string(nil)

	switch integrationDatabase.DatabaseType() {
	case settings.Sqlite3DbType:
		statements = []string{"CREATE TRIGGER pf_test_trigger AFTER INSERT ON pf_import_file BEGIN SELECT 1; END"}
	case settings.MySqlDbType:
		statements = []string{"CREATE TRIGGER pf_test_trigger BEFORE INSERT ON pf_import_file FOR EACH ROW SET NEW.original_file_name=NEW.original_file_name"}
	case settings.PostgresDbType:
		statements = []string{
			"CREATE FUNCTION pf_test_trigger_function() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
			"CREATE TRIGGER pf_test_trigger BEFORE INSERT ON pf_import_file FOR EACH ROW EXECUTE FUNCTION pf_test_trigger_function()",
		}
	default:
		t.Fatalf("unsupported integration database type %s", integrationDatabase.DatabaseType())
	}

	for _, statement := range statements {
		sess := integrationDatabase.NewSession(nil)
		_, err := sess.Exec(statement)
		sess.Close()

		if err != nil {
			t.Fatalf("create forbidden trigger fixture: %v", err)
		}
	}
}

func weakenIdentityUniqueIndex(t *testing.T) {
	t.Helper()
	dropSQL := "DROP INDEX UQE_pf_source_identity_uid_key"
	createSQL := ""

	switch integrationDatabase.DatabaseType() {
	case settings.Sqlite3DbType:
		createSQL = "CREATE UNIQUE INDEX UQE_pf_source_identity_uid_key ON pf_source_identity(uid, source_identity_key) WHERE 0"
	case settings.MySqlDbType:
		dropSQL = "DROP INDEX UQE_pf_source_identity_uid_key ON pf_source_identity"
		createSQL = "CREATE UNIQUE INDEX UQE_pf_source_identity_uid_key ON pf_source_identity(uid, source_identity_key(1))"
	case settings.PostgresDbType:
		dropSQL = `DROP INDEX "UQE_pf_source_identity_uid_key"`
		createSQL = `CREATE UNIQUE INDEX "UQE_pf_source_identity_uid_key" ON pf_source_identity(uid, source_identity_key) WHERE false`
	default:
		t.Fatalf("unsupported integration database type %s", integrationDatabase.DatabaseType())
	}

	sess := integrationDatabase.NewSession(nil)
	_, err := sess.Exec(dropSQL)
	sess.Close()

	if err != nil {
		t.Fatalf("drop identity unique index: %v", err)
	}

	sess = integrationDatabase.NewSession(nil)
	_, err = sess.Exec(createSQL)
	sess.Close()

	if err != nil {
		t.Fatalf("create weakened identity unique index: %v", err)
	}
}

func openIntegrationDatabase(t *testing.T) *datastore.Database {
	t.Helper()
	config := *integrationConfig
	db, err := datastore.OpenDatabase(&config)

	if err != nil {
		t.Fatalf("open independent integration database: %v", err)
	}

	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close independent integration database: %v", err)
		}
	})
	return db
}

func integrationDataStore(t *testing.T, db *datastore.Database) *datastore.DataStore {
	t.Helper()
	store, err := datastore.NewDataStore(db)

	if err != nil {
		t.Fatalf("create integration data store: %v", err)
	}

	return store
}

func newIntegrationRunner(t *testing.T, commit string) *migrationRunner {
	t.Helper()
	runnerId, err := newRandomHex(migrationRunnerIdByteCount)

	if err != nil {
		t.Fatalf("create migration runner id: %v", err)
	}

	return &migrationRunner{
		applicationInfo: ApplicationInfo{Version: "integration", Commit: commit},
		runnerId:        runnerId,
		databaseNow:     currentDatabaseUnixTimeWithContext,
		leaseSeconds:    migrationLeaseSeconds,
		migrations:      registeredMigrations(),
	}
}

func requireUpgrade(t *testing.T, store *datastore.DataStore) {
	t.Helper()

	if err := Upgrade(nil, store, ApplicationInfo{Version: "integration", Commit: "test"}); err != nil {
		t.Fatalf("upgrade personal finance schema: %v", err)
	}
}

func requireDatabaseUnixTime(t *testing.T, db *datastore.Database) int64 {
	t.Helper()
	now, err := currentDatabaseUnixTime(db)

	if err != nil {
		t.Fatalf("read database time: %v", err)
	}

	return now
}

func requireMigrationRecord(t *testing.T, db *datastore.Database, version int64) *SchemaMigration {
	t.Helper()
	sess := db.NewSession(nil)
	defer sess.Close()
	record := new(SchemaMigration)
	found, err := sess.ID(version).Get(record)

	if err != nil || !found {
		t.Fatalf("read migration %d: found=%t err=%v", version, found, err)
	}

	return record
}

func readMigrationRecords(t *testing.T, db *datastore.Database) []*SchemaMigration {
	t.Helper()
	sess := db.NewSession(nil)
	defer sess.Close()
	records := make([]*SchemaMigration, 0)

	if err := sess.Asc("version").Find(&records); err != nil {
		t.Fatalf("read migration records: %v", err)
	}

	return records
}

func insertMigrationRecord(t *testing.T, db *datastore.Database, record *SchemaMigration) {
	t.Helper()
	sess := db.NewSession(nil)
	inserted, err := sess.Insert(record)
	sess.Close()

	if err != nil || inserted != 1 {
		t.Fatalf("insert migration record: inserted=%d err=%v", inserted, err)
	}
}

func insertRepositoryFixture(t *testing.T, uid int64, baseId int64, fileSHA256 string, sourceAccountKey string, identityKey string, coreDigest string) {
	t.Helper()
	now := requireDatabaseUnixTime(t, integrationDatabase)
	fileId := baseId + 1
	sourceAccountId := baseId + 2
	batchId := baseId + 3
	identityId := baseId + 4
	rowId := baseId + 5
	file := &importing.ImportFile{
		Uid:              uid,
		ContentState:     importing.IMPORT_FILE_CONTENT_STATE_AVAILABLE,
		OriginalFileName: "sanitized.csv",
		FileSize:         128,
		FileSha256:       fileSHA256,
		MimeType:         "text/csv",
		FileExtension:    ".csv",
		StorageObjectKey: "pf/test/object",
		CreatedIp:        "127.0.0.1",
		CreatedUnixTime:  now,
		UpdatedUnixTime:  now,
		FileId:           fileId,
	}
	account := &importing.SourceAccount{
		Uid:                     uid,
		SourceType:              importing.SOURCE_TYPE_ALIPAY,
		SourceAccountKey:        sourceAccountKey,
		SourceAccountKeyVersion: importing.SOURCE_ACCOUNT_KEY_VERSION_V1,
		Status:                  importing.SOURCE_ACCOUNT_STATUS_ACTIVE,
		MaskedDisplayName:       "test***account",
		DiscoveryMethod:         importing.SOURCE_ACCOUNT_DISCOVERY_USER_SELECTED,
		CreatedUnixTime:         now,
		UpdatedUnixTime:         now,
		SourceAccountId:         sourceAccountId,
	}
	batch := &importing.ImportBatch{
		Uid:                  uid,
		FileId:               fileId,
		SourceAccountId:      &sourceAccountId,
		Status:               importing.IMPORT_BATCH_STATUS_READY,
		SourceTypeSnapshot:   importing.SOURCE_TYPE_ALIPAY,
		ParserName:           "integration",
		ParserVersion:        "parser-v1",
		NormalizationVersion: "normalization-v1",
		IdentityKeyVersion:   importing.IDENTITY_KEY_VERSION_V1,
		CoreDigestVersion:    importing.CORE_DIGEST_VERSION_V1,
		FingerprintVersion:   importing.FINGERPRINT_VERSION_V1,
		RawSnapshotVersion:   importing.RAW_SNAPSHOT_VERSION_V1,
		ParseOptionsDigest:   strings.Repeat("5", 64),
		TotalRowCount:        1,
		InvalidRowCount:      1,
		ErrorCode:            "",
		ErrorSummary:         "",
		CreatedUnixTime:      now,
		CompletedUnixTime:    &now,
		UpdatedUnixTime:      now,
		BatchId:              batchId,
	}
	identity := &importing.SourceIdentity{
		Uid:                uid,
		SourceAccountId:    sourceAccountId,
		IdentityKind:       importing.IDENTITY_KIND_SOURCE_TRANSACTION_ID,
		SourceIdentityKey:  identityKey,
		SourceCoreDigest:   coreDigest,
		IdentityKeyVersion: importing.IDENTITY_KEY_VERSION_V1,
		CoreDigestVersion:  importing.CORE_DIGEST_VERSION_V1,
		FingerprintVersion: importing.FINGERPRINT_VERSION_V1,
		FirstSeenUnixTime:  now,
		LastSeenUnixTime:   now,
		IdentityId:         identityId,
	}
	row := &importing.RawImportRow{
		Uid:                  uid,
		BatchId:              batchId,
		ParseState:           importing.PARSE_STATE_INVALID,
		IdentityState:        importing.IDENTITY_STATE_NOT_EVALUATED,
		ProcessingState:      importing.PROCESSING_STATE_IGNORED,
		RowNumber:            1,
		SourceLocator:        "v1:csv:2:2",
		RawFieldsJson:        "[]",
		IssuesJson:           "[]",
		RawSnapshotVersion:   importing.RAW_SNAPSHOT_VERSION_V1,
		ParserVersion:        "parser-v1",
		NormalizationVersion: "normalization-v1",
		IdentityKeyVersion:   importing.IDENTITY_KEY_VERSION_V1,
		CoreDigestVersion:    importing.CORE_DIGEST_VERSION_V1,
		FingerprintVersion:   importing.FINGERPRINT_VERSION_V1,
		SemanticEligibility:  importing.SEMANTIC_ELIGIBILITY_NON_POSTABLE,
		Disposition:          importing.IMPORT_DISPOSITION_NON_POSTABLE,
		CreatedUnixTime:      now,
		RowId:                rowId,
	}
	sess := integrationDatabase.NewSession(nil)
	defer sess.Close()

	for _, bean := range []any{file, account, batch, identity, row} {
		inserted, err := sess.Insert(bean)

		if err != nil || inserted != 1 {
			t.Fatalf("insert repository fixture %T: inserted=%d err=%v", bean, inserted, err)
		}
	}
}

func reconciliationFixtureCase(uid int64, caseId int64, caseKey string, now int64) *reconciliation.Case {
	return &reconciliation.Case{
		Uid:                   uid,
		CaseKey:               caseKey,
		CaseKeyVersion:        reconciliation.CASE_KEY_VERSION_V1,
		Status:                reconciliation.CASE_STATUS_OPEN,
		Version:               0,
		MemberCount:           2,
		SuggestedRelationType: reconciliation.DECISION_TYPE_SAME_EVENT,
		CandidateScore:        100,
		CandidateRuleVersion:  reconciliation.CANDIDATE_RULE_VERSION_V1,
		ExplanationVersion:    reconciliation.EXPLANATION_VERSION_V1,
		ReasonCodesJson:       "[]",
		CreatedUnixTime:       now,
		LastEvaluatedUnixTime: now,
		UpdatedUnixTime:       now,
		CaseId:                caseId,
	}
}

func reconciliationFixtureDecision(uid int64, caseId int64, decisionId int64, idempotencyDigest string, now int64) *reconciliation.Decision {
	return &reconciliation.Decision{
		Uid:                   uid,
		CaseId:                caseId,
		ExpectedCaseVersion:   0,
		AppliedCaseVersion:    1,
		DecisionType:          reconciliation.DECISION_TYPE_SAME_EVENT,
		IdempotencyKeyDigest:  idempotencyDigest,
		IdempotencyKeyVersion: reconciliation.IDEMPOTENCY_KEY_VERSION_V1,
		RequestDigest:         strings.Repeat("a", 64),
		RequestDigestVersion:  reconciliation.DECISION_REQUEST_VERSION_V1,
		Status:                reconciliation.DECISION_STATUS_APPLIED,
		FieldSelectionJson:    "{}",
		ReasonCodesJson:       "[]",
		ErrorCode:             "",
		CreatedUnixTime:       now,
		StartedUnixTime:       &now,
		CompletedUnixTime:     &now,
		UpdatedUnixTime:       now,
		DecisionId:            decisionId,
	}
}

func requireInsertBean(t *testing.T, bean any) {
	t.Helper()
	sess := integrationDatabase.NewSession(nil)
	inserted, err := sess.Insert(bean)
	sess.Close()

	if err != nil || inserted != 1 {
		t.Fatalf("insert %T: inserted=%d err=%v", bean, inserted, err)
	}
}

func requireInsertBeanFailure(t *testing.T, bean any) {
	t.Helper()
	sess := integrationDatabase.NewSession(nil)
	_, err := sess.Insert(bean)
	sess.Close()

	if err == nil {
		t.Fatalf("expected insert %T to violate a frozen unique constraint", bean)
	}
}

func failedOrActiveRecord(item migration, now int64, failureCode string, leaseExpires int64) *SchemaMigration {
	return &SchemaMigration{
		Version:              item.version,
		Name:                 item.name,
		Checksum:             item.checksum,
		ApplicationVersion:   "previous",
		ApplicationCommit:    "previous",
		RunnerId:             strings.Repeat("a", 32),
		ClaimToken:           strings.Repeat("b", 32),
		FirstStartedUnixTime: now,
		StartedUnixTime:      now,
		UpdatedUnixTime:      now,
		LeaseExpiresUnixTime: leaseExpires,
		Success:              false,
		FailureCode:          failureCode,
	}
}

func assertClaimLost(t *testing.T, err error) {
	t.Helper()

	if !errors.Is(err, ErrMigrationClaimLost) {
		t.Fatalf("expected stale claim to be fenced, got %v", err)
	}
}
