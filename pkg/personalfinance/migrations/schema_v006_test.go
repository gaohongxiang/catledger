package migrations

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/cardcycle"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/installments"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/legacydata"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

func TestSchemaV006ChecksumGolden(t *testing.T) {
	migrations := registeredMigrations()
	const expectedChecksum = "945c39a4b80c6c798fbdd3ed6ebf4f758189b346558ea2b62a0bbecf5dd829fe"

	if len(migrations) < 6 {
		t.Fatalf("unexpected registered migration count %d", len(migrations))
	}

	if migrations[5].version != 6 || migrations[5].name != "billflow_installments_and_card_cycle" || migrations[5].checksum != expectedChecksum {
		t.Fatalf("v006 identity changed: version=%d name=%s checksum=%s", migrations[5].version, migrations[5].name, migrations[5].checksum)
	}

	manifest := canonicalSchemaManifestV006()
	for _, required := range []string{
		"table=pf_billflow_task\n",
		"table=pf_billflow_task_member\n",
		"table=pf_billflow_action\n",
		"table=pf_billflow_todo\n",
		"table=pf_category_alias_mapping\n",
		"table=pf_installment_candidate\n",
		"table=pf_installment_candidate_member\n",
		"table=pf_account_balance_review\n",
		"table=pf_card_cycle_rule\n",
		"table=pf_card_statement_coverage\n",
		"table=pf_month_report_revision\n",
		"auto-post=auto-post-v1\n",
		"high-confidence-window=high-confidence-window-v1\n",
		"category-alias=category-alias-v1\n",
		"installment-candidate-key=installment-candidate-key-v1\n",
		"installment-detect=installment-detect-v1\n",
		"action-idempotency=idempotency-key-v1\n",
		"action-request=billflow-action-request-v1\n",
		"BIGINT NULL",
	} {
		if !strings.Contains(manifest, required) {
			t.Fatalf("v006 manifest does not include %q", required)
		}
	}

	expectedSteps := []string{
		"create_pf_billflow_task",
		"create_pf_billflow_task_member",
		"create_pf_billflow_action",
		"create_pf_billflow_todo",
		"create_pf_category_alias_mapping",
		"create_pf_installment_candidate",
		"create_pf_installment_candidate_member",
		"create_pf_account_balance_review",
		"create_pf_card_cycle_rule",
		"create_pf_card_statement_coverage",
		"create_pf_month_report_revision",
	}
	actualSteps := make([]string, 0, len(migrations[5].steps))
	for _, step := range migrations[5].steps {
		actualSteps = append(actualSteps, step.name)
	}
	if !equalStrings(actualSteps, expectedSteps) {
		t.Fatalf("v006 migration steps are %v, expected %v", actualSteps, expectedSteps)
	}
}

func TestRuntimeModelsMatchFrozenSchemaV006(t *testing.T) {
	pairs := []struct {
		frozen  any
		runtime any
	}{
		{new(billflowTaskV006), new(legacydata.Task)},
		{new(billflowTaskMemberV006), new(legacydata.TaskMember)},
		{new(billflowActionV006), new(legacydata.Action)},
		{new(billflowTodoV006), new(legacydata.Todo)},
		{new(categoryAliasMappingV006), new(legacydata.CategoryAliasMapping)},
		{new(installmentCandidateV006), new(installments.Candidate)},
		{new(installmentCandidateMemberV006), new(installments.CandidateMember)},
		{new(accountBalanceReviewV006), new(cardcycle.BalanceReview)},
		{new(cardCycleRuleV006), new(cardcycle.CycleRule)},
		{new(cardStatementCoverageV006), new(cardcycle.StatementCoverage)},
		{new(monthReportRevisionV006), new(cardcycle.MonthReportRevision)},
	}

	for _, pair := range pairs {
		frozenType := reflect.TypeOf(pair.frozen).Elem()
		runtimeType := reflect.TypeOf(pair.runtime).Elem()
		if frozenType.NumField() != runtimeType.NumField() {
			t.Fatalf("runtime model %s has %d fields, frozen v006 has %d", runtimeType.Name(), runtimeType.NumField(), frozenType.NumField())
		}

		for index := 0; index < frozenType.NumField(); index++ {
			frozenField := frozenType.Field(index)
			runtimeField := runtimeType.Field(index)
			if frozenField.Name != runtimeField.Name || frozenField.Tag.Get("xorm") != runtimeField.Tag.Get("xorm") {
				t.Fatalf("runtime model %s field %d differs from v006: runtime=%s %q frozen=%s %q",
					runtimeType.Name(), index, runtimeField.Name, runtimeField.Tag.Get("xorm"), frozenField.Name, frozenField.Tag.Get("xorm"))
			}
		}
	}
}

