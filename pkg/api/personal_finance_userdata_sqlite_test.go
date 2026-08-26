package api

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/cardcycle"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/legacydata"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/migrations"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/reconciliation"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

func TestClearUserDataRemovesReconLoansAndV006WithoutCrossingUID(t *testing.T) {
	core.ResetUserDataHooksForTest()
	t.Cleanup(core.ResetUserDataHooksForTest)

	database, err := datastore.OpenDatabase(&settings.DatabaseConfig{
		DatabaseType:          settings.Sqlite3DbType,
		DatabasePath:          filepath.Join(t.TempDir(), "userdata.db"),
		MaxIdleConnection:     1,
		MaxOpenConnection:     1,
		ConnectionMaxLifeTime: 60,
	})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() {
		if closeErr := database.Close(); closeErr != nil {
			t.Errorf("close sqlite: %v", closeErr)
		}
	})
	store, err := datastore.NewDataStore(database)
	if err != nil {
		t.Fatalf("create store: %v", err)
	}
	if err := migrations.Upgrade(nil, store, migrations.ApplicationInfo{Version: "test", Commit: "hook-701"}); err != nil {
		t.Fatalf("upgrade schema: %v", err)
	}

	storage := &userdataTestStorage{objects: map[string]struct{}{"objects/" + strings.Repeat("a", 64): {}, "objects/" + strings.Repeat("b", 64): {}}}
	if err := registerPersonalFinanceUserDataHooks(store, storage); err != nil {
		t.Fatalf("register hooks: %v", err)
	}
	registered := core.RegisteredUserDataTableNames()
	expected := migrations.UserDataTableNames()
	if len(registered) != len(expected) {
		t.Fatalf("registered tables %d != migrated user tables %d", len(registered), len(expected))
	}
	covered := make(map[string]struct{}, len(registered))
	for _, name := range registered {
		covered[name] = struct{}{}
	}
	for _, name := range expected {
		if _, ok := covered[name]; !ok {
			t.Fatalf("registered hooks missed migrated user table %s", name)
		}
	}

	firstUID, secondUID := int64(1001), int64(2002)
	insertUserDataFixtures(t, database, firstUID, "a")
	insertUserDataFixtures(t, database, secondUID, "b")

	counts, err := core.CountUserData(nil, firstUID)
	if err != nil {
		t.Fatalf("count before clear: %v", err)
	}
	if core.UserDataCountOf(counts, "pf_reconciliation_case") != 1 ||
		core.UserDataCountOf(counts, "pf_loan_contract") != 1 ||
		core.UserDataCountOf(counts, "pf_billflow_task") != 1 ||
		core.UserDataCountOf(counts, "pf_card_cycle_rule") != 1 ||
		core.UserDataCountOf(counts, "pf_import_file") != 1 {
		t.Fatalf("v006/recon/loan counts missing before clear: %+v", counts)
	}

	if err := core.ClearUserData(nil, firstUID); err != nil {
		t.Fatalf("clear user data: %v", err)
	}
	if _, ok := storage.objects["objects/"+strings.Repeat("a", 64)]; ok {
		t.Fatal("cleared user object was retained")
	}
	if _, ok := storage.objects["objects/"+strings.Repeat("b", 64)]; !ok {
		t.Fatal("other user object was deleted")
	}

	cleared, err := core.CountUserData(nil, firstUID)
	if err != nil {
		t.Fatalf("count after clear: %v", err)
	}
	for _, item := range cleared {
		if item.Count != 0 {
			t.Fatalf("cleared user still has %s=%d", item.Code, item.Count)
		}
	}
	remaining, err := core.CountUserData(nil, secondUID)
	if err != nil {
		t.Fatalf("count other user: %v", err)
	}
	if core.UserDataCountOf(remaining, "pf_reconciliation_case") != 1 ||
		core.UserDataCountOf(remaining, "pf_loan_contract") != 1 ||
		core.UserDataCountOf(remaining, "pf_billflow_task") != 1 {
		t.Fatalf("clear crossed uid boundary: %+v", remaining)
	}

	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	migrationCount, err := sess.Count(new(migrations.SchemaMigration))
	if err != nil || migrationCount < 1 {
		t.Fatalf("schema migration rows were deleted: count=%d err=%v", migrationCount, err)
	}
}

