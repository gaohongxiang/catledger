package migrations

import (
	"reflect"
	"strings"
	"testing"

	"github.com/gaohongxiang/catledger/pkg/personalfinance/organizer"
)

func TestSchemaV009ChecksumGolden(t *testing.T) {
	migrations := registeredMigrations()
	const expectedChecksum = "fc6f746812da0ae26c58552a1376070fdb570edfe365b904ba86ef13c36c90cb"

	if len(migrations) < 9 {
		t.Fatalf("unexpected registered migration count %d", len(migrations))
	}
	if migrations[8].version != 9 || migrations[8].name != "organizer_events_and_updates" || migrations[8].checksum != expectedChecksum {
		t.Fatalf("v009 identity changed: version=%d name=%s checksum=%s", migrations[8].version, migrations[8].name, migrations[8].checksum)
	}

	manifest := canonicalSchemaManifestV009()
	for _, required := range []string{
		"table=pf_finance_update\n",
		"table=pf_finance_update_source\n",
		"table=pf_economic_event\n",
		"table=pf_economic_event_evidence\n",
		"table=pf_economic_event_relation\n",
		"table=pf_economic_event_transaction\n",
		"table=pf_finance_action\n",
		"plan=organizer-plan-v1\n",
		"action-request=finance-action-request-v1\n",
		"legacy-backfill=organizer-legacy-backfill-v1\n",
	} {
		if !strings.Contains(manifest, required) {
			t.Fatalf("v009 manifest does not include %q", required)
		}
	}
	if len(migrations[8].steps) != 8 || migrations[8].steps[7].name != "backfill_posted_evidence" {
		t.Fatalf("unexpected v009 migration step count: %d", len(migrations[8].steps))
	}
}

func TestRuntimeModelsMatchFrozenSchemaV009(t *testing.T) {
	pairs := [][2]any{
		{new(financeUpdateV009), new(organizer.FinanceUpdate)},
		{new(financeUpdateSourceV009), new(organizer.FinanceUpdateSource)},
		{new(economicEventV009), new(organizer.EconomicEvent)},
		{new(economicEventEvidenceV009), new(organizer.EconomicEventEvidence)},
		{new(economicEventRelationV009), new(organizer.EconomicEventRelation)},
		{new(economicEventTransactionV009), new(organizer.EconomicEventTransaction)},
		{new(financeActionV009), new(organizer.FinanceAction)},
	}

	for _, pair := range pairs {
		frozenType := reflect.TypeOf(pair[0]).Elem()
		runtimeType := reflect.TypeOf(pair[1]).Elem()
		if frozenType.NumField() != runtimeType.NumField() {
			t.Fatalf("runtime model %s has %d fields, frozen %s has %d", runtimeType.Name(), runtimeType.NumField(), frozenType.Name(), frozenType.NumField())
		}
		for index := 0; index < frozenType.NumField(); index++ {
			frozenField := frozenType.Field(index)
			runtimeField := runtimeType.Field(index)
			if frozenField.Name != runtimeField.Name || frozenField.Tag.Get("xorm") != runtimeField.Tag.Get("xorm") {
				t.Fatalf("runtime model %s field %d differs: runtime=%s %q frozen=%s %q",
					runtimeType.Name(), index, runtimeField.Name, runtimeField.Tag.Get("xorm"), frozenField.Name, frozenField.Tag.Get("xorm"))
			}
		}
	}
}

func TestSchemaV009IndexNamesArePortable(t *testing.T) {
	for _, bean := range schemaBeansV009() {
		beanType := reflect.TypeOf(bean).Elem()
		for fieldIndex := 0; fieldIndex < beanType.NumField(); fieldIndex++ {
			for _, tagPart := range strings.Fields(beanType.Field(fieldIndex).Tag.Get("xorm")) {
				if (!strings.HasPrefix(tagPart, "UNIQUE(") && !strings.HasPrefix(tagPart, "INDEX(")) || !strings.HasSuffix(tagPart, ")") {
					continue
				}
				indexName := strings.TrimSuffix(tagPart[strings.IndexByte(tagPart, '(')+1:], ")")
				if len(indexName) > 63 || !isSafeCatalogIdentifier(indexName) {
					t.Fatalf("v009 index name %q must be ASCII-safe and at most 63 bytes", indexName)
				}
			}
		}
	}
}