func TestSchemaV006NullableAndIndexContract(t *testing.T) {
	type expectedIndex struct {
		unique  bool
		columns []string
	}

	nullableFields := map[string]struct{}{
		"pf_billflow_task.CurrentActionId":                     {},
		"pf_billflow_action.PreviousActionId":                  {},
		"pf_billflow_action.StartedUnixTime":                   {},
		"pf_billflow_action.CompletedUnixTime":                 {},
		"pf_billflow_action.FailedUnixTime":                    {},
		"pf_billflow_todo.ResolvedUnixTime":                    {},
		"pf_installment_candidate.LiabilityAccountId":          {},
		"pf_installment_candidate.TermCount":                   {},
		"pf_installment_candidate.LinkedContractId":            {},
		"pf_installment_candidate.LinkedPurchaseTransactionId": {},
		"pf_installment_candidate.PrincipalAmount":             {},
		"pf_installment_candidate.PaymentAmount":               {},
		"pf_installment_candidate.InterestAmount":              {},
		"pf_installment_candidate.FeeAmount":                   {},
		"pf_installment_candidate.CurrentPeriod":               {},
		"pf_installment_candidate_member.PeriodNumber":         {},
	}
	expectedIndexes := map[string]map[string]expectedIndex{
		"pf_billflow_task": {
			"IDX_pf_billflow_task_uid_status_updated": {columns: []string{"Uid", "Status", "UpdatedUnixTime", "TaskId"}},
		},
		"pf_billflow_task_member": {
			"UQE_pf_billflow_member_uid_task_file":  {unique: true, columns: []string{"Uid", "TaskId", "FileId"}},
			"UQE_pf_billflow_member_uid_batch":      {unique: true, columns: []string{"Uid", "BatchId"}},
			"IDX_pf_billflow_member_uid_task_order": {columns: []string{"Uid", "TaskId", "MemberOrder", "MemberId"}},
		},
		"pf_billflow_action": {
			"UQE_pf_billflow_action_uid_key":            {unique: true, columns: []string{"Uid", "IdempotencyKeyDigest"}},
			"IDX_pf_billflow_action_uid_task_created":   {columns: []string{"Uid", "TaskId", "CreatedUnixTime", "ActionId"}},
			"IDX_pf_billflow_action_uid_status_updated": {columns: []string{"Uid", "Status", "UpdatedUnixTime", "ActionId"}},
		},
		"pf_billflow_todo": {
			"UQE_pf_billflow_todo_uid_task_kind_subject": {unique: true, columns: []string{"Uid", "TaskId", "TodoKind", "SubjectKind", "SubjectId"}},
			"IDX_pf_billflow_todo_uid_status_updated":    {columns: []string{"Uid", "Status", "UpdatedUnixTime", "TodoId"}},
		},
		"pf_category_alias_mapping": {
			"UQE_pf_cat_alias_uid_type_key": {unique: true, columns: []string{"Uid", "SourceType", "AliasKey"}},
		},
		"pf_installment_candidate": {
			"UQE_pf_inst_cand_uid_key":            {unique: true, columns: []string{"Uid", "CandidateKey"}},
			"IDX_pf_inst_cand_uid_status_updated": {columns: []string{"Uid", "Status", "UpdatedUnixTime", "CandidateId"}},
		},
		"pf_installment_candidate_member": {
			"UQE_pf_inst_member_uid_cand_kind_ref": {unique: true, columns: []string{"Uid", "CandidateId", "MemberKind", "MemberRefId"}},
			"IDX_pf_inst_member_uid_cand_created":  {columns: []string{"Uid", "CandidateId", "CreatedUnixTime", "MemberId"}},
		},
		"pf_account_balance_review": {
			"UQE_pf_bal_review_uid_account": {unique: true, columns: []string{"Uid", "LedgerAccountId"}},
		},
		"pf_card_cycle_rule": {
			"UQE_pf_card_rule_uid_account_number": {unique: true, columns: []string{"Uid", "LedgerAccountId", "RuleNumber"}},
			"IDX_pf_card_rule_uid_account_status": {columns: []string{"Uid", "LedgerAccountId", "Status", "RuleId"}},
		},
		"pf_card_statement_coverage": {
			"UQE_pf_card_cov_uid_batch":          {unique: true, columns: []string{"Uid", "BatchId"}},
			"IDX_pf_card_cov_uid_account_period": {columns: []string{"Uid", "LedgerAccountId", "PeriodEnd", "CoverageId"}},
		},
		"pf_month_report_revision": {
			"IDX_pf_month_rev_uid_month_created": {columns: []string{"Uid", "YearMonth", "CreatedUnixTime", "RevisionId"}},
		},
	}

	if len(schemaBeansV006()) != 11 {
		t.Fatalf("v006 must freeze exactly eleven tables, got %d", len(schemaBeansV006()))
	}

	for _, bean := range schemaBeansV006() {
		beanType := reflect.TypeOf(bean).Elem()
		tableName := reflect.New(beanType).Interface().(interface{ TableName() string }).TableName()
		actualIndexes := make(map[string]expectedIndex)
		strippedNames := make(map[string]string)

		for fieldIndex := 0; fieldIndex < beanType.NumField(); fieldIndex++ {
			field := beanType.Field(fieldIndex)
			fieldKey := tableName + "." + field.Name
			fieldTag := field.Tag.Get("xorm")
			_, shouldBeNullable := nullableFields[fieldKey]
			isNullable := field.Type.Kind() == reflect.Ptr && strings.HasSuffix(fieldTag, " NULL") && !strings.HasSuffix(fieldTag, " NOT NULL")
			if isNullable != shouldBeNullable {
				t.Fatalf("v006 field %s nullable=%t, expected %t", fieldKey, isNullable, shouldBeNullable)
			}

			for _, tagPart := range strings.Fields(fieldTag) {
				isUnique := strings.HasPrefix(tagPart, "UNIQUE(") && strings.HasSuffix(tagPart, ")")
				isIndex := strings.HasPrefix(tagPart, "INDEX(") && strings.HasSuffix(tagPart, ")")
				if !isUnique && !isIndex {
					continue
				}

				indexName := strings.TrimSuffix(tagPart[strings.IndexByte(tagPart, '(')+1:], ")")
				if len(indexName) > 63 || !isSafeCatalogIdentifier(indexName) {
					t.Fatalf("v006 index name %q must be ASCII-safe and at most 63 bytes", indexName)
				}

				stripped := strings.TrimPrefix(strings.TrimPrefix(indexName, "UQE_"), "IDX_")
				if previous, exists := strippedNames[stripped]; exists && previous != indexName {
					t.Fatalf("v006 table %s indexes %q and %q collide after XORM prefix strip", tableName, previous, indexName)
				}
				strippedNames[stripped] = indexName

				index := actualIndexes[indexName]
				if len(index.columns) > 0 && index.unique != isUnique {
					t.Fatalf("v006 index %s mixes unique and ordinary declarations", indexName)
				}
				index.unique = isUnique
				index.columns = append(index.columns, field.Name)
				actualIndexes[indexName] = index
			}
		}

		if len(actualIndexes) != len(expectedIndexes[tableName]) {
			t.Fatalf("v006 table %s indexes are %v, expected %v", tableName, actualIndexes, expectedIndexes[tableName])
		}
		for indexName, expected := range expectedIndexes[tableName] {
			actual, exists := actualIndexes[indexName]
			if !exists || actual.unique != expected.unique || !equalStrings(actual.columns, expected.columns) {
				t.Fatalf("v006 index %s is %+v, expected %+v", indexName, actual, expected)
			}
		}
	}
}

