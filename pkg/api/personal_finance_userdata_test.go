package api

import (
	"sort"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/cardcycle"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/installments"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/legacydata"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/migrations"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/organizer"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/reconciliation"
)

func TestUserDataModulesCoverEveryMigratedUserTable(t *testing.T) {
	registered := make(map[string]struct{})
	for _, module := range []core.UserDataModule{
		organizer.UserDataModule(),
		legacydata.BillflowUserDataModule(),
		installments.UserDataModule(),
		cardcycle.UserDataModule(),
		loans.UserDataModule(),
		reconciliation.UserDataModule(),
		importing.UserDataModule(nil),
	} {
		for _, table := range module.Tables {
			if _, exists := registered[table.Name]; exists {
				t.Fatalf("duplicate hook table %s", table.Name)
			}
			registered[table.Name] = struct{}{}
		}
	}

	expected := migrations.UserDataTableNames()
	if len(expected) == 0 {
		t.Fatal("migration user table list is empty")
	}
	missing := make([]string, 0)
	for _, name := range expected {
		if name == "pf_schema_migration" {
			t.Fatal("migration ledger was treated as user data")
		}
		if _, ok := registered[name]; !ok {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("migrated user tables are not covered by any hook: %v", missing)
	}
	extra := make([]string, 0)
	for name := range registered {
		found := false
		for _, expectedName := range expected {
			if expectedName == name {
				found = true
				break
			}
		}
		if !found {
			extra = append(extra, name)
		}
	}
	if len(extra) > 0 {
		sort.Strings(extra)
		t.Fatalf("hook tables are not in the migration user table list: %v", extra)
	}
}
