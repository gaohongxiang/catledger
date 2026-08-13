package migrations

import (
	"errors"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/reconciliation"
)

func TestSchemaV001ChecksumGolden(t *testing.T) {
	migrations := registeredMigrations()

	if len(migrations) != 4 {
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

func TestSchemaV003ChecksumGolden(t *testing.T) {
	migrations := registeredMigrations()
	const expectedChecksum = "e192a9469607ad0603aba6d9e356aac68d810badcc94f67ed8f5a25630a93875"

	if migrations[2].version != 3 || migrations[2].name != "reconciliation_cases_and_decisions" || migrations[2].checksum != expectedChecksum {
		t.Fatalf("v003 identity changed: version=%d name=%s checksum=%s", migrations[2].version, migrations[2].name, migrations[2].checksum)
	}

	manifest := canonicalSchemaManifestV003()

	for _, required := range []string{
		"table=pf_reconciliation_case\n",
		"table=pf_reconciliation_case_member\n",
		"table=pf_reconciliation_decision\n",
		"table=pf_reconciliation_transaction_link\n",
		"table=pf_reconciliation_ledger_effect\n",
		"case-key=reconciliation-case-key-v1:sorted-stable-member-tokens\n",
	} {
		if !strings.Contains(manifest, required) {
			t.Fatalf("v003 manifest does not include %q", required)
		}
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

func TestSchemaV004ChecksumGolden(t *testing.T) {
	migrations := registeredMigrations()
	const expectedChecksum = "125dd0ed5dc1e613eee569296c6730381e153e8c9774e81cdd84086e5a15d5ab"

	if migrations[3].version != 4 || migrations[3].name != "loan_contracts_schedules_and_allocations" || migrations[3].checksum != expectedChecksum {
		t.Fatalf("v004 identity changed: version=%d name=%s checksum=%s", migrations[3].version, migrations[3].name, migrations[3].checksum)
	}

	manifest := canonicalSchemaManifestV004()

	for _, required := range []string{
		"table=pf_loan_contract\n",
		"table=pf_loan_contract_revision\n",
		"table=pf_loan_installment\n",
		"table=pf_loan_action\n",
		"table=pf_loan_transaction_binding\n",
		"table=pf_loan_transaction_allocation\n",
		"calculation=loan-calculation-v1\n",
		"action-request=loan-action-request-v1\n",
	} {
		if !strings.Contains(manifest, required) {
			t.Fatalf("v004 manifest does not include %q", required)
		}
	}

	expectedSteps := []string{
		"create_pf_loan_contract",
		"create_pf_loan_contract_revision",
		"create_pf_loan_installment",
		"create_pf_loan_action",
		"create_pf_loan_transaction_binding",
		"create_pf_loan_transaction_allocation",
	}
	actualSteps := make([]string, 0, len(migrations[3].steps))

	for _, step := range migrations[3].steps {
		actualSteps = append(actualSteps, step.name)
	}

	if !equalStrings(actualSteps, expectedSteps) {
		t.Fatalf("v004 migration steps are %v, expected %v", actualSteps, expectedSteps)
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

func TestRuntimeModelsMatchFrozenSchemaV003(t *testing.T) {
	pairs := []struct {
		frozen  any
		runtime any
	}{
		{new(reconciliationCaseV003), new(reconciliation.Case)},
		{new(reconciliationCaseMemberV003), new(reconciliation.CaseMember)},
		{new(reconciliationDecisionV003), new(reconciliation.Decision)},
		{new(reconciliationTransactionLinkV003), new(reconciliation.TransactionLink)},
		{new(reconciliationLedgerEffectV003), new(reconciliation.LedgerEffect)},
	}

	for _, pair := range pairs {
		frozenType := reflect.TypeOf(pair.frozen).Elem()
		runtimeType := reflect.TypeOf(pair.runtime).Elem()

		if frozenType.NumField() != runtimeType.NumField() {
			t.Fatalf("runtime model %s has %d fields, frozen v003 has %d", runtimeType.Name(), runtimeType.NumField(), frozenType.NumField())
		}

		for index := 0; index < frozenType.NumField(); index++ {
			frozenField := frozenType.Field(index)
			runtimeField := runtimeType.Field(index)

			if frozenField.Name != runtimeField.Name || runtimeField.Tag.Get("xorm") != frozenField.Tag.Get("xorm") {
				t.Fatalf("runtime model %s field %d differs from v003: runtime=%s %q frozen=%s %q",
					runtimeType.Name(), index, runtimeField.Name, runtimeField.Tag.Get("xorm"), frozenField.Name, frozenField.Tag.Get("xorm"))
			}
		}
	}
}

func TestRuntimeModelsMatchFrozenSchemaV004(t *testing.T) {
	pairs := []struct {
		frozen  any
		runtime any
	}{
		{new(loanContractV004), new(loans.Contract)},
		{new(loanContractRevisionV004), new(loans.ContractRevision)},
		{new(loanInstallmentV004), new(loans.Installment)},
		{new(loanActionV004), new(loans.Action)},
		{new(loanTransactionBindingV004), new(loans.TransactionBinding)},
		{new(loanTransactionAllocationV004), new(loans.TransactionAllocation)},
	}

	for _, pair := range pairs {
		frozenType := reflect.TypeOf(pair.frozen).Elem()
		runtimeType := reflect.TypeOf(pair.runtime).Elem()

		if frozenType.NumField() != runtimeType.NumField() {
			t.Fatalf("runtime model %s has %d fields, frozen v004 has %d", runtimeType.Name(), runtimeType.NumField(), frozenType.NumField())
		}

		for index := 0; index < frozenType.NumField(); index++ {
			frozenField := frozenType.Field(index)
			runtimeField := runtimeType.Field(index)

			if frozenField.Name != runtimeField.Name || runtimeField.Tag.Get("xorm") != frozenField.Tag.Get("xorm") {
				t.Fatalf("runtime model %s field %d differs from v004: runtime=%s %q frozen=%s %q",
					runtimeType.Name(), index, runtimeField.Name, runtimeField.Tag.Get("xorm"), frozenField.Name, frozenField.Tag.Get("xorm"))
			}
		}
	}
}

func TestSchemaV003NullableAndUniqueContract(t *testing.T) {
	nullableFields := map[string]struct{}{
		"pf_reconciliation_case.CurrentDecisionId":                   {},
		"pf_reconciliation_decision.PreviousDecisionId":              {},
		"pf_reconciliation_decision.StartedUnixTime":                 {},
		"pf_reconciliation_decision.CompletedUnixTime":               {},
		"pf_reconciliation_decision.FailedUnixTime":                  {},
		"pf_reconciliation_ledger_effect.TransactionDeletedUnixTime": {},
	}
	expectedUniqueIndexes := map[string]map[string][]string{
		"pf_reconciliation_case": {
			"UQE_pf_reconciliation_case_uid_key": {"Uid", "CaseKey"},
		},
		"pf_reconciliation_case_member": {
			"UQE_pf_reconciliation_case_member_uid_order": {"Uid", "CaseId", "MemberOrder"},
			"UQE_pf_reconciliation_case_member_uid_ref":   {"Uid", "CaseId", "MemberKind", "MemberRefId"},
		},
		"pf_reconciliation_decision": {
			"UQE_pf_reconciliation_decision_uid_key": {"Uid", "IdempotencyKeyDigest"},
		},
		"pf_reconciliation_transaction_link": {},
		"pf_reconciliation_ledger_effect": {
			"UQE_pf_reconciliation_effect_uid_decision_tx_type": {"Uid", "DecisionId", "TransactionId", "EffectType"},
		},
	}

	for _, bean := range schemaBeansV003() {
		beanType := reflect.TypeOf(bean).Elem()
		tableName := reflect.New(beanType).Interface().(interface{ TableName() string }).TableName()
		uniqueIndexes := make(map[string][]string)

		for fieldIndex := 0; fieldIndex < beanType.NumField(); fieldIndex++ {
			field := beanType.Field(fieldIndex)
			fieldKey := tableName + "." + field.Name
			fieldTag := field.Tag.Get("xorm")
			_, shouldBeNullable := nullableFields[fieldKey]
			isNullable := field.Type.Kind() == reflect.Ptr && strings.HasSuffix(fieldTag, " NULL") && !strings.HasSuffix(fieldTag, " NOT NULL")

			if isNullable != shouldBeNullable {
				t.Fatalf("v003 field %s nullable=%t, expected %t", fieldKey, isNullable, shouldBeNullable)
			}

			for _, tagPart := range strings.Fields(fieldTag) {
				isUnique := strings.HasPrefix(tagPart, "UNIQUE(") && strings.HasSuffix(tagPart, ")")
				isIndex := strings.HasPrefix(tagPart, "INDEX(") && strings.HasSuffix(tagPart, ")")

				if isUnique || isIndex {
					indexName := strings.TrimSuffix(tagPart[strings.IndexByte(tagPart, '(')+1:], ")")

					if len(indexName) > 63 || !isSafeCatalogIdentifier(indexName) {
						t.Fatalf("v003 index name %q must be ASCII-safe and at most 63 bytes", indexName)
					}

					if !isUnique {
						continue
					}

					uniqueIndexes[indexName] = append(uniqueIndexes[indexName], field.Name)
				}
			}
		}

		actualIndexNames := make([]string, 0, len(uniqueIndexes))

		for indexName := range uniqueIndexes {
			actualIndexNames = append(actualIndexNames, indexName)
		}

		sort.Strings(actualIndexNames)
		expectedIndexNames := make([]string, 0, len(expectedUniqueIndexes[tableName]))

		for indexName := range expectedUniqueIndexes[tableName] {
			expectedIndexNames = append(expectedIndexNames, indexName)
		}

		sort.Strings(expectedIndexNames)

		if !equalStrings(actualIndexNames, expectedIndexNames) {
			t.Fatalf("v003 table %s unique indexes are %v, expected %v", tableName, actualIndexNames, expectedIndexNames)
		}

		for indexName, expectedColumns := range expectedUniqueIndexes[tableName] {
			if !equalStrings(uniqueIndexes[indexName], expectedColumns) {
				t.Fatalf("v003 index %s columns are %v, expected %v", indexName, uniqueIndexes[indexName], expectedColumns)
			}
		}
	}
}

func TestSchemaV004NullableAndIndexContract(t *testing.T) {
	type expectedIndex struct {
		unique  bool
		columns []string
	}

	nullableFields := map[string]struct{}{
		"pf_loan_contract.DefaultPaymentAccountId":                  {},
		"pf_loan_contract.ClosedUnixTime":                           {},
		"pf_loan_contract_revision.PreviousRevisionId":              {},
		"pf_loan_contract_revision.PaymentBasisAmount":              {},
		"pf_loan_contract_revision.QuotedRatePptr":                  {},
		"pf_loan_contract_revision.DiscountRatePptr":                {},
		"pf_loan_contract_revision.MonthlyIrrPptr":                  {},
		"pf_loan_contract_revision.SimpleAprPptr":                   {},
		"pf_loan_contract_revision.EffectiveAprPptr":                {},
		"pf_loan_action.PreviousActionId":                           {},
		"pf_loan_action.StartedUnixTime":                            {},
		"pf_loan_action.CompletedUnixTime":                          {},
		"pf_loan_action.FailedUnixTime":                             {},
		"pf_loan_transaction_binding.CurrentAllocationId":           {},
		"pf_loan_transaction_allocation.InstallmentId":              {},
		"pf_loan_transaction_allocation.CounterpartBindingId":       {},
		"pf_loan_transaction_allocation.CounterpartUpdatedUnixTime": {},
	}
	expectedIndexes := map[string]map[string]expectedIndex{
		"pf_loan_contract": {
			"IDX_pf_loan_contract_uid_status_updated": {columns: []string{"Uid", "Status", "UpdatedUnixTime", "ContractId"}},
			"IDX_pf_loan_contract_uid_liability":      {columns: []string{"Uid", "LiabilityAccountId", "Status", "ContractId"}},
		},
		"pf_loan_contract_revision": {
			"UQE_pf_loan_revision_uid_number":           {unique: true, columns: []string{"Uid", "ContractId", "RevisionNumber"}},
			"UQE_pf_loan_revision_uid_action":           {unique: true, columns: []string{"Uid", "ActionId"}},
			"IDX_pf_loan_revision_uid_contract_created": {columns: []string{"Uid", "ContractId", "CreatedUnixTime", "RevisionId"}},
		},
		"pf_loan_installment": {
			"UQE_pf_loan_installment_uid_revision_number": {unique: true, columns: []string{"Uid", "RevisionId", "InstallmentNumber"}},
			"IDX_pf_loan_installment_uid_contract_due":    {columns: []string{"Uid", "ContractId", "DueDate", "InstallmentId"}},
			"IDX_pf_loan_installment_uid_revision_number": {columns: []string{"Uid", "RevisionId", "InstallmentNumber", "InstallmentId"}},
		},
		"pf_loan_action": {
			"UQE_pf_loan_action_uid_key":              {unique: true, columns: []string{"Uid", "IdempotencyKeyDigest"}},
			"IDX_pf_loan_action_uid_contract_created": {columns: []string{"Uid", "ContractId", "CreatedUnixTime", "ActionId"}},
			"IDX_pf_loan_action_uid_status_updated":   {columns: []string{"Uid", "Status", "UpdatedUnixTime", "ActionId"}},
		},
		"pf_loan_transaction_binding": {
			"UQE_pf_loan_binding_uid_transaction": {unique: true, columns: []string{"Uid", "TransactionId"}},
			"IDX_pf_loan_binding_uid_current":     {columns: []string{"Uid", "CurrentAllocationId", "BindingId"}},
		},
		"pf_loan_transaction_allocation": {
			"IDX_pf_loan_allocation_uid_contract_status": {columns: []string{"Uid", "ContractId", "Status", "UpdatedUnixTime", "AllocationId"}},
			"IDX_pf_loan_allocation_uid_installment":     {columns: []string{"Uid", "ContractId", "InstallmentId", "Status", "AllocationId"}},
			"IDX_pf_loan_allocation_uid_action":          {columns: []string{"Uid", "CreatedActionId", "AllocationId"}},
		},
	}

	for _, bean := range schemaBeansV004() {
		beanType := reflect.TypeOf(bean).Elem()
		tableName := reflect.New(beanType).Interface().(interface{ TableName() string }).TableName()
		actualIndexes := make(map[string]expectedIndex)

		for fieldIndex := 0; fieldIndex < beanType.NumField(); fieldIndex++ {
			field := beanType.Field(fieldIndex)
			fieldKey := tableName + "." + field.Name
			fieldTag := field.Tag.Get("xorm")
			_, shouldBeNullable := nullableFields[fieldKey]
			isNullable := field.Type.Kind() == reflect.Ptr && strings.HasSuffix(fieldTag, " NULL") && !strings.HasSuffix(fieldTag, " NOT NULL")

			if isNullable != shouldBeNullable {
				t.Fatalf("v004 field %s nullable=%t, expected %t", fieldKey, isNullable, shouldBeNullable)
			}

			for _, tagPart := range strings.Fields(fieldTag) {
				isUnique := strings.HasPrefix(tagPart, "UNIQUE(") && strings.HasSuffix(tagPart, ")")
				isIndex := strings.HasPrefix(tagPart, "INDEX(") && strings.HasSuffix(tagPart, ")")

				if !isUnique && !isIndex {
					continue
				}

				indexName := strings.TrimSuffix(tagPart[strings.IndexByte(tagPart, '(')+1:], ")")

				if len(indexName) > 63 || !isSafeCatalogIdentifier(indexName) {
					t.Fatalf("v004 index name %q must be ASCII-safe and at most 63 bytes", indexName)
				}

				index := actualIndexes[indexName]
				if len(index.columns) > 0 && index.unique != isUnique {
					t.Fatalf("v004 index %s mixes unique and ordinary declarations", indexName)
				}
				index.unique = isUnique
				index.columns = append(index.columns, field.Name)
				actualIndexes[indexName] = index
			}
		}

		if len(actualIndexes) != len(expectedIndexes[tableName]) {
			t.Fatalf("v004 table %s indexes are %v, expected %v", tableName, actualIndexes, expectedIndexes[tableName])
		}

		for indexName, expected := range expectedIndexes[tableName] {
			actual, exists := actualIndexes[indexName]
			if !exists || actual.unique != expected.unique || !equalStrings(actual.columns, expected.columns) {
				t.Fatalf("v004 index %s is %+v, expected %+v", indexName, actual, expected)
			}
		}
	}
}