func TestSchemaV006UpgradeIsExactOnSQLite(t *testing.T) {
	database, err := datastore.OpenDatabase(&settings.DatabaseConfig{
		DatabaseType:          settings.Sqlite3DbType,
		DatabasePath:          filepath.Join(t.TempDir(), "pf-v006.db"),
		MaxIdleConnection:     1,
		MaxOpenConnection:     1,
		ConnectionMaxLifeTime: 60,
	})
	if err != nil {
		t.Fatalf("open SQLite v006 database: %v", err)
	}
	t.Cleanup(func() {
		if closeErr := database.Close(); closeErr != nil {
			t.Errorf("close SQLite v006 database: %v", closeErr)
		}
	})

	store, err := datastore.NewDataStore(database)
	if err != nil {
		t.Fatalf("create SQLite v006 store: %v", err)
	}
	if err := Upgrade(nil, store, ApplicationInfo{Version: "test", Commit: "v006-first"}); err != nil {
		t.Fatalf("first v006 upgrade: %v", err)
	}
	if err := Upgrade(nil, store, ApplicationInfo{Version: "test", Commit: "v006-repeat"}); err != nil {
		t.Fatalf("repeat v006 upgrade: %v", err)
	}
	if err := verifyMigrationTable(database); err != nil {
		t.Fatalf("migration table is not exact: %v", err)
	}
	if err := verifySchemaV012WithContext(nil, database); err != nil {
		t.Fatalf("latest schema is not exact: %v", err)
	}

	record := new(SchemaMigration)
	sess := database.NewSession(nil)
	found, getErr := sess.ID(int64(6)).Get(record)
	sess.Close()
	if getErr != nil || !found || !record.Success || record.FailureCode != "" {
		t.Fatalf("unexpected v006 migration record: found=%t record=%+v err=%v", found, record, getErr)
	}
	latest := new(SchemaMigration)
	sess = database.NewSession(nil)
	found, getErr = sess.ID(int64(12)).Get(latest)
	sess.Close()
	if getErr != nil || !found || !latest.Success || latest.FailureCode != "" {
		t.Fatalf("unexpected v012 migration record: found=%t record=%+v err=%v", found, latest, getErr)
	}
}
