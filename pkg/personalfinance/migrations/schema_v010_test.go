package migrations

import (
	"reflect"
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/organizer"
)

func TestSchemaV010ChecksumGolden(t *testing.T) {
	migrations := registeredMigrations()
	const expectedChecksum = "698c964be365a34c9eab603e2aab04faee979bb96eeb76a2b43db0e0af552830"

	if len(migrations) != 10 {
		t.Fatalf("unexpected migration count %d", len(migrations))
	}
	migration := migrations[9]
	if migration.version != 10 || migration.name != "organizer_review_issues" || migration.checksum != expectedChecksum {
		t.Fatalf("v010 identity changed: version=%d name=%s checksum=%s", migration.version, migration.name, migration.checksum)
	}

	manifest := canonicalSchemaManifestV010()
	for _, required := range []string{
		"table=pf_review_issue\n",
		"table=pf_review_issue_member\n",
		"plan=organizer-plan-v2\n",
		"review-issue-key=review-issue-key-v1\n",
		"review-issue-member-key=review-issue-member-key-v1\n",
		"review-issue-rule=review-issue-v1\n",
	} {
		if !strings.Contains(manifest, required) {
			t.Fatalf("v010 manifest does not include %q", required)
		}
	}

	expectedSteps := []string{"create_pf_review_issue", "create_pf_review_issue_member"}
	actualSteps := make([]string, 0, len(migration.steps))
	for _, step := range migration.steps {
		actualSteps = append(actualSteps, step.name)
	}
	if !equalStrings(actualSteps, expectedSteps) {
		t.Fatalf("v010 migration steps are %v, expected %v", actualSteps, expectedSteps)
	}
}

func TestRuntimeModelsMatchFrozenSchemaV010(t *testing.T) {
	pairs := []struct {
		frozen  any
		runtime any
	}{
		{new(reviewIssueV010), new(organizer.ReviewIssue)},
		{new(reviewIssueMemberV010), new(organizer.ReviewIssueMember)},
	}

	for _, pair := range pairs {
		frozenType := reflect.TypeOf(pair.frozen).Elem()
		runtimeType := reflect.TypeOf(pair.runtime).Elem()
		if frozenType.NumField() != runtimeType.NumField() {
			t.Fatalf("runtime model %s has %d fields, frozen v010 has %d", runtimeType.Name(), runtimeType.NumField(), frozenType.NumField())
		}
		for index := 0; index < frozenType.NumField(); index++ {
			frozenField := frozenType.Field(index)
			runtimeField := runtimeType.Field(index)
			if frozenField.Name != runtimeField.Name || frozenField.Tag.Get("xorm") != runtimeField.Tag.Get("xorm") {
				t.Fatalf("runtime model %s field %d differs from v010: runtime=%s %q frozen=%s %q",
					runtimeType.Name(), index, runtimeField.Name, runtimeField.Tag.Get("xorm"), frozenField.Name, frozenField.Tag.Get("xorm"))
			}
		}
	}
}

func TestSchemaV010IndexContract(t *testing.T) {
	type expectedIndex struct {
		unique  bool
		columns []string
	}
	expected := map[string]map[string]expectedIndex{
		"pf_review_issue": {
			"UQE_pf_rev_issue_uid_update_key":  {unique: true, columns: []string{"Uid", "UpdateId", "IssueKey"}},
			"IDX_pf_rev_issue_uid_update_filter": {columns: []string{"Uid", "UpdateId", "Status", "IssueType", "UpdatedUnixTime", "IssueId"}},
			"IDX_pf_rev_issue_uid_status_updated": {columns: []string{"Uid", "Status", "UpdatedUnixTime", "IssueId"}},
		},
		"pf_review_issue_member": {
			"UQE_pf_rev_member_uid_issue_key":   {unique: true, columns: []string{"Uid", "IssueId", "MemberKey"}},
			"IDX_pf_rev_member_uid_issue_order": {columns: []string{"Uid", "IssueId", "SortOrder", "MemberId"}},
			"IDX_pf_rev_member_uid_object":      {columns: []string{"Uid", "ObjectType", "ObjectId", "MemberId"}},
			"IDX_pf_rev_member_uid_update":      {columns: []string{"Uid", "UpdateId", "MemberId"}},
		},
	}

	for _, bean := range schemaBeansV010() {
		beanType := reflect.TypeOf(bean).Elem()
		tableName := reflect.New(beanType).Interface().(interface{ TableName() string }).TableName()
		actual := make(map[string]expectedIndex)
		for fieldIndex := 0; fieldIndex < beanType.NumField(); fieldIndex++ {
			field := beanType.Field(fieldIndex)
			for _, tagPart := range strings.Fields(field.Tag.Get("xorm")) {
				isUnique := strings.HasPrefix(tagPart, "UNIQUE(") && strings.HasSuffix(tagPart, ")")
				isIndex := strings.HasPrefix(tagPart, "INDEX(") && strings.HasSuffix(tagPart, ")")
				if !isUnique && !isIndex {
					continue
				}
				name := strings.TrimSuffix(tagPart[strings.IndexByte(tagPart, '(')+1:], ")")
				if len(name) > 63 || !isSafeCatalogIdentifier(name) {
					t.Fatalf("v010 index name %q must be ASCII-safe and at most 63 bytes", name)
				}
				index := actual[name]
				if len(index.columns) > 0 && index.unique != isUnique {
					t.Fatalf("v010 index %s mixes unique and ordinary declarations", name)
				}
				index.unique = isUnique
				index.columns = append(index.columns, field.Name)
				actual[name] = index
			}
		}
		if !reflect.DeepEqual(actual, expected[tableName]) {
			t.Fatalf("v010 table %s indexes are %v, expected %v", tableName, actual, expected[tableName])
		}
	}
}
