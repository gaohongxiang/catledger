package core

import "testing"

func TestRegisterUserDataModuleRejectsMigrationTableAndConflicts(t *testing.T) {
	ResetUserDataHooksForTest()
	t.Cleanup(ResetUserDataHooksForTest)

	if err := RegisterUserDataModule(UserDataModule{Name: "empty"}); err != ErrUserDataHookInvalid {
		t.Fatalf("empty module was accepted: %v", err)
	}
	if err := RegisterUserDataModule(UserDataModule{
		Name: "bad", Tables: UserDataTables("pf_schema_migration"),
	}); err == nil {
		t.Fatal("schema migration table was accepted")
	}
	if err := RegisterUserDataModule(UserDataModule{
		Name: "users", Tables: UserDataTables("account"),
	}); err == nil {
		t.Fatal("non-pf table was accepted")
	}

	first := UserDataModule{Name: "first", Tables: UserDataTables("pf_one")}
	if err := RegisterUserDataModule(first); err != nil {
		t.Fatalf("register first module: %v", err)
	}
	if err := RegisterUserDataModule(first); err == nil {
		t.Fatal("duplicate module was accepted")
	}
	if err := RegisterUserDataModule(UserDataModule{Name: "second", Tables: UserDataTables("pf_one")}); err == nil {
		t.Fatal("duplicate table was accepted")
	}
	if got := RegisteredUserDataTableNames(); len(got) != 1 || got[0] != "pf_one" {
		t.Fatalf("registered tables: %v", got)
	}
}

func TestCountUserDataRequiresStoreAndMapsCodes(t *testing.T) {
	ResetUserDataHooksForTest()
	t.Cleanup(ResetUserDataHooksForTest)

	if _, err := CountUserData(nil, 1); err != ErrUserDataStoreUnavailable {
		t.Fatalf("count without store: %v", err)
	}
	if err := ClearUserData(nil, 1); err != ErrUserDataStoreUnavailable {
		t.Fatalf("clear without store: %v", err)
	}

	counts := []UserDataCount{{Code: "pf_import_file", Count: 3}, {Code: "pf_billflow_task", Count: 2}}
	if UserDataCountOf(counts, "pf_import_file") != 3 || UserDataCountOf(counts, "missing") != 0 {
		t.Fatalf("count lookup failed: %+v", counts)
	}
}
