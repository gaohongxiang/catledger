package migrations

import (
	"reflect"
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/installments"
)

func TestSchemaV011IdentityAndRuntimeModel(t *testing.T) {
	migrations := registeredMigrations()
	if len(migrations) != 12 {
		t.Fatalf("unexpected migration count %d", len(migrations))
	}
	migration := migrations[10]
	if migration.version != 11 || migration.name != "installment_contract_drafts" {
		t.Fatalf("unexpected v011 identity: version=%d name=%s", migration.version, migration.name)
	}
	if !strings.Contains(canonicalSchemaManifestV011(), "table=pf_installment_contract_draft\n") ||
		!strings.Contains(canonicalSchemaManifestV011(), "installment-contract-draft=installment-contract-draft-v1\n") {
		t.Fatal("v011 manifest does not freeze the installment contract draft table")
	}
	if len(migration.steps) != 1 || migration.steps[0].name != "create_pf_installment_contract_draft" {
		t.Fatalf("unexpected v011 steps: %+v", migration.steps)
	}
	frozen := reflect.TypeOf(installmentContractDraftV011{})
	runtime := reflect.TypeOf(installments.ContractDraft{})
	if frozen.NumField() != runtime.NumField() {
		t.Fatalf("runtime contract draft has %d fields, frozen v011 has %d", runtime.NumField(), frozen.NumField())
	}
	for index := 0; index < frozen.NumField(); index++ {
		frozenField, runtimeField := frozen.Field(index), runtime.Field(index)
		if frozenField.Name != runtimeField.Name || frozenField.Type != runtimeField.Type || frozenField.Tag != runtimeField.Tag {
			t.Fatalf("runtime contract draft field %d changed: frozen=%+v runtime=%+v", index, frozenField, runtimeField)
		}
	}
}
