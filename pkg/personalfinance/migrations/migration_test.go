package migrations

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func TestSchemaV001ChecksumGolden(t *testing.T) {
	migrations := registeredMigrations()

	if len(migrations) != 1 {
		t.Fatalf("unexpected registered migration count %d", len(migrations))
	}

	const expectedChecksum = "71ca2be439df0fadab021905b4ffd2a21dcd814bc8903f47759287574d692193"

	if migrations[0].version != 1 || migrations[0].name != "initial_import_evidence_schema" || migrations[0].checksum != expectedChecksum {
		t.Fatalf("v001 identity changed: version=%d name=%s checksum=%s", migrations[0].version, migrations[0].name, migrations[0].checksum)
	}

	if !strings.Contains(canonicalSchemaManifestV001(), "table=pf_schema_migration\n") ||
		!strings.Contains(canonicalSchemaManifestV001(), "table=pf_raw_import_row\n") ||
		!strings.Contains(canonicalSchemaManifestV001(), "SMALLINT NULL") {
		t.Fatal("v001 manifest does not include the frozen ledger, raw rows, and SMALLINT fields")
	}
}

func TestMigrationHeartbeatStopIsBoundedAndIdempotent(t *testing.T) {
	heartbeat := &migrationHeartbeat{
		stop:     make(chan struct{}),
		done:     make(chan error),
		lost:     make(chan struct{}),
		stopped:  make(chan struct{}),
		stopWait: 10 * time.Millisecond,
	}
	started := time.Now()
	firstErr := heartbeat.Stop()

	if firstErr == nil || time.Since(started) > time.Second {
		t.Fatalf("heartbeat stop was not bounded: elapsed=%s err=%v", time.Since(started), firstErr)
	}

	started = time.Now()
	secondErr := heartbeat.Stop()

	if secondErr == nil || secondErr.Error() != firstErr.Error() || time.Since(started) > time.Second {
		t.Fatalf("heartbeat stop was not idempotent: elapsed=%s first=%v second=%v", time.Since(started), firstErr, secondErr)
	}
}

func TestValidateAppliedMigrationsRequiresContiguousHistory(t *testing.T) {
	registered := registeredMigrations()
	records := []*SchemaMigration{
		{
			Version:  2,
			Name:     "future",
			Checksum: strings.Repeat("f", 64),
			Success:  true,
		},
	}

	err := validateAppliedMigrations(records, registered)

	if !errors.Is(err, ErrMigrationRegistryInvalid) {
		t.Fatalf("expected non-contiguous history to fail, got %v", err)
	}
}

func TestValidateMigrationRegistryRequiresVersionsFromOneWithoutGaps(t *testing.T) {
	first := registeredMigrations()[0]
	startsAtTwo := first
	startsAtTwo.version = 2

	if err := validateMigrationRegistry([]migration{startsAtTwo}); !errors.Is(err, ErrMigrationRegistryInvalid) {
		t.Fatalf("registry starting at version 2 was accepted: %v", err)
	}

	third := first
	third.version = 3
	third.name = "third"

	if err := validateMigrationRegistry([]migration{first, third}); !errors.Is(err, ErrMigrationRegistryInvalid) {
		t.Fatalf("registry with a version gap was accepted: %v", err)
	}
}

func TestRuntimeModelsMatchFrozenSchemaV001(t *testing.T) {
	pairs := []struct {
		frozen  any
		runtime any
	}{
		{new(importFileV001), new(importing.ImportFile)},
		{new(sourceAccountV001), new(importing.SourceAccount)},
		{new(importBatchV001), new(importing.ImportBatch)},
		{new(sourceIdentityV001), new(importing.SourceIdentity)},
		{new(rawImportRowV001), new(importing.RawImportRow)},
	}

	for _, pair := range pairs {
		frozenType := reflect.TypeOf(pair.frozen).Elem()
		runtimeType := reflect.TypeOf(pair.runtime).Elem()

		if frozenType.NumField() != runtimeType.NumField() {
			t.Fatalf("runtime model %s has %d fields, frozen v001 has %d", runtimeType.Name(), runtimeType.NumField(), frozenType.NumField())
		}

		for index := 0; index < frozenType.NumField(); index++ {
			frozenField := frozenType.Field(index)
			runtimeField := runtimeType.Field(index)

			if frozenField.Name != runtimeField.Name || frozenField.Tag.Get("xorm") != runtimeField.Tag.Get("xorm") {
				t.Fatalf("runtime model %s field %d differs from v001: runtime=%s %q frozen=%s %q",
					runtimeType.Name(), index, runtimeField.Name, runtimeField.Tag.Get("xorm"), frozenField.Name, frozenField.Tag.Get("xorm"))
			}
		}
	}
}
