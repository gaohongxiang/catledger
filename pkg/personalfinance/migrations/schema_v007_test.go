package migrations

import (
	"reflect"
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func TestSchemaV007ChecksumGolden(t *testing.T) {
	migrations := registeredMigrations()
	const expectedChecksum = "2a345eb898271ce50216ccfc1b6108ad8ab90275faafe93614fd25422c359676"

	if len(migrations) != 8 {
		t.Fatalf("unexpected registered migration count %d", len(migrations))
	}

	if migrations[6].version != 7 || migrations[6].name != "payment_account_exclusions" || migrations[6].checksum != expectedChecksum {
		t.Fatalf("v007 identity changed: version=%d name=%s checksum=%s", migrations[6].version, migrations[6].name, migrations[6].checksum)
	}

	manifest := canonicalSchemaManifestV007()
	for _, required := range []string{
		"table=pf_payment_account_exclusion\n",
		"payment-account-exclusion=payment-account-exclusion-v1\n",
		"UNIQUE(UQE_pf_payacct_excl_uid_type_currency_key)",
	} {
		if !strings.Contains(manifest, required) {
			t.Fatalf("v007 manifest does not include %q", required)
		}
	}

	if len(migrations[6].steps) != 1 || migrations[6].steps[0].name != "create_pf_payment_account_exclusion" {
		t.Fatalf("unexpected v007 migration steps: %+v", migrations[6].steps)
	}
}

func TestRuntimeModelsMatchFrozenSchemaV007(t *testing.T) {
	frozenType := reflect.TypeOf(new(paymentAccountExclusionV007)).Elem()
	runtimeType := reflect.TypeOf(new(importing.PaymentAccountExclusion)).Elem()

	if frozenType.NumField() != runtimeType.NumField() {
		t.Fatalf("runtime model %s has %d fields, frozen v007 has %d", runtimeType.Name(), runtimeType.NumField(), frozenType.NumField())
	}

	for index := 0; index < frozenType.NumField(); index++ {
		frozenField := frozenType.Field(index)
		runtimeField := runtimeType.Field(index)

		if frozenField.Name != runtimeField.Name || runtimeField.Tag.Get("xorm") != frozenField.Tag.Get("xorm") {
			t.Fatalf("runtime model %s field %d differs from v007: runtime=%s %q frozen=%s %q",
				runtimeType.Name(), index, runtimeField.Name, runtimeField.Tag.Get("xorm"), frozenField.Name, frozenField.Tag.Get("xorm"))
		}
	}
}

func TestSchemaV007UniqueAndIndexContract(t *testing.T) {
	type expectedV007Index struct {
		unique  bool
		columns []string
	}
	beanType := reflect.TypeOf(new(paymentAccountExclusionV007)).Elem()
	actualIndexes := make(map[string]expectedV007Index)

	for fieldIndex := 0; fieldIndex < beanType.NumField(); fieldIndex++ {
		field := beanType.Field(fieldIndex)
		fieldTag := field.Tag.Get("xorm")
		if field.Type.Kind() == reflect.Ptr || !strings.HasSuffix(fieldTag, " NOT NULL") {
			t.Fatalf("v007 field %s must be non-nullable: %s", field.Name, fieldTag)
		}
		for _, tagPart := range strings.Fields(fieldTag) {
			isUnique := strings.HasPrefix(tagPart, "UNIQUE(") && strings.HasSuffix(tagPart, ")")
			isIndex := strings.HasPrefix(tagPart, "INDEX(") && strings.HasSuffix(tagPart, ")")
			if !isUnique && !isIndex {
				continue
			}
			indexName := strings.TrimSuffix(tagPart[strings.IndexByte(tagPart, '(')+1:], ")")
			if len(indexName) > 63 || !isSafeCatalogIdentifier(indexName) {
				t.Fatalf("v007 index name %q must be ASCII-safe and at most 63 bytes", indexName)
			}
			index := actualIndexes[indexName]
			if len(index.columns) > 0 && index.unique != isUnique {
				t.Fatalf("v007 index %s mixes unique and ordinary declarations", indexName)
			}
			index.unique = isUnique
			index.columns = append(index.columns, field.Name)
			actualIndexes[indexName] = index
		}
	}

	expectedIndexes := map[string]expectedV007Index{
		"UQE_pf_payacct_excl_uid_type_currency_key": {
			unique: true, columns: []string{"Uid", "SourceType", "Currency", "AliasKey"},
		},
		"IDX_pf_payacct_excl_uid_updated": {
			columns: []string{"Uid", "UpdatedUnixTime", "ExclusionId"},
		},
	}
	if len(actualIndexes) != len(expectedIndexes) {
		t.Fatalf("v007 indexes are %v, expected %v", actualIndexes, expectedIndexes)
	}
	for indexName, expected := range expectedIndexes {
		actual, exists := actualIndexes[indexName]
		if !exists || actual.unique != expected.unique || !equalStrings(actual.columns, expected.columns) {
			t.Fatalf("v007 index %s is %+v, expected %+v", indexName, actual, expected)
		}
	}
}