func insertUserDataFixtures(t *testing.T, database *datastore.Database, uid int64, token string) {
	t.Helper()
	digest := strings.Repeat(token, 64)
	if len(digest) > 64 {
		digest = digest[:64]
	}
	sess := database.NewPrivacySession(nil)
	defer sess.Close()
	now := int64(10)
	file := &importing.ImportFile{
		Uid: uid, ContentState: importing.IMPORT_FILE_CONTENT_STATE_AVAILABLE, OriginalFileName: "fixture.csv",
		FileSize: 4, FileSha256: digest, MimeType: "text/csv", FileExtension: "csv",
		StorageObjectKey: "objects/" + digest, CreatedIp: "127.0.0.1", CreatedUnixTime: now, UpdatedUnixTime: now, FileId: uid,
	}
	caseRecord := &reconciliation.Case{
		Uid: uid, CaseKey: digest, CaseKeyVersion: reconciliation.CASE_KEY_VERSION_V1, Status: reconciliation.CASE_STATUS_OPEN,
		Version: 1, MemberCount: 2, SuggestedRelationType: reconciliation.DECISION_TYPE_SAME_EVENT, CandidateScore: 1,
		CandidateRuleVersion: reconciliation.CANDIDATE_RULE_VERSION_V1, ExplanationVersion: reconciliation.EXPLANATION_VERSION_V1,
		ReasonCodesJson: "[]", CreatedUnixTime: now, LastEvaluatedUnixTime: now, UpdatedUnixTime: now, CaseId: uid,
	}
	contract := &loans.Contract{
		Uid: uid, Name: "fixture", LenderName: "bank", ContractType: loans.CONTRACT_TYPE_BANK_LOAN,
		LiabilityAccountId: uid + 10, Status: loans.CONTRACT_STATUS_ACTIVE, CloseReasonCode: loans.CLOSE_REASON_NONE,
		Currency: "CNY", Note: "", Version: 1, CurrentRevisionId: uid + 1, CreatedUnixTime: now, UpdatedUnixTime: now, ContractId: uid,
	}
	task := &legacydata.Task{
		Uid: uid, Status: legacydata.TASK_STATUS_RECEIVING, ConfirmPolicy: legacydata.CONFIRM_POLICY_CONFIRM_THEN_POST,
		Version: 1, CreatedUnixTime: now, UpdatedUnixTime: now, TaskId: uid,
	}
	rule := &cardcycle.CycleRule{
		Uid: uid, LedgerAccountId: 11, RuleNumber: 1, StatementDay: 15, DueDay: 3, EffectiveFrom: "2026-08-01",
		Status: cardcycle.RULE_STATUS_ACTIVE, CreatedUnixTime: now, RuleId: uid,
	}
	for _, bean := range []any{file, caseRecord, contract, task, rule} {
		if _, err := sess.Insert(bean); err != nil {
			t.Fatalf("insert fixture %T for uid %d: %v", bean, uid, err)
		}
	}
}

type userdataTestStorage struct {
	objects map[string]struct{}
}

func (s *userdataTestStorage) SaveTemporary(core.Context, string, []byte) error { return nil }
func (s *userdataTestStorage) Promote(core.Context, string, string) error       { return nil }
func (s *userdataTestStorage) Verify(core.Context, string, string, int64) (bool, error) {
	return true, nil
}
func (s *userdataTestStorage) Delete(_ core.Context, objectKey string) error {
	delete(s.objects, objectKey)
	return nil
}
