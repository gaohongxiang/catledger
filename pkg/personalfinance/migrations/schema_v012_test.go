package migrations

import (
	"reflect"
	"strings"
	"testing"

	"github.com/gaohongxiang/catledger/pkg/personalfinance/loans"
)

func TestSchemaV012IdentityAndRuntimeModel(t *testing.T) {
	migrations := registeredMigrations()
	if len(migrations) != 12 {
		t.Fatalf("unexpected migration count %d", len(migrations))
	}
	migration := migrations[11]
	if migration.version != 12 || migration.name != "loan_opening_progress_baselines" {
		t.Fatalf("unexpected v012 identity: version=%d name=%s", migration.version, migration.name)
	}
	if !strings.Contains(canonicalSchemaManifestV012(), "table=pf_loan_progress_baseline\n") ||
		!strings.Contains(canonicalSchemaManifestV012(), "loan-opening-progress-baseline=loan-opening-progress-baseline-v1\n") {
		t.Fatal("v012 manifest does not freeze the opening progress baseline table")
	}
	if len(migration.steps) != 1 || migration.steps[0].name != "create_pf_loan_progress_baseline" {
		t.Fatalf("unexpected v012 steps: %+v", migration.steps)
	}
	frozen := reflect.TypeOf(loanProgressBaselineV012{})
	runtime := reflect.TypeOf(loans.ProgressBaseline{})
	if frozen.NumField() != runtime.NumField() {
		t.Fatalf("runtime progress baseline has %d fields, frozen v012 has %d", runtime.NumField(), frozen.NumField())
	}
	for index := 0; index < frozen.NumField(); index++ {
		frozenField, runtimeField := frozen.Field(index), runtime.Field(index)
		if frozenField.Name != runtimeField.Name || frozenField.Type != runtimeField.Type || frozenField.Tag != runtimeField.Tag {
			t.Fatalf("runtime progress baseline field %d changed: frozen=%+v runtime=%+v", index, frozenField, runtimeField)
		}
	}
}
