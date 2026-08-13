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

	if len(migrations) != 2 {
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

func TestSchemaV002ChecksumGolden(t *testing.T) {
	migrations := registeredMigrations()
	const expectedChecksum = "782f00261f8866e446fa2cce395330b446b3e458d505ea40587a8144a96a9eae"

	if migrations[1].version != 2 || migrations[1].name != "posting_links_and_batch_issues" || migrations[1].checksum != expectedChecksum {
		t.Fatalf("v002 identity changed: version=%d name=%s checksum=%s", migrations[1].version, migrations[1].name, migrations[1].checksum)
	}

	if !strings.Contains(canonicalSchemaManifestV002(), "table=pf_import_posting\n") ||
		!strings.Contains(canonicalSchemaManifestV002(), "table=pf_raw_row_transaction_link\n") ||
		!strings.Contains(canonicalSchemaManifestV002(), "table=pf_import_batch_issue\n") {
		t.Fatal("v002 manifest does not include posting, links, and batch issues")
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

func TestRuntimeModelsMatchFrozenSchemaV002(t *testing.T) {
	pairs := []struct {
		frozen  any
		runtime any
	}{
		{new(importPostingV002), new(importing.ImportPosting)},
		{new(rawRowTransactionLinkV002), new(importing.RawRowTransactionLink)},
		{new(importBatchIssueV002), new(importing.ImportBatchIssue)},
	}

	for _, pair := range pairs {
		frozenType := reflect.TypeOf(pair.frozen).Elem()
		runtimeType := reflect.TypeOf(pair.runtime).Elem()

		if frozenType.NumField() != runtimeType.NumField() {
			t.Fatalf("runtime model %s has %d fields, frozen v002 has %d", runtimeType.Name(), runtimeType.NumField(), frozenType.NumField())
		}

		for index := 0; index < frozenType.NumField(); index++ {
			frozenField := frozenType.Field(index)
			runtimeField := runtimeType.Field(index)

			if frozenField.Name != runtimeField.Name || runtimeField.Tag.Get("xorm") != frozenField.Tag.Get("xorm") {
				t.Fatalf("runtime model %s field %d differs from v002: runtime=%s %q frozen=%s %q",
					runtimeType.Name(), index, runtimeField.Name, runtimeField.Tag.Get("xorm"), frozenField.Name, frozenField.Tag.Get("xorm"))
			}
		}
	}
}
