package migrations

import (
	"reflect"
	"strings"
	"testing"

	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
)

func TestSchemaV008ChecksumGolden(t *testing.T) {
	migrations := registeredMigrations()
	const expectedChecksum = "4d47954495ac216c2c55bde87118f6d1fc68f62b90f50aa85510021962ffd77f"

	if len(migrations) < 8 {
		t.Fatalf("unexpected registered migration count %d", len(migrations))
	}

	if migrations[7].version != 8 || migrations[7].name != "import_batch_card_headers" || migrations[7].checksum != expectedChecksum {
		t.Fatalf("v008 identity changed: version=%d name=%s checksum=%s", migrations[7].version, migrations[7].name, migrations[7].checksum)
	}

	manifest := canonicalSchemaManifestV008()
	for _, required := range []string{
		"table=pf_import_batch_card_header\n",
		"card-statement-header=card-statement-header-v1\n",
		"UNIQUE(UQE_pf_card_hdr_uid_batch)",
		"BIGINT NULL",
	} {
		if !strings.Contains(manifest, required) {
			t.Fatalf("v008 manifest does not include %q", required)
		}
	}

	if len(migrations[7].steps) != 1 || migrations[7].steps[0].name != "create_pf_import_batch_card_header" {
		t.Fatalf("unexpected v008 migration steps: %+v", migrations[7].steps)
	}
}

func TestRuntimeModelsMatchFrozenSchemaV008(t *testing.T) {
	frozenType := reflect.TypeOf(new(importBatchCardHeaderV008)).Elem()
	runtimeType := reflect.TypeOf(new(importing.CardHeader)).Elem()

	if frozenType.NumField() != runtimeType.NumField() {
		t.Fatalf("runtime model %s has %d fields, frozen v008 has %d", runtimeType.Name(), runtimeType.NumField(), frozenType.NumField())
	}

	for index := 0; index < frozenType.NumField(); index++ {
		frozenField := frozenType.Field(index)
		runtimeField := runtimeType.Field(index)

		if frozenField.Name != runtimeField.Name || runtimeField.Tag.Get("xorm") != frozenField.Tag.Get("xorm") {
			t.Fatalf("runtime model %s field %d differs from v008: runtime=%s %q frozen=%s %q",
				runtimeType.Name(), index, runtimeField.Name, runtimeField.Tag.Get("xorm"), frozenField.Name, frozenField.Tag.Get("xorm"))
		}
	}
}

func TestSchemaV008UniqueAndIndexContract(t *testing.T) {
	type expectedV008Index struct {
		unique  bool
		columns []string
	}
	beanType := reflect.TypeOf(new(importBatchCardHeaderV008)).Elem()
	actualIndexes := make(map[string]expectedV008Index)

	for fieldIndex := 0; fieldIndex < beanType.NumField(); fieldIndex++ {
		field := beanType.Field(fieldIndex)
		fieldTag := field.Tag.Get("xorm")
		for _, tagPart := range strings.Fields(fieldTag) {
			isUnique := strings.HasPrefix(tagPart, "UNIQUE(") && strings.HasSuffix(tagPart, ")")
			isIndex := strings.HasPrefix(tagPart, "INDEX(") && strings.HasSuffix(tagPart, ")")
			if !isUnique && !isIndex {
				continue
			}
			indexName := strings.TrimSuffix(tagPart[strings.IndexByte(tagPart, '(')+1:], ")")
			if len(indexName) > 63 || !isSafeCatalogIdentifier(indexName) {
				t.Fatalf("v008 index name %q must be ASCII-safe and at most 63 bytes", indexName)
			}
			index := actualIndexes[indexName]
			if isUnique {
				index.unique = true
			}
			index.columns = append(index.columns, field.Name)
			actualIndexes[indexName] = index
		}
	}

	expectedIndexes := map[string]expectedV008Index{
		"UQE_pf_card_hdr_uid_batch": {
			unique: true, columns: []string{"Uid", "BatchId"},
		},
	}
	if len(actualIndexes) != len(expectedIndexes) {
		t.Fatalf("v008 indexes are %v, expected %v", actualIndexes, expectedIndexes)
	}
	for indexName, expected := range expectedIndexes {
		actual, exists := actualIndexes[indexName]
		if !exists || actual.unique != expected.unique || !equalStrings(actual.columns, expected.columns) {
			t.Fatalf("v008 index %s is %+v, expected %+v", indexName, actual, expected)
		}
	}
}
